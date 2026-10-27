# Ventus

A browser-based virtual wind tunnel for exploring how air moves around 3D objects.

Ventus aims to combine credible aerodynamic simulation with an immersive visual experience: load a model, configure the wind, and inspect airflow, pressure, and the wake around it.

**Status: pre-alpha learning project.** The current app supports a stationary sphere, an empty tunnel, and provisional force measurements. User-uploaded models, smoke trails, and volume visualization are still in development or planned.

## Our mission

Build a wind tunnel that is enjoyable to explore, useful for learning, and increasingly capable as its physics and validation improve.

- **Physics first.** Validate the calculations before treating their results as trustworthy measurements.
- **Exceptional visuals and interaction.** Work toward fluid motion, readable analysis, polished controls, and a dedicated tunnel workspace.
- **Use the user's GPU effectively.** Offer more detail and richer visuals as the device, browser, and validated solver allow.
- **Keep access simple.** Open the app, use it, optionally download results, and leave. No account, database, or server-side simulation is required by the current architecture.
- **Make the limits understandable.** Explain quality, performance, and accuracy without asking users to understand the implementation.

The long-term experience should make airflow feel tangible: streams passing around the body, smoke-like trails revealing motion, and wake structures that can be explored in 3D. These visuals must follow the calculated flow. Fine vortices require appropriate physics and sufficient resolution; a smooth model or dense particle effect does not establish simulation accuracy.

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

- Local GPU detection, startup checks, smaller-grid fallbacks, and device-loss handling.
- A 3D airflow solver with gradual wind startup, inlet/outlet boundaries, and free-slip tunnel sides.
- Run, pause, single-step, and fluid reset controls.
- A stationary sphere with solid-cell boundaries, plus an empty tunnel for comparison.
- Safe scene changes that reset the fluid and step counter.
- An orbitable Three.js viewer with speed and pressure slices, labeled color scales, and optional cell outlines.
- A hideable slice and a voxel-body view showing the shape the solver actually uses.
- Density, speed, stability, and basic dimensionless-flow readouts.
- Selectable simulation resolution, memory estimates, and measured batch time per step.
- Signed sphere forces, provisional drag/lift coefficients, and a drag history chart.
- Automated GPU, CPU-reference, analytical-flow, reset, and viewer checks.

The sphere is currently represented by only a few cells across its diameter. It is intentionally coarse and blocky in voxel view. The smooth sphere is a visual preview; the voxel body represents the simulation geometry.

Current sphere results are a low-Reynolds-number demonstration. They do not establish accurate full-size vehicle aerodynamics, resolved turbulent wakes, or validated drag/lift coefficients. Wind values currently use simulation units; physical dimensions and meters-per-second controls are planned.

## Try the current demo

1. Start the app and wait for GPU initialization to finish.
2. Keep **Stationary sphere** selected, or choose **Empty tunnel** for comparison.
3. Set the target inlet speed and click **Run**.
4. Orbit the scene and switch between speed and pressure coloring.
5. Move the slice across the tunnel, toggle **Show voxel body**, or hide the slice entirely.
6. Pause to inspect the state, advance one step, or reset the fluid.

Changing the test scene resets the simulation. A nearly uniform color can be correct for an empty tunnel. Smoke-like trails and particle visualization are not implemented yet.

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

- [ ] Local OBJ, GLB, and glTF loading.
- [ ] Model preview, units, physical dimensions, orientation, and placement controls.
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
- [ ] Moving flow tracers, configurable emitters, and persistent trails.
- [ ] Smoke-like visualization and volumetric views.
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
| `npm run study:boundaries` | Isolate inlet, outlet, and side-distance effects |

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

Keep current capabilities separate from future goals. Changes to physics or shaders should include relevant validation and a performance note; performance figures should come from measurements. Passing basic benchmarks does not guarantee accuracy for arbitrary uploaded models.

## License

[MIT](LICENSE.md).
