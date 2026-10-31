# Ventus

A browser-based virtual wind tunnel for exploring how air moves around 3D objects.

Ventus aims to combine credible aerodynamic simulation with an immersive visual experience: load a model, configure the wind, and inspect airflow, pressure, and the wake around it.

**Status: pre-alpha learning project.** The current app supports a stationary sphere, an empty tunnel, provisional force measurements, thin smoke-style flow lines, optional diagnostic tracers, and local GLB model preparation. Simulating uploaded geometry is the next stage.

## Our mission

Build a wind tunnel that is enjoyable to explore, useful for learning, and increasingly capable as its physics and validation improve.

- **Physics first.** Validate the calculations before treating their results as trustworthy measurements.
- **Exceptional visuals and interaction.** Work toward fluid motion, readable analysis, polished controls, and a dedicated tunnel workspace.
- **Use the user's GPU effectively.** Offer more detail and richer visuals as the device, browser, and validated solver allow.
- **Keep access simple.** Open the app, use it, optionally download results, and leave. No account, database, or server-side simulation is required by the current architecture.
- **Make the limits understandable.** Explain quality, performance, and accuracy without asking users to understand the implementation.

The long-term experience should make airflow feel tangible: streams passing around the body, smoke-like trails revealing motion, and wake structures that can be explored in 3D. These visuals must follow the calculated flow. Fine vortices require appropriate physics and sufficient resolution; a smooth model or dense particle effect does not establish simulation accuracy.

**The visual goal is fine, continuous smoke filaments around models, with clear shape and depth, guided by the calculated airflow.**

## Your GPU powers the simulation

**Ventus runs simulations locally using your GPU. Higher quality increases GPU memory use, power consumption, and computation time.**

Models and simulation data remain on the user's device in the current app. There is no server GPU or cloud compute service behind it.

Our direction is to start at a practical quality level and let capable hardware go further. The current coarse grid is a development starting point, not the intended final quality ceiling.

Planned quality controls will distinguish:

| Setting | What it changes |
| --- | --- |
| Simulation resolution | How finely the object and airflow are represented |
| Simulation effort | How much calculation is performed before and during exploration |
| Visual quality | Particle density, trails, effects, and rendering detail |

We will benchmark and optimize our own implementation before attributing limits to the user's hardware. Higher resolution will be evaluated alongside accuracy, memory use, and responsiveness. Local refinement is a future investigation, not an implemented feature.

WebGPU does not provide a reliable total/free VRAM reading. The app can report resource estimates, supported limits, and measured performance. A confirmed minimum hardware specification and performance tiers have not been established yet.

## What works today

- A dedicated local GLB import page with an interactive 3D preview, uniform auto-fit, physical dimensions, quarter-turn orientation controls, and a built-in reference model.
- Local GPU detection, startup checks, smaller-grid fallbacks, and device-loss handling.
- A 3D airflow solver with gradual wind startup, inlet/outlet boundaries, free-slip tunnel sides, and surface-distance interpolation at the sphere wall.
- Run, pause, single-step, and fluid reset controls.
- A stationary sphere with solid-cell boundaries, plus an empty tunnel for comparison.
- Safe scene changes that reset the fluid and step counter.
- An orbitable Three.js viewer with speed and pressure slices, labeled color scales, and optional cell outlines.
- A hideable slice and a voxel-body view showing the shape the solver actually uses.
- GPU-advected 3D airflow tracers with soft heads and short fading path trails, visible without a slice.
- Thin smoke-style streamlines from eleven inlet positions, traced through the calculated 3D velocity field. Soft bundled strands replace the old fog volume. These are instantaneous flow lines, not transported smoke density.
- Faster simulation pace choices and an optional translucent slice with adjustable opacity.
- Density, speed, stability, and basic dimensionless-flow readouts.
- Selectable simulation resolution, memory estimates, and measured batch time per step.
- Signed sphere forces, provisional drag/lift coefficients, and a drag history chart.
- Automated GPU, CPU-reference, analytical-flow, reset, and viewer checks.

