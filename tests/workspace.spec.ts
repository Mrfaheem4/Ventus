import { test, expect } from '@playwright/test';

test('workspace prioritizes the scene and fits desktop and narrow screens', async ({ page }) => {
  await page.routeWebSocket('**', socket => socket.close());
  await page.goto('/');
  test.skip(!await page.evaluate(async () => Boolean(navigator.gpu && await navigator.gpu.requestAdapter())), 'Real GPU required for the workspace');
  await expect(page.getByRole('status')).toContainText('GPU ready');
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    const canvas = page.getByRole('region', { name: '3D flow view' }).getByRole('img');
    await expect(canvas).toBeVisible();
    await expect.poll(async () => (await canvas.boundingBox())!.width).toBeGreaterThan(viewport.width*0.95);
    expect((await canvas.boundingBox())!.height).toBeGreaterThan(viewport.height*0.5);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.getByText('Initial fluid check passed')).not.toBeVisible();
    await expect(page.getByRole('region', { name: 'Sphere force measurements' })).not.toBeVisible();
    await page.screenshot({ path: `test-results/workspace-${viewport.width}.png`, fullPage: true });
  }
});
