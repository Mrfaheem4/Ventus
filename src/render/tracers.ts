import shader from '../shaders/tracers.wgsl?raw';
import type { GPUContext } from '../gpu/device';
import type { Obstacle } from '../geometry/sphere';
import { seedTracers } from './tracer-seeds';

export async function createTracers(context: GPUContext, obstacle: Obstacle, signal: AbortSignal,
  initial = seedTracers(context.grid, obstacle)) {
  signal.throwIfAborted();
  if (!initial.length || initial.length%4 || initial.some((value) => !Number.isFinite(value))) throw new Error('Invalid tracer seeds.');
  const { device, grid, resources } = context;
  const owned: GPUBuffer[] = [];
  let disposed = false, busy = false;
  const buffer = (label: string, size: number, usage: GPUBufferUsageFlags) => {
    const result = device.createBuffer({ label, size, usage }); owned.push(result); return result;
  };
  const dispose = () => { if (disposed) return; disposed = true; signal.removeEventListener('abort',dispose); owned.forEach((value) => value.destroy()); };
  signal.addEventListener('abort',dispose,{ once: true });
  device.pushErrorScope('out-of-memory'); device.pushErrorScope('internal'); device.pushErrorScope('validation');
  let scopesOpen = true;
  const closeScopes = async () => {
    if (!scopesOpen) return [];
    scopesOpen = false;
    return Promise.all([device.popErrorScope(),device.popErrorScope(),device.popErrorScope()]);
  };
  try {
    const particles = buffer('Passive airflow tracers', initial.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
    const params = buffer('Tracer integration parameters',16,GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    const readback = buffer('Tracer position readback',initial.byteLength,GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    device.queue.writeBuffer(particles,0,initial);
    const module = device.createShaderModule({ label: '3D velocity-driven tracer advection', code: shader });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((message) => message.type === 'error');
    if (errors.length) throw new Error(errors.map((message) => message.message).join('; '));
    const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    signal.throwIfAborted();
    if (disposed) throw new Error('Tracers disposed.');
    const bindings = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: resources.field.createView() }, { binding: 1, resource: { buffer: resources.flags } },
      { binding: 2, resource: { buffer: particles } }, { binding: 3, resource: { buffer: params } },
    ] });
    const allocationErrors = (await closeScopes()).flatMap((error) => error ? [error.message] : []);
    if (allocationErrors.length) throw new Error(allocationErrors.join('; '));
    signal.throwIfAborted();
    return {
      dispose,
      async advance(steps: number) {
        signal.throwIfAborted();
        if (disposed || busy) throw new Error('Tracer operation unavailable.');
        if (!Number.isInteger(steps) || steps < 1 || steps > 16) throw new Error('Tracer batch must contain 1–16 solver steps.');
        busy = true;
        try {
          device.queue.writeBuffer(params,0,new Uint32Array([grid.nx,grid.ny,grid.nz,steps]));
          const encoder = device.createCommandEncoder({ label: 'Advance passive tracers with the calculated flow' });
          const pass = encoder.beginComputePass();
          pass.setPipeline(pipeline); pass.setBindGroup(0,bindings); pass.dispatchWorkgroups(Math.ceil(initial.length/4/64)); pass.end();
          encoder.copyBufferToBuffer(particles,0,readback,0,initial.byteLength);
          device.queue.submit([encoder.finish()]);
          await readback.mapAsync(GPUMapMode.READ);
          signal.throwIfAborted();
          if (disposed) throw new Error('Tracers disposed.');
          const positions = new Float32Array(readback.getMappedRange().slice(0));
          if (positions.some((value) => !Number.isFinite(value))) throw new Error('Invalid tracer position readback.');
          return positions;
        } finally { if (!disposed && readback.mapState === 'mapped') readback.unmap(); busy = false; }
      },
      get bytes() { return owned.reduce((sum,value) => sum+value.size,0); },
    };
  } catch (error) { await closeScopes().catch(() => undefined); dispose(); throw error; }
}
export type Tracers = Awaited<ReturnType<typeof createTracers>>;
