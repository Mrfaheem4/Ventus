/// <reference types="@webgpu/types" />
import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { createObstacle, obstacleSlice } from '../src/geometry/sphere';
import { colorizeSlice } from '../src/render/slice';
import { cpuStep, initialField } from './cpu_reference/d3q19';
import { DEFAULT_SETTINGS } from '../src/sim/settings';

test('sphere mask has an interior, correct cell centers, transverse symmetry and clearance', () => {
  for (const grid of [{ nx: 64, ny: 32, nz: 32 }, { nx: 32, ny: 16, nz: 16 }, { nx: 16, ny: 8, nz: 8 }]) {
    const body = createObstacle(grid, 'sphere');
    const sphere = body.sphere!;
    expect(body.solidCells).toBeGreaterThan(0);
    let count = 0;
    for (let z = 0; z < grid.nz; z++) for (let y = 0; y < grid.ny; y++) for (let x = 0; x < grid.nx; x++) {
      const flag = body.solidFlags[x+grid.nx*(y+grid.ny*z)];
      const inside = Math.hypot(x+0.5-sphere.center[0], y+0.5-sphere.center[1], z+0.5-sphere.center[2]) <= sphere.radius;
      if (Boolean(flag) !== inside) throw new Error('Sphere classification does not match cell-center geometry.');
      if (flag !== body.solidFlags[x+grid.nx*((grid.ny-1-y)+grid.ny*z)]
        || flag !== body.solidFlags[x+grid.nx*(y+grid.ny*(grid.nz-1-z))]) throw new Error('Sphere is not transversely symmetric.');
      if (flag) { count++; if (x <= 0 || x >= grid.nx-1) throw new Error('Sphere touches an open boundary.'); }
    }
    expect(count).toBe(body.solidCells);
    expect(body.blockage).toBeLessThanOrEqual(0.063); // Small fallback grids quantize area strongly.
    expect(createObstacle(grid).solidCells).toBe(0);
  }
  expect(createObstacle({ nx: 64, ny: 32, nz: 32 }, 'sphere').blockage).toBeLessThan(0.05);
});

test('solid slice cells are transparent and excluded from fluid ranges', () => {
  const values = new Float32Array([99,0,0,99, 0.02,0,0,0.001]);
  const colors = colorizeSlice(values, 'speed', 0.03, new Uint32Array([1,0]));
  expect(Array.from(colors.pixels.slice(0,4))).toEqual([0,0,0,0]);
  expect(colors.min).toBeCloseTo(0.02);
  expect(colors.max).toBeCloseTo(0.02);
  const grid = { nx: 64, ny: 32, nz: 32 };
  expect(obstacleSlice(createObstacle(grid, 'sphere'), grid, 16).some((flag) => flag === 1)).toBe(true);
});

