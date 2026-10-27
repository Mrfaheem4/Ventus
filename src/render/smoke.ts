import shader from "../shaders/smoke.wgsl?raw";
import type { GPUContext } from "../gpu/device";
import type { Grid } from "../gpu/grid";

export interface SmokeFrame {
  density: Uint8Array;
  grid: Grid;
  step: number;
}
export function smokeGrid(grid: Grid): Grid {
  // Match the flow cells: a coarse scalar grid erased near-body deflection.
  return { ...grid };
}
export async function createSmoke(
  context: GPUContext,
  signal: AbortSignal,
  initial?: Float32Array,
) {
  signal.throwIfAborted();
  const { device, grid, resources } = context;
  const size = smokeGrid(grid),
    cells = size.nx * size.ny * size.nz;
  if (
    initial &&
    (initial.length !== cells ||
      initial.some((x) => !Number.isFinite(x) || x < 0 || x > 1))
  )
    throw new Error("Invalid initial smoke concentration.");
  const packedBytes = Math.ceil(cells / 4) * 4;
  const owned: GPUBuffer[] = [];
  let disposed = false,
    busy = false,
    current = 0;
  const buffer = (label: string, bytes: number, usage: GPUBufferUsageFlags) => {
    const b = device.createBuffer({ label, size: bytes, usage });
    owned.push(b);
    return b;
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener("abort", dispose);
    owned.forEach((b) => b.destroy());
  };
  signal.addEventListener("abort", dispose, { once: true });
  device.pushErrorScope("out-of-memory");
  device.pushErrorScope("internal");
  device.pushErrorScope("validation");
  let open = true;
  const closeScopes = async () => {
    if (!open) return [];
    open = false;
    return Promise.all([
      device.popErrorScope(),
      device.popErrorScope(),
      device.popErrorScope(),
    ]);
  };
  try {
    const fields = [0, 1].map((i) =>
      buffer(
        `Smoke concentration ${i}`,
        cells * 4,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      ),
    );
    if (initial) device.queue.writeBuffer(fields[0], 0, initial);
    const packed = buffer(
      "Packed smoke concentration",
      packedBytes,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    );
    const readback = buffer(
      "Smoke volume readback",
      packedBytes,
      GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    );
    const params = buffer(
      "Smoke transport parameters",
      32,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
    const module = device.createShaderModule({
      label: "Passive smoke concentration advection",
      code: shader,
    });
    const info = await module.getCompilationInfo();
    if (info.messages.some((m) => m.type === "error"))
      throw new Error(info.messages.map((m) => m.message).join("; "));
    const advect = await device.createComputePipelineAsync({
      layout: "auto",
      compute: { module, entryPoint: "advect" },
    });
    const pack = await device.createComputePipelineAsync({
      layout: "auto",
      compute: { module, entryPoint: "pack" },
    });
    signal.throwIfAborted();
    const groups = fields.map((source, i) =>
      device.createBindGroup({
        layout: advect.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: resources.field.createView() },
          { binding: 1, resource: { buffer: resources.flags } },
          { binding: 2, resource: { buffer: source } },
          { binding: 3, resource: { buffer: fields[1 - i] } },
          { binding: 4, resource: { buffer: params } },
        ],
      }),
    );
    const packGroups = fields.map((field) =>
      device.createBindGroup({
        layout: pack.getBindGroupLayout(1),
        entries: [
          { binding: 0, resource: { buffer: field } },
          { binding: 1, resource: { buffer: packed } },
        ],
      }),
    );
    // Auto layout includes an empty group 0 for the packing entry point.
    const empty = device.createBindGroup({
      layout: pack.getBindGroupLayout(0),
      entries: [],
    });
    const errors = (await closeScopes()).flatMap((e) => (e ? [e.message] : []));
    if (errors.length) throw new Error(errors.join("; "));
    signal.throwIfAborted();
    return {
      dispose,
      get bytes() {
        return owned.reduce((sum, b) => sum + b.size, 0);
      },
      async advance(steps: number, step: number): Promise<SmokeFrame> {
        signal.throwIfAborted();
        if (
          disposed ||
          busy ||
          !Number.isInteger(steps) ||
          steps < 1 ||
          steps > 16
        )
          throw new Error("Smoke requires an available 1–16 step batch.");
        busy = true;
        try {
          device.queue.writeBuffer(
            params,
            0,
            new Uint32Array([
              grid.nx,
              grid.ny,
              grid.nz,
              steps,
              size.nx,
              size.ny,
              size.nz,
              step,
            ]),
          );
          const encoder = device.createCommandEncoder({
            label: "Transport and read passive smoke",
          });
          let pass = encoder.beginComputePass();
          pass.setPipeline(advect);
          pass.setBindGroup(0, groups[current]);
          pass.dispatchWorkgroups(
            Math.ceil(size.nx / 8),
            Math.ceil(size.ny / 4),
            Math.ceil(size.nz / 4),
          );
          pass.end();
          current = 1 - current;
          pass = encoder.beginComputePass();
          pass.setPipeline(pack);
          pass.setBindGroup(0, empty);
          pass.setBindGroup(1, packGroups[current]);
          pass.dispatchWorkgroups(Math.ceil(packedBytes / 4 / 64));
          pass.end();
          encoder.copyBufferToBuffer(packed, 0, readback, 0, packedBytes);
          device.queue.submit([encoder.finish()]);
          await readback.mapAsync(GPUMapMode.READ);
          signal.throwIfAborted();
          if (disposed) throw new Error("Smoke disposed.");
          return {
            density: new Uint8Array(readback.getMappedRange().slice(0, cells)),
            grid: size,
            step,
          };
        } finally {
          if (!disposed && readback.mapState === "mapped") readback.unmap();
          busy = false;
        }
      },
    };
  } catch (error) {
    await closeScopes().catch(() => undefined);
    dispose();
    throw error;
  }
}
export type Smoke = Awaited<ReturnType<typeof createSmoke>>;
