/// <reference types="@webgpu/types" />
import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

test('isolate inlet, outlet and side-distance effects on the same voxel sphere', async ({ page }, testInfo) => {
  test.setTimeout(600000);
  await page.routeWebSocket('**', (socket) => socket.close());
  await page.goto('/');
  const supported = await page.evaluate(async () => Boolean(navigator.gpu && await navigator.gpu.requestAdapter()));
  test.skip(!supported, 'A real WebGPU adapter is required.');
  const report = await page.evaluate(async () => {
    const paths = ['/src/gpu/device.ts', '/src/gpu/buffers.ts', '/src/gpu/grid.ts', '/src/sim/initialize.ts', '/src/sim/lbm.ts', '/src/geometry/sphere.ts'];
    const [{ initializeGPU }, { allocateGrid }, { gridMemory }, { initializeFluid }, { createSolver }, { createObstacle }] = await Promise.all(paths.map((path) => import(/* @vite-ignore */ path)));
    const abort = new AbortController();
    const errors: string[] = [];
    const base = await initializeGPU(abort.signal, (message: string) => errors.push(message));
    base.resources.destroy();
    const radius = 3.68, tau = 0.9, reynolds = 2;
    const speed = reynolds*((tau-0.5)/3)/(2*radius);
    const variants = [
      { name: 'baseline', grid: { nx: 64, ny: 32, nz: 32 }, x: 19.2 },
      { name: 'inlet farther', grid: { nx: 96, ny: 32, nz: 32 }, x: 51.2 },
      { name: 'outlet farther', grid: { nx: 128, ny: 32, nz: 32 }, x: 19.2 },
      { name: 'sides farther', grid: { nx: 64, ny: 64, nz: 64 }, x: 19.2 },
      { name: 'all farther', grid: { nx: 128, ny: 64, nz: 64 }, x: 51.2 },
    ];
    const cases = [];
    let expectedShape = '';
    try {
      for (const variant of variants) {
        const { grid } = variant;
        const center = [variant.x, grid.ny/2, grid.nz/2];
        const body = createObstacle(grid, 'sphere', radius, center);
        // Check exact discrete geometry, not just nominal diameter or cell count.
        const shape: string[] = [];
        for (let z = 0; z < grid.nz; z++) for (let y = 0; y < grid.ny; y++) for (let x = 0; x < grid.nx; x++) {
          if (body.solidFlags[x+grid.nx*(y+grid.ny*z)]) shape.push(`${x-Math.floor(center[0])},${y-center[1]},${z-center[2]}`);
        }
        if (!expectedShape) expectedShape = shape.join(';');
        if (shape.join(';') !== expectedShape) throw new Error('Boundary study changed the voxel sphere.');
        const memory = gridMemory(grid);
        const resources = allocateGrid(base.device, grid);
        const context = { ...base, grid, memory, resources };
        let solver;
        try {
          await initializeFluid(context, abort.signal);
          const field = new Float32Array(19*memory.cells);
          const cx = [0,1,-1,0,0,0,0,1,-1,1,-1,1,-1,1,-1,0,0,0,0];
          for (let i = 0; i < 19; i++) {
            const w = i === 0 ? 1/3 : i <= 6 ? 1/18 : 1/36;
            const cu = cx[i]*speed;
            field.fill(w*(1+3*cu+4.5*cu*cu-1.5*speed*speed), i*memory.cells, (i+1)*memory.cells);
          }
          resources.distributions.forEach((buffer: GPUBuffer) => base.device.queue.writeBuffer(buffer, 0, field));
          solver = await createSolver(context, abort.signal, { obstacle: 'sphere', sphereRadius: radius, sphereCenter: center, tau, targetSpeed: speed, rampSteps: 1 });
          const started = performance.now();
          const warmup = grid.ny === 64 ? 8192 : 4096;
          while (solver.stats.steps < warmup) await solver.step(16);
          const windows = [];
          let settled = false;
          for (let window = 0; window < 8; window++) {
            let cd = 0, lift = 0, side = 0, drag = 0, samples = 0;
            for (let batch = 0; batch < 64; batch++) {
              await solver.step(16);
              for (const sample of solver.lastForceSamples) { cd += sample.cd; lift += sample.lift; side += sample.side; drag += sample.drag; samples++; }
            }
            windows.push({ step: solver.stats.steps, cd: cd/samples, lift: lift/samples, side: side/samples, drag: drag/samples });
            if (windows.length >= 3) {
              const last = windows.slice(-3).map((value) => value.cd);
              if ((Math.max(...last)-Math.min(...last))/(last.reduce((a,b) => a+b, 0)/3) < 0.01) { settled = true; break; }
            }
          }
          const recent = windows.slice(-3);
          cases.push({ name: variant.name, grid, center, radius, solidCells: body.solidCells,
            inletClearance: center[0]-radius, outletClearance: grid.nx-center[0]-radius,
            sideClearance: grid.ny/2-radius, blockage: body.blockage,
            meanCd: recent.reduce((sum, value) => sum+value.cd, 0)/3,
            liftRatio: Math.max(...recent.map((value) => Math.abs(value.lift/value.drag))),
            sideRatio: Math.max(...recent.map((value) => Math.abs(value.side/value.drag))),
            densityRange: [solver.stats.densityMin, solver.stats.densityMax],
            settled, windows, steps: solver.stats.steps, wallMilliseconds: performance.now()-started,
            allocationEstimateBytes: memory.totalBytes+solver.scratchBytes });
        } finally { solver?.dispose(); resources.destroy(); }
      }
      if (errors.length) throw new Error(errors.join('; '));
      return { adapter: base.adapterName, browser: navigator.userAgent, reynolds, tau, speed, radius, cases,
        note: 'Same solid-cell pattern, lattice speed, viscosity and Re in every case. Time-window settling is diagnostic; this does not prove domain independence. No boundary formula was tuned to a reference.' };
    } finally { abort.abort(); }
  });
  const path = testInfo.outputPath('boundary-distance-study.json');
  await writeFile(path, JSON.stringify(report, null, 2));
  await testInfo.attach('boundary-distance-study', { path, contentType: 'application/json' });
  for (const result of report.cases) {
    expect(Number.isFinite(result.meanCd)).toBe(true);
    expect(result.meanCd).toBeGreaterThan(0);
    expect(result.liftRatio).toBeLessThan(0.01);
    expect(result.sideRatio).toBeLessThan(0.01);
  }
});
