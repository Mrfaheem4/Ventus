/// <reference types="@webgpu/types" />
import { expect, test } from '@playwright/test';
import { colorizeSlice, halfToFloat } from '../src/render/slice';

test('half-float decoding and labeled color scales preserve their meaning', () => {
  expect(halfToFloat(0x3c00)).toBe(1);
  expect(halfToFloat(0xc000)).toBe(-2);
  expect(halfToFloat(0x0001)).toBe(2 ** -24);
  expect(halfToFloat(0x7c00)).toBe(Infinity);
  expect(halfToFloat(0x7e00)).toBeNaN();
  const values = new Float32Array([0,0,0,-0.02, 0.03,0,0,0, 0.1,0,0,0.02, NaN,0,0,NaN]);
  const speed = colorizeSlice(values, 'speed', 0.03);
  expect(Array.from(speed.pixels.slice(0, 4))).toEqual([68,1,84,255]);
  expect(Array.from(speed.pixels.slice(4, 8))).toEqual([253,231,37,255]);
  expect(Array.from(speed.pixels.slice(8, 12))).toEqual([253,231,37,255]);
  expect(speed.max).toBeCloseTo(0.1);
  expect(speed.invalidCells).toBe(1);
  const pressure = colorizeSlice(values, 'pressure', 0.02);
  expect(Array.from(pressure.pixels.slice(4, 8))).toEqual([221,221,221,255]);
  expect(Array.from(pressure.pixels.slice(12, 16))).toEqual([255,0,255,255]);
  expect(() => colorizeSlice(values, 'speed', 0)).toThrow();
});

test('real GPU slice readback selects Z, removes row padding and converts pressure', async ({ page }) => {
  await page.goto('/');
  const supported = await page.evaluate(async () => Boolean(navigator.gpu && await navigator.gpu.requestAdapter()));
  test.skip(!supported, 'Real WebGPU adapter required for slice readback.');
  const result = await page.evaluate(async () => {
    const paths = ['/src/gpu/device.ts', '/src/gpu/buffers.ts', '/src/gpu/grid.ts', '/src/render/slice.ts'];
    const [{ initializeGPU }, { allocateGrid }, { gridMemory }, { readSlice }] = await Promise.all(paths.map((path) => import(/* @vite-ignore */ path)));
    const abort = new AbortController();
    const errors: string[] = [];
    const base = await initializeGPU(abort.signal, (message: string) => errors.push(message));
    const grid = { nx: 13, ny: 7, nz: 5 };
    const resources = allocateGrid(base.device, grid);
    const context = { ...base, grid, resources, memory: gridMemory(grid) };
    try {
      const data = new Uint16Array(context.memory.cells*4);
      for (let z = 0; z < grid.nz; z++) for (let y = 0; y < grid.ny; y++) for (let x = 0; x < grid.nx; x++) {
        const offset = (x+grid.nx*(y+grid.ny*z))*4;
        data[offset] = z % 2 ? 0x2c00 : 0x2800; // 1/16 or 1/32
        data[offset+1] = y % 2 ? 0x2400 : 0; // 1/64 or zero
        data[offset+3] = 0x4200; // Scaled density deviation = 3; pressure variation = 0.001
      }
      base.device.queue.writeTexture({ texture: resources.field }, data,
        { bytesPerRow: grid.nx*8, rowsPerImage: grid.ny },
        { width: grid.nx, height: grid.ny, depthOrArrayLayers: grid.nz });
      const even = Array.from(await readSlice(context, 2, abort.signal));
      const odd = Array.from(await readSlice(context, 3, abort.signal));
      let invalid = false, cancelled = false;
      try { await readSlice(context, 5, abort.signal); } catch { invalid = true; }
      const cancelledSignal = new AbortController();
      cancelledSignal.abort();
      try { await readSlice(context, 0, cancelledSignal.signal); } catch { cancelled = true; }
      if (errors.length) throw new Error(errors.join('; '));
      return { even, odd, invalid, cancelled };
    } finally { resources.destroy(); abort.abort(); }
  });
  expect(result.even).toHaveLength(13*7*4);
  for (let y = 0; y < 7; y++) for (let x = 0; x < 13; x++) {
    const offset = (x+13*y)*4;
    expect(result.even[offset]).toBe(1/32);
    expect(result.odd[offset]).toBe(1/16);
    expect(result.even[offset+1]).toBe(y % 2 ? 1/64 : 0);
    expect(result.even[offset+3]).toBeCloseTo(0.001, 7);
  }
  expect(result.invalid).toBe(true);
  expect(result.cancelled).toBe(true);
});

