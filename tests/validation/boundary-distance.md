# Separate boundary-distance study

Run `npm run study:boundaries`, with `VENTUS_BROWSER_CHANNEL=msedge` if using installed Edge. This is a separate, single-worker real-WebGPU study; it can take several minutes. An unavailable GPU produces a skip. Measurements are attached as `boundary-distance-study.json` in the Playwright result directory.

The previous sphere study changed multiple distances together. This study isolates their effects before changing boundary formulas. Every case uses the production free-slip side boundaries, equilibrium inlet, copied-population outlet, tau = 0.9, nominal Re = 2, diameter = 7.36 cells, and lattice speed approximately 0.036232. Fluid starts at uniform equilibrium with a one-step inlet ramp.

| Case | Grid | Sphere center | Distance changed relative to baseline |
| --- | --- | --- | --- |
| Baseline | 64 x 32 x 32 | (19.2, 16, 16) | None |
| Inlet farther | 96 x 32 x 32 | (51.2, 16, 16) | Inlet +32 cells; outlet and sides unchanged |
| Outlet farther | 128 x 32 x 32 | (19.2, 16, 16) | Outlet +64 cells; inlet and sides unchanged |
| Sides farther | 64 x 64 x 64 | (19.2, 32, 32) | Both Y/Z side clearances +16 cells; inlet/outlet unchanged |
| All farther | 128 x 64 x 64 | (51.2, 32, 32) | Inlet/outlet +32 cells each; Y/Z clearances +16 cells |

The fractional position on the lattice stays the same. The study checks the entire solid-cell pattern after integer translation, rather than assuming equal nominal diameter gives identical geometry. Flow speed, viscosity, and sphere resolution stay fixed. The study changes domain distances, not boundary algorithms or sphere resolution.

The first three cases warm up for 4,096 steps; cases with doubled width/depth warm up for 8,192. Each averaging window includes all force samples over 1,024 steps. After three windows, a range of less than 1% of their mean Cd marks recent-window settling. Up to eight windows are attempted. The report includes the flag and window values even if settling is not reached. Finite positive drag and lift/side magnitudes below 1% of drag are checked separately. Recent stability is not proof of full convergence.

The combined-distance case is not a full factorial experiment: it cannot establish independent additive corrections or identify every interaction. More than one domain size per direction, finer sphere geometry, and longer-time checks are needed before claiming domain independence. Results at this Re and relaxation time do not validate the default UI flow or a turbulent automotive case. No coefficient correction is fitted to an isolated-sphere reference.

Memory estimates cover the explicitly allocated study grid and solver buffers, excluding browser, idle demo, rendering, and driver resources. Wall time includes simulation and diagnostic readbacks; it is not GPU-only timing or interactive FPS.

## Local measurements: 27 October 2026

Edge 156; adapter vendor reported `amd`. The full [JSON measurements](measurements/boundary-distance-2026-10-27.json) include geometry, clearances, density ranges, window means, memory estimates, and elapsed time. All five cases met the recent-window settling criterion and the transverse-force checks.

| Case | Mean Cd | Change from baseline |
| --- | ---: | ---: |
| Baseline | 18.703 | — |
| Inlet farther | 18.499 | -1.09% |
| Outlet farther | 18.707 | +0.02% |
| Sides farther | 16.816 | -10.09% |
| All farther | 15.823 | -15.40% |

Side-distance sensitivity was the largest individual effect among the tested changes. Increasing outlet distance alone had little effect in this low-Re case. The combined change also shows that single-direction effects cannot be treated as independent additive corrections. This result prioritizes side/far-field treatment and further domain checks; it does not justify changing a numerical boundary formula without separate validation. The production boundary formulas remain unchanged in this milestone.

These measurements use one sphere resolution and one parameter set. They are not a universal ranking of boundary importance. The isolated-sphere correlation at Re = 2 is approximately 14.898, so even the combined case retains a roughly 6.2% difference. The longest case needed 11,264 steps and about 120 seconds in this run; other devices, concurrent work, and scene interaction change timing.

## Resolution controls

UI presets keep the same normalized tunnel and sphere dimensions. At grid height H, scale = H/32; initial lattice speed = 0.03/scale and ramp duration = round(300*scale^2). With fixed relaxation time this preserves nominal Reynolds number and comparable nondimensional ramp duration. Very small fallback grids cap initial speed at 0.08, so exact Re matching is not promised there. The control's initial wind speed is preset-dependent; subsequent manual speed changes intentionally change Re.

The default Automatic option retains the original startup fallback. Explicit presets request exactly that grid, check adapter and device limits, and report an allocation failure without substituting a smaller grid. Changing resolution aborts the old scene, disposes its resources, and initializes a new scene at rest. Performance-based automatic selection is still future work.
