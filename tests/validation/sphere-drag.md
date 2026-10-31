# Sphere force measurements and domain study

These measurements are diagnostic. Agreement between the GPU and CPU force sums checks implementation; it does not establish the accuracy of the finite-tunnel flow around a voxel sphere.

## Measurement

The production solver uses stationary half-way bounce-back. A population traveling from a fluid node into a solid transfers momentum `2*f_i*c_i` to the body. The force pass reads the same post-collision populations that the following streaming step reflects. It runs before every solver step, including all steps inside a batch.

The GPU sums fluid-to-solid surface links in groups of 64. It subtracts the constant reference-density equilibrium weight before summing; the removed background cancels over a closed obstacle. This reduces cancellation error in single precision. Partial sums for up to 16 steps are read back with the existing health diagnostics. Empty tunnels allocate no force-link buffers or force pipeline.

Signs are +X drag, +Y lift, +Z side force. Values are lattice momentum per lattice time step, **not newtons**. With reference density 1, inlet speed U, and nominal smooth-sphere diameter D:

```text
A = pi*D^2/4
Cd = Fx / (0.5*U^2*A)
Cl = Fy / (0.5*U^2*A)
Cs = Fz / (0.5*U^2*A)
nu = (tau - 0.5)/3
Re = U*D/nu
```

During startup, U follows the prescribed inlet ramp. Coefficients are unavailable for negligible reference speed or a periodic case with no imposed inlet. A completed ramp does not imply settled flow. The UI retains the final sample of each batch, up to 600 samples; its recent mean uses up to 50 post-ramp samples. This is an inspection aid rather than a convergence test.

## Independent checks

`tests/forces.spec.ts` compares every GPU force sample against a separate CPU enumeration that sums the full populations without the GPU link list or background subtraction. The 26-step sequence uses batches of 7, 16, and 3 to cross the diagnostic ring-buffer boundary. Absolute force differences must remain below 2e-5 lattice units. In a periodic domain, fluid momentum loss must equal integrated body impulse within 2e-4. A reset clears samples; a resting sphere must have force below 1e-7. UI checks cover live readings, history, reset, and removal in an empty tunnel.

## Reproducible study

Run `npm run study:drag`. With installed Edge on Windows:

```powershell
$env:VENTUS_BROWSER_CHANNEL = 'msedge'
npm.cmd run study:drag
```

This long study uses one worker and writes `sphere-drag-study.json` to its Playwright result directory. It requires a real WebGPU adapter; absence is reported as a skip. Run it separately from other GPU work. The study can take several minutes.

All cases use Re = 2, tau = 0.9, nu = 0.133333, a uniform initial flow, a one-step inlet ramp, free-slip sides, and the production inlet/outlet boundaries. The first three grids preserve normalized sphere size and location. Under refinement, U scales inversely with grid height and step durations scale with height squared. This preserves Re and comparable nondimensional durations while reducing lattice Mach number.

The expanded-domain case keeps D = 7.36 cells, U, nu, and the exact solid-cell pattern of the middle case. Its 144-cell length preserves the sphere's fractional X position on the lattice. Width and depth double; inlet and outlet distances also increase. This checks combined domain-size sensitivity, not separate contributions from each boundary. A routine test verifies that the body is an integer translation of the middle-case body.

Warmup is `ceil(1600*(height/24)^2/16)*16` steps. Each averaging window lasts `ceil(256*(height/24)^2/16)*16` steps. After at least three windows, the last three mean Cd values must have a range below 1% of their mean to receive the diagnostic `settled` flag. Up to eight windows are attempted. Every step contributes to the study means. This criterion checks recent drift; it is not proof of asymptotic convergence or turbulent statistical convergence.

The comparison uses the empirical isolated smooth-sphere Schiller–Naumann correlation:

```text
Cd = 24/Re * (1 + 0.15*Re^0.687)
```

At Re = 2 it gives Cd = 14.897878. The app restricts this comparison to 0 < Re <= 800. This reference describes a different, unbounded problem; no tunnel correction or fitted multiplier is applied. The report's 15% comparison flag is diagnostic and is not asserted as an accuracy requirement. Tests require finite positive drag, matched Re, and lift/side magnitudes below 1% of drag; convergence and reference differences remain visible in the report even when unfavorable.

See the [sphere flow study](https://doi.org/10.1016/j.ijthermalsci.2018.07.009) for the reference correlation and [wall-effects research](https://doi.org/10.1115/1.4051215) for why confinement needs separate consideration.

## Example local run: 26 October 2026

Edge 156 on the development laptop; the adapter reported vendor `amd`. The exact GPU model is unconfirmed. Each case met the recent-window settling criterion and the lift/side tolerance of 1% of drag.

| Grid | Sphere diameter, cells | Mean Cd | Difference from isolated reference | Estimated allocations, MiB | Wall ms / solver step |
| --- | ---: | ---: | ---: | ---: | ---: |
| 48 x 24 x 24 | 5.52 | 18.646 | +25.2% | 4.34 | 0.546 |
| 64 x 32 x 32 | 7.36 | 18.705 | +25.6% | 10.27 | 0.687 |
| 96 x 48 x 48 | 11.04 | 18.477 | +24.0% | 34.63 | 2.120 |
| 144 x 64 x 64, expanded domain | 7.36 | 15.842 | +6.3% | 92.27 | 5.443 |

The first three cases used 2,368, 4,240, and 9,472 steps. The expanded case used 16,864 steps. Estimated allocations include study-grid and solver buffers; 1 MiB = 1,048,576 bytes. Timings are one local run, not a device rating.

Refining the sphere alone barely changed the roughly 24–26% reference difference. Keeping the middle sphere's exact voxel pattern while enlarging the tunnel lowered Cd by about 15.3%, reducing the reference difference to 6.3%. This supports a significant domain-size sensitivity. It does not identify which boundary dominates, prove that the largest domain is independent, or remove voxel and boundary errors. No correction was fitted to make these values match the reference.

## Limits and next work

The sphere remains a cell-center voxel mask with half-way reflection rather than an accurately fitted curved boundary. The inlet/outlet are simple, reference density is fixed at 1, and the simulated tunnel is finite. A near-constant Cd under grid refinement can still contain a domain bias. Larger domains also need resolution studies. The present study is at Re = 2 and tau = 0.9; it does not validate the default UI case at tau = 0.6, a wide Re range, high-Re wakes, or arbitrary models.

Memory figures count explicitly allocated study-grid buffers/textures and solver buffers. They exclude browser, renderer, driver overhead, texture padding, CPU arrays, and the idle demo's resources; they are not total VRAM usage. Timings cover simulation batches and readbacks after study initialization, with no deliberate viewer interaction. The test page can retain its idle demo viewer. Timings use wall time, not GPU timestamp queries, and cannot be interpreted as interactive frame rates or guaranteed device performance.

Next: improve domain independence, assess inlet/outlet effects, refine curved boundaries and the sphere, and repeat at additional Re and relaxation times before treating force coefficients as validated measurements.

**Historical boundary formulation:** the saved measurements above predate the 28 October 2026 velocity-inlet correction. Rerunning these scripts uses the current solver. See [boundary correction notes](flow-playback.md); old measurements must not be presented as validation of the new formulation.
