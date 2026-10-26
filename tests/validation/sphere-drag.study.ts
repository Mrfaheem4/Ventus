/// <reference types="@webgpu/types" />
import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { schillerNaumann } from "../../src/sim/forces";

test("matched-Re sphere resolution study with memory, settling and reference diagnostics", async ({
  page,
}, testInfo) => {
  test.setTimeout(600000);
  // A documentation save must not reload the page midway through a long run.
  await page.routeWebSocket("**", (socket) => socket.close());
  await page.goto("/");
  const supported = await page.evaluate(async () =>
    Boolean(navigator.gpu && (await navigator.gpu.requestAdapter())),
  );
  test.skip(
    !supported,
    "Real WebGPU adapter required for a drag resolution study.",
  );
  const result = await page.evaluate(async () => {
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
    ] = await Promise.all(paths.map((path) => import(/* @vite-ignore */ path)));
    const abort = new AbortController();
    const errors: string[] = [];
    const base = await initializeGPU(abort.signal, (message: string) =>
      errors.push(message),
    );
    // The study owns its grids; do not retain a redundant default grid allocation.
    base.resources.destroy();
    const cases = [];
    const tau = 0.9,
      viscosity = (tau - 0.5) / 3,
      reynolds = 2;
    try {
      for (const variant of [
        { height: 24 },
        { height: 32 },
        { height: 48 },
        { height: 64, radius: 3.68 },
      ]) {
        const height = variant.height;
        // 0.3*144 and 0.3*64 have the same subcell offset, so the
        // expanded-domain body is an integer translation of the middle body.
        const grid = {
          nx: variant.radius ? 144 : height * 2,
          ny: height,
          nz: height,
        };
        const memory = gridMemory(grid);
        const resources = allocateGrid(base.device, grid);
        const context = { ...base, grid, resources, memory };
        try {
          await initializeFluid(context, abort.signal);
          const diameter = 2 * (variant.radius ?? height * 0.115);
          const speed = (reynolds * viscosity) / diameter;
          const n = memory.cells;
          const cx = [
            0, 1, -1, 0, 0, 0, 0, 1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0,
          ];
          const field = new Float32Array(19 * n);
          for (let i = 0; i < 19; i++) {
            const weight = i === 0 ? 1 / 3 : i <= 6 ? 1 / 18 : 1 / 36;
            const cu = cx[i] * speed;
            field.fill(
              weight * (1 + 3 * cu + 4.5 * cu * cu - 1.5 * speed * speed),
              i * n,
              (i + 1) * n,
            );
          }
          resources.distributions.forEach((buffer: GPUBuffer) =>
            base.device.queue.writeBuffer(buffer, 0, field),
          );
          const solver = await createSolver(context, abort.signal, {
            obstacle: "sphere",
            tau,
            targetSpeed: speed,
            rampSteps: 1,
            sphereRadius: variant.radius,
          });
          // Diffusive refinement: same normalized geometry, Re, tau and physical
          // durations. U scales as 1/height and time steps as height squared.
          const scale = height / 24;
          const warmup = Math.ceil((1600 * scale * scale) / 16) * 16;
          const windowSteps = Math.ceil((256 * scale * scale) / 16) * 16;
          const start = performance.now();
          while (solver.stats.steps < warmup) await solver.step(16);
          const windows = [];
          let settled = false;
          for (let window = 0; window < 8; window++) {
            let cd = 0,
              drag = 0,
              lift = 0,
              side = 0,
              samples = 0;
            for (let step = 0; step < windowSteps; step += 16) {
              await solver.step(16);
              for (const sample of solver.lastForceSamples) {
                cd += sample.cd;
                drag += sample.drag;
                lift += sample.lift;
                side += sample.side;
                samples++;
              }
            }
            windows.push({
              step: solver.stats.steps,
              cd: cd / samples,
              drag: drag / samples,
              lift: lift / samples,
              side: side / samples,
            });
            if (windows.length >= 3) {
              const last = windows.slice(-3).map((value) => value.cd);
              const relativeSpread =
                (Math.max(...last) - Math.min(...last)) /
                (last.reduce((sum, value) => sum + value, 0) / last.length);
              if (relativeSpread < 0.01) {
                settled = true;
                break;
              }
            }
          }
          const wallMilliseconds = performance.now() - start;
          const last = windows.slice(-3);
          const meanCd =
            last.reduce((sum, value) => sum + value.cd, 0) / last.length;
          const liftRatio = Math.max(
            ...last.map((value) => Math.abs(value.lift / value.drag)),
          );
          const sideRatio = Math.max(
            ...last.map((value) => Math.abs(value.side / value.drag)),
          );
          cases.push({
            kind: variant.radius ? "expanded-domain" : "grid-refinement",
            grid,
            diameterCells: diameter,
            targetSpeed: speed,
            reynolds,
            tau,
            viscosity,
            coreBytes: memory.totalBytes,
            solverScratchBytes: solver.scratchBytes,
            allocationEstimateBytes: memory.totalBytes + solver.scratchBytes,
            steps: solver.stats.steps,
            wallMilliseconds,
            wallMsPerStep: wallMilliseconds / solver.stats.steps,
            settled,
            meanCd,
            liftRatio,
            sideRatio,
            windows,
            densityRange: [solver.stats.densityMin, solver.stats.densityMax],
            blockage: solver.obstacle.blockage,
          });
          solver.dispose();
        } finally {
          resources.destroy();
        }
      }
      if (errors.length) throw new Error(errors.join("; "));
      return { browser: navigator.userAgent, adapter: base.adapterName, cases };
    } finally {
      abort.abort();
    }
  });
  const reference = schillerNaumann(2)!;
  const report = {
    ...result,
    reference: {
      name: "Schiller–Naumann isolated smooth sphere",
      reynolds: 2,
      cd: reference,
    },
    comparison: result.cases.map((value) => ({
      kind: value.kind,
      diameterCells: value.diameterCells,
      meanCd: value.meanCd,
      relativeDifference: Math.abs(value.meanCd - reference) / reference,
      matchesWithin15Percent:
        value.settled && Math.abs(value.meanCd - reference) / reference < 0.15,
    })),
    note: "Finite tunnel, coarse cell-center geometry, and simple open boundaries differ from the unbounded empirical reference. Comparison outcomes are diagnostic, not an accuracy badge. Timing is wall time including health/force readback, not GPU timestamps.",
  };
  const path = testInfo.outputPath("sphere-drag-study.json");
  await writeFile(path, JSON.stringify(report, null, 2));
  await testInfo.attach("sphere-drag-study", {
    path,
    contentType: "application/json",
  });
  for (const entry of result.cases) {
    expect(entry.meanCd).toBeGreaterThan(0);
    expect(Number.isFinite(entry.meanCd)).toBe(true);
    expect(entry.reynolds).toBe(2);
    expect(entry.liftRatio).toBeLessThan(0.01);
    expect(entry.sideRatio).toBeLessThan(0.01);
    expect(entry.coreBytes).toBeGreaterThan(0);
    expect(entry.wallMilliseconds).toBeGreaterThan(0);
  }
  // Report convergence and empirical-reference differences, even if they fail:
  // tests of the force implementation must not disguise unresolved physics.
});
