# First transported smoke volume

The smoke view addresses the sparse tracers' poor visibility and dependence on an opaque slice. It defaults to white volume-rendered smoke, with diagnostic tracers off and the slice hidden. An enabled slice starts at 20% opacity, can be adjusted, and does not write depth. The larger viewer gives the smoke more screen space.

## Transport

`smoke.wgsl` transports a passive scalar concentration using the solver's actual 3D velocity texture. This is a visual marker, not a new fluid or turbulence model. The scalar does not feed back into momentum, force measurements, or air density.

The scalar grid matches the airflow grid, including higher resolution presets. Two f32 storage buffers ping-pong concentration; newly allocated buffers start at zero. Seven narrow Gaussian emitters span normalized Y positions 0.26?0.74 near the Z center. A slow emission-only sinusoidal pulse changes concentration, never air velocity. No synthetic vortices are added.

Each airflow batch is followed by a semi-Lagrangian backward trace using the latest end-of-batch velocity snapshot. It uses midpoint backtrace intervals of at most two lattice time steps, samples the old concentration using separable bounded Catmull-Rom reconstruction. Each interpolation is clamped to its central pair to prevent new extrema. The previous arbitrary decay has been removed; stationary smoke now persists. Velocity remains trilinearly interpolated. Inlet values are prescribed; solids at output centers are zeroed, and midpoint/endpoint solid checks suppress traced paths through the body. Out-of-domain paths are zeroed. These sampled collision checks and a finite scalar grid do not guarantee exclusion of every thin/diagonal feature. Semi-Lagrangian interpolation is diffusive and is not a conservative smoke-mass solver. Transfer to the renderer is quantized to 8 bits.

This is a visual scalar and a batch-wise temporal approximation, not a validated smoke transport solver. It can smooth small structures, especially on long runs. It cannot reveal vortices absent from the velocity solution, and changing smoke appearance does not establish quantitative CFD accuracy. Default sphere flow remains low-Re and may be smooth.

## Rendering and resource cost

GPU packing transfers one byte per cell per update: 65,536 bytes at Standard and 1,024,000 at Extra. Calculation buffers use approximately 10 bytes/cell plus 32 bytes: 0.625 MiB at Standard and 9.77 MiB at Extra. These estimates exclude renderer and driver resources. Higher resolution now increases smoke cost too.

The single-channel 3D texture is rendered with 96 samples per ray. Four density samples toward a fixed light approximate light attenuation at each sample, giving smoke depth. Opaque-scene depth clips rays against the body. This is approximate single scattering, not a physically calibrated optical renderer. Empty-space acceleration, emission controls and further performance work remain planned. Tracer trails use 96 samples and additive blending to avoid dark faded tails painting over the scene. Hidden slices no longer trigger GPU readbacks.

Smoke and tracers stop with simulation time. Reset, geometry/resolution changes, disabling visualization, reinitialization, and unmount release/reset their calculation resources and history. Creation errors disable the affected visualization while a healthy solver can continue. Device loss uses the existing recovery flow.

## Simulation pace

The original interactive loop advanced four solver steps per animation update, with GPU readback and rendering overhead on each update. The new Gentle/Balanced/Fast choices run 4/8/16 actual airflow steps per update; Fast is the default. This amortizes scheduling and visualization overhead. It does not multiply marker speed or wind speed, skip airflow solver steps, or promise a fixed wall-clock speedup. Larger batches use a longer frozen velocity interval for visualization, while the underlying LBM still computes every step. Smaller batches trade throughput for more frequent visual field sampling. GPU throughput and rendering cost determine actual progress.

`npm run study:playback` compares complete four-step tracer and sixteen-step smoke configurations. It includes solver, readbacks, React, scheduling, and rendering; this is not an isolated timing or an FPS benchmark.

### Historical playback comparison, before visual refinement: 27 October 2026

One sequential Edge/WebGPU run at Standard resolution measured approximately **155 steps/s** for four-step tracers and **468 steps/s** for sixteen-step smoke, about 3.0x more simulated progress per wall second. Each case warmed for at least 320 steps and measured at least 1,024 more. The full [measurements](measurements/playback-cost-2026-10-27.json) include elapsed time and caveats. Polling/pause overhead is included. This comparison changes both visualization and batch size; it does not isolate their contributions, guarantee a speedup, identify a hardware tier, or establish rendering FPS.

## Checks

`tests/smoke.spec.ts` tests a prescribed smoke pulse in still air and in a constant 1/16-cell-per-step flow. Over 16 steps it must move exactly one cell, subject to 8-bit quantization. It checks solid output exclusion and compares four fractional Gaussian translations against the exact solution and linear remapping. The bounded cubic reconstruction must reduce the sampled absolute error by at least 30% in that case. The real browser check covers the default smoke view, faster pace, live concentration transfer, frozen pause, reset, disabling, slice opacity, screenshots, and WebGL shader errors. Real GPU checks explicitly skip without an adapter. These tests do not establish arbitrary unsteady transport accuracy or smoke mass conservation.

### Refined renderer playback

After full-grid smoke, bounded cubic reconstruction, 96 ray samples and density lighting, a local Standard-resolution run measured **421 simulation steps/s** with sixteen-step smoke and **145 steps/s** with four-step tracers. See [measurements](measurements/refined-playback-2026-10-27.json). This is a single sequential run, not FPS or an isolated before/after benchmark. Higher presets and other GPUs were not performance-qualified by this measurement.
