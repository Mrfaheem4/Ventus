> Historical measurements: all saved tables below predate the 30 October 2026 [curved-wall change](curved-wall.md). They do not validate the new wall treatment.

# Production preset resolution comparison

Run `npm run study:resolution` with a real WebGPU browser. This extends the older Re=2 study to the actual startup sphere case. An unavailable GPU is a skip, never evidence of validation.

## Controlled comparison

- Standard 64 x 32 x 32, Fine 96 x 48 x 48, High 128 x 64 x 64.
- Same normalized tunnel and sphere; sphere diameter is 23% of tunnel height.
- Reynolds number 6.624, relaxation time 0.6, free-slip side boundaries and production inlet/outlet.
- Start from rest. Inlet speeds are 0.03, 0.02, 0.015 lattice units, with ramps of 300, 675, 1200 steps.
- Diffusive scaling: spatial resolution increases by s, lattice speed decreases by s, time steps increase by s squared. Final step counts are 4096, 9216, 16384, representing the same normalized duration.
- Warm up for 2048*s*s steps, then collect four windows of 512*s*s steps. Every step contributes to the force average; report the mean of the final three windows.
- Report recent-window Cd spread below 1% as a settling diagnostic, not proof of steady state or convergence. There is no adaptive early exit that would compare different simulated times.
- Sample five matching normalized positions. Bilinear interpolation within each central XY slice and averaging the two central Z slices avoids mismatched nearest-cell locations. Report streamwise velocity divided by inlet speed and pressure variation divided by dynamic pressure.

## What the measurements mean

The JSON includes drag changes between neighboring presets, force windows, density range, wake probes, sphere cell count, nominal diameter, blockage, allocation estimate and wall time per solver step. Force positivity, finite probes, matched duration and transverse-force symmetry are checks; grid convergence is a measured outcome, not an assumed pass condition.

The Schiller?Naumann reference is an isolated smooth sphere correlation. This finite tunnel has a voxelized sphere and simple boundaries. Agreement with the correlation alone does not validate the solver; disagreement is reported without tuning the result. See the existing [domain study](boundary-distance.md) for confinement sensitivity.

GPU costs include stepping and health/force readbacks, but exclude smoke transport, rendering, setup and final probe reads. Memory excludes renderer, browser, driver, and idle demo resources. These are local measurements, not FPS, free VRAM, or a universal hardware recommendation. No turbulence or arbitrary uploaded model is validated here.

## Next gate

Use the measured grid sensitivity to guide curved-boundary work. Model upload follows that boundary check; a separate vortex demonstration is not a prerequisite for importing geometry.

## Historical results before the boundary correction - 27 October 2026

Edge 156; adapter reports `amd`, not an exact GPU model. [Raw measurements](measurements/preset-resolution-2026-10-27.json).

| Preset | Diameter (cells) | Mean Cd | Recent-window spread | Allocations (MiB) | Wall ms/step | Total stepping time (s) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Standard | 7.36 | 4.5052 | 0.023% | 10.27 | 1.042 | 4.27 |
| Fine | 11.04 | 4.2477 | 0.078% | 34.63 | 2.477 | 22.83 |
| High | 14.72 | 4.2546 | 0.188% | 82.06 | 9.140 | 149.74 |

Standard-to-Fine Cd changes by 6.06%, using Fine as the denominator; Fine-to-High changes by 0.162%, using High as the denominator. All recent force windows satisfy the 1% settling diagnostic. However, Fine/High drag is about 24% below the isolated-sphere correlation (Cd 5.6152). Grid agreement therefore does **not** establish physical accuracy.

At the first wake probe (x/L=0.45, y/H=0.5), streamwise velocity divided by prescribed inlet speed is 0.2929, 0.3007, 0.2995. Farther downstream at x/L=0.8 it is 0.5974, 0.6005, 0.5995. These are point probes, not cross-sectional flux measurements. Raw pressure relative to rho=1 contains a large common offset that grows when normalized by the decreasing dynamic pressure; it must not be interpreted as surface Cp or direct proof of a pressure-gradient error.

The High run costs about 35 times the Standard stepping time at equal normalized duration in this single run. Both more cells and more time steps contribute. Thermal state, browser scheduling and other activity are uncontrolled; this is not a universal speed ratio.

**Decision:** retain provisional force labeling. Investigate the inlet/outlet and startup with an empty-tunnel control before changing curved boundaries or claiming uploaded-model forces are accurate. Finer grids alone do not resolve the observed reference discrepancy.

## Historical empty-tunnel control: boundary defect before correction

The companion `inlet-startup.study.ts` runs an empty 64 x 32 x 32 tunnel from rest at the same tau, ramp and target speed. It is included in `npm run study:resolution`. [Raw control measurements](measurements/inlet-startup-2026-10-27.json).

At both 1,024 and 4,096 steps, the boundary plane reads 0.029999 while every sampled interior X plane averages 0.019791, just 65.97% of the prescribed 0.03. Interior density is approximately 1.0303. This cannot be attributed to sphere blockage because there is no sphere. It demonstrates that the current equilibrium inlet / population-copy outlet setup does not deliver the intended interior speed for this startup.

The studies successfully captured finite, reproducible measurements; **the inlet-delivery physics check fails**. The study runner's green status is not an accuracy certification. Do not fit a speed or Cd correction factor to these measurements. Replace and validate the open-boundary treatment, add a regression requiring the intended interior speed from rest, and rerun the preset comparison before using these force coefficients quantitatively. The exact contribution of each boundary and the sphere reference discrepancy remain to be isolated.

The inlet formulation was subsequently corrected on 28 October 2026. The historical measurements above are retained for comparison; see [flow and playback](flow-playback.md) for the fix and rerun.

## Corrected inlet rerun - 28 October 2026

[Corrected preset measurements](measurements/preset-resolution-fixed-2026-10-28.json) and [empty-tunnel acceptance](measurements/inlet-startup-fixed-2026-10-28.json). Same geometry, durations and Reynolds number as the historical comparison.

| Preset | Mean Cd | Force-window spread | Wall ms/step | Density range |
| --- | ---: | ---: | ---: | --- |
| Standard | 7.5382 | 0.0018% | 1.101 | 1.04451-1.05018 |
| Fine | 7.0269 | 0.0035% | 2.703 | 1.02999-1.03245 |
| High | 7.0314 | 0.0072% | 10.393 | 1.02263-1.02413 |

The empty tunnel now measures 0.029999 at every sampled X plane against a target of 0.03, rather than the old interior 0.019791. The new force windows meet the settling criterion, and Fine/High Cd differ by about 0.0633%. However, they remain about 25% above the isolated reference. A uniform density offset also remains (nominal density 1 is still used in Cd normalization), alongside finite-domain and voxel-body effects. Correct inlet velocity is established for the tested control; quantitative sphere-force accuracy is not. No fitted correction was applied. See [flow and playback limits](flow-playback.md).
