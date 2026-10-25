// Independent CPU reference for the ordering in README section 5.
const DIRECTIONS = [
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

export function checkRestDistributions(values: Float32Array) {
  if (values.length !== 19) throw new Error("Expected 19 D3Q19 distributions.");
  let density = 0;
  const momentum = [0, 0, 0];
  let maxPopulationError = 0;
  values.forEach((value, i) => {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error("Fluid initialization produced an invalid distribution.");
    }
    const expected = i === 0 ? 1 / 3 : i <= 6 ? 1 / 18 : 1 / 36;
    maxPopulationError = Math.max(
      maxPopulationError,
      Math.abs(value - expected),
    );
    density += value;
    for (let axis = 0; axis < 3; axis++)
      momentum[axis] += value * DIRECTIONS[i][axis];
  });
  const speed = Math.hypot(...momentum) / density;
  const densityError = Math.abs(density - 1);
  if (
    !Number.isFinite(speed) ||
    densityError > 1e-6 ||
    speed > 1e-6 ||
    maxPopulationError > 1e-6
  ) {
    throw new Error(
      "Fluid initialization failed the density, velocity, or equilibrium check.",
    );
  }
  return { density, speed, densityError, maxPopulationError };
}
