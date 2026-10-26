import type { Grid } from "../../src/gpu/grid";
import type { SolverSettings } from "../../src/sim/settings";

// Deliberately simple, double-precision CPU reference; never used for interactive simulation.
export const directions = [
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
];
export function equilibrium(rho: number, velocity: number[]) {
  return directions.map((c) => {
    const norm = c.reduce((sum, value) => sum + value * value, 0);
    const weight = norm === 0 ? 1 / 3 : norm === 1 ? 1 / 18 : 1 / 36;
    const cu = c.reduce((sum, value, axis) => sum + value * velocity[axis], 0);
    return (
      weight *
      rho *
      (1 +
        3 * cu +
        4.5 * cu * cu -
        1.5 * velocity.reduce((sum, value) => sum + value * value, 0))
    );
  });
}
export function initialField(grid: Grid, uniform = false) {
  const n = grid.nx * grid.ny * grid.nz;
  const field = new Float64Array(19 * n);
  for (let z = 0; z < grid.nz; z++)
    for (let y = 0; y < grid.ny; y++)
      for (let x = 0; x < grid.nx; x++) {
        const rho = uniform
          ? 1
          : 1 +
            0.002 *
              Math.cos((2 * Math.PI * x) / grid.nx) *
              Math.sin((2 * Math.PI * z) / grid.nz);
        const velocity = uniform
          ? [0.02, 0, 0]
          : [
              0.01 * Math.sin((2 * Math.PI * y) / grid.ny),
              0.005 * Math.cos((2 * Math.PI * z) / grid.nz),
              0.004 * Math.sin((2 * Math.PI * x) / grid.nx),
            ];
        equilibrium(rho, velocity).forEach((value, i) => {
          field[i * n + x + grid.nx * (y + grid.ny * z)] = value;
        });
      }
  return field;
}
export function cpuStep(
  source: Float64Array,
  grid: Grid,
  settings: SolverSettings,
  step: number,
) {
  const n = grid.nx * grid.ny * grid.nz;
  const output = new Float64Array(source.length);
  const node = (x: number, y: number, z: number) =>
    x + grid.nx * (y + grid.ny * z);
  const t = Math.min(step / settings.rampSteps, 1);
  const inlet = equilibrium(1, [
    settings.targetSpeed * t * t * (3 - 2 * t),
    0,
    0,
  ]);
  for (let z = 0; z < grid.nz; z++)
    for (let y = 0; y < grid.ny; y++)
      for (let x = 0; x < grid.nx; x++) {
        const destination = node(x, y, z);
        if (settings.boundaryMode !== "periodic" && x === 0) {
          inlet.forEach((value, i) => {
            output[i * n + destination] = value;
          });
          continue;
        }
        if (settings.boundaryMode !== "periodic" && x === grid.nx - 1) {
          for (let i = 0; i < 19; i++)
            output[i * n + destination] = source[i * n + node(x - 1, y, z)];
          continue;
        }
        const populations = directions.map((c, i) => {
          let [sx, sy, sz] = [x - c[0], y - c[1], z - c[2]];
          let incoming = i;
          if (settings.boundaryMode === "free-slip") {
            const reflected = [...c];
            if (sy < 0 || sy >= grid.ny) {
              sy = y;
              reflected[1] *= -1;
            }
            if (sz < 0 || sz >= grid.nz) {
              sz = z;
              reflected[2] *= -1;
            }
            incoming = directions.findIndex((direction) =>
              direction.every((v, axis) => v === reflected[axis]),
            );
          } else {
            sy = (sy + grid.ny) % grid.ny;
            sz = (sz + grid.nz) % grid.nz;
          }
          if (settings.boundaryMode === "periodic")
            sx = (sx + grid.nx) % grid.nx;
          return source[incoming * n + node(sx, sy, sz)];
        });
        const rho = populations.reduce((sum, value) => sum + value, 0);
        const velocity = [0, 1, 2].map(
          (axis) =>
            populations.reduce(
              (sum, value, i) => sum + value * directions[i][axis],
              0,
            ) / rho,
        );
        const eq = equilibrium(rho, velocity);
        populations.forEach((value, i) => {
          output[i * n + destination] = value - (value - eq[i]) / settings.tau;
        });
      }
  return output;
}
