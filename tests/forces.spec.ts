/// <reference types="@webgpu/types" />
import { expect, test } from "@playwright/test";
import { createObstacle } from "../src/geometry/sphere";
import {
  buildSurfaceLinks,
  forceSample,
  schillerNaumann,
} from "../src/sim/forces";
import { DEFAULT_SETTINGS, validateSettings } from "../src/sim/settings";
import { cpuStep, directions, initialField } from "./cpu_reference/d3q19";

test.beforeEach(async ({ page }) => {
  // Force measurements must survive development-server hot-reload messages.
  // Navigation would erase the GPU state and invalidate the comparison.
  await page.routeWebSocket('**', (socket) => socket.close());
});

// Independent reference sums full populations over fluid nodes/neighbor directions;
// it does not use the GPU link list or reference-pressure subtraction.
function cpuForce(
  values: Float64Array,
  grid: { nx: number; ny: number; nz: number },
  flags: Uint32Array,
) {
  const result = [0, 0, 0];
  const n = flags.length;
  for (let z = 0; z < grid.nz; z++)
    for (let y = 0; y < grid.ny; y++)
      for (let x = 0; x < grid.nx; x++) {
        const node = x + grid.nx * (y + grid.ny * z);
        if (flags[node]) continue;
        directions.forEach(([cx, cy, cz], direction) => {
          const [sx, sy, sz] = [x + cx, y + cy, z + cz];
          if (
            sx < 0 ||
            sx >= grid.nx ||
            sy < 0 ||
            sy >= grid.ny ||
            sz < 0 ||
            sz >= grid.nz
          )
            return;
          if (flags[sx + grid.nx * (sy + grid.ny * sz)]) {
            [cx, cy, cz].forEach((c, axis) => {
              result[axis] += 2 * values[direction * n + node] * c;
            });
          }
        });
      }
  return result;
}

test("surface links close and coefficient normalization respects signs and zero speed", () => {
  const grid = { nx: 64, ny: 32, nz: 32 };
  const body = createObstacle(grid, "sphere");
  const expandedGrid = { nx: 144, ny: 64, nz: 64 };
  const expanded = createObstacle(expandedGrid, "sphere", body.sphere!.radius);
  const relativeSolidCells = (
    shape: ReturnType<typeof createObstacle>,
    size: typeof grid,
  ) => {
    const cells: string[] = [];
    for (let z = 0; z < size.nz; z++)
      for (let y = 0; y < size.ny; y++)
        for (let x = 0; x < size.nx; x++) {
          if (shape.solidFlags[x + size.nx * (y + size.ny * z)])
            cells.push(
              `${x - Math.floor(shape.sphere!.center[0])},${y - size.ny / 2},${z - size.nz / 2}`,
            );
        }
    return cells;
  };
  expect(relativeSolidCells(expanded, expandedGrid)).toEqual(
    relativeSolidCells(body, grid),
  );
  expect(() => createObstacle(grid, "sphere", 16)).toThrow();
  expect(() =>
    validateSettings({ ...DEFAULT_SETTINGS, sphereRadius: 2 }),
  ).toThrow();
  const links = buildSurfaceLinks(grid, body);
  expect(links.length).toBeGreaterThan(0);
  const directionsCount = new Array<number>(19).fill(0);
  for (let i = 0; i < links.length; i += 2) {
    expect(body.solidFlags[links[i]]).toBe(0);
    directionsCount[links[i + 1]]++;
  }
  directions.forEach((c, i) => {
    const opposite = directions.findIndex((v) =>
      v.every((value, axis) => value === -c[axis]),
    );
    expect(directionsCount[i]).toBe(directionsCount[opposite]);
  });
  expect(buildSurfaceLinks(grid, createObstacle(grid))).toHaveLength(0);
  const sample = forceSample(300, [0.1, -0.01, 0.02], 0.03, 8, 0.6, true);
  expect(sample.cd).toBeCloseTo(0.1 / (0.5 * 0.03 ** 2 * Math.PI * 16));
  expect(sample.cl).toBeLessThan(0);
  expect(sample.cs).toBeGreaterThan(0);
  expect(sample.reynolds).toBeCloseTo(7.2);
  expect(forceSample(1, [0, 0, 0], 0, 8, 0.6, false).cd).toBeNull();
  expect(() => forceSample(1, [NaN, 0, 0], 0.03, 8, 0.6, false)).toThrow();
  expect(() => forceSample(1, [0, 0, 0], -1, 8, 0.6, false)).toThrow();
  expect(schillerNaumann(2)).toBeCloseTo((24 / 2) * (1 + 0.15 * 2 ** 0.687));
  expect(schillerNaumann(0)).toBeNull();
  expect(schillerNaumann(1000)).toBeNull();
});

