import { expect, test } from '@playwright/test';
import { Box3, BoxGeometry, Vector3 } from 'three';
import { normalizeModel } from '../src/models/normalization';

function modelGlb() {
  const geometry = new BoxGeometry(4,2,1);
  const position=geometry.getAttribute('position').array, normal=geometry.getAttribute('normal').array, index=geometry.index!.array;
  const buffers=[position,normal,index].map(array=>Buffer.from(array.buffer,array.byteOffset,array.byteLength));
  const binary=Buffer.concat(buffers);
  const json={asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],
    nodes:[{translation:[100,20,-12],scale:[2,1.5,1],children:[1]},{mesh:0}],
    meshes:[{primitives:[{attributes:{POSITION:0,NORMAL:1},indices:2,material:0}]}],
    materials:[{pbrMetallicRoughness:{baseColorFactor:[0.3,0.7,0.65,1],metallicFactor:0.2,roughnessFactor:0.35}}],
    buffers:[{byteLength:binary.length}],bufferViews:buffers.map((buffer,i)=>({buffer:0,byteOffset:buffers.slice(0,i).reduce((s,b)=>s+b.length,0),byteLength:buffer.length})),
    accessors:[{bufferView:0,componentType:5126,count:24,type:'VEC3',min:[-2,-1,-0.5],max:[2,1,0.5]},
      {bufferView:1,componentType:5126,count:24,type:'VEC3'}, {bufferView:2,componentType:5123,count:36,type:'SCALAR'}]};
  const text=Buffer.from(JSON.stringify(json)), jsonBytes=Buffer.alloc(Math.ceil(text.length/4)*4,0x20);text.copy(jsonBytes);
  const binBytes=Buffer.alloc(Math.ceil(binary.length/4)*4);binary.copy(binBytes);
  const output=Buffer.alloc(12+8+jsonBytes.length+8+binBytes.length);
  output.writeUInt32LE(0x46546c67,0);output.writeUInt32LE(2,4);output.writeUInt32LE(output.length,8);
  output.writeUInt32LE(jsonBytes.length,12);output.writeUInt32LE(0x4e4f534a,16);jsonBytes.copy(output,20);
  const offset=20+jsonBytes.length;output.writeUInt32LE(binBytes.length,offset);output.writeUInt32LE(0x004e4942,offset+4);binBytes.copy(output,offset+8);
  geometry.dispose();return output;
}

test('normalization preserves proportions, physical scale and off-origin placement',()=>{
  const bounds=new Box3(new Vector3(96,18.5,-12.5),new Vector3(104,21.5,-11.5));
  for(const rotation of [[0,0,0],[0,0,90],[90,180,270]] as const){
    const fit=normalizeModel(bounds,rotation,16), transformed=bounds.clone().applyMatrix4(fit.matrix);
    expect(transformed.getCenter(new Vector3()).distanceTo(new Vector3(-0.35,0,0))).toBeLessThan(1e-10);
    const columns=[new Vector3().setFromMatrixColumn(fit.matrix,0),new Vector3().setFromMatrixColumn(fit.matrix,1),new Vector3().setFromMatrixColumn(fit.matrix,2)];
    columns.forEach(column=>expect(column.length()).toBeCloseTo(fit.scale,10));
    expect(transformed.getSize(new Vector3()).distanceTo(fit.normalizedSize)).toBeLessThan(1e-10);
    expect(fit.normalizedSize.x).toBeLessThanOrEqual(0.8000001);expect(fit.normalizedSize.y).toBeLessThanOrEqual(0.3800001);
    expect(fit.normalizedSize.z).toBeLessThanOrEqual(0.5500001);
    expect(fit.physicalSize.distanceTo(fit.normalizedSize.clone().multiplyScalar(fit.metresPerTunnelUnit))).toBeLessThan(1e-10);
  }
  expect(()=>normalizeModel(bounds,[0,0,0],0)).toThrow();expect(()=>normalizeModel(new Box3(),[0,0,0],1)).toThrow();
});

test('model preparation imports a real GLB, applies hierarchy transforms, rotates, replaces and stays local',async({page})=>{
  test.setTimeout(60000);await page.routeWebSocket('**',socket=>socket.close());
  const errors:string[]=[], remote:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(request.method()==='POST' || /^https:\/\//.test(request.url()))remote.push(request.url());});
  await page.setViewportSize({width:1440,height:1000});await page.goto('/#/import');
  const preview=page.getByRole('img',{name:'Interactive model preparation preview'});
  await expect(preview).toBeVisible();await expect(preview).toHaveAttribute('data-model','reference');
  await page.screenshot({path:'test-results/model-import-empty.png',fullPage:true});
  await page.getByLabel('Upload GLB model').setInputFiles({name:'offset-model.glb',mimeType:'model/gltf-binary',buffer:modelGlb()});
  await expect(preview).toHaveAttribute('data-model','offset-model.glb');
  await expect(page.getByLabel('Physical longest dimension')).toHaveValue('8');
  const actual=()=>preview.evaluate(element=>({size:element.getAttribute('data-actual-size')!.split(',').map(Number),center:element.getAttribute('data-actual-center')!.split(',').map(Number)}));
  await expect.poll(async()=>Math.max(...(await actual()).size.map((v,i)=>Math.abs(v-[0.8,0.3,0.1][i])))).toBeLessThan(1e-5);
  expect((await actual()).center[0]).toBeCloseTo(-0.35,5);
  await page.getByLabel('Physical longest dimension').fill('16');
  await expect(page.getByTestId('physical-dimensions')).toContainText('16.0');
  await page.getByRole('button',{name:'Rotate Z 90 degrees'}).click();
  await expect.poll(async()=>Math.max(...(await actual()).size.map((v,i)=>Math.abs(v-[0.1425,0.38,0.0475][i])))).toBeLessThan(1e-5);
  await page.getByRole('button',{name:'Review placement'}).click();await expect(page.getByText('Placement prepared')).toBeVisible();
  await page.getByLabel('Upload GLB model').setInputFiles({name:'invalid.glb',mimeType:'model/gltf-binary',buffer:Buffer.from('not a GLB')});
  await expect(page.getByRole('alert')).toContainText('valid GLB');await expect(preview).toHaveAttribute('data-model','offset-model.glb');
  await page.getByRole('button',{name:'Clear',exact:true}).click();
  await page.getByRole('button',{name:/Try the reference model/}).click();await expect(preview).toHaveAttribute('data-model','Reference coupe');
  await page.getByRole('button',{name:'Wireframe',exact:true}).click();await expect(page.getByRole('button',{name:'Wireframe',exact:true})).toHaveAttribute('aria-pressed','true');
  await page.getByRole('button',{name:'Wireframe',exact:true}).click();
  await expect(page.getByRole('button',{name:'Wireframe',exact:true})).toHaveAttribute('aria-pressed','false');
  await page.screenshot({path:'test-results/model-import-prepared.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await expect.poll(async()=>(await preview.boundingBox())!.width).toBeLessThan(391);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/model-import-mobile.png',fullPage:true});
  expect(errors).toEqual([]);expect(remote).toEqual([]);
});
