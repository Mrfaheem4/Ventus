/// <reference types="@webgpu/types" />
import { test, expect } from '@playwright/test';

test('smoke lines follow a known 3D field, disappear at rest and stop before the sphere', async ({page}) => {
  await page.routeWebSocket('**',socket=>socket.close()); await page.goto('/');
  test.skip(!await page.evaluate(async()=>Boolean(navigator.gpu && await navigator.gpu.requestAdapter())),'Real GPU required');
  const result=await page.evaluate(async()=>{
    const paths=['/src/gpu/device.ts','/src/sim/initialize.ts','/src/geometry/sphere.ts','/src/render/filaments.ts'];
    const [{initializeGPU},{initializeFluid},{createObstacle},{createFilaments}]=await Promise.all(paths.map(path=>import(/* @vite-ignore */path)));
    const abort=new AbortController(), errors:string[]=[], grid={nx:16,ny:8,nz:8};
    const context=await initializeGPU(abort.signal,(m:string)=>errors.push(m),grid);
    let smoke;
    try {
      await initializeFluid(context,abort.signal);
      smoke=await createFilaments(context,createObstacle(grid),abort.signal);
      const rest=await smoke.advance(16,16);
      const field=new Uint16Array(16*8*8*4);
      for(let i=0;i<field.length;i+=4){field[i]=0x2c00;field[i+1]=0x2800;}
      context.device.queue.writeTexture({texture:context.resources.field},field,{bytesPerRow:128,rowsPerImage:8},{width:16,height:8,depthOrArrayLayers:8});
      const moving=await smoke.advance(16,32);smoke.dispose();
      const body=createObstacle(grid,'sphere');context.device.queue.writeBuffer(context.resources.flags,0,body.solidFlags);
      for(let i=0;i<field.length;i+=4)field[i+1]=0;
      context.device.queue.writeTexture({texture:context.resources.field},field,{bytesPerRow:128,rowsPerImage:8},{width:16,height:8,depthOrArrayLayers:8});
      smoke=await createFilaments(context,body,abort.signal);
      const clipped=await smoke.advance(16,48);
      let minimum=Infinity, terminated=0;
      for(let line=0;line<clipped.lines;line++)for(let j=0;j<clipped.points;j++){
        const i=(line*clipped.points+j)*4;
        if(clipped.positions[i+3]<0){if(j>0)terminated++;break;}
        minimum=Math.min(minimum,Math.hypot(...[0,1,2].map(a=>clipped.positions[i+a]-body.sphere.center[a])));
      }
      if(errors.length)throw new Error(errors.join('; '));
      return {rest:Array.from(rest.positions.filter((_:number,i:number)=>i%4===3)),point:Array.from(moving.positions.slice(12,16)),minimum,radius:body.sphere.radius,terminated};
    } finally{smoke?.dispose();abort.abort();}
  });
  expect(result.rest.every(v=>v<0)).toBe(true);
  expect(result.point[0]).toBeCloseTo(0.75+1.5/Math.sqrt(1.25),4);
  expect(result.point[1]).toBeCloseTo((0.23-0.002)*8+0.75/Math.sqrt(1.25),4);
  expect(result.point[2]).toBeCloseTo((0.5-0.002)*8,4);
  expect(result.minimum).toBeGreaterThan(result.radius); expect(result.terminated).toBeGreaterThan(0);
});

test('thin smoke lines render around the calculated sphere flow and clear on reset', async ({page})=>{
  test.setTimeout(90000);await page.routeWebSocket('**',socket=>socket.close());await page.goto('/');
  test.skip(!await page.evaluate(async()=>Boolean(navigator.gpu && await navigator.gpu.requestAdapter())),'Real GPU required');
  const errors:string[]=[];page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  const viewer=page.getByRole('region',{name:'3D flow view'}),canvas=viewer.getByRole('img');
  await expect(viewer.getByLabel('Show smoke')).toBeChecked();
  await expect(page.getByText('Initial fluid check passed')).not.toBeVisible();
  await page.getByRole('button',{name:'Run',exact:true}).click();
  await expect.poll(async()=>Number(await canvas.getAttribute('data-smoke-step')),{timeout:60000}).toBeGreaterThanOrEqual(1200);
  const phase=Number(await canvas.getAttribute('data-smoke-time'));
  await expect.poll(async()=>Number(await canvas.getAttribute('data-smoke-time')),{timeout:3000}).toBeGreaterThan(phase);
  await page.getByRole('button',{name:'Pause',exact:true}).click();
  await expect(page.getByRole('button',{name:'Reset fluid'})).toBeEnabled();
  await expect(canvas).toHaveAttribute('data-smoke-lines','33');
  expect(Number(await canvas.getAttribute('data-smoke-segments'))).toBeGreaterThan(100);
  const frozenTime=await canvas.getAttribute('data-smoke-time');
  const screenshot=await canvas.screenshot();expect((await canvas.screenshot()).equals(screenshot)).toBe(true);
  await expect(canvas).toHaveAttribute('data-smoke-time',frozenTime!);
  await viewer.screenshot({path:'test-results/thin-smoke.png'});
  await viewer.getByRole('button',{name:'Side view'}).click();
  await viewer.screenshot({path:'test-results/thin-smoke-side.png'});
  await page.getByRole('button',{name:'Reset fluid'}).click();
  await expect(canvas).toHaveAttribute('data-smoke-lines','0');
  await page.getByText('Wind settings',{exact:true}).click();
  await page.getByRole('button',{name:'Step once'}).click();
  await expect(canvas).toHaveAttribute('data-smoke-step','1');
  await page.getByLabel('Test scene').selectOption('none');
  await page.getByRole('button',{name:'Step once'}).click();
  await expect(canvas).toHaveAttribute('data-smoke-step','1');
  await expect(page.getByRole('alert')).toHaveCount(0);expect(errors).toEqual([]);
});