for (const boundaryMode of ['free-slip', 'periodic'] as const) {
  test(`sphere bounce-back matches CPU reference with ${boundaryMode} boundaries`, async ({ page }) => {
    test.setTimeout(90000);
    await page.goto('/');
    const supported = await page.evaluate(async () => Boolean(navigator.gpu && await navigator.gpu.requestAdapter()));
    test.skip(!supported, 'Real WebGPU adapter required.');
    const grid = { nx: 24, ny: 16, nz: 16 };
    const body = createObstacle(grid, 'sphere');
    const initial = initialField(grid);
    const settings = { ...DEFAULT_SETTINGS, boundaryMode, obstacle: 'sphere' as const };
    for (let i = 0; i < initial.length; i++) if (body.solidFlags[i % body.solidFlags.length]) initial[i] = 7;
    let expected = initial;
    for (let step = 1; step <= 23; step++) expected = cpuStep(expected, grid, settings, step, body.solidFlags);
    const result = await page.evaluate(async ({ grid, initial, settings }) => {
      const paths = ['/src/gpu/device.ts', '/src/gpu/buffers.ts', '/src/gpu/grid.ts', '/src/sim/initialize.ts', '/src/sim/lbm.ts'];
      const [{ initializeGPU }, { allocateGrid }, { gridMemory }, { initializeFluid }, { createSolver }] = await Promise.all(paths.map((path) => import(/* @vite-ignore */ path)));
      const abort = new AbortController();
      const errors: string[] = [];
      const base = await initializeGPU(abort.signal, (message: string) => errors.push(message));
      const resources = allocateGrid(base.device, grid);
      const context = { ...base, grid, resources, memory: gridMemory(grid) };
      const readback = base.device.createBuffer({ size: context.memory.distributionBytes*2, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      try {
        await initializeFluid(context, abort.signal);
        resources.distributions.forEach((buffer: GPUBuffer) => base.device.queue.writeBuffer(buffer, 0, new Float32Array(initial)));
        const solver = await createSolver(context, abort.signal, settings);
        await solver.step(7);
        const stats = await solver.step(16);
        const encoder = base.device.createCommandEncoder();
        encoder.copyBufferToBuffer(solver.currentBuffer, 0, readback, 0, context.memory.distributionBytes);
        const other = resources.distributions.find((buffer: GPUBuffer) => buffer !== solver.currentBuffer);
        encoder.copyBufferToBuffer(other, 0, readback, context.memory.distributionBytes, context.memory.distributionBytes);
        base.device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const mapped = new Float32Array(readback.getMappedRange());
        const values = Array.from(mapped.subarray(0, context.memory.distributionBytes/4));
        let maxSolid = 0;
        for (let state = 0; state < 2; state++) for (let i = 0; i < 19; i++) for (let node = 0; node < context.memory.cells; node++) {
          if (solver.obstacle.solidFlags[node]) maxSolid = Math.max(maxSolid, Math.abs(mapped[(state*19+i)*context.memory.cells+node]));
        }
        readback.unmap();
        await solver.reset();
        const resetEncoder = base.device.createCommandEncoder();
        resources.distributions.forEach((buffer: GPUBuffer, state: number) => {
          resetEncoder.copyBufferToBuffer(buffer, 0, readback, state*context.memory.distributionBytes, context.memory.distributionBytes);
        });
        base.device.queue.submit([resetEncoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const resetValues = new Float32Array(readback.getMappedRange());
        let resetError = 0;
        for (let state = 0; state < 2; state++) for (let i = 0; i < 19; i++) for (let node = 0; node < context.memory.cells; node++) {
          const expected = solver.obstacle.solidFlags[node] ? 0 : i === 0 ? 1/3 : i <= 6 ? 1/18 : 1/36;
          resetError = Math.max(resetError, Math.abs(resetValues[(state*19+i)*context.memory.cells+node]-expected));
        }
        readback.unmap();
        if (errors.length) throw new Error(errors.join('; '));
        return { values, maxSolid, stats, resetError };
      } finally { readback.destroy(); resources.destroy(); abort.abort(); }
    }, { grid, initial: Array.from(initial), settings });
    let error = 0;
    result.values.forEach((value, i) => { error = Math.max(error, Math.abs(value-expected[i])); });
    expect(error).toBeLessThan(1e-5);
    expect(result.maxSolid).toBe(0);
    expect(result.resetError).toBeLessThan(1e-6);
    expect(result.stats.invalidCells).toBe(0);
    if (boundaryMode === 'periodic') {
      const massBefore = initial.reduce((sum, value, i) => sum+(body.solidFlags[i % body.solidFlags.length] ? 0 : value), 0);
      const massAfter = result.values.reduce((sum, value) => sum+value, 0);
      expect(Math.abs(massAfter-massBefore)/massBefore).toBeLessThan(1e-5);
    }
  });
}

test('sphere changes actual flow and pressure relative to an empty tunnel', async ({ page }, testInfo) => {
  test.setTimeout(180000);
  await page.goto('/');
  const supported = await page.evaluate(async () => Boolean(navigator.gpu && await navigator.gpu.requestAdapter()));
  test.skip(!supported, 'Real WebGPU adapter required.');
  const result = await page.evaluate(async () => {
    const paths = ['/src/gpu/device.ts', '/src/sim/initialize.ts', '/src/sim/lbm.ts', '/src/geometry/sphere.ts'];
    const [{ initializeGPU }, { initializeFluid }, { createSolver }, { createObstacle }] = await Promise.all(paths.map((path) => import(/* @vite-ignore */ path)));
    const abort = new AbortController();
    const errors: string[] = [];
    const context = await initializeGPU(abort.signal, (message: string) => errors.push(message));
    const { device, grid, memory } = context;
    const shape = createObstacle(grid, 'sphere');
    const readback = device.createBuffer({ size: memory.distributionBytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const results = [];
    try {
      for (const obstacle of ['none', 'sphere']) {
        await initializeFluid(context, abort.signal);
        if (obstacle === 'sphere') {
          const resting = await createSolver(context, abort.signal, { obstacle, targetSpeed: 0 });
          for (let i = 0; i < 4; i++) await resting.step(16);
          if (resting.stats.maxSpeed > 1e-6 || Math.abs(resting.stats.densityMin-1) > 1e-5
            || Math.abs(resting.stats.densityMax-1) > 1e-5) throw new Error('Sphere created spurious flow at rest.');
          resting.dispose();
          await initializeFluid(context, abort.signal);
        }
        const solver = await createSolver(context, abort.signal, { obstacle });
        for (let i = 0; i < 75; i++) await solver.step(16);
        const encoder = device.createCommandEncoder();
        encoder.copyBufferToBuffer(solver.currentBuffer, 0, readback, 0, memory.distributionBytes);
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const values = new Float32Array(readback.getMappedRange());
        const cx = [0,1,-1,0,0,0,0,1,-1,1,-1,1,-1,1,-1,0,0,0,0];
        const cy = [0,0,0,1,-1,0,0,1,-1,-1,1,0,0,0,0,1,-1,1,-1];
        function probe(x: number, y: number, z: number) {
          const node = x+grid.nx*(y+grid.ny*z);
          let rho = 0, mx = 0, my = 0;
          for (let i = 0; i < 19; i++) { const f = values[i*memory.cells+node]; rho += f; mx += f*cx[i]; my += f*cy[i]; }
          return { ux: mx/rho, uy: my/rho, pressure: (rho-1)/3 };
        }
        const [x,y,z] = shape.sphere.center;
        const r = shape.sphere.radius;
        const upstream = probe(Math.floor(x-r-2), Math.floor(y), Math.floor(z));
        const upstreamBelow = probe(Math.floor(x-r-2), Math.floor(y)-1, Math.floor(z));
        const wake = probe(Math.ceil(x+r+2), Math.floor(y), Math.floor(z));
        const bypass = probe(Math.floor(x), Math.ceil(y+r+2), Math.floor(z));
        readback.unmap();
        const stats = solver.stats;
        const reset = await solver.reset();
        results.push({ obstacle, upstream, upstreamBelow, wake, bypass, stats, reset });
        solver.dispose();
      }
      if (errors.length) throw new Error(errors.join('; '));
      return results;
    } finally { readback.destroy(); abort.abort(); }
  });
  const measurements = testInfo.outputPath('sphere-versus-empty-probes.json');
  await writeFile(measurements, JSON.stringify(result, null, 2));
  await testInfo.attach('sphere-versus-empty-probes', { path: measurements, contentType: 'application/json' });
  const [empty, sphere] = result;
  expect(sphere.upstream.ux).toBeLessThan(empty.upstream.ux*0.9);
  expect(sphere.wake.ux).toBeLessThan(empty.wake.ux*0.9);
  // At this low Re, viscosity slows even the selected side probe. Verify
  // actual transverse diversion instead of assuming inviscid side acceleration.
  expect(sphere.upstream.uy).toBeGreaterThan(0.0001);
  expect(sphere.upstreamBelow.uy).toBeLessThan(-0.0001);
  expect(Math.abs(sphere.upstream.uy+sphere.upstreamBelow.uy)).toBeLessThan(1e-5);
  expect(sphere.bypass.ux).toBeGreaterThan(sphere.wake.ux);
  expect(sphere.upstream.pressure).toBeGreaterThan(sphere.wake.pressure);
  expect(sphere.reset.steps).toBe(0);
});

test('sphere preview, voxel view, optional slice and scene reset work in the UI', async ({ page }) => {
  test.setTimeout(90000);
  await page.goto('/');
  const supported = await page.evaluate(async () => Boolean(navigator.gpu && await navigator.gpu.requestAdapter()));
  test.skip(!supported, 'Real WebGPU adapter required.');
  await expect(page.getByLabel('Test scene')).toHaveValue('sphere');
  const viewer = page.getByRole('region', { name: '3D flow view' });
  const canvas = viewer.getByRole('img');
  await expect(viewer.getByTestId('slice-range')).toContainText('Slice range:');
  await viewer.getByLabel('Show slice', { exact: true }).uncheck();
  const smooth = await canvas.screenshot();
  await viewer.getByLabel('Show voxel body').check();
  expect((await canvas.screenshot()).equals(smooth)).toBe(false);
  await viewer.getByLabel('Show slice', { exact: true }).check();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  const stepText = page.locator('dt', { hasText: 'Simulation steps' }).locator('..').locator('dd');
  await expect.poll(async () => Number((await stepText.textContent())!.replaceAll(',', ''))).toBeGreaterThanOrEqual(300);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Step once' })).toBeEnabled();
  await viewer.screenshot({ path: 'test-results/sphere-flow.png' });
  await page.getByLabel('Test scene').selectOption('none');
  await expect(stepText).toHaveText('0');
  await expect(viewer.getByLabel('Show voxel body')).toHaveCount(0);
  await page.getByRole('button', { name: 'Step once' }).click();
  await expect(stepText).toHaveText('1');
  await expect(page.getByRole('alert')).toHaveCount(0);
});
