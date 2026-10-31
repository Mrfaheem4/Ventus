import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createExampleAsset, disposeModel } from '../models/glb';
import type { PreparedAsset } from '../models/glb';
import { normalizeModel, PREVIEW_TUNNEL } from '../models/normalization';
import type { ModelPlacement } from '../models/normalization';

export function createModelPreview(host: HTMLDivElement) {
  const renderer = new THREE.WebGLRenderer({antialias:true,powerPreference:'low-power'});
  renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.domElement.setAttribute('role','img');
  renderer.domElement.setAttribute('aria-label','Interactive model preparation preview');
  host.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#0c151b');
  scene.fog = new THREE.Fog('#0c151b',4,8);
  const camera = new THREE.PerspectiveCamera(35,1,0.01,30);
  const controls = new OrbitControls(camera,renderer.domElement);
  controls.minDistance = 1; controls.maxDistance = 8;
  controls.target.set(-0.15,-0.03,0);
  const holder = new THREE.Group();holder.matrixAutoUpdate = false;scene.add(holder);
  scene.add(new THREE.HemisphereLight('#d4e8ef','#24363a',2.8));
  for(const [color,intensity,position] of [
    ['#ffffff',4,[-2,4,3]],['#84ddd2',2.5,[2,1,-3]],['#adc8f5',1,[-3,0,-2]],
  ] as const){const light=new THREE.DirectionalLight(color,intensity);light.position.set(position[0],position[1],position[2]);scene.add(light);}
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(12,12),new THREE.MeshStandardMaterial({color:'#101d24',roughness:0.9,metalness:0.1}));
  floor.rotation.x=-Math.PI/2;floor.position.y=-0.505;scene.add(floor);
  const grid = new THREE.GridHelper(8,64,'#335058','#1a2d35');grid.position.y=-0.5;scene.add(grid);
  const boxGeometry = new THREE.BoxGeometry(...PREVIEW_TUNNEL.toArray());
  const cage = new THREE.LineSegments(new THREE.EdgesGeometry(boxGeometry),new THREE.LineBasicMaterial({color:'#39616a',transparent:true,opacity:0.48}));
  boxGeometry.dispose();scene.add(cage);
  const fitBox = new THREE.Box3Helper(new THREE.Box3(), '#a7cec4');
  (fitBox.material as THREE.LineBasicMaterial).transparent=true;
  (fitBox.material as THREE.LineBasicMaterial).opacity=0.26;
  scene.add(fitBox);
  const reference = createExampleAsset();
  let current: PreparedAsset | null = null, wireframe=false, disposed=false;
  const render = () => {if(!disposed)renderer.render(scene,camera);};
  const applyMaterialMode = () => {
    (current ?? reference).root.traverse(object => {
      if(!(object instanceof THREE.Mesh))return;
      (Array.isArray(object.material)?object.material:[object.material]).forEach(material=>{
        if('wireframe' in material){material.wireframe=wireframe;material.needsUpdate=true;}
      });
    });
  };
  function place(placement:ModelPlacement) {
    holder.matrix.copy(placement.matrix);holder.matrixWorldNeedsUpdate=true;holder.updateMatrixWorld(true);
    fitBox.box.setFromObject(holder,true);fitBox.visible=Boolean(current);
    renderer.domElement.dataset.scale=String(placement.scale);
    renderer.domElement.dataset.size=placement.normalizedSize.toArray().join(',');
    renderer.domElement.dataset.actualSize=fitBox.box.getSize(new THREE.Vector3()).toArray().join(',');
    renderer.domElement.dataset.actualCenter=fitBox.box.getCenter(new THREE.Vector3()).toArray().join(',');
    render();
  }
  function setModel(asset:PreparedAsset|null,placement?:ModelPlacement) {
    holder.clear();current=asset;holder.add((asset ?? reference).root);
    applyMaterialMode();
    renderer.domElement.dataset.model=asset?.name ?? 'reference';
    place(placement ?? normalizeModel(reference.bounds,[0,0,0],4.5));
  }
  function resetCamera(){
    const factor=Math.max(1,1.15/camera.aspect);
    camera.position.set(1.45,0.9,1.8).multiplyScalar(factor);
    controls.target.set(-0.15,-0.03,0);controls.update();render();
  }
  controls.addEventListener('change',render);
  let aspect=1;
  const resize=new ResizeObserver(()=>{
    const {width,height}=host.getBoundingClientRect();if(!width || !height)return;
    const previous=Math.max(1,1.15/aspect);aspect=width/height;
    camera.aspect=aspect;camera.updateProjectionMatrix();renderer.setSize(width,height,false);
    camera.position.sub(controls.target).multiplyScalar(Math.max(1,1.15/aspect)/previous).add(controls.target);
    controls.update();render();
  });
  resize.observe(host);setModel(null);resetCamera();
  return {
    setModel,place,resetCamera,
    setWireframe(value:boolean){wireframe=value;applyMaterialMode();render();},
    dispose(){
      if(disposed)return;disposed=true;resize.disconnect();controls.dispose();
      // Imported assets belong to the page; remove them before disposing stage resources.
      holder.clear();reference.dispose();
      disposeModel(scene);
      grid.geometry.dispose();(grid.material as THREE.Material).dispose();
      cage.geometry.dispose();(cage.material as THREE.Material).dispose();
      fitBox.geometry.dispose();(fitBox.material as THREE.Material).dispose();
      renderer.dispose();renderer.forceContextLoss();renderer.domElement.remove();
    },
  };
}
export type ModelPreview=ReturnType<typeof createModelPreview>;
