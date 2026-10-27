/// <reference types="@webgpu/types" />
import { expect, test } from '@playwright/test';
import { createObstacle } from '../src/geometry/sphere';
import { seedTracers, TRACER_COUNT } from '../src/render/tracer-seeds';

test('initial passive markers are deterministic and outside the voxel body', () => {
  const grid = { nx: 64, ny: 32, nz: 32 };
  const body = createObstacle(grid,'sphere');
  const positions = seedTracers(grid,body);
  expect(positions.length).toBe(TRACER_COUNT*4);
  expect(positions).toEqual(seedTracers(grid,body));
  for (let i = 0; i < positions.length; i += 4) {
    const [x,y,z,generation] = positions.slice(i,i+4);
    expect(generation).toBe(0);
    if (body.solidFlags[Math.floor(x)+grid.nx*(Math.floor(y)+grid.ny*Math.floor(z))]) throw new Error('Seed inside the solid.');
    if (x <= 0.5 || x >= grid.nx-0.5 || y <= 0.5 || y >= grid.ny-0.5 || z <= 0.5 || z >= grid.nz-0.5) throw new Error('Seed outside the tracer domain.');
  }
});

test('GPU tracer integration follows 3D velocity, interpolated shear, rest and crossed solid cells', async ({ page }, testInfo) => {
  test.setTimeout(90000);
  await page.routeWebSocket('**',(socket) => socket.close());
  await page.goto('/');
  const supported = await page.evaluate(async () => Boolean(navigator.gpu && await navigator.gpu.requestAdapter()));
  test.skip(!supported,'Real WebGPU adapter required.');
  const result = await page.evaluate(async () => {
    const paths = ['/src/gpu/device.ts','/src/gpu/buffers.ts','/src/gpu/grid.ts','/src/sim/initialize.ts','/src/render/tracers.ts','/src/geometry/sphere.ts'];
    const [{ initializeGPU },{ allocateGrid },{ gridMemory },{ initializeFluid },{ createTracers },{ createObstacle }] = await Promise.all(paths.map((path) => import(/* @vite-ignore */ path)));
    const abort = new AbortController();
    const errors: string[] = [];
    const base = await initializeGPU(abort.signal,(message: string) => errors.push(message));
    base.resources.destroy();
    const grid = { nx: 16, ny: 16, nz: 16 };
    const memory = gridMemory(grid), resources = allocateGrid(base.device,grid);
    const context = { ...base,grid,memory,resources };
    const body = createObstacle(grid);
    const field = new Uint16Array(memory.cells*4);
    const write = () => base.device.queue.writeTexture({ texture: resources.field },field,
      { bytesPerRow: grid.nx*8, rowsPerImage: grid.ny }, { width: grid.nx,height: grid.ny,depthOrArrayLayers: grid.nz });
    const constant = (x: number,y: number,z: number) => {
      for (let i = 0; i < memory.cells; i++) field.set([x,y,z,0],i*4);
      write();
    };
    let tracers;
    try {
      await initializeFluid(context,abort.signal);
      const initial = new Float32Array([4,5,6,0]);
      constant(0x2c00,0x2800,0xa400); // (1/16, 1/32, -1/64)
      tracers = await createTracers(context,body,abort.signal,initial);
      const first = Array.from(await tracers.advance(4));
      const second = Array.from(await tracers.advance(12));
      let invalid = false;
      try { await tracers.advance(0); } catch { invalid = true; }
      tracers.dispose();
      constant(0,0,0);
      tracers = await createTracers(context,body,abort.signal,initial);
      const resting = Array.from(await tracers.advance(16));
      tracers.dispose();
      // ux = y/256, uy = 1/64. Values at cell centers are exactly
      // representable in half precision; independently predict the trajectory.
      for (let z = 0; z < 16; z++) for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const u = (y+0.5)/256;
        const exponent = Math.floor(Math.log2(u));
        const bits = ((exponent+15)<<10)+Math.round((u/2**exponent-1)*1024);
        field.set([bits,0x2400,0,0],(x+16*(y+16*z))*4);
      }
      write();
      tracers = await createTracers(context,body,abort.signal,new Float32Array([4,5.25,6,0]));
      const shear = Array.from(await tracers.advance(8));
      tracers.dispose();
      // A short diagonal enters and exits (5,4,5) between its midpoint
      // and endpoint. Testing only the endpoints/midpoint would miss it.
      const flags = new Uint32Array(memory.cells); flags[5+16*(4+16*5)] = 1;
      base.device.queue.writeBuffer(resources.flags,0,flags);
      constant(0x3000,0x3000,0); // vx = vy = 1/8
      tracers = await createTracers(context,body,abort.signal,new Float32Array([4.925,4.9125,5.5,0, 15.45,8,8,0]));
      const collisions = Array.from(await tracers.advance(1));
      if (errors.length) throw new Error(errors.join('; '));
      return { first,second,resting,shear,collisions,invalid };
    } finally { tracers?.dispose(); resources.destroy(); abort.abort(); }
  });
  await testInfo.attach('tracer-advection-measurements',{ body: JSON.stringify(result,null,2), contentType: 'application/json' });
  const close = (actual: number[],expected: number[]) => expected.forEach((value,i) => expect(actual[i]).toBeCloseTo(value,5));
  close(result.first,[4.25,5.125,5.9375,0]);
  close(result.second,[5,5.5,5.75,0]);
  close(result.resting,[4,5,6,0]);
  close(result.shear,[4+8*5.25/256+0.5*(1/256)*(1/64)*8**2,5.25+8/64,6,0]);
  expect(result.invalid).toBe(true);
  for (const offset of [0,4]) {
    expect(result.collisions[offset]).toBe(1.25);
    expect(result.collisions[offset+3]).toBe(1);
  }
});

