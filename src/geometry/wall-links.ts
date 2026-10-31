import type { Grid } from "../gpu/grid";
import type { Obstacle } from "./sphere";
import { LATTICE_DIRECTIONS } from "../sim/forces";

// Bits 0..2 retain solid/inlet/outlet flags; higher bits index surface nodes.
// Store 19 distances only at those nodes, not at every cell in the tunnel.
export function buildWallLinks(
  grid: Grid,
  obstacle: Obstacle,
  links: Uint32Array,
  interpolate: boolean,
) {
  const flags = obstacle.solidFlags.slice();
  if (!interpolate || !obstacle.sphere)
    return { flags, fractions: new Float32Array([0.5]), nodes: 0 };
  const slots = new Map<number, number>();
  for (let i = 0; i < links.length; i += 2)
    if (!slots.has(links[i])) slots.set(links[i], slots.size);
  const fractions = new Float32Array(Math.max(1, slots.size * 19)).fill(0.5);
  const { center, radius } = obstacle.sphere;
  for (let i = 0; i < links.length; i += 2) {
    const node = links[i],
      direction = links[i + 1],
      slot = slots.get(node)!;
    flags[node] |= (slot + 1) << 3;
    const [dx, dy, dz] = LATTICE_DIRECTIONS[direction];
    const x = node % grid.nx,
      y = Math.floor(node / grid.nx) % grid.ny,
      z = Math.floor(node / (grid.nx * grid.ny));
    const v = [x + 0.5 - center[0], y + 0.5 - center[1], z + 0.5 - center[2]];
    const a = dx * dx + dy * dy + dz * dz,
      b = v[0] * dx + v[1] * dy + v[2] * dz;
    const c =
      v.reduce((sum, value) => sum + value * value, 0) - radius * radius;
    // Stable near-root of |v+q*d|^2 = radius^2.
    const q = c / (-b + Math.sqrt(Math.max(0, b * b - a * c)));
    if (!Number.isFinite(q) || q <= 0 || q > 1 + 1e-9)
      throw new Error("Invalid fluid-to-surface intersection.");
    const opposite = LATTICE_DIRECTIONS.findIndex(
      (d) => d[0] === -dx && d[1] === -dy && d[2] === -dz,
    );
    const ax = x - dx,
      ay = y - dy,
      az = z - dz;
    const awayValid =
      ax >= 0 &&
      ax < grid.nx &&
      ay >= 0 &&
      ay < grid.ny &&
      az >= 0 &&
      az < grid.nz &&
      !(flags[ax + grid.nx * (ay + grid.ny * az)] & 1);
    // A concave/underresolved gap can lack the second fluid sample.
    fractions[slot * 19 + opposite] =
      q < 0.5 && !awayValid ? 0.5 : Math.min(q, 1);
  }
  return { flags, fractions, nodes: slots.size };
}
