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
export function cpuWallReflection(source: Float64Array, grid: Grid, settings: SolverSettings, flags: Uint32Array, node: number, incoming: number) {
  const c = directions[incoming], n = flags.length;
  const opposite = directions.findIndex(d => d.every((v,a) => v === -c[a]));
  const outgoing = source[opposite*n+node];
  if (settings.wallBoundary === 'halfway') return outgoing;
  const x = node%grid.nx, y = Math.floor(node/grid.nx)%grid.ny, z = Math.floor(node/(grid.nx*grid.ny));
  const center = settings.sphereCenter ?? [grid.nx*0.3,grid.ny/2,grid.nz/2];
  const radius = settings.sphereRadius ?? Math.min(grid.ny,grid.nz)*0.115;
  const v = [x+0.5-center[0],y+0.5-center[1],z+0.5-center[2]];
  const a = c.reduce((s,v) => s+v*v,0), b = -v.reduce((s,v,i) => s+v*c[i],0);
  const delta = v.reduce((s,v) => s+v*v,0)-radius*radius;
  const q = (-b-Math.sqrt(Math.max(0,b*b-a*delta)))/a;
  if(q < 0.5) {
    const [ax,ay,az]=[x+c[0],y+c[1],z+c[2]];
    const away = ax+grid.nx*(ay+grid.ny*az);
    if(ax<0 || ax>=grid.nx || ay<0 || ay>=grid.ny || az<0 || az>=grid.nz || flags[away]&1) return outgoing;
    return 2*q*outgoing+(1-2*q)*source[opposite*n+away];
  }
  return outgoing/(2*q)+(1-1/(2*q))*source[incoming*n+node];
}
export function cpuStep(
  source: Float64Array,
  grid: Grid,
  settings: SolverSettings,
  step: number,
  solidFlags?: Uint32Array,
) {
  if (settings.obstacle !== 'none' && !solidFlags) throw new Error('Obstacle reference requires solid flags.');
  const n = grid.nx * grid.ny * grid.nz;
  const output = new Float64Array(source.length);
  const node = (x: number, y: number, z: number) =>
    x + grid.nx * (y + grid.ny * z);
  const t = Math.min(step / settings.rampSteps, 1);
  const closedX = settings.boundaryMode === 'periodic' || settings.boundaryMode === 'channel';
  for (let z = 0; z < grid.nz; z++)
    for (let y = 0; y < grid.ny; y++)
      for (let x = 0; x < grid.nx; x++) {
        const destination = node(x, y, z);
        if (solidFlags && (solidFlags[destination] & 1)) continue;
        if (!closedX && x === grid.nx-1) {
          for(let i=0;i<19;i++) output[i*n+destination]=source[i*n+node(x-1,y,z)];
          continue;
        }
        if (!closedX && x === 0) {
          const adjacent = node(1,y,z);
          const f = directions.map((_,i)=>source[i*n+adjacent]);
          const rho = f.reduce((sum,v)=>sum+v,0);
          const u = [0,1,2].map(axis=>directions.reduce((sum,c,i)=>sum+c[axis]*f[i],0)/rho);
          const neighborEq = equilibrium(rho,u);
          const boundaryEq = equilibrium(rho,[settings.targetSpeed*t*t*(3-2*t),0,0]);
          f.forEach((v,i)=>{ output[i*n+destination] = boundaryEq[i]+v-neighborEq[i]; });
          continue;
        }
        const populations = directions.map((c, i) => {
          let [sx, sy, sz] = [x - c[0], y - c[1], z - c[2]];
          let incoming = i;
          if (settings.boundaryMode === 'channel' && (sy < 0 || sy >= grid.ny)) {
            const opposite = directions.findIndex((direction) => direction.every((value, axis) => value === -c[axis]));
            return source[opposite*n+destination];
          }
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
          if (closedX)
            sx = (sx + grid.nx) % grid.nx;
          const upstream = node(sx, sy, sz);
          if (solidFlags && (solidFlags[upstream] & 1)) {
            return cpuWallReflection(source,grid,settings,solidFlags,destination,i);
          }
          return source[incoming * n + upstream];
        });
        const rho = populations.reduce((sum, value) => sum + value, 0);
        const velocity = [0, 1, 2].map(
          (axis) =>
            populations.reduce(
              (sum, value, i) => sum + value * directions[i][axis],
              0,
            ) / rho,
        );
        velocity[0] += settings.acceleration/2;
        const eq = equilibrium(rho, velocity);
        populations.forEach((value, i) => {
          const c = directions[i];
          const norm = c.reduce((sum, v) => sum+v*v, 0);
          const weight = norm === 0 ? 1/3 : norm === 1 ? 1/18 : 1/36;
          const cu = c.reduce((sum, v, axis) => sum+v*velocity[axis], 0);
          const forcing = weight*(1-1/(2*settings.tau))*rho*settings.acceleration*(3*(c[0]-velocity[0])+9*cu*c[0]);
          output[i * n + destination] = value - (value - eq[i]) / settings.tau + forcing;
        });
      }
  return output;
}
