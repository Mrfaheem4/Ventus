import { gridMemory } from "./grid";
import type { Grid } from "./grid";

export function allocateGrid(device: GPUDevice, grid: Grid) {
  const memory = gridMemory(grid);
  const resources: Array<GPUBuffer | GPUTexture> = [];
  const destroy = () => resources.forEach((resource) => resource.destroy());
  function buffer(label: string, size: number, usage: GPUBufferUsageFlags) {
    const resource = device.createBuffer({ label, size, usage });
    resources.push(resource);
    return resource;
  }
  try {
    const usage =
      GPUBufferUsage.STORAGE |
      GPUBufferUsage.COPY_DST |
      GPUBufferUsage.COPY_SRC;
    const distributions = [
      buffer("D3Q19 distributions A", memory.distributionBytes, usage),
      buffer("D3Q19 distributions B", memory.distributionBytes, usage),
    ] as const;
    const flags = buffer("Cell flags", memory.flagsBytes, usage);
    const params = buffer(
      "Simulation parameters",
      memory.uniformBytes,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
    const field = device.createTexture({
      label: "Velocity and pressure field",
      dimension: "3d",
      size: { width: grid.nx, height: grid.ny, depthOrArrayLayers: grid.nz },
      format: "rgba16float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    resources.push(field);
    return { distributions, flags, params, field, destroy };
  } catch (error) {
    destroy();
    throw error;
  }
}