test("GPU impulse matches CPU exchange, ring batches, and fluid momentum loss", async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.goto("/");
  const supported = await page.evaluate(async () =>
    Boolean(navigator.gpu && (await navigator.gpu.requestAdapter())),
  );
  test.skip(!supported, "A real GPU is required for force validation.");
  const grid = { nx: 24, ny: 16, nz: 16 };
  const body = createObstacle(grid, "sphere");
  const settings = {
    ...DEFAULT_SETTINGS,
    obstacle: "sphere" as const,
    boundaryMode: "periodic" as const,
    wallBoundary: "halfway" as const,
  };
  const initial = initialField(grid);
  for (let i = 0; i < initial.length; i++)
    initial[i] = body.solidFlags[i % body.solidFlags.length]
      ? 0
      : Math.fround(initial[i]);
  const expected = [];
  let state = initial;
  for (let step = 1; step <= 26; step++) {
    expected.push(cpuForce(state, grid, body.solidFlags));
    state = cpuStep(state, grid, settings, step, body.solidFlags);
  }
  const result = await page.evaluate(
    async ({ grid, initial, settings }) => {
      const paths = [
        "/src/gpu/device.ts",
        "/src/gpu/buffers.ts",
        "/src/gpu/grid.ts",
        "/src/sim/initialize.ts",
        "/src/sim/lbm.ts",
      ];
      const [
        { initializeGPU },
        { allocateGrid },
        { gridMemory },
        { initializeFluid },
        { createSolver },
      ] = await Promise.all(
        paths.map((path) => import(/* @vite-ignore */ path)),
      );
      const abort = new AbortController();
      const errors: string[] = [];
      const base = await initializeGPU(abort.signal, (message: string) =>
        errors.push(message),
      );
      const resources = allocateGrid(base.device, grid);
      const context = { ...base, grid, resources, memory: gridMemory(grid) };
      const readback = base.device.createBuffer({
        size: context.memory.distributionBytes,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      try {
        await initializeFluid(context, abort.signal);
        resources.distributions.forEach((buffer: GPUBuffer) =>
          base.device.queue.writeBuffer(buffer, 0, new Float32Array(initial)),
        );
        const solver = await createSolver(context, abort.signal, settings);
        const samples = [];
        for (const count of [7, 16, 3]) {
          await solver.step(count);
          samples.push(...solver.lastForceSamples);
        }
        const encoder = base.device.createCommandEncoder();
        encoder.copyBufferToBuffer(
          solver.currentBuffer,
          0,
          readback,
          0,
          context.memory.distributionBytes,
        );
        base.device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const values = new Float32Array(readback.getMappedRange());
        const momentum = [0, 0, 0];
        const velocities = [
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
        for (let i = 0; i < 19; i++)
          for (let node = 0; node < context.memory.cells; node++) {
            velocities[i].forEach((velocity, axis) => {
              momentum[axis] +=
                velocity * values[i * context.memory.cells + node];
            });
          }
        readback.unmap();
        await solver.reset();
        const reset = {
          samples: solver.lastForceSamples.length,
          force: solver.stats.forces,
        };
        await solver.step();
        const resting = solver.stats.forces;
        if (errors.length) throw new Error(errors.join("; "));
        return { samples, momentum, reset, resting };
      } finally {
        readback.destroy();
        resources.destroy();
        abort.abort();
      }
    },
    { grid, initial: Array.from(initial), settings },
  );
  expect(result.samples).toHaveLength(26);
  const impulse = [0, 0, 0];
  result.samples.forEach((sample, i) => {
    expect(sample.step).toBe(i + 1);
    [sample.drag, sample.lift, sample.side].forEach((value, axis) => {
      expect(Math.abs(value - expected[i][axis])).toBeLessThan(2e-5);
      impulse[axis] += value;
    });
    expect(sample.cd).toBeNull(); // No externally prescribed speed in periodic mode.
  });
  const before = [0, 0, 0];
  directions.forEach((c, i) => {
    for (let node = 0; node < body.solidFlags.length; node++)
      c.forEach((value, axis) => {
        before[axis] += value * initial[i * body.solidFlags.length + node];
      });
  });
  before.forEach((value, axis) =>
    expect(
      Math.abs(result.momentum[axis] - value + impulse[axis]),
    ).toBeLessThan(2e-4),
  );
  expect(result.reset.samples).toBe(0);
  expect(result.reset.force).toBeNull();
  expect(
    Math.abs(result.resting.drag) +
      Math.abs(result.resting.lift) +
      Math.abs(result.resting.side),
  ).toBeLessThan(1e-7);
});

test("force readouts and history reset with the scene", async ({ page }) => {
  test.setTimeout(90000);
  await page.goto("/");
  const supported = await page.evaluate(async () =>
    Boolean(navigator.gpu && (await navigator.gpu.requestAdapter())),
  );
  test.skip(!supported, "A real GPU is required.");
  await page.getByText("Simulation diagnostics", { exact: true }).click();
  const panel = page.getByRole("region", { name: "Sphere force measurements" });
  await expect(
    panel.getByRole("img", { name: "Drag coefficient history" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Run", exact: true }).click();
  const steps = page
    .locator("dt", { hasText: "Simulation steps" })
    .locator("..")
    .locator("dd");
  await expect
    .poll(
      async () => Number((await steps.textContent())!.replaceAll(",", "")),
      { timeout: 20000 },
    )
    .toBeGreaterThanOrEqual(320);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByRole("button", { name: "Reset fluid" })).toBeEnabled();
  const drag = panel
    .locator("dt", { hasText: "Drag force +X" })
    .locator("..")
    .locator("dd");
  expect(Number(await drag.textContent())).toBeGreaterThan(0);
  await panel.screenshot({ path: "test-results/force-panel.png" });
  await page.getByRole("button", { name: "Reset fluid" }).click();
  await expect(drag).toHaveText("—");
  await page.getByLabel("Test scene").selectOption("none");
  await expect(panel).toHaveCount(0);
});
