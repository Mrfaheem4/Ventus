import lbmShader from "../shaders/lbm.wgsl?raw";
import macroShader from "../shaders/macroscopic.wgsl?raw";
import obstacleShader from '../shaders/obstacles.wgsl?raw';
import { createObstacle } from '../geometry/sphere';
import type { GPUContext } from "../gpu/device";
import { initializeFluid } from "./initialize";
import { DEFAULT_SETTINGS, inletSpeed, validateSettings } from "./settings";
import type { SolverSettings } from "./settings";

export interface FlowStats {
  steps: number;
  inletSpeed: number;
  densityMin: number;
  densityMax: number;
  maxSpeed: number;
  invalidCells: number;
}

export async function createSolver(
  context: GPUContext,
  signal: AbortSignal,
  overrides: Partial<SolverSettings> = {},
) {
  const settings = { ...DEFAULT_SETTINGS, ...overrides };
  validateSettings(settings);
  signal.throwIfAborted();
  const { device, resources, grid } = context;
  const obstacle = createObstacle(grid, settings.obstacle);
  const owned: GPUBuffer[] = [];
  let disposed = false;
  let busy = false;
  let failed = false;
  let current = 0;
  let steps = 0;
  let stats: FlowStats = {
    steps: 0,
    inletSpeed: 0,
    densityMin: 1,
    densityMax: 1,
    maxSpeed: 0,
    invalidCells: 0,
  };
  function dispose() {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener("abort", dispose);
    owned.forEach((buffer) => buffer.destroy());
  }
  function checkActive() {
    signal.throwIfAborted();
    if (disposed) throw new Error("The airflow solver has been disposed.");
  }
  signal.addEventListener("abort", dispose, { once: true });
  function buffer(label: string, size: number, usage: GPUBufferUsageFlags) {
    const value = device.createBuffer({ label, size, usage });
    owned.push(value);
    return value;
  }
  function configureBoundaries() {
    const flags = obstacle.solidFlags.slice();
    if (
      settings.boundaryMode !== "periodic" &&
      settings.boundaryMode !== "channel"
    ) {
      for (let z = 0; z < grid.nz; z++)
        for (let y = 0; y < grid.ny; y++) {
          const row = grid.nx * (y + grid.ny * z);
          flags[row] |= 2;
          flags[row + grid.nx - 1] |= 4;
        }
    }
    device.queue.writeBuffer(resources.flags, 0, flags);
  }

  device.pushErrorScope("out-of-memory");
  device.pushErrorScope("internal");
  device.pushErrorScope("validation");
  let failure: unknown;
  let result: Awaited<ReturnType<typeof build>> | undefined;
  async function build() {
    const alignment = device.limits.minUniformBufferOffsetAlignment;
    const stride = Math.ceil(48 / alignment) * alignment;
    const params = buffer(
      "Per-step parameters",
      stride * 16,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
    const health = buffer(
      "Flow health reduction",
      16,
      GPUBufferUsage.STORAGE |
        GPUBufferUsage.COPY_SRC |
        GPUBufferUsage.COPY_DST,
    );
    const readback = buffer(
      "Flow health readback",
      16,
      GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    );
    async function module(label: string, code: string) {
      const shader = device.createShaderModule({ label, code });
      const info = await shader.getCompilationInfo();
      checkActive();
      const errors = info.messages.filter(
        (message) => message.type === "error",
      );
      if (errors.length)
        throw new Error(
          `${label}: ${errors.map((error) => error.message).join("; ")}`,
        );
      return shader;
    }
    const stepModule = await module("D3Q19 stream and collide", lbmShader);
    const macroModule = await module(
      "Velocity, pressure, and stability",
      macroShader,
    );
    const stepLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "read-only-storage" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "storage" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "read-only-storage" },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.COMPUTE,
          buffer: {
            type: "uniform",
            hasDynamicOffset: true,
            minBindingSize: 48,
          },
        },
      ],
    });
    const pipeline = await device.createComputePipelineAsync({
      label: "D3Q19 BGK step",
      layout: device.createPipelineLayout({ bindGroupLayouts: [stepLayout] }),
      compute: { module: stepModule, entryPoint: "main" },
    });
    checkActive();
    const macroLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "read-only-storage" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          buffer: {
            type: "uniform",
            hasDynamicOffset: true,
            minBindingSize: 48,
          },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: {
            access: "write-only",
            format: "rgba16float",
            viewDimension: "3d",
          },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "storage" },
        },
        {
          binding: 4,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "read-only-storage" },
        },
      ],
    });
    const macro = await device.createComputePipelineAsync({
      label: "Macroscopic field and stability",
      layout: device.createPipelineLayout({ bindGroupLayouts: [macroLayout] }),
      compute: { module: macroModule, entryPoint: "main" },
    });
    checkActive();
    const groups = [0, 1].map((i) =>
      device.createBindGroup({
        layout: stepLayout,
        entries: [
          { binding: 0, resource: { buffer: resources.distributions[i] } },
          { binding: 1, resource: { buffer: resources.distributions[1 - i] } },
          { binding: 2, resource: { buffer: resources.flags } },
          { binding: 3, resource: { buffer: params, size: 48 } },
        ],
      }),
    );
    const macros = resources.distributions.map((state) =>
      device.createBindGroup({
        layout: macro.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: state } },
          { binding: 1, resource: { buffer: params, size: 48 } },
          { binding: 2, resource: resources.field.createView() },
          { binding: 3, resource: { buffer: health } },
          { binding: 4, resource: { buffer: resources.flags } },
        ],
      }),
    );
    let solidPipeline: GPUComputePipeline | undefined;
    let solidGroup: GPUBindGroup | undefined;
    if (obstacle.solidCells) {
      const shader = await module('Static solid preparation', obstacleShader);
      solidPipeline = await device.createComputePipelineAsync({ label: 'Prepare solid cells', layout: 'auto', compute: { module: shader, entryPoint: 'main' } });
      checkActive();
      solidGroup = device.createBindGroup({ layout: solidPipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: resources.distributions[0] } },
        { binding: 1, resource: { buffer: resources.distributions[1] } },
        { binding: 2, resource: { buffer: resources.flags } },
        { binding: 3, resource: { buffer: resources.params } },
        { binding: 4, resource: resources.field.createView() },
      ] });
    }
    function prepareSolids() {
      if (!solidPipeline || !solidGroup) return;
      const encoder = device.createCommandEncoder({ label: 'Apply stationary obstacle' });
      const pass = encoder.beginComputePass();
      pass.setPipeline(solidPipeline);
      pass.setBindGroup(0, solidGroup);
      pass.dispatchWorkgroups(Math.ceil(grid.nx/8), Math.ceil(grid.ny/8), Math.ceil(grid.nz/4));
      pass.end();
      device.queue.submit([encoder.finish()]);
    }
    configureBoundaries();
    prepareSolids();

    async function step(count = 1): Promise<FlowStats> {
      checkActive();
      if (failed)
        throw new Error(
          "Reset the fluid before continuing after a solver failure.",
        );
      if (busy)
        throw new Error("A simulation operation is already in progress.");
      if (!Number.isInteger(count) || count < 1 || count > 16)
        throw new Error("Use between 1 and 16 steps per batch.");
      busy = true;
      try {
        const packed = new ArrayBuffer(stride * count);
        for (let i = 0; i < count; i++) {
          const words = new Uint32Array(packed, i * stride, 12);
          const floats = new Float32Array(packed, i * stride, 12);
          words.set([grid.nx, grid.ny, grid.nz]);
          floats[3] = settings.tau;
          floats[4] = settings.targetSpeed;
          words[8] = steps + i + 1;
          words[9] = settings.rampSteps;
          words[10] =
            settings.boundaryMode === "free-slip"
              ? 0
              : settings.boundaryMode === "periodic-sides"
                ? 1
                : settings.boundaryMode === "periodic"
                  ? 2
                  : 3;
          floats[11] = settings.acceleration;
        }
        device.queue.writeBuffer(params, 0, packed);
        device.queue.writeBuffer(
          health,
          0,
          new Uint32Array([0x7f800000, 0, 0, 0]),
        );
        const encoder = device.createCommandEncoder({
          label: "Bounded airflow batch",
        });
        for (let i = 0; i < count; i++) {
          const pass = encoder.beginComputePass();
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, groups[current], [i * stride]);
          pass.dispatchWorkgroups(
            Math.ceil(grid.nx / 8),
            Math.ceil(grid.ny / 8),
            Math.ceil(grid.nz / 4),
          );
          pass.end();
          current = 1 - current;
        }
        const pass = encoder.beginComputePass();
        pass.setPipeline(macro);
        pass.setBindGroup(0, macros[current], [(count - 1) * stride]);
        pass.dispatchWorkgroups(
          Math.ceil(grid.nx / 8),
          Math.ceil(grid.ny / 8),
          Math.ceil(grid.nz / 4),
        );
        pass.end();
        encoder.copyBufferToBuffer(health, 0, readback, 0, 16);
        device.queue.submit([encoder.finish()]);
        steps += count;
        // Mapping fences this batch before another can be queued: no unbounded GPU work.
        await readback.mapAsync(GPUMapMode.READ);
        checkActive();
        const data = readback.getMappedRange();
        const values = new Float32Array(data);
        stats = {
          steps,
          inletSpeed: inletSpeed(steps, settings),
          densityMin: values[0],
          densityMax: values[1],
          maxSpeed: values[2],
          invalidCells: new Uint32Array(data)[3],
        };
        readback.unmap();
        if (
          stats.invalidCells ||
          !Number.isFinite(stats.densityMin) ||
          !Number.isFinite(stats.densityMax) ||
          !Number.isFinite(stats.maxSpeed) ||
          stats.densityMin < 0.8 ||
          stats.densityMax > 1.2 ||
          stats.maxSpeed > 0.3
        ) {
          throw new Error(
            "Simulation unstable. Reset, reduce inlet speed, or increase relaxation time.",
          );
        }
        return { ...stats };
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        if (!disposed && readback.mapState === "mapped") readback.unmap();
        busy = false;
      }
    }
    async function reset() {
      checkActive();
      if (busy)
        throw new Error(
          "Wait for the current simulation operation before resetting.",
        );
      busy = true;
      try {
        await initializeFluid(context, signal);
        checkActive();
        // In forced verification mode, post-collision populations need a half
        // impulse so that their force-corrected physical velocity is zero.
        if (settings.acceleration !== 0) {
          const cx = [0,1,-1,0,0,0,0,1,-1,1,-1,1,-1,1,-1,0,0,0,0];
          const u = settings.acceleration / 2;
          const values = new Float32Array(context.memory.cells);
          for (let i = 0; i < 19; i++) {
            const weight = i === 0 ? 1/3 : i <= 6 ? 1/18 : 1/36;
            const cu = cx[i]*u;
            values.fill(weight*(1+3*cu+4.5*cu*cu-1.5*u*u));
            for (const buffer of resources.distributions) device.queue.writeBuffer(buffer, i*values.byteLength, values);
          }
        }
        configureBoundaries();
        prepareSolids();
        current = 0;
        steps = 0;
        failed = false;
        stats = {
          steps: 0,
          inletSpeed: 0,
          densityMin: 1,
          densityMax: 1,
          maxSpeed: 0,
          invalidCells: 0,
        };
        return { ...stats };
      } finally {
        busy = false;
      }
    }
    return {
      step,
      reset,
      dispose,
      get currentBuffer() {
        return resources.distributions[current];
      },
      get stats() {
        return { ...stats };
      },
      settings: { ...settings },
      obstacle,
    };
  }
  try {
    result = await build();
  } catch (error) {
    failure = error;
  }
  const validation = await device.popErrorScope();
  const internal = await device.popErrorScope();
  const outOfMemory = await device.popErrorScope();
  try {
    checkActive();
    const error = validation ?? internal ?? outOfMemory;
    if (error) throw new Error(`Solver setup: ${error.message}`);
    if (failure) throw failure;
    return result!;
  } catch (error) {
    dispose();
    throw error;
  }
}

export type Solver = Awaited<ReturnType<typeof createSolver>>;
