/// <reference types="@webgpu/types" />
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { cpuStep, directions, initialField } from './cpu_reference/d3q19';
import { DEFAULT_SETTINGS, inletSpeed, validateSettings } from '../src/sim/settings';
import type { BoundaryMode } from '../src/sim/settings';

async function requireGPU(page: Page) {
  await page.goto('/');
  const supported = await page.evaluate(async () => Boolean(navigator.gpu && await navigator.gpu.requestAdapter()));
  test.skip(!supported, 'A real WebGPU adapter is required for solver validation.');
  await expect(page.getByRole('status')).toContainText('GPU ready');
}

test('inlet ramp and parameter guards', () => {
  expect(inletSpeed(0, DEFAULT_SETTINGS)).toBe(0);
  expect(inletSpeed(150, DEFAULT_SETTINGS)).toBeCloseTo(0.015);
  expect(inletSpeed(300, DEFAULT_SETTINGS)).toBeCloseTo(0.03);
  expect(inletSpeed(600, DEFAULT_SETTINGS)).toBeCloseTo(0.03);
  for (const targetSpeed of [NaN, Infinity, -1, 0.1]) expect(() => validateSettings({ ...DEFAULT_SETTINGS, targetSpeed })).toThrow();
  expect(() => validateSettings({ ...DEFAULT_SETTINGS, tau: 0.5 })).toThrow();
  expect(() => validateSettings({ ...DEFAULT_SETTINGS, rampSteps: 0 })).toThrow();
});

