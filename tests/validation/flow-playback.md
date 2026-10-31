> Historical milestone: 28 October 2026. The density volume and display buffer described below were replaced by [thin flow lines](smoke.md) on 30 October. Sphere reflection now uses [surface distances](curved-wall.md). Saved timings and force comparisons below predate those changes.

# Flow boundaries and continuous playback

## Boundary correction

The previous inlet overwrote every population with equilibrium at both a prescribed velocity and density 1. The empty-tunnel control reached the requested 0.03 at the inlet plane but only 0.019791 in the interior. The boundary therefore failed its intended velocity-delivery requirement.

The replacement inlet follows non-equilibrium extrapolation: for adjacent fluid density rhoA, velocity uA and post-collision populations fA, prescribe the ramped inlet velocity uB and write:

`fB_i = feq_i(rhoA, uB) + [fA_i - feq_i(rhoA, uA)]`.

This lets density respond and retains the adjacent non-equilibrium contribution. The outlet copies adjacent post-collision populations, a first-order zero-gradient outlet. It is not a prescribed-pressure or reflection-free outlet. See [Guo, Zheng and Shi (2002)](https://doi.org/10.1088/1009-1963/11/4/310) for the non-equilibrium extrapolation method. Our specific implementation and limits are tested locally; the paper is not an accuracy certificate for Ventus.

The pressure-outlet reconstruction from the interrupted session was not retained: it did not satisfy the startup control. No multiplier was fitted to speed or forces.

## Acceptance and remaining limits

`tests/boundaries.spec.ts` checks every cell on two XY slices, including transverse wall cells. Cases cover the 64 x 32 x 32 startup at speed 0.03/tau 0.6, a smaller grid at 0.06/tau 0.9, and periodic sides at 0.015/tau 0.6. After a specified settling interval, maximum streamwise speed error must be below 1%, transverse speed below 1e-5, pressure spread below 1e-4, and density inside 0.9-1.15. Rest, arbitrary initial fields, bounce-back and analytical viscous-flow checks remain in the full suite with an independent double-precision CPU reference.

The open setup can retain a uniform density offset after startup; in the empty 0.03 case it is about 1.0464. This is an explicit limitation: pressure is a variation relative to density 1, and force normalization still uses nominal density 1. Absolute pressure and quantitatively calibrated Cd are not established. Finite-domain and curved-voxel errors also remain. The correction establishes delivered velocity for the tested cases, not automotive accuracy or domain independence.

## Playback and workspace

Smoke now enters continuously instead of varying with a sine wave. Constant emission does not stop density already in the tunnel. The scalar follows actual solver velocity as before.

A separate animation loop samples an adaptive 80-300 ms buffer of completed density snapshots. The delay tracks 1.5 times a smoothed volume-arrival interval, within those bounds, and the displayed timeline never runs backwards. Two WebGL textures are blended on display frames, with up to 16 queued CPU snapshots retained (the two textures may also retain their upload arrays). There is no extrapolation past the latest calculated state. Longer GPU stalls therefore still hold the latest state. Pause snaps to the latest completed volume and stops animation; reset, resolution changes and disposal clear the buffer. The solver awaits each bounded GPU batch before yielding to the event loop and scheduling another. The display does not introduce additional fluid steps.

The scene spans the workspace width and most of the viewport height. Wind settings, force/stability results, startup checks, GPU details, voxel view and tracers are collapsed by default. Smoke, slice, scene, run/pause/reset and camera controls remain accessible. Higher simulation resolution still resets the flow.

Tests cover constant emission at different simulation timestamps, scalar transport, buffered interpolation, holding during stalls, pause/reset, renderer animation between two supplied volumes, resource lifecycle, and desktop/narrow-screen layout. Larger graphics area and continuous rendering add GPU cost; timing must be remeasured on each device.

## Saved results

The [corrected empty-tunnel control](measurements/inlet-startup-fixed-2026-10-28.json) measures 0.029999 throughout the sampled tunnel for a 0.03 target. The [preset rerun](measurements/preset-resolution-fixed-2026-10-28.json) is summarized in [resolution notes](preset-resolution.md). Fine/High drag agree closely but remain about 25% above the isolated-sphere reference. Boundary delivery passes; force calibration remains unresolved.

The volume and its occlusion-depth pass now render at half the display width and height (one quarter of the pixels); a fullscreen pass composites straight-alpha smoke over the full-resolution model. Density-field resolution is unchanged. Blank samples skip lighting, and the first interpolation texture is reused when it already contains the previous segment endpoint. This adds interpolation and compositing resources and approximation at silhouettes, but keeps geometry sharp.

### Playback measurement caveat

A local sequential run measured about 165 simulation steps/s for sixteen-step smoke in the larger workspace. [Measurements](measurements/playback-buffered-2026-10-28.json). A preceding full-resolution smoke-pass run measured about 114 steps/s ([measurements](measurements/playback-before-render-optimization-2026-10-28.json)). The unchanged four-step tracer case varied greatly between the two runs, so these cannot establish an isolated percentage improvement or hardware rating. These wall timings include solver, display work, readbacks, scheduling and polling; they are not rendering FPS. The larger viewport and frequent display updates cost more than the historical small, batch-rendered view.
