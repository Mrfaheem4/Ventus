/// <reference types="@webgpu/types" />
import { expect, test } from '@playwright/test';

test('GPU concentration transport moves a known pulse, preserves still air and excludes solids', async ({ page }) => {
  test.setTimeout(90000);
  await page.routeWebSocket('**',(socket) => socket.close());
  await page.goto('/');
  const supported = await page.evaluate(async () => Boolean(navigator.gpu && await navigator.gpu.requestAdapter()));
  test.skip(!supported,'Real GPU required.');
  const result = await page.evaluate(async () => {
    const paths = ['/src/gpu/device.ts','/src/gpu/buffers.ts','/src/gpu/grid.ts','/src/sim/initialize.ts','/src/render/smoke.ts'];
    const [{ initializeGPU },{ allocateGrid },{ gridMemory },{ initializeFluid },{ createSmoke }] = await Promise.all(paths.map((path) => import(/* @vite-ignore */ path)));
    const abort = new AbortController();
    const errors: string[] = [];
    const base = await initializeGPU(abort.signal,(message: string) => errors.push(message)); base.resources.destroy();
    const grid = { nx: 16,ny: 8,nz: 8 },memory = gridMemory(grid),resources = allocateGrid(base.device,grid);
    const context = { ...base,grid,memory,resources };
    const pulse = new Float32Array(memory.cells);
    for (let z = 0; z < 8; z++) for (let y = 0; y < 8; y++) pulse[3+16*(y+8*z)] = 1;
    let smoke;
    try {
      await initializeFluid(context,abort.signal);
      smoke = await createSmoke(context,abort.signal,pulse);
      const still = await smoke.advance(16,16); smoke.dispose();
      const velocity = new Uint16Array(memory.cells*4);
      for (let i = 0; i < memory.cells; i++) velocity[i*4] = 0x2c00; // ux = 1/16
      base.device.queue.writeTexture({ texture: resources.field },velocity,{ bytesPerRow: 16*8,rowsPerImage: 8 },{ width: 16,height: 8,depthOrArrayLayers: 8 });
      const flags = new Uint32Array(memory.cells); const solid = 4+16*(4+8*4); flags[solid] = 1;
      base.device.queue.writeBuffer(resources.flags,0,flags);
      smoke = await createSmoke(context,abort.signal,pulse);
      const moved = await smoke.advance(16,16);
      smoke.dispose();
      base.device.queue.writeBuffer(resources.flags,0,new Uint32Array(memory.cells));
      const gaussian = new Float32Array(memory.cells);
      for (let i = 0; i < gaussian.length; i++) gaussian[i] = Math.exp(-0.5*((i%16-6)/1.5)**2);
      smoke = await createSmoke(context,abort.signal,gaussian);
      let fractional;
      for (let i = 1; i <= 4; i++) fractional = await smoke.advance(4,i*4);
      const profile = Array.from({ length: 10 },(_,i) => fractional!.density[i+3+16*(2+8*2)]/255);
      if (errors.length) throw new Error(errors.join('; '));
      return { still: Array.from(still.density),moved: Array.from(moved.density),solid,profile };
    } finally { smoke?.dispose(); resources.destroy(); abort.abort(); }
  });
  const at = (x: number,y = 2,z = 2) => x+16*(y+8*z);
  expect(result.still[at(3)]).toBe(255);
  expect(result.still[at(4)]).toBe(0);
  expect(result.moved[at(3)]).toBe(0);
  expect(result.moved[at(4)]).toBe(255);
  expect(result.moved[at(5)]).toBe(0);
  expect(result.moved[result.solid]).toBe(0);
  // Four fractional translations should preserve a smooth pulse better than
  // linear remapping, against the exact one-cell translated Gaussian.
  let linear = Array.from({ length: 16 },(_,x) => Math.exp(-0.5*((x-6)/1.5)**2));
  for (let step = 0; step < 4; step++) linear = linear.map((v,x) => 0.75*v+0.25*linear[Math.max(0,x-1)]);
  let cubicError = 0, linearError = 0;
  result.profile.forEach((v,i) => {
    const exact = Math.exp(-0.5*((i+3-7)/1.5)**2);
    cubicError += Math.abs(v-exact); linearError += Math.abs(linear[i+3]-exact);
    expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1);
  });
  expect(cubicError).toBeLessThan(linearError*0.7);
});

test('smoke is the default slice-free view, supports translucent slices and freezes/reset clears', async ({ page }) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on('console',(message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.routeWebSocket('**',(socket) => socket.close());
  await page.goto('/');
  const supported = await page.evaluate(async () => Boolean(navigator.gpu && await navigator.gpu.requestAdapter()));
  test.skip(!supported,'Real GPU required.');
  const viewer = page.getByRole('region',{ name: '3D flow view' });
  const canvas = viewer.getByRole('img');
  await expect(viewer.getByLabel('Show smoke')).toBeChecked();
  await expect(viewer.getByLabel('Show slice',{ exact: true })).not.toBeChecked();
  await expect(page.getByLabel('Simulation pace')).toHaveValue('16');
  await page.getByRole('button',{ name: 'Run',exact: true }).click();
  await expect.poll(async () => Number(await canvas.getAttribute('data-smoke-step')),{ timeout: 60000 }).toBeGreaterThanOrEqual(1200);
  await page.getByRole('button',{ name: 'Pause',exact: true }).click();
  await expect(page.getByRole('button',{ name: 'Step once' })).toBeEnabled();
  const smokeStep = await canvas.getAttribute('data-smoke-step');
  await expect(canvas).toHaveAttribute('data-smoke-voxels','65536');
  await viewer.screenshot({ path: 'test-results/smoke-view.png' });
  await viewer.getByRole('button',{ name: 'Side view' }).click();
  await viewer.screenshot({ path: 'test-results/smoke-side.png' });
  const frozen = await canvas.screenshot();
  expect((await canvas.screenshot()).equals(frozen)).toBe(true);
  await expect(canvas).toHaveAttribute('data-smoke-step',smokeStep!);
  await viewer.getByLabel('Show slice',{ exact: true }).check();
  await expect(viewer.getByLabel('Slice opacity:')).toHaveValue('0.2');
  await viewer.screenshot({ path: 'test-results/smoke-with-slice.png' });
  await page.getByRole('button',{ name: 'Reset fluid' }).click();
  await expect(canvas).toHaveAttribute('data-smoke-voxels','0');
  await viewer.getByLabel('Show smoke').uncheck();
  await page.getByRole('button',{ name: 'Step once' }).click();
  await expect(canvas).toHaveAttribute('data-smoke-step','0');
  expect(errors.filter((message) => /THREE.WebGLProgram|Shader Error|VALIDATE_STATUS|GL_INVALID/.test(message))).toEqual([]);
  await expect(page.getByRole('alert')).toHaveCount(0);
});
