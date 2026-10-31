import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader, DRACO_GLTF_CONFIG } from "three/addons/loaders/DRACOLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";

export interface PreparedAsset {
  root: THREE.Object3D;
  bounds: THREE.Box3;
  name: string;
  bytes: number;
  meshes: number;
  triangles: number;
  notes: string[];
  dispose: () => void;
}

function disposeModels(roots: readonly THREE.Object3D[]) {
  const geometries = new Set<THREE.BufferGeometry>(),
    materials = new Set<THREE.Material>(),
    textures = new Set<THREE.Texture>();
  roots.forEach((root) =>
    root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      geometries.add(object.geometry);
      (Array.isArray(object.material)
        ? object.material
        : [object.material]
      ).forEach((material) => {
        materials.add(material);
        Object.values(material).forEach((value) => {
          if (value instanceof THREE.Texture) textures.add(value);
        });
      });
      if (object instanceof THREE.InstancedMesh) object.dispose();
    }),
  );
  geometries.forEach((g) => g.dispose());
  materials.forEach((m) => m.dispose());
  const bitmaps = new Set<ImageBitmap>();
  textures.forEach((t) => {
    if (typeof ImageBitmap !== "undefined" && t.image instanceof ImageBitmap)
      bitmaps.add(t.image);
    t.dispose();
  });
  bitmaps.forEach((bitmap) => bitmap.close());
  roots.forEach((root) => root.removeFromParent());
}

export function disposeModel(root: THREE.Object3D) {
  disposeModels([root]);
}

export function inspectAsset(
  root: THREE.Object3D,
  name: string,
  bytes = 0,
  notes: string[] = [],
  resources: readonly THREE.Object3D[] = [root],
): PreparedAsset {
  let meshes = 0,
    triangles = 0;
  const lights: THREE.Object3D[] = [];
  root.traverse((object) => {
    if (object instanceof THREE.Light || object instanceof THREE.Camera)
      lights.push(object);
    if (!(object instanceof THREE.Mesh)) return;
    if (object instanceof THREE.SkinnedMesh)
      throw new Error(
        "Export a static mesh without a skeleton for this preparation step.",
      );
    const positions = object.geometry.getAttribute("position");
    if (!positions) return;
    meshes++;
    triangles +=
      Math.floor((object.geometry.index?.count ?? positions.count) / 3) *
      (object instanceof THREE.InstancedMesh ? object.count : 1);
  });
  lights.forEach((light) => light.removeFromParent());
  if (!meshes || !triangles)
    throw new Error("This GLB does not contain a triangle mesh.");
  if (triangles > 500_000)
    throw new Error(
      "This preview supports up to 500,000 triangles. Export a lighter mesh and try again.",
    );
  root.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(root, true),
    size = bounds.getSize(new THREE.Vector3());
  if (
    bounds.isEmpty() ||
    ![
      ...size.toArray(),
      ...bounds.min.toArray(),
      ...bounds.max.toArray(),
    ].every(Number.isFinite) ||
    Math.max(...size.toArray()) <= 0
  )
    throw new Error("The mesh has invalid or empty bounds.");
  if (Math.min(...size.toArray()) < Math.max(...size.toArray()) * 1e-6)
    notes.push("This model is flat. It may not enclose a solid volume.");
  let disposed = false;
  return {
    root,
    bounds,
    name,
    bytes,
    meshes,
    triangles,
    notes,
    dispose: () => {
      if (!disposed) {
        disposed = true;
        disposeModels(resources);
      }
    },
  };
}

