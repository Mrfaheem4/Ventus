/// <reference types="@webgpu/types" />
import { test, expect } from '@playwright/test';
import { createObstacle } from '../src/geometry/sphere';
import { buildWallLinks } from '../src/geometry/wall-links';
import { buildSurfaceLinks, LATTICE_DIRECTIONS } from '../src/sim/forces';
import { DEFAULT_SETTINGS } from '../src/sim/settings';
import { cpuStep, cpuWallReflection, directions, initialField } from './cpu_reference/d3q19';

test('surface fractions lie on the sphere and cover both interpolation branches', () => {
  const grid = { nx:24,ny:16,nz:16 }, body = createObstacle(grid,'sphere');
  const links = buildSurfaceLinks(grid,body), wall = buildWallLinks(grid,body,links,true);
  let near = 0, far = 0;
  for(let i=0;i<links.length;i+=2) {
    const node = links[i], d = LATTICE_DIRECTIONS[links[i+1]];
    const incoming = LATTICE_DIRECTIONS.findIndex(c => c.every((v,a)=>v===-d[a]));
    const q = wall.fractions[((wall.flags[node]>>>3)-1)*19+incoming];
    if(q<0.5) near++; else far++;
    const x=node%grid.nx+0.5, y=Math.floor(node/grid.nx)%grid.ny+0.5, z=Math.floor(node/(grid.nx*grid.ny))+0.5;
    const distance = Math.hypot(...[x,y,z].map((v,a)=>v+q*d[a]-body.sphere!.center[a]));
    expect(distance).toBeCloseTo(body.sphere!.radius,5);
    expect(q).toBeGreaterThan(0); expect(q).toBeLessThanOrEqual(1);
  }
  expect(near).toBeGreaterThan(0); expect(far).toBeGreaterThan(0);
  expect(wall.fractions.byteLength).toBeLessThan(grid.nx*grid.ny*grid.nz*4);
});

test('interpolated GPU reflection and force match an independent CPU reference, then reset to rest', async ({ page }) => {
  test.setTimeout(90000);
  await page.routeWebSocket('**',socket=>socket.close()); await page.goto('/');
  test.skip(!await page.evaluate(async()=>Boolean(navigator.gpu && await navigator.gpu.requestAdapter())),'Real GPU required');
  const grid = { nx:24,ny:16,nz:16 }, body = createObstacle(grid,'sphere');
  const settings = { ...DEFAULT_SETTINGS,obstacle:'sphere' as const };
  let state = initialField(grid);
  for(let i=0;i<state.length;i++) state[i]=body.solidFlags[i%body.solidFlags.length]&1?0:Math.fround(state[i]);
  const initial = Array.from(state), links = buildSurfaceLinks(grid,body), force = [0,0,0];
  for(let step=1;step<=23;step++) {
    if(step===23) for(let j=0;j<links.length;j+=2) {
      const node=links[j], direction=links[j+1], d=directions[direction];
      const incoming=directions.findIndex(c=>c.every((v,a)=>v===-d[a]));
      const returned=cpuWallReflection(state,grid,settings,body.solidFlags,node,incoming);
      for(let axis=0;axis<3;axis++) force[axis]+=(state[direction*body.solidFlags.length+node]+returned)*d[axis];
    }
    state=cpuStep(state,grid,settings,step,body.solidFlags);
  }
  const result = await page.evaluate(async({grid,settings,initial})=>{
    const paths=['/src/gpu/device.ts','/src/sim/initialize.ts','/src/sim/lbm.ts'];
    const [{initializeGPU},{initializeFluid},{createSolver}]=await Promise.all(paths.map(path=>import(/* @vite-ignore */path)));
    const abort=new AbortController(), errors:string[]=[];
    const context=await initializeGPU(abort.signal,(m:string)=>errors.push(m),grid);
    let solver,readback;
    try {
      await initializeFluid(context,abort.signal);
      context.resources.distributions.forEach((b:GPUBuffer)=>context.device.queue.writeBuffer(b,0,new Float32Array(initial)));
      solver=await createSolver(context,abort.signal,settings); await solver.step(7); await solver.step(16);
      const force=solver.stats.forces;
      readback=context.device.createBuffer({size:context.memory.distributionBytes,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
      const encoder=context.device.createCommandEncoder(); encoder.copyBufferToBuffer(solver.currentBuffer,0,readback,0,context.memory.distributionBytes);
      context.device.queue.submit([encoder.finish()]); await readback.mapAsync(GPUMapMode.READ);
      const values=Array.from(new Float32Array(readback.getMappedRange())); readback.unmap();
      await solver.reset(); solver.dispose();
      solver=await createSolver(context,abort.signal,{...settings,targetSpeed:0}); const rest=await solver.step(16);
      if(errors.length) throw new Error(errors.join('; '));
      return {values,force,rest};
    } finally { readback?.destroy(); solver?.dispose(); abort.abort(); }
  },{grid,settings,initial});
  expect(Math.max(...result.values.map((v:number,i:number)=>Math.abs(v-state[i])))).toBeLessThan(1e-5);
  [result.force.drag,result.force.lift,result.force.side].forEach((v,i)=>expect(Math.abs(v-force[i])).toBeLessThan(2e-5));
  expect(result.rest.maxSpeed).toBeLessThan(1e-6);
  expect(result.rest.invalidCells).toBe(0);
});
