import initShader from "../shaders/init.wgsl?raw";
import type { GPUContext } from "../gpu/device";
import { checkRestDistributions } from "./initialization-check";

export interface InitializationReport {
  sampledCells: number;
  checkedStates: number;
  densityMin: number;
  densityMax: number;
  maxDensityError: number;
  maxSpeed: number;
  maxPopulationError: number;
}

// Reusable initialization/reset operation. It does not advance simulation time.
export async function initializeFluid(
  context: GPUContext,
  signal: AbortSignal,
): Promise<InitializationReport> {
  const { device, resources, grid, memory } = context;
  const throwIfCancelled = () => signal.throwIfAborted();
  throwIfCancelled();
  const center =
    Math.floor(grid.nx / 2) +
    grid.nx * (Math.floor(grid.ny / 2) + grid.ny * Math.floor(grid.nz / 2));
  const nodes = [
    ...new Set([
      0,
      grid.nx - 1,
      center,
      memory.cells - grid.nx,
      memory.cells - 1,
    ]),
  ];
  // For each node: A's 19 populations, B's 19 populations, and one u32 flag.
  const wordsPerSample = 39;
  let readback: GPUBuffer | undefined;
  const releaseReadback = () => readback?.destroy();
  signal.addEventListener("abort", releaseReadback, { once: true });
  device.pushErrorScope("out-of-memory");
  device.pushErrorScope("internal");
  device.pushErrorScope("validation");

  let failure: unknown;
  let report: InitializationReport | undefined;
  try {
    const module = device.createShaderModule({
      label: "Initialize resting fluid",
      code: initShader,
    });
    const info = await module.getCompilationInfo();
    throwIfCancelled();
    const errors = info.messages.filter((message) => message.type === "error");
    if (errors.length)
      throw new Error(
        `Initialization shader: ${errors.map((error) => error.message).join("; ")}`,
      );
    const pipeline = await device.createComputePipelineAsync({
      label: "Resting D3Q19 initialization",
      layout: "auto",
      compute: { module, entryPoint: "main" },
    });
    throwIfCancelled();
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: resources.distributions[0] } },
        { binding: 1, resource: { buffer: resources.distributions[1] } },
        { binding: 2, resource: { buffer: resources.flags } },
        { binding: 3, resource: { buffer: resources.params } },
        { binding: 4, resource: resources.field.createView() },
      ],
    });
    const params = new ArrayBuffer(32);
    new Uint32Array(params, 0, 3).set([grid.nx, grid.ny, grid.nz]);
    new Float32Array(params)[3] = 0.6; // Safe starting relaxation time; no collision yet.
    // Inlet and Smagorinsky coefficient remain zero. No inlet is driven yet.
    device.queue.writeBuffer(resources.params, 0, params);
    readback = device.createBuffer({
      label: "Initialization sample readback",
      size: nodes.length * wordsPerSample * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encoder = device.createCommandEncoder({
      label: "Initialize and sample resting fluid",
    });
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(
      Math.ceil(grid.nx / 8),
      Math.ceil(grid.ny / 8),
      Math.ceil(grid.nz / 4),
    );
    pass.end();
    nodes.forEach((node, sample) => {
      resources.distributions.forEach((buffer, state) => {
        for (let direction = 0; direction < 19; direction++) {
          encoder.copyBufferToBuffer(
            buffer,
            (direction * memory.cells + node) * 4,
            readback!,
            (sample * wordsPerSample + state * 19 + direction) * 4,
            4,
          );
        }
      });
      encoder.copyBufferToBuffer(
        resources.flags,
        node * 4,
        readback!,
        (sample * wordsPerSample + 38) * 4,
        4,
      );
    });
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    throwIfCancelled();
    const mapped = readback.getMappedRange();
    const values = new Float32Array(mapped);
    const flags = new Uint32Array(mapped);
    report = {
      sampledCells: nodes.length,
      checkedStates: nodes.length * 2,
      densityMin: Infinity,
      densityMax: -Infinity,
      maxDensityError: 0,
      maxSpeed: 0,
      maxPopulationError: 0,
    };
    for (let sample = 0; sample < nodes.length; sample++) {
      if (flags[sample * wordsPerSample + 38] !== 0)
        throw new Error("Initial cell flags must identify fluid.");
      for (let state = 0; state < 2; state++) {
        const offset = sample * wordsPerSample + state * 19;
        const checked = checkRestDistributions(
          values.subarray(offset, offset + 19),
        );
        report.densityMin = Math.min(report.densityMin, checked.density);
        report.densityMax = Math.max(report.densityMax, checked.density);
        report.maxDensityError = Math.max(
          report.maxDensityError,
          checked.densityError,
        );
        report.maxSpeed = Math.max(report.maxSpeed, checked.speed);
        report.maxPopulationError = Math.max(
          report.maxPopulationError,
          checked.maxPopulationError,
        );
      }
    }
    readback.unmap();
  } catch (error) {
    failure = error;
  } finally {
    releaseReadback();
    signal.removeEventListener("abort", releaseReadback);
  }
  // Surface captured validation/allocation errors, not just a misleading sample failure.
  const validation = await device.popErrorScope();
  const internal = await device.popErrorScope();
  const outOfMemory = await device.popErrorScope();
  throwIfCancelled();
  const gpuError = validation ?? internal ?? outOfMemory;
  if (gpuError) throw new Error(`Fluid initialization: ${gpuError.message}`);
  if (failure) throw failure;
  return report!;
}