export async function loadGlb(file: File): Promise<PreparedAsset> {
  if (!file.name.toLowerCase().endsWith(".glb"))
    throw new Error("Choose a .glb file with embedded geometry and textures.");
  if (file.size > 50 * 1024 * 1024)
    throw new Error("Choose a GLB under 50 MB for this preview.");
  const data = await file.arrayBuffer();
  if (data.byteLength < 20) throw new Error("This file is not a valid GLB.");
  const header = new DataView(data);
  if (
    header.getUint32(0, true) !== 0x46546c67 ||
    header.getUint32(4, true) !== 2 ||
    header.getUint32(8, true) !== data.byteLength
  )
    throw new Error("Choose a valid glTF 2.0 binary (.glb) file.");
  const jsonLength = header.getUint32(12, true);
  if (
    header.getUint32(16, true) !== 0x4e4f534a ||
    20 + jsonLength > data.byteLength
  )
    throw new Error("The GLB metadata is incomplete.");
  let json;
  try {
    json = JSON.parse(
      new TextDecoder().decode(new Uint8Array(data, 20, jsonLength)),
    );
  } catch {
    throw new Error("The GLB metadata could not be read.");
  }
  if (json.extensionsRequired?.includes("KHR_texture_basisu"))
    throw new Error(
      "Export this model with PNG or JPEG textures; KTX2 textures are not supported yet.",
    );
  // Model resources stay local. Decoder scripts are hosted with the app itself.
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (url.startsWith("data:") || url.startsWith("blob:")) return url;
    throw new Error(
      "Use a self-contained GLB with all geometry and textures embedded.",
    );
  });
  const draco = new DRACOLoader()
    .setDecoderPath(DRACO_GLTF_CONFIG)
    .setWorkerLimit(1);
  const loader = new GLTFLoader(manager)
    .setDRACOLoader(draco)
    .setMeshoptDecoder(MeshoptDecoder);
  let roots: THREE.Object3D[] = [];
  try {
    const gltf = await loader.parseAsync(data, "");
    roots = gltf.scenes;
    return inspectAsset(
      gltf.scene,
      file.name,
      file.size,
      gltf.animations.length
        ? ["Animations are held at their initial pose."]
        : [],
      roots,
    );
  } catch (error) {
    disposeModels(roots);
    throw error instanceof Error
      ? error
      : new Error("The GLB could not be opened.");
  } finally {
    draco.dispose();
  }
}

export function createExampleAsset(): PreparedAsset {
  const root = new THREE.Group();
  const paint = new THREE.MeshPhysicalMaterial({
    color: "#92c6c1",
    metalness: 0.35,
    roughness: 0.3,
    clearcoat: 0.6,
  });
  const glass = new THREE.MeshStandardMaterial({
    color: "#253e48",
    metalness: 0.6,
    roughness: 0.2,
    side: THREE.DoubleSide,
  });
  const rubber = new THREE.MeshStandardMaterial({
    color: "#131c22",
    roughness: 0.85,
  });
  const hub = new THREE.MeshStandardMaterial({
    color: "#8dabb4",
    metalness: 0.7,
    roughness: 0.3,
  });
  const profile = new THREE.Shape();
  profile.moveTo(-2.2, 0.45);
  profile.lineTo(-2.05, 0.85);
  profile.lineTo(-1.15, 0.94);
  profile.lineTo(-0.55, 1.45);
  profile.lineTo(0.8, 1.45);
  profile.lineTo(1.4, 0.94);
  profile.lineTo(2.15, 0.8);
  profile.lineTo(2.25, 0.48);
  profile.lineTo(1.9, 0.32);
  profile.lineTo(-1.95, 0.32);
  profile.closePath();
  const body = new THREE.Mesh(
    new THREE.ExtrudeGeometry(profile, {
      depth: 1.65,
      bevelEnabled: true,
      bevelSize: 0.07,
      bevelThickness: 0.07,
      bevelSegments: 3,
      steps: 1,
    }),
    paint,
  );
  body.position.z = -0.825;
  root.add(body);
  // Window panels sit outside the extruded body, separated by a painted pillar.
  for (const z of [-0.902, 0.902]) {
    for (const points of [
      [[-0.99, 1.01], [-0.51, 1.38], [0.02, 1.38], [0.02, 1.01]],
      [[0.12, 1.01], [0.12, 1.38], [0.75, 1.38], [1.18, 1.01]],
    ]) {
      const windowShape = new THREE.Shape();
      points.forEach(([x, y], index) => index ? windowShape.lineTo(x, y) : windowShape.moveTo(x, y));
      windowShape.closePath();
      const pane = new THREE.Mesh(new THREE.ShapeGeometry(windowShape), glass);
      pane.position.z = z;
      root.add(pane);
    }
  }
  for (const x of [-1.35, 1.35])
    for (const z of [-0.9, 0.9]) {
      const wheel = new THREE.Mesh(
        new THREE.CylinderGeometry(0.34, 0.34, 0.22, 32),
        rubber,
      );
      wheel.rotation.x = Math.PI / 2;
      wheel.position.set(x, 0.36, z);
      root.add(wheel);
      const rim = new THREE.Mesh(
        new THREE.CylinderGeometry(0.2, 0.2, 0.23, 24),
        hub,
      );
      rim.rotation.x = Math.PI / 2;
      rim.position.copy(wheel.position);
      root.add(rim);
    }
  return inspectAsset(root, "Reference coupe", 0, [
    "Example geometry for exploring the preparation tools.",
  ]);
}
