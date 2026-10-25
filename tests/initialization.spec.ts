/// <reference types="@webgpu/types" />
import { expect, test } from '@playwright/test';
import { checkRestDistributions } from '../src/sim/initialization-check';

test('CPU check accepts equilibrium but rejects invalid density, velocity, and populations', () => {
  const rest = Float32Array.from({ length: 19 }, (_, i) => i === 0 ? 1 / 3 : i <= 6 ? 1 / 18 : 1 / 36);
  expect(checkRestDistributions(rest).density).toBeCloseTo(1, 6);
  expect(checkRestDistributions(rest).speed).toBe(0);
  for (const invalid of [NaN, Infinity, -0.1, 0]) {
    const corrupted = rest.slice();
    corrupted[0] = invalid;
    expect(() => checkRestDistributions(corrupted)).toThrow();
  }
  const moving = rest.slice();
  moving[1] += 0.01;
  moving[2] -= 0.01;
  expect(() => checkRestDistributions(moving)).toThrow();
  // Preserve mass and zero momentum while breaking the equilibrium populations.
  const wrongWeights = rest.slice();
  wrongWeights[0] -= 0.02;
  wrongWeights[1] += 0.01;
  wrongWeights[2] += 0.01;
  expect(() => checkRestDistributions(wrongWeights)).toThrow();
});

test('real GPU resets every cell in both buffers, flags, and field, including partial workgroups', async ({ page }) => {
  await page.goto('/');
  const supported = await page.evaluate(async () => Boolean(navigator.gpu && await navigator.gpu.requestAdapter()));
  test.skip(!supported, 'A real WebGPU adapter is required to validate the initialization shader.');
  await expect(page.getByRole('status')).toContainText('Air initialized at rest');

  const results = await page.evaluate(async () => {
    // Import through Vite so this exercises the production WGSL and dispatch code.
    const devicePath = '/src/gpu/device.ts';
    const buffersPath = '/src/gpu/buffers.ts';
    const gridPath = '/src/gpu/grid.ts';
    const initPath = '/src/sim/initialize.ts';
    const { initializeGPU } = await import(/* @vite-ignore */ devicePath);
    const { allocateGrid } = await import(/* @vite-ignore */ buffersPath);
    const { gridMemory } = await import(/* @vite-ignore */ gridPath);
    const { initializeFluid } = await import(/* @vite-ignore */ initPath);
    const controller = new AbortController();
    const gpuErrors: string[] = [];
    const context = await initializeGPU(controller.signal, (message: string) => gpuErrors.push(message));
    const device: GPUDevice = context.device;
    const results = [];
    try {
      for (const grid of [context.grid, { nx: 13, ny: 9, nz: 5 }]) {
        const resources = allocateGrid(device, grid);
        const memory = gridMemory(grid);
        let readback: GPUBuffer | undefined;
        try {
          const poison = new Float32Array(memory.distributionBytes / 4).fill(7);
          for (const buffer of resources.distributions) device.queue.writeBuffer(buffer, 0, poison);
          device.queue.writeBuffer(resources.flags, 0, new Uint32Array(memory.cells).fill(0xffffffff));
          // Half-float 1.0 in all channels, so a zero field cannot pass by default allocation.
          const texels = new Uint16Array(memory.cells * 4).fill(0x3c00);
          device.queue.writeTexture({ texture: resources.field }, texels,
            { bytesPerRow: grid.nx * 8, rowsPerImage: grid.ny },
            { width: grid.nx, height: grid.ny, depthOrArrayLayers: grid.nz });
          const report = await initializeFluid({ ...context, grid, resources, memory }, controller.signal);
          const bytesPerRow = Math.ceil(grid.nx * 8 / 256) * 256;
          const textureOffset = Math.ceil((memory.distributionBytes * 2 + memory.flagsBytes) / 256) * 256;
          const textureBytes = bytesPerRow * grid.ny * grid.nz;
          readback = device.createBuffer({ size: textureOffset + textureBytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
          const encoder = device.createCommandEncoder();
          resources.distributions.forEach((buffer: GPUBuffer, i: number) => {
            encoder.copyBufferToBuffer(buffer, 0, readback!, i * memory.distributionBytes, memory.distributionBytes);
          });
          encoder.copyBufferToBuffer(resources.flags, 0, readback, memory.distributionBytes * 2, memory.flagsBytes);
          encoder.copyTextureToBuffer({ texture: resources.field },
            { buffer: readback, offset: textureOffset, bytesPerRow, rowsPerImage: grid.ny },
            { width: grid.nx, height: grid.ny, depthOrArrayLayers: grid.nz });
          device.queue.submit([encoder.finish()]);
          await readback.mapAsync(GPUMapMode.READ);
          const mapped = readback.getMappedRange();
          const values = new Float32Array(mapped, 0, memory.distributionBytes * 2 / 4);
          let maxError = 0;
          for (let state = 0; state < 2; state++) {
            for (let direction = 0; direction < 19; direction++) {
              const expected = direction === 0 ? 1 / 3 : direction <= 6 ? 1 / 18 : 1 / 36;
              for (let node = 0; node < memory.cells; node++) {
                const actual = values[state * 19 * memory.cells + direction * memory.cells + node];
                if (!Number.isFinite(actual)) throw new Error('Non-finite GPU population');
                maxError = Math.max(maxError, Math.abs(actual - expected));
              }
            }
          }
          const flags = new Uint32Array(mapped, memory.distributionBytes * 2, memory.cells);
          const field = new Uint16Array(mapped, textureOffset, textureBytes / 2);
          results.push({ grid, maxError, flagsClear: flags.every((flag) => flag === 0),
            fieldClear: field.every((value) => value === 0), report });
          readback.unmap();
        } finally {
          readback?.destroy();
          resources.destroy();
        }
      }
      if (gpuErrors.length) throw new Error(gpuErrors.join('; '));
      return results;
    } finally {
      controller.abort();
    }
  });
  expect(results).toHaveLength(2);
  for (const result of results) {
    expect(result.maxError).toBeLessThan(1e-6);
    expect(result.flagsClear).toBe(true);
    expect(result.fieldClear).toBe(true);
    expect(result.report.maxDensityError).toBeLessThan(1e-6);
    expect(result.report.maxSpeed).toBe(0);
    expect(result.report.checkedStates).toBe(10);
  }
});
