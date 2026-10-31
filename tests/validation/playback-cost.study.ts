import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

test('compare complete UI playback at four-step tracers versus sixteen-step smoke', async ({ page }, testInfo) => {
  test.setTimeout(180000);
  await page.routeWebSocket('**',(socket) => socket.close());
  const cases = [];
  for (const mode of ['four-step tracers','sixteen-step smoke']) {
    await page.goto('/');
    const supported = await page.evaluate(async () => Boolean(navigator.gpu && await navigator.gpu.requestAdapter()));
    test.skip(!supported,'Real GPU required for playback measurement.');
    const viewer = page.getByRole('region',{ name: '3D flow view' });
    const steps = page.locator('dt',{ hasText: 'Simulation steps' }).locator('..').locator('dd');
    const read = () => steps.evaluate((element) => ({ steps: Number(element.textContent!.replaceAll(',','')),milliseconds: performance.now() }));
    if (mode === 'four-step tracers') {
      await viewer.getByLabel('Show smoke').uncheck();
      await viewer.getByText('Inspect geometry and tracers',{ exact:true }).click();
      await viewer.getByLabel('Show airflow tracers').check();
      await page.getByText('Wind settings',{ exact:true }).click();
      await page.getByLabel('Simulation pace').selectOption('4');
    }
    await viewer.scrollIntoViewIfNeeded();
    await page.getByRole('button',{ name: 'Run',exact: true }).click();
    await expect.poll(async () => (await read()).steps,{ timeout: 60000 }).toBeGreaterThanOrEqual(320);
    const start = await read();
    await expect.poll(async () => (await read()).steps,{ timeout: 60000 }).toBeGreaterThanOrEqual(start.steps+1024);
    await page.getByRole('button',{ name: 'Pause',exact: true }).click();
    await expect(page.getByRole('button',{ name: 'Step once' })).toBeEnabled();
    const end = await read();
    const elapsedMilliseconds = end.milliseconds-start.milliseconds;
    cases.push({ mode,steps: end.steps-start.steps,elapsedMilliseconds,stepsPerWallSecond: (end.steps-start.steps)/elapsedMilliseconds*1000 });
    if (mode === 'sixteen-step smoke') {
      await page.getByRole('button',{ name: 'Run',exact: true }).click();
      await expect.poll(async () => (await read()).steps,{ timeout: 60000 }).toBeGreaterThanOrEqual(4096);
      await page.getByRole('button',{ name: 'Pause',exact: true }).click();
      await expect(page.getByRole('button',{ name: 'Step once' })).toBeEnabled();
      await viewer.scrollIntoViewIfNeeded();
      await viewer.screenshot({ path: testInfo.outputPath('developed-smoke.png') });
      await viewer.getByLabel('Show slice',{ exact: true }).check();
      await viewer.screenshot({ path: testInfo.outputPath('developed-smoke-slice.png') });
    }
  }
  const report = { cases,note: 'One sequential Edge/WebGPU run at default Standard resolution. Wall time includes solver, visualization, React, rendering, readbacks and scheduling. Warmup >=320 steps; each measured interval >=1024 steps. Polling and pause contribute timing overhead. This compares two complete configurations, not an isolated effect or guaranteed speedup. Not a rendering FPS measurement.' };
  const path = testInfo.outputPath('playback-cost.json');
  await writeFile(path,JSON.stringify(report,null,2));
  await testInfo.attach('playback-cost',{ path,contentType: 'application/json' });
  report.cases.forEach((value) => expect(value.stepsPerWallSecond).toBeGreaterThan(0));
});
