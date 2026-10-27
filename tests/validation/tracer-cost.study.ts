/// <reference types="@webgpu/types" />
import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

test('measure solver and passive-tracer batch wall cost without animated viewer updates', async ({ page }, testInfo) => {
  test.setTimeout(120000);
  await page.routeWebSocket('**',(socket) => socket.close());
  await page.goto('/');
  const supported = await page.evaluate(async () => Boolean(navigator.gpu && await navigator.gpu.requestAdapter()));
  test.skip(!supported,'A real GPU is required.');
  const report = await page.evaluate(async () => {
    const paths = ['/src/gpu/device.ts','/src/gpu/buffers.ts','/src/gpu/grid.ts','/src/sim/initialize.ts','/src/sim/lbm.ts','/src/render/tracers.ts'];
    const [{ initializeGPU },{ allocateGrid },{ gridMemory },{ initializeFluid },{ createSolver },{ createTracers }] = await Promise.all(paths.map((path) => import(/* @vite-ignore */ path)));
    const abort = new AbortController();
    const errors: string[] = [];
    const base = await initializeGPU(abort.signal,(message: string) => errors.push(message));
    base.resources.destroy();
    const cases = [];
    try {
      for (const height of [32,48]) for (const enabled of [false,true]) {
        const grid = { nx: height*2, ny: height,nz: height };
        const resources = allocateGrid(base.device,grid);
        const context = { ...base,grid,resources,memory: gridMemory(grid) };
        let solver, tracers;
        try {
          await initializeFluid(context,abort.signal);
          solver = await createSolver(context,abort.signal,{ obstacle: 'sphere',targetSpeed: 0.03*32/height,rampSteps: Math.round(300*(height/32)**2) });
          if (enabled) tracers = await createTracers(context,solver.obstacle,abort.signal);
          for (let i = 0; i < 16; i++) { await solver.step(4); if (tracers) await tracers.advance(4); }
          let solverMilliseconds = 0, tracerMilliseconds = 0;
          for (let i = 0; i < 256; i++) {
            let start = performance.now(); await solver.step(4); solverMilliseconds += performance.now()-start;
            if (tracers) { start = performance.now(); await tracers.advance(4); tracerMilliseconds += performance.now()-start; }
          }
          cases.push({ grid,enabled,steps: 1024,batchSteps: 4, solverMsPerStep: solverMilliseconds/1024,
            tracerMsPerStep: tracerMilliseconds/1024,totalMsPerStep: (solverMilliseconds+tracerMilliseconds)/1024,
            tracerBytes: tracers?.bytes ?? 0,positionReadbackBytesPerBatch: enabled ? 768*16 : 0 });
        } finally { tracers?.dispose(); solver?.dispose(); resources.destroy(); }
      }
      if (errors.length) throw new Error(errors.join('; '));
      return { adapter: base.adapterName,browser: navigator.userAgent,cases,
        note: 'One sequential run. Wall time includes diagnostics and position readback. Pipelines warm before timing. Excludes React, animated scene rendering, trail geometry work and GPU-only timestamps. Idle demo resources may remain. Not an FPS or hardware-tier benchmark.' };
    } finally { abort.abort(); }
  });
  const path = testInfo.outputPath('tracer-cost.json');
  await writeFile(path,JSON.stringify(report,null,2));
  await testInfo.attach('tracer-cost',{ path,contentType: 'application/json' });
  for (const value of report.cases) {
    expect(value.totalMsPerStep).toBeGreaterThan(0);
    expect(Number.isFinite(value.totalMsPerStep)).toBe(true);
  }
});