The sphere is currently represented by only a few cells across its diameter. It is intentionally coarse and blocky in voxel view. The smooth sphere is a visual preview; the voxel body represents the simulation geometry.

Current sphere results are a low-Reynolds-number demonstration. They do not establish accurate full-size vehicle aerodynamics, resolved turbulent wakes, or validated drag/lift coefficients. Wind values currently use simulation units; physical dimensions and meters-per-second controls are planned.

## Try the current demo

1. Start the app and wait for GPU initialization to finish.
2. Keep **Stationary sphere** selected, or choose **Empty tunnel** for comparison.
3. Click **Run**. To change speed or simulation pace, open **Wind settings** while paused; reset before changing speed.
4. Drag to orbit the full-width scene. Enable **Show slice** to inspect speed or pressure coloring.
5. Watch the default **Show smoke** view. The slice starts hidden; enable **Show slice** for an adjustable translucent overlay. Open **Inspect geometry and tracers** for voxel inspection and optional airflow tracers.
   **Simulation pace** defaults to Fast (16 actual solver steps per update). Pause to choose a different pace or toggle smoke/tracers. Higher throughput depends on your GPU; this does not multiply particle speeds independently of the airflow.
6. Pause to inspect the state, advance one step, or reset the fluid.

Changing the test scene resets the simulation and clears smoke/tracer history. A nearly uniform slice color can be correct for an empty tunnel. Smoke and tracers freeze when paused. Flow lines update as the simulated velocity field develops. The lines show the current calculated velocity field and stop at solids or stagnation. In steady flow the centre paths remain stationary; subtle moving wisps illustrate flow along them. This texture does not add physical turbulence or simulate transported smoke mass. The low-Re sphere flow may remain smooth; a smoke effect does not create physically resolved vortices.

Use **Simulation resolution** to choose Standard (64 × 32 × 32), Fine (96 × 48 × 48), High (128 × 64 × 64), or Extra (160 × 80 × 80). Automatic keeps the conservative startup and smaller-grid fallback. Changing resolution starts a fresh scene and resets the flow, history, and wind settings. Explicit selections report allocation failures rather than silently substituting a smaller grid.

The presets adjust the starting lattice wind speed and ramp duration to keep the initial Reynolds number comparable. A finer grid needs more steps to cover the same flow development. These are resource presets, not validated accuracy levels; memory estimates exclude rendering and driver overhead, and batch timing is not frame rate.

## Roadmap

### 1. Establish trustworthy physics

- [x] GPU setup, fluid initialization, and basic airflow stepping.
- [x] Inlet/outlet boundaries, gradual startup, pause/step/reset, and stability checks.
- [x] CPU-reference comparisons and basic mass-conservation checks.
- [x] Taylor-Green vortex decay and Poiseuille channel validation, including two-resolution refinement checks.
- [x] Stationary sphere boundaries, reset safety, and basic flow-response checks.
- [x] Momentum-exchange force measurements and an initial matched-Re sphere comparison.
- [ ] Quantitative drag/lift validation: the sphere comparison still shows a reference gap.
- [ ] Sphere resolution studies and more accurate treatment of curved surfaces.
- [ ] Physical dimensions, units, and meters-per-second wind controls.
- [ ] Broader 3D validation and improved boundary and turbulence treatment.
- [ ] Cylinder and additional benchmark objects.

### 2. Support users' own models

- [x] Local self-contained GLB loading and an interactive preparation preview.
- [x] Uniform auto-fit, physical dimensions in metres, and quarter-turn orientation controls.
- [ ] Additional formats (OBJ, glTF, STL), unit selection, and adjustable tunnel placement.
- [ ] Geometry checks and clear feedback about invalid or unresolved features.
- [ ] Convert the model's surface and interior into a reliable simulation obstacle.
- [ ] Show the simulation representation alongside the original model.
- [ ] Reinitialize safely when geometry or its placement changes.

Models will remain stationary during a simulation in this phase. Moving ground, rotating wheels, and other moving parts are deferred.

### 3. Scale quality with the hardware

