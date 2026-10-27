import type { Grid } from '../gpu/grid';
import type { Obstacle } from '../geometry/sphere';

export const TRACER_COUNT = 768;
export interface TracerFrame { positions: Float32Array; step: number }

export function seedTracers(grid: Grid, obstacle: Obstacle, count = TRACER_COUNT) {
  const positions = new Float32Array(count*4);
  let state = 123456789;
  const random = () => { state = (Math.imul(state,1664525)+1013904223) >>> 0; return state/4294967296; };
  for (let i = 0; i < count; i++) {
    let x = 0, y = 0, z = 0;
    for (let attempt = 0; attempt < 32; attempt++) {
      x = 1.25+random()*(grid.nx-2.75); y = 1+random()*(grid.ny-2); z = 1+random()*(grid.nz-2);
      if (!(obstacle.solidFlags[Math.floor(x)+grid.nx*(Math.floor(y)+grid.ny*Math.floor(z))] & 1)) break;
      x = 1.25;
    }
    positions.set([x,y,z,0], i*4);
  }
  return positions;
}
