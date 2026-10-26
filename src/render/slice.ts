import type { GPUContext } from '../gpu/device';

export type SliceQuantity = 'speed' | 'pressure';

export function halfToFloat(bits: number) {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >>> 10) & 31;
  const fraction = bits & 1023;
  if (exponent === 31) return fraction ? NaN : sign * Infinity;
  return sign * (exponent === 0 ? fraction * 2 ** -24 : (1 + fraction / 1024) * 2 ** (exponent - 15));
}

// Read one XY plane, not the whole simulation. One temporary buffer per request;
// the caller serializes requests and limits their frequency.
export async function readSlice(context: GPUContext, z: number, signal: AbortSignal) {
  signal.throwIfAborted();
  const { device, grid, resources } = context;
  if (!Number.isInteger(z) || z < 0 || z >= grid.nz) throw new Error('Slice is outside the tunnel.');
  const bytesPerRow = Math.ceil(grid.nx * 8 / 256) * 256;
  const buffer = device.createBuffer({ label: 'XY flow slice readback', size: bytesPerRow * grid.ny,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const dispose = () => buffer.destroy();
  signal.addEventListener('abort', dispose, { once: true });
  try {
    const encoder = device.createCommandEncoder({ label: 'Read XY flow slice' });
    encoder.copyTextureToBuffer({ texture: resources.field, origin: { x: 0, y: 0, z } },
      { buffer, bytesPerRow, rowsPerImage: grid.ny },
      { width: grid.nx, height: grid.ny, depthOrArrayLayers: 1 });
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    signal.throwIfAborted();
    const raw = new Uint16Array(buffer.getMappedRange());
    const values = new Float32Array(grid.nx * grid.ny * 4);
    for (let y = 0; y < grid.ny; y++) for (let x = 0; x < grid.nx; x++) {
      const source = y * bytesPerRow / 2 + x * 4;
      const destination = (x + grid.nx * y) * 4;
      for (let channel = 0; channel < 4; channel++) {
        values[destination + channel] = halfToFloat(raw[source + channel]);
      }
      values[destination + 3] /= 3000; // Scaled density deviation -> lattice pressure variation.
    }
    buffer.unmap();
    return values;
  } finally {
    signal.removeEventListener('abort', dispose);
    dispose();
  }
}

const viridis = [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]];
const pressure = [[59, 76, 192], [221, 221, 221], [180, 4, 38]];

export function colorizeSlice(values: Float32Array, quantity: SliceQuantity, extent: number, solidMask?: Uint32Array) {
  if (!Number.isFinite(extent) || extent <= 0 || values.length % 4 !== 0) throw new Error('Invalid slice color scale.');
  const pixels = new Uint8Array(values.length);
  if (solidMask && solidMask.length !== values.length / 4) throw new Error('Solid mask does not match the slice.');
  const colors = quantity === 'speed' ? viridis : pressure;
  let min = Infinity, max = -Infinity, invalidCells = 0;
  for (let offset = 0; offset < values.length; offset += 4) {
    // Transparent holes reveal the obstacle, and solids do not enter fluid extrema.
    if (solidMask && (solidMask[offset / 4] & 1)) continue;
    const value = quantity === 'speed' ? Math.hypot(values[offset], values[offset + 1], values[offset + 2]) : values[offset + 3];
    if (!Number.isFinite(value)) {
      pixels.set([255, 0, 255, 255], offset);
      invalidCells++;
      continue;
    }
    min = Math.min(min, value);
    max = Math.max(max, value);
    const t = Math.min(1, Math.max(0, quantity === 'speed' ? value / extent : 0.5 + value / (2 * extent)));
    const scaled = t * (colors.length - 1);
    const a = Math.min(colors.length - 2, Math.floor(scaled));
    const fraction = scaled - a;
    for (let channel = 0; channel < 3; channel++) pixels[offset + channel] = Math.round(colors[a][channel] * (1 - fraction) + colors[a + 1][channel] * fraction);
    pixels[offset + 3] = 255;
  }
  return { pixels, min, max, invalidCells };
}