- [ ] Measure simulation speed, memory requirements, and sustained responsiveness.
- [ ] Establish tested hardware baselines and useful quality tiers.
- [x] Conservative automatic startup and explicit resolution choices with resource estimates.
- [ ] Performance-based automatic quality selection and broader advanced controls.
- [ ] Higher-resolution grids and support for larger allocations where available.
- [ ] Improve memory efficiency and GPU scheduling.
- [ ] Scale simulation quality and rendering quality independently.
- [ ] Investigate local refinement around the body and wake.
- [ ] Clearly communicate local GPU use, resource estimates, progress, and recoverable failures.

A powerful GPU should unlock more capability as the engine improves. No fixed resolution or tiny-vortex accuracy is promised across all models and devices.

### 4. Make airflow visible in 3D

- [x] Orbitable tunnel with optional speed/pressure slices and cell outlines.
- [x] Smooth and voxel previews of the stationary sphere.
- [x] Velocity-driven 3D tracers, soft heads, and short fading path trails.
- [ ] Configurable smoke emitters and longer history controls.
- [x] Thin, soft smoke-style flow lines following the calculated velocity.
- [ ] Refine smoke-line appearance, emission controls, and rendering performance.
- [ ] Wake and vortex inspection using quantities derived from the simulation.
- [ ] Model-surface pressure coloring and point inspection.
- [ ] Clear legends, useful view presets, and exportable results or captures.

### 5. Build the immersive tunnel workspace — much later

Do this major visual redesign after the core physics, model handling, and flow visualization work reliably. Visual quality and interaction are major project goals, not finishing touches to ignore.

- [ ] A dedicated full-page workspace centered on the 3D tunnel scene.
- [ ] A room-like environment with lighting, depth, surroundings, and a clear sense of scale.
- [ ] Well-presented models with visible wind streams, smoke trails, and computed wake structures.
- [ ] Refined camera controls, transitions, and feedback.
- [ ] Controls and analysis tools arranged around the scene without obscuring it.
- [ ] Optional slices and grids as inspection tools rather than the only way to see airflow.
- [ ] Responsive layouts and visual quality settings appropriate to the device.

## Browser and hardware

Use a browser that exposes hardware-accelerated WebGPU, with compatible GPU drivers. Integrated graphics can be suitable for smaller simulations; stronger hardware can support more demanding settings as they become available. The app checks support at startup.

Run on HTTPS or localhost. Browser support alone does not guarantee adequate memory, speed, or numerical accuracy for a chosen simulation.

**Current development machine:** a gaming laptop with an AMD Ryzen 5 7535HS processor. The browser reports the selected GPU vendor as AMD; the exact active GPU model and memory configuration have not been confirmed. The processor name is not the GPU model.

## Run locally

Requires Node.js 22.12 or later.

```bash
npm install
npm run dev
```

Open the local address printed by Vite. In Windows PowerShell, use `npm.cmd` if script policy blocks `npm.ps1`.

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the development app |
| `npm run build` | Check TypeScript and build the app |
| `npm run preview` | Preview the built app |
| `npm run lint` | Check source code |
| `npm test` | Run automated checks |
| `npm run study:drag` | Run the longer, isolated GPU sphere study |
| `npm run study:resolution` | Compare production presets and verify empty-tunnel delivery |
| `npm run study:boundaries` | Isolate inlet, outlet, and side-distance effects |
| `npm run study:tracers` | Measure tracer integration and position-readback cost |
| `npm run study:playback` | Compare complete UI playback configurations |

## Validation and development

Ventus uses React, TypeScript, Vite, Tailwind CSS, Three.js, and WebGPU. The current solver uses the Lattice Boltzmann Method. Shader code and implementation details live in the source rather than being duplicated here.

For browser tests, install Chromium once with `npx playwright install chromium`, then run `npm test`. To use an existing Edge installation in PowerShell:

```powershell
$env:VENTUS_BROWSER_CHANNEL = 'msedge'
npm.cmd test
```

