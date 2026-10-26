import type { Grid } from "../gpu/grid";
import type { Obstacle } from "../geometry/sphere";

export const LATTICE_DIRECTIONS = [
  [0, 0, 0],
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
  [1, 1, 0],
  [-1, -1, 0],
  [1, -1, 0],
  [-1, 1, 0],
  [1, 0, 1],
  [-1, 0, -1],
  [1, 0, -1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, -1],
  [0, 1, -1],
  [0, -1, 1],
] as const;

export interface ForceSample {
  step: number;
  drag: number;
  lift: number;
  side: number;
  cd: number | null;
  cl: number | null;
  cs: number | null;
  reynolds: number | null;
  referenceSpeed: number;
  referenceArea: number;
  rampComplete: boolean;
}

// Outgoing links only: each pair is the fluid node and direction INTO the body.
export function buildSurfaceLinks(grid: Grid, obstacle: Obstacle) {
  if (!obstacle.solidCells) return new Uint32Array();
  const links: number[] = [];
  for (let z = 0; z < grid.nz; z++)
    for (let y = 0; y < grid.ny; y++)
      for (let x = 0; x < grid.nx; x++) {
        const node = x + grid.nx * (y + grid.ny * z);
        if (obstacle.solidFlags[node] & 1) continue;
        for (let direction = 1; direction < 19; direction++) {
          const [cx, cy, cz] = LATTICE_DIRECTIONS[direction];
          const [sx, sy, sz] = [x + cx, y + cy, z + cz];
          if (
            sx < 0 ||
            sx >= grid.nx ||
            sy < 0 ||
            sy >= grid.ny ||
            sz < 0 ||
            sz >= grid.nz
          )
            continue;
          if (obstacle.solidFlags[sx + grid.nx * (sy + grid.ny * sz)] & 1)
            links.push(node, direction);
        }
      }
  return new Uint32Array(links);
}

export function forceSample(
  step: number,
  force: readonly number[],
  speed: number,
  diameter: number,
  tau: number,
  rampComplete: boolean,
): ForceSample {
  if (force.length !== 3 || force.some((value) => !Number.isFinite(value)))
    throw new Error("Invalid aerodynamic force readback.");
  if (
    !Number.isFinite(speed) ||
    speed < 0 ||
    !Number.isFinite(diameter) ||
    diameter < 0 ||
    !Number.isFinite(tau) ||
    tau <= 0.5
  )
    throw new Error("Invalid force reference parameters.");
  const area = (Math.PI * diameter * diameter) / 4;
  // Reference density = 1 in lattice units. This is nominal inlet normalization,
  // not a claim that local flow has converged to a uniform free stream.
  const denominator = 0.5 * speed * speed * area;
  const usable = diameter > 0 && Number.isFinite(speed) && speed >= 1e-5;
  return {
    step,
    drag: force[0],
    lift: force[1],
    side: force[2],
    cd: usable ? force[0] / denominator : null,
    cl: usable ? force[1] / denominator : null,
    cs: usable ? force[2] / denominator : null,
    reynolds: usable ? (speed * diameter) / ((tau - 0.5) / 3) : null,
    referenceSpeed: speed,
    referenceArea: area,
    rampComplete,
  };
}

// Empirical isolated-sphere comparison, not a finite-tunnel correction or calibration.
export function schillerNaumann(reynolds: number) {
  if (!Number.isFinite(reynolds) || reynolds <= 0 || reynolds > 800)
    return null;
  return (24 / reynolds) * (1 + 0.15 * reynolds ** 0.687);
}
