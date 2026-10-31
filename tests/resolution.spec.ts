/// <reference types="@webgpu/types" />
import { expect, test } from '@playwright/test';
import { createObstacle } from '../src/geometry/sphere';
import { RESOLUTION_PRESETS, resolutionScale, gridMemory } from '../src/gpu/grid';

test('presets preserve nominal Reynolds number and boundary experiments preserve discrete geometry', () => {
  for (const { grid } of RESOLUTION_PRESETS) {
    const scale = resolutionScale(grid);
    const diameter = 2*createObstacle(grid, 'sphere').sphere!.radius;
    expect((0.03/scale)*diameter/((0.6-0.5)/3)).toBeCloseTo(6.624, 8);
    expect(gridMemory(grid).distributionBytes).toBeLessThan(134217728);
  }
  const sphere = createObstacle({ nx: 64, ny: 32, nz: 32 }, 'sphere', 3.68, [19.2,16,16]);
  const moved = createObstacle({ nx: 96, ny: 32, nz: 32 }, 'sphere', 3.68, [51.2,16,16]);
  for (let z = 0; z < 32; z++) for (let y = 0; y < 32; y++) for (let x = 0; x < 64; x++) {
    if (sphere.solidFlags[x+64*(y+32*z)] !== moved.solidFlags[x+32+96*(y+32*z)]) throw new Error('The translated sphere changed voxel geometry.');
  }
  expect(moved.solidCells).toBe(sphere.solidCells);
  expect(() => createObstacle({ nx: 64, ny: 32, nz: 32 }, 'sphere', 3.68, [2,16,16])).toThrow();
});

test('resolution change resets a running flow and creates a working finer simulation', async ({ page }) => {
  test.setTimeout(90000);
  await page.routeWebSocket('**', (socket) => socket.close());
  await page.goto('/');
  const supported = await page.evaluate(async () => Boolean(navigator.gpu && await navigator.gpu.requestAdapter()));
  test.skip(!supported, 'A real GPU is required.');
  const value = (label: string) => page.locator('dt', { hasText: label }).locator('..').locator('dd');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect.poll(async () => Number((await value('Simulation steps').textContent())!.replaceAll(',', '')), { timeout: 20000 }).toBeGreaterThan(0);
  await page.getByLabel('Simulation resolution').selectOption('fine');
  await expect(value('Grid dimensions')).toHaveText('96 × 48 × 48', { timeout: 20000 });
  await expect(value('Simulation steps')).toHaveText('0');
  await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeEnabled();
  await expect(page.getByLabel('Target inlet speed')).toHaveValue('0.02');
  await page.getByText('Wind settings',{ exact:true }).evaluate(el => { (el.parentElement as HTMLDetailsElement).open = true; });
  await page.getByRole('button', { name: 'Step once' }).click();
  await expect(value('Simulation steps')).toHaveText('1');
  await expect(value('Latest batch wall time / step')).toContainText('ms');
  await expect(value('Grid + solver allocation estimate')).not.toContainText('not yet measured');
  await page.getByRole('button', { name: 'Reset fluid' }).click();
  await expect(value('Simulation steps')).toHaveText('0');
  await expect(value('Latest batch wall time / step')).toHaveText('—');
  await expect(value('Grid + solver allocation estimate')).not.toContainText('not yet measured');
  await page.screenshot({ path: 'test-results/resolution-controls.png', fullPage: true });
  await page.getByLabel('Simulation resolution').selectOption('auto');
  await expect(value('Grid dimensions')).toHaveText('64 × 32 × 32');
  await expect(value('Simulation steps')).toHaveText('0');
  await expect(page.getByRole('alert')).toHaveCount(0);
});
