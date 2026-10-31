import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Grid } from '../gpu/grid';
import type { Obstacle } from '../geometry/sphere';
import { createTracerView } from './tracer-view';
import type { TracerFrame } from './tracer-seeds';
import { createFilamentView } from './filament-view';
import type { FilamentFrame as SmokeFrame } from './filaments';

export function createTunnelView(container: HTMLDivElement, grid: Grid, obstacle?: Obstacle) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.domElement.setAttribute('aria-label', 'Orbitable 3D wind tunnel with smoke and an optional flow slice');
  renderer.domElement.setAttribute('role', 'img');
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#080f19');
  const tracers = createTracerView(grid);
  scene.add(tracers.group);
  const width = grid.nx / grid.ny;
  const depth = grid.nz / grid.ny;
  const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
  const controls = new OrbitControls(camera, renderer.domElement);
  let fitScale = 1;
  controls.minDistance = 0.6;
  controls.maxDistance = 12;
  const smoke = createFilamentView(grid);
  scene.add(smoke.mesh);
  let running=false, animation=0, lastDraw=0;
  function render() {
    renderer.domElement.dataset.smokeTime=String(smoke.sample(performance.now()));
    renderer.render(scene,camera);
  }
  function animate(now:number) {
    if(!running)return;
    // Keep decorative smoke animation inexpensive on integrated GPUs.
    if(!document.hidden && smoke.mesh.visible && now-lastDraw>=1000/30){render();lastDraw=now;}
    animation=requestAnimationFrame(animate);
  }
  function resetCamera() {
    camera.position.set(width * 0.22, 0.45, Math.max(depth * 2.5, 2.2));
    camera.position.multiplyScalar(fitScale);
    controls.target.set(0, 0, 0);
    controls.update();
    render();
  }

  const box = new THREE.BoxGeometry(width, 1, depth);
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(box), new THREE.LineBasicMaterial({ color: '#304052', transparent: true, opacity: 0.55 }));
  box.dispose();
  scene.add(edges);

  const texture = new THREE.DataTexture(new Uint8Array(grid.nx * grid.ny * 4), grid.nx, grid.ny);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.needsUpdate = true;
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(width, 1),
    new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide, toneMapped: false, transparent: true, opacity: 0.2, depthWrite: false, alphaTest: 0.01 }));
  plane.visible = false;
  scene.add(plane);
  let sliceVisible = true, gridVisible = false, hasSlice = false;

  const sphere = obstacle?.sphere;
  let smoothBody: THREE.Mesh | undefined;
  let voxelBody: THREE.InstancedMesh | undefined;
  if (sphere && obstacle) {
    scene.add(new THREE.HemisphereLight('#c8e2ff', '#253045', 1.3));
    const light = new THREE.DirectionalLight('#ffffff', 2.8);
    light.position.set(-2, 3, 4);
    scene.add(light);
    smoothBody = new THREE.Mesh(new THREE.SphereGeometry(sphere.radius/grid.ny, 40, 24),
      new THREE.MeshStandardMaterial({ color: '#459ca9', roughness: 0.28, metalness: 0.4 }));
    smoothBody.position.set(sphere.center[0]/grid.ny-width/2, sphere.center[1]/grid.ny-0.5, sphere.center[2]/grid.ny-depth/2);
    scene.add(smoothBody);
    voxelBody = new THREE.InstancedMesh(new THREE.BoxGeometry(1/grid.ny, 1/grid.ny, 1/grid.ny),
      new THREE.MeshStandardMaterial({ color: '#a9bed5', roughness: 0.65, metalness: 0.08 }), obstacle.solidCells);
    const matrix = new THREE.Matrix4();
    let instance = 0;
    for (let z = 0; z < grid.nz; z++) for (let y = 0; y < grid.ny; y++) for (let x = 0; x < grid.nx; x++) {
      if (obstacle.solidFlags[x+grid.nx*(y+grid.ny*z)] & 1) {
        matrix.makeTranslation((x+0.5)/grid.ny-width/2, (y+0.5)/grid.ny-0.5, (z+0.5)/grid.ny-depth/2);
        voxelBody.setMatrixAt(instance++, matrix);
      }
    }
    voxelBody.instanceMatrix.needsUpdate = true;
    voxelBody.visible = false;
    scene.add(voxelBody);
  }

  const positions: number[] = [];
  for (let x = 0; x <= grid.nx; x++) {
    const position = x / grid.ny - width / 2;
    positions.push(position, -0.5, 0, position, 0.5, 0);
  }
  for (let y = 0; y <= grid.ny; y++) {
    const position = y / grid.ny - 0.5;
    positions.push(-width / 2, position, 0, width / 2, position, 0);
  }
  const lines = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)),
    new THREE.LineBasicMaterial({ color: '#d6edff', transparent: true, opacity: 0.25, depthTest: false }));
  lines.renderOrder = 1;
  lines.visible = false;
  scene.add(lines);
  const axes = new THREE.AxesHelper(0.3);
  axes.position.set(-width / 2, -0.65, depth / 2);
  scene.add(axes);
  const arrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(-width * 0.3, 0.58, 0), width * 0.6, '#67e8f9', 0.09, 0.06);
  scene.add(arrow);

  function label(text: string, x: number, color: string) {
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = color;
    ctx.font = '500 26px Segoe UI, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, 128, 32);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false }));
    sprite.scale.set(0.6, 0.15, 1);
    sprite.position.set(x, 0.65, 0);
    scene.add(sprite);
  }
  label('INLET', -width / 2, '#67e8f9');
  label('OUTLET', width / 2, '#94a3b8');
  const cameraChanged = () => render();
  controls.addEventListener('change', cameraChanged);
  const resize = new ResizeObserver(() => {
    const { width, height } = container.getBoundingClientRect();
    if (!width || !height) return;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    // Keep the same horizontal framing on portrait screens without resetting orbit.
    const nextScale = Math.max(1, 1.5 / camera.aspect);
    camera.position.sub(controls.target).multiplyScalar(nextScale / fitScale).add(controls.target);
    fitScale = nextScale;
    controls.update();
    render();
  });
  resize.observe(container);
  resetCamera();

  return {
    canvas: renderer.domElement,
    resetCamera,
    sideView() {
      camera.position.set(0,0,Math.max(depth*2.8,2.8)).multiplyScalar(fitScale);
      controls.target.set(0,0,0); controls.update(); render();
    },
    setRunning(value:boolean) {
      running=value;smoke.setRunning(value);cancelAnimationFrame(animation);
      if(value)animation=requestAnimationFrame(animate);else render();
    },
    setSmoke(frame: SmokeFrame | null) {
      const segments=smoke.update(frame);
      renderer.domElement.dataset.smokeStep=String(frame?.step ?? 0);
      renderer.domElement.dataset.smokeLines=String(frame?.lines ?? 0);
      renderer.domElement.dataset.smokeSegments=String(segments);
      if(!running || !frame)render();
    },
    setSliceOpacity(opacity: number) { plane.material.opacity = opacity; render(); },
    setTracers(frame: TracerFrame | null) {
      const state = tracers.update(frame);
      renderer.domElement.dataset.tracerStep = String(state.step);
      renderer.domElement.dataset.tracerCount = String(state.count);
      renderer.domElement.dataset.tracerSegments = String(state.segments);
      render();
    },
    setGrid(visible: boolean) { gridVisible = visible; lines.visible = visible && sliceVisible; render(); },
    setSliceVisible(visible: boolean) { sliceVisible = visible; plane.visible = visible && hasSlice; lines.visible = visible && gridVisible; render(); },
    setVoxelBody(visible: boolean) { if (smoothBody) smoothBody.visible = !visible; if (voxelBody) voxelBody.visible = visible; render(); },
    setSlice(z: number, pixels: Uint8Array) {
      hasSlice = true;
      plane.visible = sliceVisible;
      (texture.image.data as Uint8Array).set(pixels);
      texture.needsUpdate = true;
      plane.position.z = (z + 0.5) / grid.ny - depth / 2;
      lines.position.z = plane.position.z;
      render();
    },
    dispose() {
      running=false;cancelAnimationFrame(animation);
      resize.disconnect();
      controls.dispose();
      const textures = new Set<THREE.Texture>();
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Sprite || object instanceof THREE.Points) {
          if ('geometry' in object) object.geometry.dispose();
          if (object instanceof THREE.InstancedMesh) object.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach((material) => {
            if ('map' in material && material.map instanceof THREE.Texture) textures.add(material.map);
            material.dispose();
          });
        }
      });
      textures.forEach((texture) => texture.dispose());
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
}

export type TunnelView = ReturnType<typeof createTunnelView>;
