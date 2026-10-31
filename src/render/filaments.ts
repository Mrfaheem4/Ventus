import shader from '../shaders/filaments.wgsl?raw';
import type { GPUContext } from '../gpu/device';
import type { Obstacle } from '../geometry/sphere';

export interface FilamentFrame { positions:Float32Array; points:number; lines:number; step:number }

export async function createFilaments(context:GPUContext, obstacle:Obstacle, signal:AbortSignal) {
  const {device,grid,resources}=context;
  const points=Math.ceil(grid.nx*1.25/0.5)+1, lines=33, bytes=points*lines*16;
  const owned:GPUBuffer[]=[];
  let disposed=false, busy=false;
  const buffer=(label:string,size:number,usage:GPUBufferUsageFlags)=>{const b=device.createBuffer({label,size,usage});owned.push(b);return b;};
  const dispose=()=>{if(disposed)return;disposed=true;signal.removeEventListener('abort',dispose);owned.forEach(b=>b.destroy());};
  signal.throwIfAborted(); signal.addEventListener('abort',dispose,{once:true});
  device.pushErrorScope('out-of-memory'); device.pushErrorScope('internal'); device.pushErrorScope('validation');
  let scopes=true;
  const close=async()=>{if(!scopes)return [];scopes=false;return Promise.all([device.popErrorScope(),device.popErrorScope(),device.popErrorScope()]);};
  try {
    const paths=buffer('Smoke filament paths',bytes,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC);
    const readback=buffer('Smoke filament readback',bytes,GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ);
    const params=buffer('Smoke filament parameters',32,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
    const words=new ArrayBuffer(32); new Uint32Array(words).set([grid.nx,grid.ny,grid.nz,points]);
    new Float32Array(words,16).set([...(obstacle.sphere?.center ?? [0,0,0]),obstacle.sphere?.radius ?? 0]);
    device.queue.writeBuffer(params,0,words);
    const module=device.createShaderModule({label:'Velocity-driven smoke-style streamlines',code:shader});
    const info=await module.getCompilationInfo();
    if(info.messages.some(m=>m.type==='error'))throw new Error(info.messages.map(m=>m.message).join('; '));
    const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});
    const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[
      {binding:0,resource:resources.field.createView()},{binding:1,resource:{buffer:resources.flags}},
      {binding:2,resource:{buffer:paths}},{binding:3,resource:{buffer:params}},
    ]});
    const errors=(await close()).filter(e=>e); if(errors.length)throw new Error(errors.map(e=>e!.message).join('; '));
    signal.throwIfAborted();
    return {
      dispose,
      get bytes(){return owned.reduce((sum,b)=>sum+b.size,0);},
      async advance(steps:number,step:number):Promise<FilamentFrame> {
        signal.throwIfAborted();
        if(disposed || busy || !Number.isInteger(steps) || steps<1 || steps>16)throw new Error('Smoke line calculation unavailable.');
        busy=true;
        try {
          const encoder=device.createCommandEncoder({label:'Trace thin smoke lines through the calculated field'});
          const pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(1);pass.end();
          encoder.copyBufferToBuffer(paths,0,readback,0,bytes);device.queue.submit([encoder.finish()]);
          await readback.mapAsync(GPUMapMode.READ);signal.throwIfAborted();
          return {positions:new Float32Array(readback.getMappedRange().slice(0)),points,lines,step};
        } finally {if(!disposed && readback.mapState==='mapped')readback.unmap();busy=false;}
      },
    };
  } catch(error){await close().catch(()=>undefined);dispose();throw error;}
}
export type Filaments=Awaited<ReturnType<typeof createFilaments>>;
