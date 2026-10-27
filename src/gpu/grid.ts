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

// Resource presets, not accuracy guarantees. The physical domain stays fixed.
export const RESOLUTION_PRESETS = [
  { id: 'standard', label: 'Standard', grid: { nx: 64, ny: 32, nz: 32 } },
  { id: 'fine', label: 'Fine', grid: { nx: 96, ny: 48, nz: 48 } },
  { id: 'high', label: 'High', grid: { nx: 128, ny: 64, nz: 64 } },
  { id: 'extra', label: 'Extra', grid: { nx: 160, ny: 80, nz: 80 } },
] as const;

export function resolutionScale(grid: Grid) { return grid.ny / 32; }

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
