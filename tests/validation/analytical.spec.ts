/// <reference types="@webgpu/types" />
import { expect, test } from "@playwright/test";
import type { TestInfo } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { equilibrium } from "../cpu_reference/d3q19";

async function recordMeasurements(
  info: TestInfo,
  name: string,
  values: unknown,
) {
  const path = info.outputPath(`${name}.json`);
  await writeFile(path, JSON.stringify(values, null, 2));
  await info.attach(name, { path, contentType: "application/json" });
}

// Two-dimensional analytical solutions embedded in the three-dimensional D3Q19 grid.
for (const tau of [0.6, 0.9]) {
  test(`Taylor–Green decay, viscosity and refinement at tau=${tau}`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(180000);
    await page.goto("/");
    const supported = await page.evaluate(async () =>
      Boolean(navigator.gpu && (await navigator.gpu.requestAdapter())),
    );
    test.skip(
      !supported,
      "Real WebGPU adapter required for analytical validation.",
    );
    const results = [];
    for (const size of [32, 64]) {
      const grid = { nx: size, ny: size, nz: 2 };
      const amplitude = (0.01 * 32) / size; // Fixed Reynolds number across refinement.
      const k = (2 * Math.PI) / size;
      const initial = new Float32Array(19 * size * size * 2);
      for (let z = 0; z < 2; z++)
        for (let y = 0; y < size; y++)
          for (let x = 0; x < size; x++) {
            const rho =
              1 +
              0.75 *
                amplitude ** 2 *
                (Math.cos(2 * k * x) + Math.cos(2 * k * y));
            const velocity = [
              amplitude * Math.sin(k * x) * Math.cos(k * y),
              -amplitude * Math.cos(k * x) * Math.sin(k * y),
              0,
            ];
            equilibrium(rho, velocity).forEach((value, i) => {
              initial[i * size * size * 2 + x + size * (y + size * z)] = value;
            });
          }
      const checkpoints = [(size * size) / 8, (size * size) / 4];
      const snapshots = await page.evaluate(
        async ({ grid, tau, initial, checkpoints }) => {
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
          const context = {
            ...base,
            grid,
            resources,
            memory: gridMemory(grid),
          };
          const readback = base.device.createBuffer({
            size: context.memory.distributionBytes,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
          });
          try {
            await initializeFluid(context, abort.signal);
            resources.distributions.forEach((buffer: GPUBuffer) =>
              base.device.queue.writeBuffer(
                buffer,
                0,
                new Float32Array(initial),
              ),
            );
            const solver = await createSolver(context, abort.signal, {
              boundaryMode: "periodic",
              tau,
              targetSpeed: 0,
            });
            const measurements = [];
            const k = (2 * Math.PI) / grid.nx;
            const n = context.memory.cells;
            const cx = [
              0, 1, -1, 0, 0, 0, 0, 1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0,
            ];
            const cy = [
              0, 0, 0, 1, -1, 0, 0, 1, -1, -1, 1, 0, 0, 0, 0, 1, -1, 1, -1,
            ];
            for (const checkpoint of checkpoints) {
              while (solver.stats.steps < checkpoint)
                await solver.step(
                  Math.min(16, checkpoint - solver.stats.steps),
                );
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
              let errorSquared = 0,
                expectedSquared = 0,
                projection = 0,
                norm = 0,
                mass = 0;
              const expectedAmplitude =
                ((0.01 * 32) / grid.nx) *
                Math.exp(((-2 * (tau - 0.5)) / 3) * k * k * checkpoint);
              for (let z = 0; z < grid.nz; z++)
                for (let y = 0; y < grid.ny; y++)
                  for (let x = 0; x < grid.nx; x++) {
                    const node = x + grid.nx * (y + grid.ny * z);
                    let rho = 0,
                      mx = 0,
                      my = 0;
                    for (let i = 0; i < 19; i++) {
                      const f = values[i * n + node];
                      rho += f;
                      mx += f * cx[i];
                      my += f * cy[i];
                    }
                    mass += rho;
                    const shape = [
                      Math.sin(k * x) * Math.cos(k * y),
                      -Math.cos(k * x) * Math.sin(k * y),
                    ];
                    [mx / rho, my / rho].forEach((velocity, axis) => {
                      const expected = expectedAmplitude * shape[axis];
                      errorSquared += (velocity - expected) ** 2;
                      expectedSquared += expected ** 2;
                      projection += velocity * shape[axis];
                      norm += shape[axis] ** 2;
                    });
                  }
              measurements.push({
                steps: checkpoint,
                amplitude: projection / norm,
                relativeL2: Math.sqrt(errorSquared / expectedSquared),
                massError: Math.abs(mass - n) / n,
              });
              readback.unmap();
            }
            if (errors.length) throw new Error(errors.join("; "));
            return measurements;
          } finally {
            readback.destroy();
            resources.destroy();
            abort.abort();
          }
        },
        { grid, tau, initial: Array.from(initial), checkpoints },
      );
      const viscosity = (tau - 0.5) / 3;
      const measuredViscosity =
        -Math.log(snapshots[1].amplitude / snapshots[0].amplitude) /
        (2 * k * k * (checkpoints[1] - checkpoints[0]));
      const viscosityError =
        Math.abs(measuredViscosity - viscosity) / viscosity;
      results.push({
        size,
        tau,
        viscosity,
        measuredViscosity,
        viscosityError,
        snapshots,
      });
      for (const snapshot of snapshots) {
        expect(snapshot.relativeL2).toBeLessThan(size === 32 ? 0.025 : 0.01);
        expect(snapshot.massError).toBeLessThan(1e-4);
      }
      expect(viscosityError).toBeLessThan(size === 32 ? 0.03 : 0.01);
    }
    await recordMeasurements(testInfo, "taylor-green-measurements", results);
    expect(results[1].snapshots[1].relativeL2).toBeLessThan(
      results[0].snapshots[1].relativeL2 * 0.75,
    );
  });
}