for (const scenario of [
  { mode: 'free-slip', uniform: false }, { mode: 'periodic-sides', uniform: false },
  { mode: 'periodic', uniform: false }, { mode: 'free-slip', uniform: true },
] as { mode: BoundaryMode; uniform: boolean }[]) {
  const { mode, uniform } = scenario;
  test(`GPU matches CPU reference for ${uniform ? 'uniform' : 'nonuniform'} flow with ${mode} boundaries`, async ({ page }) => {
    await requireGPU(page);
    const grid = { nx: 12, ny: 7, nz: 5 };
    const settings = { ...DEFAULT_SETTINGS, boundaryMode: mode, rampSteps: uniform ? 1 : 20, targetSpeed: uniform ? 0.02 : 0.03 };
    const initial = initialField(grid, uniform);
    let expected = initial;
    for (let step = 1; step <= 23; step++) expected = cpuStep(expected, grid, settings, step);
    const result = await page.evaluate(async ({ grid, settings, initial }) => {
      const paths = ['/src/gpu/device.ts', '/src/gpu/buffers.ts', '/src/gpu/grid.ts', '/src/sim/initialize.ts', '/src/sim/lbm.ts'];
      const [{ initializeGPU }, { allocateGrid }, { gridMemory }, { initializeFluid }, { createSolver }] = await Promise.all(paths.map((path) => import(/* @vite-ignore */ path)));
      const abort = new AbortController();
      let fatal = '';
      const base = await initializeGPU(abort.signal, (message: string) => { fatal = message; });
      const resources = allocateGrid(base.device, grid);
      const context = { ...base, resources, grid, memory: gridMemory(grid) };
      let readback: GPUBuffer | undefined;
      try {
        await initializeFluid(context, abort.signal);
        for (const buffer of resources.distributions) base.device.queue.writeBuffer(buffer, 0, new Float32Array(initial));
        const solver = await createSolver(context, abort.signal, settings);
        // Different batch sizes and odd totals catch uniform overwrite and ping-pong bugs.
        await solver.step(7);
        const stats = await solver.step(16);
        const textureOffset = Math.ceil(context.memory.distributionBytes / 256) * 256;
        const bytesPerRow = Math.ceil(grid.nx*8/256)*256;
        const textureBytes = bytesPerRow*grid.ny*grid.nz;
        readback = base.device.createBuffer({ size: textureOffset+textureBytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
        const encoder = base.device.createCommandEncoder();
        encoder.copyBufferToBuffer(solver.currentBuffer, 0, readback, 0, context.memory.distributionBytes);
        encoder.copyTextureToBuffer({ texture: resources.field }, { buffer: readback, offset: textureOffset, bytesPerRow, rowsPerImage: grid.ny },
          { width: grid.nx, height: grid.ny, depthOrArrayLayers: grid.nz });
        base.device.queue.submit([encoder.finish()]);
        await readback!.mapAsync(GPUMapMode.READ);
        const mapped = readback!.getMappedRange();
        const values = Array.from(new Float32Array(mapped, 0, context.memory.distributionBytes/4));
        const field = Array.from(new Uint16Array(mapped, textureOffset, textureBytes/2));
        readback!.unmap();
        if (fatal) throw new Error(fatal);
        return { values, stats, field, bytesPerRow };
      } finally { readback?.destroy(); resources.destroy(); abort.abort(); }
    }, { grid, settings, initial: Array.from(initial) });
    let maxError = 0;
    result.values.forEach((value, i) => { maxError = Math.max(maxError, Math.abs(value-expected[i])); });
    expect(maxError).toBeLessThan(1e-5);
    expect(result.stats.steps).toBe(23);
    expect(result.stats.invalidCells).toBe(0);
    expect(result.stats.maxSpeed).toBeLessThan(0.1);
    const halfFloat = (bits: number) => {
      const sign = bits & 0x8000 ? -1 : 1;
      const exponent = (bits >> 10) & 31;
      const fraction = bits & 1023;
      return sign * (exponent === 0 ? fraction * 2**-24 : (1+fraction/1024) * 2**(exponent-15));
    };
    let minDensity = Infinity;
    let maxDensity = -Infinity;
    let maxSpeed = 0;
    const n = grid.nx*grid.ny*grid.nz;
    for (let z = 0; z < grid.nz; z++) for (let y = 0; y < grid.ny; y++) for (let x = 0; x < grid.nx; x++) {
      const node = x+grid.nx*(y+grid.ny*z);
      let rho = 0;
      const momentum = [0,0,0];
      for (let i = 0; i < 19; i++) {
        const value = result.values[i*n+node];
        rho += value;
        directions[i].forEach((direction, axis) => { momentum[axis] += value*direction; });
      }
      const velocity = momentum.map((value) => value/rho);
      minDensity = Math.min(minDensity, rho);
      maxDensity = Math.max(maxDensity, rho);
      maxSpeed = Math.max(maxSpeed, Math.hypot(...velocity));
      const texel = (z*grid.ny+y)*result.bytesPerRow/2+x*4;
      for (let axis = 0; axis < 3; axis++) expect(Math.abs(halfFloat(result.field[texel+axis])-velocity[axis])).toBeLessThan(2e-5);
      const pressureSignal = (rho-1)*1000;
      // rgba16float quantization grows with signal magnitude; allow one relative
      // f16 precision unit plus f32 density-recovery roundoff after scaling.
      expect(Math.abs(halfFloat(result.field[texel+3])-pressureSignal)).toBeLessThan(Math.abs(pressureSignal)/1024+0.001);
    }
    expect(Math.abs(result.stats.densityMin-minDensity)).toBeLessThan(1e-6);
    expect(Math.abs(result.stats.densityMax-maxDensity)).toBeLessThan(1e-6);
    expect(Math.abs(result.stats.maxSpeed-maxSpeed)).toBeLessThan(1e-6);
    if (uniform) {
      let drift = 0;
      result.values.forEach((value, i) => { drift = Math.max(drift, Math.abs(value-initial[i])); });
      expect(drift).toBeLessThan(1e-6);
      expect(result.stats.densityMin).toBeCloseTo(1, 5);
      expect(result.stats.densityMax).toBeCloseTo(1, 5);
      expect(result.stats.maxSpeed).toBeCloseTo(0.02, 5);
    }
    if (mode === 'periodic') {
      const massBefore = initial.reduce((sum, value) => sum+value, 0);
      const massAfter = result.values.reduce((sum, value) => sum+value, 0);
      expect(Math.abs(massAfter-massBefore)/massBefore).toBeLessThan(1e-5);
    }
  });
}

test('rest stays at rest, inlet drives flow, and reset restores both buffers', async ({ page }) => {
  test.setTimeout(90000);
  await requireGPU(page);
  const result = await page.evaluate(async () => {
    const paths = ['/src/gpu/device.ts', '/src/gpu/buffers.ts', '/src/gpu/grid.ts', '/src/sim/initialize.ts', '/src/sim/lbm.ts'];
    const [{ initializeGPU }, { allocateGrid }, { gridMemory }, { initializeFluid }, { createSolver }] = await Promise.all(paths.map((path) => import(/* @vite-ignore */ path)));
    const abort = new AbortController();
    let fatal = '';
    const base = await initializeGPU(abort.signal, (message: string) => { fatal = message; });
    const grid = { nx: 24, ny: 8, nz: 8 };
    const resources = allocateGrid(base.device, grid);
    const context = { ...base, grid, resources, memory: gridMemory(grid) };
    try {
      await initializeFluid(context, abort.signal);
      const rest = await createSolver(context, abort.signal, { targetSpeed: 0 });
      for (let i = 0; i < 10; i++) await rest.step(16);
      const resting = rest.stats;
      rest.dispose();
      const solver = await createSolver(context, abort.signal, { rampSteps: 100 });
      for (let i = 0; i < 80; i++) await solver.step(16);
      const flowing = solver.stats;
      const readback = base.device.createBuffer({ size: context.memory.distributionBytes * 2,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      let minStreamwiseVelocity = Infinity;
      let resetError = 0;
      let reset;
      try {
        const encoder = base.device.createCommandEncoder();
        encoder.copyBufferToBuffer(solver.currentBuffer, 0, readback, 0, context.memory.distributionBytes);
        base.device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const values = new Float32Array(readback.getMappedRange());
        const n = context.memory.cells;
        const cx = [0,1,-1,0,0,0,0,1,-1,1,-1,1,-1,1,-1,0,0,0,0];
        for (let node = 0; node < n; node++) {
          let density = 0;
          let momentum = 0;
          for (let i = 0; i < 19; i++) { density += values[i*n+node]; momentum += values[i*n+node]*cx[i]; }
          minStreamwiseVelocity = Math.min(minStreamwiseVelocity, momentum/density);
        }
        readback.unmap();
        reset = await solver.reset();
        const check = base.device.createCommandEncoder();
        resources.distributions.forEach((buffer: GPUBuffer, state: number) => {
          check.copyBufferToBuffer(buffer, 0, readback, state*context.memory.distributionBytes, context.memory.distributionBytes);
        });
        base.device.queue.submit([check.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const resetValues = new Float32Array(readback.getMappedRange());
        for (let i = 0; i < resetValues.length; i++) {
          const direction = Math.floor(i/n)%19;
          const expected = direction === 0 ? 1/3 : direction <= 6 ? 1/18 : 1/36;
          resetError = Math.max(resetError, Math.abs(resetValues[i]-expected));
        }
        readback.unmap();
      } finally { readback.destroy(); }
      if (fatal) throw new Error(fatal);
      return { resting, flowing, reset, resetError, minStreamwiseVelocity };
    } finally { resources.destroy(); abort.abort(); }
  });
  expect(result.resting.maxSpeed).toBeLessThan(1e-6);
  expect(result.resting.densityMin).toBeCloseTo(1, 5);
  expect(result.resting.densityMax).toBeCloseTo(1, 5);
  expect(result.flowing.inletSpeed).toBeCloseTo(0.03);
  expect(result.flowing.densityMin).toBeGreaterThan(0.95);
  expect(result.flowing.densityMax).toBeLessThan(1.05);
  expect(result.flowing.maxSpeed).toBeGreaterThan(0.02);
  expect(result.flowing.maxSpeed).toBeLessThan(0.05);
  expect(result.reset.steps).toBe(0);
  expect(result.reset.maxSpeed).toBe(0);
  expect(result.resetError).toBeLessThan(1e-6);
  // Startup can still be transient: verify propagation everywhere, not a
  // premature claim that the whole domain has converged to the inlet velocity.
  expect(result.minStreamwiseVelocity).toBeGreaterThan(0.01);
});

test('unstable data stops stepping until a successful reset', async ({ page }) => {
  await requireGPU(page);
  const result = await page.evaluate(async () => {
    const paths = ['/src/gpu/device.ts', '/src/gpu/buffers.ts', '/src/gpu/grid.ts', '/src/sim/initialize.ts', '/src/sim/lbm.ts'];
    const [{ initializeGPU }, { allocateGrid }, { gridMemory }, { initializeFluid }, { createSolver }] = await Promise.all(paths.map((path) => import(/* @vite-ignore */ path)));
    const abort = new AbortController();
    const base = await initializeGPU(abort.signal, (message: string) => { throw new Error(message); });
    const grid = { nx: 12, ny: 7, nz: 5 };
    const resources = allocateGrid(base.device, grid);
    const context = { ...base, grid, resources, memory: gridMemory(grid) };
    try {
      await initializeFluid(context, abort.signal);
      const solver = await createSolver(context, abort.signal, { targetSpeed: 0 });
      // Finite but unphysical density, so the test does not depend on NaN behavior.
      base.device.queue.writeBuffer(solver.currentBuffer, 0, new Float32Array(context.memory.cells).fill(2));
      let unstable = '';
      let locked = '';
      try { await solver.step(); } catch (error) { unstable = String(error); }
      try { await solver.step(); } catch (error) { locked = String(error); }
      await solver.reset();
      const recovered = await solver.step();
      return { unstable, locked, recovered };
    } finally { resources.destroy(); abort.abort(); }
  });
  expect(result.unstable).toContain('Simulation unstable');
  expect(result.locked).toContain('Reset the fluid');
  expect(result.recovered.steps).toBe(1);
  expect(result.recovered.maxSpeed).toBeLessThan(1e-6);
});

test('real UI supports stepping, running, pausing, reset, and background pause', async ({ page }) => {
  test.setTimeout(60000);
  await requireGPU(page);
  const panel = page.getByRole('region', { name: 'Empty-tunnel airflow' });
  await panel.getByRole('button', { name: 'Step once' }).click();
  await expect(panel.locator('dt', { hasText: 'Simulation steps' }).locator('..').locator('dd')).toHaveText('1');
  await panel.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Step once' })).toBeEnabled();
  const pausedSteps = await panel.locator('dt', { hasText: 'Simulation steps' }).locator('..').locator('dd').textContent();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(panel.locator('dt', { hasText: 'Simulation steps' }).locator('..').locator('dd')).toHaveText(pausedSteps!);
  await panel.getByRole('button', { name: 'Run', exact: true }).click();
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(panel.getByRole('button', { name: 'Run', exact: true })).toBeVisible();
  await page.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, value: false }));
  await expect(panel.getByRole('button', { name: 'Reset fluid' })).toBeEnabled();
  await panel.getByRole('button', { name: 'Reset fluid' }).click();
  await expect(panel.locator('dt', { hasText: 'Simulation steps' }).locator('..').locator('dd')).toHaveText('0');
  await expect(panel.getByLabel('Target inlet speed:')).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/solver-controls.png', fullPage: true });
});
