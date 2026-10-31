/// <reference types="@webgpu/types" />
import { test, expect } from '@playwright/test';

for (const scenario of [
  { speed: 0.03, tau: 0.6, grid: { nx: 64, ny: 32, nz: 32 }, steps: 4096, mode: 'free-slip' },
  { speed: 0.06, tau: 0.9, grid: { nx: 32, ny: 16, nz: 16 }, steps: 2048, mode: 'free-slip' },
  { speed: 0.015, tau: 0.6, grid: { nx: 32, ny: 16, nz: 16 }, steps: 2048, mode: 'periodic-sides' },
]) {
  test(`empty ${scenario.mode} tunnel delivers ${scenario.speed} at tau=${scenario.tau}`, async ({ page }, testInfo) => {
    test.setTimeout(120000);
    await page.routeWebSocket('**', socket => socket.close());
    await page.goto('/');
    test.skip(!await page.evaluate(async () => Boolean(navigator.gpu && await navigator.gpu.requestAdapter())), 'Real GPU required');
    const result = await page.evaluate(async (scenario) => {
      const paths = ['/src/gpu/device.ts', '/src/sim/initialize.ts', '/src/sim/lbm.ts', '/src/render/slice.ts'];
      const [{ initializeGPU }, { initializeFluid }, { createSolver }, { readSlice }] = await Promise.all(paths.map(path => import(/* @vite-ignore */ path)));
      const abort = new AbortController(), errors: string[] = [];
      const context = await initializeGPU(abort.signal, (m: string) => errors.push(m), scenario.grid);
      let solver;
      try {
        await initializeFluid(context, abort.signal);
        solver = await createSolver(context, abort.signal, { obstacle: 'none', targetSpeed: scenario.speed, tau: scenario.tau, rampSteps: 300, boundaryMode: scenario.mode });
        while (solver.stats.steps < scenario.steps) await solver.step(16);
        let maxRelativeError = 0, maxTransverseSpeed = 0, pressureMin = Infinity, pressureMax = -Infinity;
        // Include transverse wall cells and two distinct Z planes; the complete
        // XY slice catches interior underdelivery hidden by an exact inlet value.
        for (const z of [0, Math.floor(scenario.grid.nz/2)]) {
          const field = await readSlice(context, z, abort.signal);
          for (let i = 0; i < field.length; i += 4) {
            maxRelativeError = Math.max(maxRelativeError, Math.abs(field[i]/scenario.speed-1));
            maxTransverseSpeed = Math.max(maxTransverseSpeed, Math.hypot(field[i+1], field[i+2]));
            pressureMin = Math.min(pressureMin, field[i+3]); pressureMax = Math.max(pressureMax, field[i+3]);
          }
        }
        if (errors.length) throw new Error(errors.join('; '));
        return { maxRelativeError, maxTransverseSpeed, pressureSpread: pressureMax-pressureMin, stats: solver.stats };
      } finally { solver?.dispose(); abort.abort(); }
    }, scenario);
    await testInfo.attach('delivered-flow', { body: JSON.stringify({ scenario, result }, null, 2), contentType: 'application/json' });
    expect(result.maxRelativeError).toBeLessThan(0.01);
    expect(result.maxTransverseSpeed).toBeLessThan(1e-5);
    expect(result.pressureSpread).toBeLessThan(1e-4);
    expect(result.stats.invalidCells).toBe(0);
    expect(result.stats.densityMin).toBeGreaterThan(0.9);
    expect(result.stats.densityMax).toBeLessThan(1.15);
  });
}
