import { Box3, Euler, Matrix4, Vector3 } from "three";

export type ModelRotation = readonly [number, number, number];
export const PREVIEW_TUNNEL = new Vector3(2, 1, 1);
const FIT_REGION = new Vector3(0.8, 0.38, 0.55);
const PLACEMENT = new Vector3(-0.35, 0, 0);

export interface ModelPlacement {
  matrix: Matrix4;
  scale: number;
  normalizedSize: Vector3;
  physicalSize: Vector3;
  physicalScale: number;
  metresPerTunnelUnit: number;
}

/** The same matrix can transform rendering and future voxelisation geometry. */
export function normalizeModel(
  bounds: Box3,
  rotation: ModelRotation,
  physicalLength: number,
): ModelPlacement {
  const size = bounds.getSize(new Vector3()),
    center = bounds.getCenter(new Vector3());
  const longest = Math.max(size.x, size.y, size.z);
  if (
    bounds.isEmpty() ||
    ![...size.toArray(), ...center.toArray()].every(Number.isFinite) ||
    longest <= 0
  )
    throw new Error("This model has no usable dimensions.");
  if (!Number.isFinite(physicalLength) || physicalLength <= 0)
    throw new Error("Enter a physical length greater than zero.");
  if (!rotation.every(Number.isFinite))
    throw new Error("Invalid model orientation.");
  const r = new Matrix4().makeRotationFromEuler(
    new Euler(
      ...(rotation.map((v) => (v * Math.PI) / 180) as [number, number, number]),
      "XYZ",
    ),
  );
  const rotated = new Box3();
  for (const x of [-0.5, 0.5])
    for (const y of [-0.5, 0.5])
      for (const z of [-0.5, 0.5])
        rotated.expandByPoint(
          new Vector3(x * size.x, y * size.y, z * size.z).applyMatrix4(r),
        );
  const orientedSize = rotated.getSize(new Vector3());
  const scale = Math.min(
    ...orientedSize
      .toArray()
      .map((v, i) => (v > 1e-12 ? FIT_REGION.getComponent(i) / v : Infinity)),
  );
  const matrix = new Matrix4()
    .makeTranslation(...PLACEMENT.toArray())
    .multiply(new Matrix4().makeScale(scale, scale, scale))
    .multiply(r)
    .multiply(new Matrix4().makeTranslation(-center.x, -center.y, -center.z));
  const physicalScale = physicalLength / longest;
  return {
    matrix,
    scale,
    normalizedSize: orientedSize.clone().multiplyScalar(scale),
    physicalSize: orientedSize.multiplyScalar(physicalScale),
    physicalScale,
    metresPerTunnelUnit: physicalScale / scale,
  };
}
