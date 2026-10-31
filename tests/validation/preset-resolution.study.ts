/// <reference types="@webgpu/types" />
import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { schillerNaumann } from "../../src/sim/forces";

test("production preset refinement at matched Reynolds number and physical time", async ({
  page,
}, testInfo) => {
  test.setTimeout(900000);
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
      "/src/render/slice.ts",
    ];
    const [
      { initializeGPU },
      { allocateGrid },
      { gridMemory },
      { initializeFluid },
      { createSolver },
      { readSlice },
    ] = await Promise.all(paths.map((path) => import(/* @vite-ignore */ path)));
    const abort = new AbortController();
    const errors: string[] = [];
    const base = await initializeGPU(abort.signal, (message: string) =>
      errors.push(message),
    );
    // The study owns its grids; do not retain a redundant default grid allocation.
    base.resources.destroy();
    const cases = [];
    const tau = 0.6,
      viscosity = (tau - 0.5) / 3,
      reynolds = 6.624;
    try {
      for (const height of [32,48,64]) {
        const grid = { nx: height*2, ny: height, nz: height };
        const memory = gridMemory(grid);
        const resources = allocateGrid(base.device, grid);
        const context = { ...base, grid, resources, memory };
        try {
          await initializeFluid(context, abort.signal);
          const diameter = 2 * height * 0.115;
          const speed = (reynolds * viscosity) / diameter;
          const solver = await createSolver(context, abort.signal, {
            obstacle: "sphere",
            tau,
            targetSpeed: speed,
            rampSteps: Math.round(300*(height/32)**2),
          });
          // Diffusive refinement: same normalized geometry, Re, tau and physical
          // durations. U scales as 1/height and time steps as height squared.
          const scale = height / 32;
          const warmup = Math.ceil((2048 * scale * scale) / 16) * 16;
          const windowSteps = Math.ceil((512 * scale * scale) / 16) * 16;
          const start = performance.now();
          while (solver.stats.steps < warmup) await solver.step(16);
          const windows = [];
          for (let window = 0; window < 4; window++) {
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
          // Average the two central Z planes, then bilinearly sample the
          // same normalized points on every grid (not nearest cell centers).
          const planes = await Promise.all([readSlice(context,height/2-1,abort.signal),readSlice(context,height/2,abort.signal)]);
          const probes = [[0.15,0.5],[0.45,0.5],[0.6,0.5],[0.8,0.5],[0.3,0.7]].map(([x,y]) => {
            const qx=x*grid.nx-0.5, qy=y*height-0.5, ix=Math.floor(qx), iy=Math.floor(qy);
            const sample = (channel: number) => planes.reduce((total,plane) => {
              let value=0;
              for (let dy=0;dy<2;dy++) for(let dx=0;dx<2;dx++)
                value += plane[((ix+dx)+grid.nx*(iy+dy))*4+channel]*(dx?qx-ix:1-qx+ix)*(dy?qy-iy:1-qy+iy);
              return total+value/2;
            },0);
            return { x,y,uxOverInlet:sample(0)/speed, pressureOverDynamic:sample(3)/(0.5*speed*speed) };
          });
          const recent = windows.slice(-3).map(w => w.cd);
          const relativeWindowSpread = (Math.max(...recent)-Math.min(...recent))/meanCd;
          const settled = relativeWindowSpread < 0.01;
          cases.push({
            kind: "grid-refinement",
            grid,
            probes,
            relativeWindowSpread,
            normalizedTime: solver.stats.steps/(scale*scale),
            solidCells: solver.obstacle.solidCells,
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
  const reference = schillerNaumann(6.624)!;
  const report = {
    ...result,
    reference: {
      name: "Schiller–Naumann isolated smooth sphere",
      reynolds: 6.624,
      cd: reference,
    },
    successiveDragChanges: result.cases.slice(1).map((value,i) => ({ from: result.cases[i].grid, to: value.grid, relativeChange: Math.abs(value.meanCd-result.cases[i].meanCd)/Math.abs(value.meanCd) })),
    comparison: result.cases.map((value) => ({
      kind: value.kind,
      diameterCells: value.diameterCells,
      meanCd: value.meanCd,
      relativeDifference: Math.abs(value.meanCd - reference) / reference,
      matchesWithin15Percent:
        value.settled && Math.abs(value.meanCd - reference) / reference < 0.15,
    })),
    note: "Finite tunnel, coarse cell-center geometry, and simple open boundaries differ from the unbounded empirical reference. Comparison outcomes are diagnostic, not an accuracy badge. Presets start from rest with matched ramps and finish at identical diffusive time; settling and grid agreement are reported, not assumed. Timing is wall time including health/force readback, not GPU timestamps.",
  };
  const path = testInfo.outputPath("preset-resolution-study.json");
  await writeFile(path, JSON.stringify(report, null, 2));
  await testInfo.attach("preset-resolution-study", {
    path,
    contentType: "application/json",
  });
  for (const entry of result.cases) {
    expect(entry.normalizedTime).toBe(4096);
    expect(entry.probes.every(p => Number.isFinite(p.uxOverInlet) && Number.isFinite(p.pressureOverDynamic))).toBe(true);
    expect(entry.meanCd).toBeGreaterThan(0);
    expect(Number.isFinite(entry.meanCd)).toBe(true);
    expect(entry.reynolds).toBe(6.624);
    expect(entry.liftRatio).toBeLessThan(0.01);
    expect(entry.sideRatio).toBeLessThan(0.01);
    expect(entry.coreBytes).toBeGreaterThan(0);
    expect(entry.wallMilliseconds).toBeGreaterThan(0);
  }
  // Report convergence and empirical-reference differences, even if they fail:
  // tests of the force implementation must not disguise unresolved physics.
});
