export interface Grid {
  nx: number;
  ny: number;
  nz: number;
}

// Startup grids, not automotive accuracy presets.
export const STARTER_GRIDS: readonly Grid[] = [
  { nx: 64, ny: 32, nz: 32 },
  { nx: 32, ny: 16, nz: 16 },
  { nx: 16, ny: 8, nz: 8 },
];

export function gridMemory(grid: Grid) {
  const cells = grid.nx * grid.ny * grid.nz;
  const distributionBytes = cells * 19 * 4;
  const flagsBytes = cells * 4;
  const fieldBytes = cells * 8; // rgba16float: velocity xyz + pressure variation
  const uniformBytes = 32;
  return {
    cells,
    distributionBytes,
    flagsBytes,
    fieldBytes,
    uniformBytes,
    totalBytes: distributionBytes * 2 + flagsBytes + fieldBytes + uniformBytes,
  };
}

export function fitsGrid(
  grid: Grid,
  limits: Pick<
    GPUSupportedLimits,
    "maxBufferSize" | "maxStorageBufferBindingSize" | "maxTextureDimension3D"
  >,
) {
  const memory = gridMemory(grid);
  return (
    memory.distributionBytes <= limits.maxBufferSize &&
    memory.distributionBytes <= limits.maxStorageBufferBindingSize &&
    Math.max(grid.nx, grid.ny, grid.nz) <= limits.maxTextureDimension3D
  );
}