test("Poiseuille channel profile, stationary walls and refinement", async ({
  page,
}, testInfo) => {
  test.setTimeout(180000);
  await page.goto("/");
  const supported = await page.evaluate(async () =>
    Boolean(navigator.gpu && (await navigator.gpu.requestAdapter())),
  );
  test.skip(
    !supported,
    "Real WebGPU adapter required for analytical validation.",
  );
  const results = [];
  for (const height of [16, 32]) {
    const tau = 0.8;
    const viscosity = (tau - 0.5) / 3;
    const acceleration = (8 * viscosity * 0.01) / height ** 2;
    const grid = { nx: 8, ny: height, nz: 2 };
    const steps =
      Math.ceil((10 * height ** 2) / (viscosity * Math.PI ** 2) / 16) * 16;
    const result = await page.evaluate(
      async ({ grid, tau, acceleration, steps }) => {
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
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });
        try {
          await initializeFluid(context, abort.signal);
          // Buffers hold post-collision populations: a half-impulse shift
          // makes their force-corrected velocity zero at the start.
          const resting = new Float32Array(
            context.memory.distributionBytes / 4,
          );
          const n = context.memory.cells;
          const cx = [
            0, 1, -1, 0, 0, 0, 0, 1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0,
          ];
          for (let i = 0; i < 19; i++) {
            const weight = i === 0 ? 1 / 3 : i <= 6 ? 1 / 18 : 1 / 36;
            const cu = (cx[i] * acceleration) / 2;
            resting.fill(
              weight *
                (1 + 3 * cu + 4.5 * cu * cu - 1.5 * (acceleration / 2) ** 2),
              i * n,
              (i + 1) * n,
            );
          }
          resources.distributions.forEach((buffer: GPUBuffer) =>
            base.device.queue.writeBuffer(buffer, 0, resting),
          );
          const solver = await createSolver(context, abort.signal, {
            boundaryMode: "channel",
            acceleration,
            tau,
            targetSpeed: 0,
          });
          const profiles = [];
          for (const checkpoint of [
            Math.floor((steps * 0.8) / 16) * 16,
            steps,
          ]) {
            while (solver.stats.steps < checkpoint)
              await solver.step(Math.min(16, checkpoint - solver.stats.steps));
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
            const n = context.memory.cells;
            const cx = [
              0, 1, -1, 0, 0, 0, 0, 1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0,
            ];
            const profile = new Array<number>(grid.ny).fill(0);
            let mass = 0;
            for (let z = 0; z < grid.nz; z++)
              for (let y = 0; y < grid.ny; y++)
                for (let x = 0; x < grid.nx; x++) {
                  const node = x + grid.nx * (y + grid.ny * z);
                  let rho = 0,
                    mx = 0;
                  for (let i = 0; i < 19; i++) {
                    rho += values[i * n + node];
                    mx += values[i * n + node] * cx[i];
                  }
                  mass += rho;
                  profile[y] +=
                    (mx / rho - acceleration / 2) / (grid.nx * grid.nz);
                }
            profiles.push({ profile, massError: Math.abs(mass - n) / n });
            readback.unmap();
          }
          if (errors.length) throw new Error(errors.join("; "));
          return profiles;
        } finally {
          readback.destroy();
          resources.destroy();
          abort.abort();
        }
      },
      { grid, tau, acceleration, steps },
    );
    const expected = Array.from(
      { length: height },
      (_, y) =>
        (acceleration / (2 * viscosity)) * (y + 0.5) * (height - y - 0.5),
    );
    const profile = result[1].profile;
    const relativeL2 = Math.sqrt(
      profile.reduce((sum, u, y) => sum + (u - expected[y]) ** 2, 0) /
        expected.reduce((sum, u) => sum + u * u, 0),
    );
    const steadyChange =
      Math.max(...profile.map((u, y) => Math.abs(u - result[0].profile[y]))) /
      0.01;
    results.push({
      height,
      steps,
      tau,
      acceleration,
      relativeL2,
      steadyChange,
      profile,
      expected,
    });
    expect(relativeL2).toBeLessThan(height === 16 ? 0.02 : 0.01);
    expect(steadyChange).toBeLessThan(0.001);
    expect(result[1].massError).toBeLessThan(0.001);
    for (let y = 0; y < height; y++)
      expect(Math.abs(profile[y] - profile[height - 1 - y])).toBeLessThan(1e-5);
  }
  await recordMeasurements(testInfo, "poiseuille-measurements", results);
  expect(results[1].relativeL2).toBeLessThan(results[0].relativeL2 * 0.75);
});