Real GPU tests are explicitly skipped if no compatible adapter is available. A skipped GPU check is not evidence that the simulation passed validation. Analytical formulas, test criteria, example measurements, and limits are documented in the [validation notes](tests/validation/README.md).

The [sphere force study](tests/validation/sphere-drag.md) records resolution, tunnel size, memory estimates, timings, and the unresolved difference from an isolated-sphere reference. The study runs with one worker to avoid competition between tests for the GPU.

The [boundary-distance study](tests/validation/boundary-distance.md) changes one set of boundary distances at a time while preserving the exact voxel sphere. It provides a baseline for future boundary-formula changes.

[Tracer validation notes](tests/validation/tracers.md) explain advection, collision checks, reset behavior, transfer costs, and the current batch-wise approximation for time-varying flow.

[Smoke notes](tests/validation/smoke.md) describe the thin flow-line representation, rendering, and accuracy limits.

Keep current capabilities separate from future goals. Changes to physics or shaders should include relevant validation and a performance note; performance figures should come from measurements. Passing basic benchmarks does not guarantee accuracy for arbitrary uploaded models.

## License

[MIT](LICENSE.md).

## Current milestone: prepare uploaded geometry

**Boundary correction:** the inlet now prescribes velocity while extrapolating the adjacent density and non-equilibrium populations. The zero-gradient outlet remains open. Empty-tunnel regressions require interior speed within 1% of the target across multiple speeds and grids. Density can shift during startup, and force coefficients remain provisional. See the [boundary and playback notes](tests/validation/flow-playback.md).

The [preset study](tests/validation/preset-resolution.md) records drag, wake probes, settling, memory, and calculation cost; higher resolution is not an accuracy certificate. Curved-wall interpolation is now implemented, with quantitative refinement studies still pending.

The GLB preparation page now provides preview, orientation, and scale. Next come geometry checks and voxelisation so uploaded models actually affect airflow. Other import formats and a vortex demonstration follow.

## Surface and smoke refinement - 30 October 2026

Voxelisation and solid blocking remain. The sphere wall now uses actual fluid-to-surface link distances for interpolated reflection; force measurement uses the same returned populations. This improves the geometric wall treatment without increasing the entire grid. It does not establish turbulence or calibrated drag accuracy. See [curved-wall notes](tests/validation/curved-wall.md).

The puffy density renderer and its obsolete playback tests have been removed. Thin smoke-style streamlines follow the computed velocity; the calculate-then-explore workflow remains planned. Use `npm run test:focused` for the small affected checks. GPU tests now use one worker by default; full suites and resolution sweeps remain manual checks.

## Prepare your own model

Click **Add your model** in the tunnel header, or open `/#/import`. Drop a self-contained `.glb`, choose a file, or try the reference coupe. Inspect it in 3D, confirm its longest physical dimension in metres, and rotate it in 90-degree increments. GLB dimensions initially assume metres; confirm them against your export.

The model is centred using its world-space bounds, including nested transforms. A single scale fits it into the preview tunnel without changing its proportions. Real-world dimensions are recorded separately from display scale. The placement matrix is ready to be shared with future voxelisation; uploaded geometry does **not** affect the sphere solver yet. **Review placement** only reviews preparation. Solid-volume checks have not run.

This first importer accepts static triangle meshes up to 50 MB and 500,000 triangles. Embedded PNG/JPEG textures, Draco geometry, and Meshopt compression are supported; decoder assets ship with the app. External model resources, skeletal meshes, and required KTX2 textures are rejected with an explanation. Animation clips are held at their initial pose. Files stay in browser memory and are released when replaced or when leaving the page; reload to start fresh.

For this page alone, run `npm test -- tests/model-preparation.spec.ts --workers=1`. It checks normalization and a real GLB import with nested transforms, rotation, replacement, invalid-file handling, local requests, and desktop/mobile layout. It does not run a fluid simulation or establish compressed-asset compatibility across all exporters.

Smoke wisps now use independent random seeds per strand, retained while running or paused and renewed on reset. Smooth variations change thickness and opacity along calculated paths; they do not add physical turbulence.
