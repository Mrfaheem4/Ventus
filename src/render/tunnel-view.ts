import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Grid } from '../gpu/grid';

export function createTunnelView(container: HTMLDivElement, grid: Grid) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.setAttribute('aria-label', 'Orbitable 3D wind tunnel with a colored XY flow slice');
  renderer.domElement.setAttribute('role', 'img');
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#06101d');
  const width = grid.nx / grid.ny;
  const depth = grid.nz / grid.ny;
  const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
  const controls = new OrbitControls(camera, renderer.domElement);
  let fitScale = 1;
  controls.minDistance = 0.6;
  controls.maxDistance = 12;
  function render() { renderer.render(scene, camera); }
  function resetCamera() {
    camera.position.set(width * 1.05, 1.1, Math.max(depth * 2.7, 2.2));
    camera.position.multiplyScalar(fitScale);
    controls.target.set(0, 0, 0);
    controls.update();
    render();
  }

  const box = new THREE.BoxGeometry(width, 1, depth);
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(box), new THREE.LineBasicMaterial({ color: '#456582' }));
  box.dispose();
  scene.add(edges);

  const texture = new THREE.DataTexture(new Uint8Array(grid.nx * grid.ny * 4), grid.nx, grid.ny);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.needsUpdate = true;
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(width, 1),
    new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide, toneMapped: false }));
  plane.visible = false;
  scene.add(plane);

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
  const arrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(-width * 0.3, 0.7, 0), width * 0.6, '#67e8f9', 0.09, 0.06);
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
    sprite.position.set(x, 0.87, 0);
    scene.add(sprite);
  }
  label('INLET', -width / 2, '#67e8f9');
  label('OUTLET', width / 2, '#94a3b8');
  controls.addEventListener('change', render);
  const resize = new ResizeObserver(() => {
    const { width, height } = container.getBoundingClientRect();
    if (!width || !height) return;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    // Keep the same horizontal framing on portrait screens without resetting orbit.
    const nextScale = Math.max(1, 1 / camera.aspect);
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
    setGrid(visible: boolean) { lines.visible = visible; render(); },
    setSlice(z: number, pixels: Uint8Array) {
      plane.visible = true;
      (texture.image.data as Uint8Array).set(pixels);
      texture.needsUpdate = true;
      plane.position.z = (z + 0.5) / grid.ny - depth / 2;
      lines.position.z = plane.position.z;
      render();
    },
    dispose() {
      resize.disconnect();
      controls.dispose();
      const textures = new Set<THREE.Texture>();
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Sprite) {
          if ('geometry' in object) object.geometry.dispose();
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
