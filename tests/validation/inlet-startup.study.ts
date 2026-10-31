/// <reference types="@webgpu/types" />
import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

test('empty tunnel startup measures delivered flow independently of sphere drag', async ({ page }, testInfo) => {
  test.setTimeout(120000);
  await page.routeWebSocket('**',socket => socket.close());
  await page.goto('/');
  test.skip(!await page.evaluate(async () => Boolean(navigator.gpu && await navigator.gpu.requestAdapter())), 'Real GPU required');
  const report = await page.evaluate(async () => {
    const paths = ['/src/gpu/device.ts','/src/sim/initialize.ts','/src/sim/lbm.ts','/src/render/slice.ts'];
    const [{ initializeGPU },{ initializeFluid },{ createSolver },{ readSlice }] = await Promise.all(paths.map(path => import(/* @vite-ignore */ path)));
    const abort = new AbortController(), errors: string[] = [];
    const context = await initializeGPU(abort.signal,(m: string) => errors.push(m),{ nx:64,ny:32,nz:32 });
    let solver;
    try {
      await initializeFluid(context,abort.signal);
      solver = await createSolver(context,abort.signal,{ obstacle:'none',targetSpeed:0.03,tau:0.6,rampSteps:300 });
      const checkpoints = [];
      for (const end of [1024,4096]) {
        while (solver.stats.steps < end) await solver.step(16);
        const plane = await readSlice(context,16,abort.signal);
        const profile = [0,1,2,16,32,48,62,63].map(x => {
          let ux = 0,pressure = 0;
          for(let y=0;y<32;y++) { ux+=plane[(x+64*y)*4]/32; pressure+=plane[(x+64*y)*4+3]/32; }
          return { x,ux,relativeInletSpeed:ux/0.03,pressureVariation:pressure };
        });
        checkpoints.push({ steps:end,profile,densityMin:solver.stats.densityMin,densityMax:solver.stats.densityMax });
      }
      if(errors.length) throw new Error(errors.join('; '));
      return { adapter:context.adapterName,grid:context.grid,checkpoints,note:'Empty free-slip tunnel from rest. Cross-Y means at Z=16. Reports delivered flow; stable values alone do not certify the boundary condition.' };
    } finally { solver?.dispose(); abort.abort(); }
  });
  const path=testInfo.outputPath('inlet-startup.json');
  await writeFile(path,JSON.stringify(report,null,2));
  await testInfo.attach('inlet-startup',{ path,contentType:'application/json' });
  for(const checkpoint of report.checkpoints) for(const p of checkpoint.profile) expect(Number.isFinite(p.ux)).toBe(true);
  for (const p of report.checkpoints.at(-1)!.profile) expect(Math.abs(p.relativeInletSpeed-1)).toBeLessThan(0.01);
});