test('Three.js viewer orbits, shows live flow, switches slices and cleans up on reinitialization', async ({ page }) => {
  test.setTimeout(90000);
  await page.goto('/');
  const supported = await page.evaluate(async () => Boolean(navigator.gpu && await navigator.gpu.requestAdapter()));
  test.skip(!supported, 'Real WebGPU adapter required for live viewer.');
  await page.getByLabel('Test scene').selectOption('none');
  await expect(page.getByRole('button', { name: 'Step once' })).toBeEnabled();
  const viewer = page.getByRole('region', { name: '3D flow view' });
  const canvas = viewer.getByRole('img', { name: 'Orbitable 3D wind tunnel with smoke and an optional flow slice' });
  await expect(canvas).toBeVisible();
  await viewer.getByLabel('Show slice', { exact: true }).check();
  await expect(viewer.getByTestId('slice-range')).toContainText('Slice range:');
  const before = await canvas.screenshot();
  const bounds = (await canvas.boundingBox())!;
  await page.mouse.move(bounds.x+bounds.width/2, bounds.y+bounds.height/2);
  await page.mouse.down();
  await page.mouse.move(bounds.x+bounds.width/2+80, bounds.y+bounds.height/2+30, { steps: 8 });
  await page.mouse.up();
  expect((await canvas.screenshot()).equals(before)).toBe(false);
  await viewer.getByRole('button', { name: 'Reset camera' }).click();
  await viewer.getByLabel('Show slice',{ exact: true }).check();
  await viewer.getByLabel('Show cell grid').check();
  await viewer.getByLabel('Color by').selectOption('pressure');
  await expect(viewer.getByLabel('Pressure variation color scale')).toBeVisible();
  await viewer.getByLabel('XY slice position:').focus();
  await viewer.getByLabel('XY slice position:').press('Home');
  await expect(viewer.getByLabel('XY slice position:')).toHaveValue('0');
  await viewer.getByLabel('Color by').selectOption('speed');
  const panel = page.getByRole('region', { name: 'Wind-tunnel airflow' });
  await panel.getByRole('button', { name: 'Run', exact: true }).click();
  const stepText = panel.locator('dt', { hasText: 'Simulation steps' }).locator('..').locator('dd');
  await expect.poll(async () => Number((await stepText.textContent())!.replaceAll(',', ''))).toBeGreaterThanOrEqual(120);
  await panel.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Step once' })).toBeEnabled();
  await expect.poll(async () => {
    const text = await viewer.getByTestId('slice-range').textContent();
    return Number(text?.match(/ to ([\d.eE+-]+)/)?.[1] ?? 0);
  }).toBeGreaterThan(0.005);
  await viewer.screenshot({ path: 'test-results/flow-viewer.png' });
  await panel.getByRole('button', { name: 'Reset fluid' }).click();
  await expect(viewer.getByTestId('slice-range')).toHaveText('Slice range: 0.000e+0 to 0.000e+0');
  await page.getByRole('button', { name: 'Reinitialize GPU' }).click();
  await expect(page.getByRole('status')).toContainText('GPU ready');
  await expect(canvas).toHaveCount(1);
  await viewer.getByLabel('Show slice', { exact: true }).check();
  await expect(viewer.getByTestId('slice-range')).toContainText('Slice range:');
  await expect(viewer.getByText(/^3D view:/)).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await viewer.screenshot({ path: 'test-results/flow-viewer-mobile.png' });
});
