import type { Grid } from "../gpu/grid";

export type ObstacleKind = "none" | "sphere";
export interface Sphere {
  center: readonly [number, number, number];
  radius: number;
}
export interface Obstacle {
  kind: ObstacleKind;
  sphere: Sphere | null;
  solidFlags: Uint32Array;
  solidCells: number;
  blockage: number;
}

// Coordinates describe cell boxes [x,x+1] with centers at x+0.5.
export function createObstacle(
  grid: Grid,
  kind: ObstacleKind = "none",
  radiusOverride?: number,
  centerOverride?: readonly [number, number, number],
): Obstacle {
  const solidFlags = new Uint32Array(grid.nx * grid.ny * grid.nz);
  if (kind === "none")
    return { kind, sphere: null, solidFlags, solidCells: 0, blockage: 0 };
  if (kind !== "sphere") throw new Error("Unknown static obstacle.");
  const sphere: Sphere = {
    center: centerOverride ?? [grid.nx * 0.3, grid.ny / 2, grid.nz / 2],
    radius: radiusOverride ?? Math.min(grid.ny, grid.nz) * 0.115,
  };
  if (sphere.center.length !== 3 || sphere.center.some((value) => !Number.isFinite(value))) throw new Error('Sphere center must have three finite coordinates.');
  if (sphere.center.some((value, axis) => value-sphere.radius <= 1 || value+sphere.radius >= [grid.nx, grid.ny, grid.nz][axis]-1)) {
    throw new Error('The sphere needs at least one fluid cell of clearance from every boundary.');
  }
  if (
    !Number.isFinite(sphere.radius) ||
    sphere.radius <= 0 ||
    sphere.radius >= Math.min(grid.ny, grid.nz) / 2 - 1
  ) {
    throw new Error(
      "Sphere radius must be positive and leave space at the tunnel sides.",
    );
  }
  if (
    sphere.center[0] - sphere.radius <= 1 ||
    sphere.center[0] + sphere.radius >= grid.nx - 1
  ) {
    throw new Error("The sphere needs space between the inlet and outlet.");
  }
  let solidCells = 0,
    frontalCells = 0;
  for (let z = 0; z < grid.nz; z++)
    for (let y = 0; y < grid.ny; y++) {
      let blocked = false;
      for (let x = 0; x < grid.nx; x++) {
        const distanceSquared =
          (x + 0.5 - sphere.center[0]) ** 2 +
          (y + 0.5 - sphere.center[1]) ** 2 +
          (z + 0.5 - sphere.center[2]) ** 2;
        if (distanceSquared <= sphere.radius ** 2) {
          solidFlags[x + grid.nx * (y + grid.ny * z)] = 1;
          solidCells++;
          blocked = true;
        }
      }
      if (blocked) frontalCells++;
    }
  if (!solidCells) throw new Error("This grid cannot resolve the sphere.");
  return {
    kind,
    sphere,
    solidFlags,
    solidCells,
    blockage: frontalCells / (grid.ny * grid.nz),
  };
}

export function obstacleSlice(obstacle: Obstacle, grid: Grid, z: number) {
  return obstacle.solidFlags.subarray(
    z * grid.nx * grid.ny,
    (z + 1) * grid.nx * grid.ny,
  );
}