test('a tracer shader failure disables the visualization while airflow keeps stepping', async ({ page }) => {
  await page.routeWebSocket('**',(socket) => socket.close());
  await page.route(/\/src\/shaders\/tracers\.wgsl\?/, (route) => route.fulfill({ contentType: 'application/javascript', body: 'export default "invalid shader code";' }));
  await page.goto('/');
  const supported = await page.evaluate(async () => Boolean(navigator.gpu && await navigator.gpu.requestAdapter()));
  test.skip(!supported,'Real WebGPU adapter required.');
  const steps = page.locator('dt',{ hasText: 'Simulation steps' }).locator('..').locator('dd');
  await page.getByLabel('Show airflow tracers').check();
  await page.getByRole('button',{ name: 'Step once' }).click();
  await expect(steps).toHaveText('1');
  await expect(page.getByText(/^Airflow tracers:/)).toBeVisible();
  await expect(page.getByLabel('Show airflow tracers')).not.toBeChecked();
  await page.getByRole('button',{ name: 'Step once' }).click();
  await expect(steps).toHaveText('2');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('live tracers work without a slice, pause with the solver and clear on reset', async ({ page }) => {
  test.setTimeout(90000);
  await page.routeWebSocket('**',(socket) => socket.close());
  await page.goto('/');
  const supported = await page.evaluate(async () => Boolean(navigator.gpu && await navigator.gpu.requestAdapter()));
  test.skip(!supported,'Real WebGPU adapter required.');
  const viewer = page.getByRole('region',{ name: '3D flow view' });
  const canvas = viewer.getByRole('img');
  const steps = page.locator('dt',{ hasText: 'Simulation steps' }).locator('..').locator('dd');
  await viewer.getByLabel('Show airflow tracers').check();
  await viewer.getByLabel('Show slice',{ exact: true }).uncheck();
  await page.getByRole('button',{ name: 'Run',exact: true }).click();
  await expect.poll(async () => Number((await steps.textContent())!.replaceAll(',','')),{ timeout: 30000 }).toBeGreaterThanOrEqual(160);
  await page.getByRole('button',{ name: 'Pause',exact: true }).click();
  await expect(page.getByRole('button',{ name: 'Step once' })).toBeEnabled();
  await expect(canvas).toHaveAttribute('data-tracer-count',String(TRACER_COUNT));
  await expect.poll(async () => Number(await canvas.getAttribute('data-tracer-segments'))).toBeGreaterThan(0);
  const step = await canvas.getAttribute('data-tracer-step');
  const still = await canvas.screenshot();
  expect((await canvas.screenshot()).equals(still)).toBe(true);
  await expect(canvas).toHaveAttribute('data-tracer-step',step!);
  await viewer.screenshot({ path: 'test-results/airflow-tracers.png' });
  await page.getByRole('button',{ name: 'Reset fluid' }).click();
  await expect(canvas).toHaveAttribute('data-tracer-count','0');
  await expect(canvas).toHaveAttribute('data-tracer-segments','0');
  await page.getByRole('button',{ name: 'Step once' }).click();
  await expect(canvas).toHaveAttribute('data-tracer-step','1');
  await viewer.getByLabel('Show airflow tracers').uncheck();
  await expect(canvas).toHaveAttribute('data-tracer-count','0');
  await page.getByRole('button',{ name: 'Step once' }).click();
  await expect(steps).toHaveText('2');
  await expect(canvas).toHaveAttribute('data-tracer-count','0');
  await viewer.getByLabel('Show airflow tracers').check();
  await page.getByRole('button',{ name: 'Step once' }).click();
  await expect(canvas).toHaveAttribute('data-tracer-step','3');
  await page.getByLabel('Test scene').selectOption('none');
  await expect(canvas).toHaveAttribute('data-tracer-count','0');
  await page.getByRole('button',{ name: 'Step once' }).click();
  await expect(canvas).toHaveAttribute('data-tracer-step','1');
  await page.getByRole('button',{ name: 'Reinitialize GPU' }).click();
  await expect(page.getByRole('status')).toContainText('GPU ready');
  await expect(canvas).toHaveAttribute('data-tracer-count','0');
});
