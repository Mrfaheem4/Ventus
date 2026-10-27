# Passive airflow tracer foundation

The diagnostic tracer view provides 768 passive markers with soft sprite heads and up to 48 displayed positions per short path trail. They are not themselves a smoke-density simulation or evidence of resolved small vortices. The separate [smoke view](smoke.md) now provides passive concentration transport and volume rendering. Neither affects fluid density, momentum, or forces.

## Motion and clock

`src/shaders/tracers.wgsl` reads the solver's rgba16float velocity texture directly on the GPU. It manually interpolates eight neighboring cell-center values in 3D. After each solver batch, it uses explicit midpoint (RK2) integration with one lattice-time substep per completed solver step. Advection reads the latest end-of-batch field, held fixed throughout those substeps. Pace choices now use 4, 8, or 16 steps; Fast defaults to 16. The historical isolated cost study below uses four-step batches.

**This is a temporal approximation.** Paths are not integrated against a separately recovered velocity field at every LBM step. Rapidly changing flow can need smaller batches or tighter coupling later. No wall-clock motion, added swirl, random acceleration, or render-frame time scaling is applied. Pausing freezes positions and trails. A slow machine displays less simulated time per second rather than changing tracer physics to compensate.

Seeds are deterministic and initially distributed through fluid cells so the whole tunnel can be inspected. On leaving the interior tracer domain or encountering a solid voxel, a marker restarts near the inlet with a new deterministic Y/Z position. Generation counters break the trail at each restart. Restarting blocked markers is a visualization policy, not a model of smoke interacting with surfaces. It does not conserve smoke concentration or mass.

Solid checks use the voxel mask, not the smooth preview. Speed-bounded one-step segments use segment-versus-box slab intersections over at most eight neighboring voxels. This catches short diagonal intersections that endpoint/midpoint tests can miss. Sparse straight displayed trail segments connect recorded accepted positions; they are not a continuous fitted surface-following curve and can visually clip the smooth preview on coarse grids. The visual and voxel surfaces still differ.

## Rendering and resource cost

The GPU returns only positions and restart generations to the existing WebGL Three.js viewer: 768 x 16 bytes = **12 KiB per displayed batch**, independent of fluid-grid resolution. The full velocity volume is not read back. Two position buffers plus a 16-byte uniform use **24,592 bytes**, included in the app's allocation estimate when active. Batch timing includes enabled tracer work and initial tracer compilation/allocation when first used. It is not rendering FPS or GPU-only timing.

CPU history, dynamic WebGL geometry, sprite texture, renderer, and driver resources are excluded from the simulation-buffer estimate. Trails add CPU work and WebGL uploads; this bounded prototype is not an architecture claim for hundreds of thousands of smoke particles. Large-scale smoke needs further performance work and an appropriate density/rendering representation.

### Local cost measurement: 27 October 2026

Run `npm run study:tracers` for an isolated, single-worker cost study. The [recorded JSON](measurements/tracer-cost-2026-10-27.json) comes from Edge 156 on the development laptop, adapter vendor `amd` (exact GPU model unconfirmed). Each case warms its pipelines, then measures 1,024 solver steps in batches of four. Fresh identical initial conditions are used for each on/off case.

| Grid | Tracers disabled, total wall ms/step | Tracers enabled, total wall ms/step | Tracer phase alone, ms/step |
| --- | ---: | ---: | ---: |
| 64 x 32 x 32 | 1.224 | 2.110 | 0.879 |
| 96 x 48 x 48 | 2.230 | 3.354 | 0.894 |

These are a single sequential run, not confidence intervals or a performance tier. The tracer phase includes its separate dispatch, mapping fence, and 12 KiB position readback. The solver's own timing also varies between cases. React updates, trail geometry, animated scene rendering, and WebGL uploads are excluded; an idle demo can remain on the test page. These numbers cannot be converted directly into interactive FPS. The additional queue/readback fence is a clear optimization target before scaling smoke density substantially.

Tracers are now optional and disabled by default in favor of the smoke view. They can be toggled while paused. Toggling, fluid reset, scene/resolution changes, GPU reinitialization, and cleanup clear history and release tracer buffers as appropriate. Scene disposal also releases point/line geometry, sprite texture, and materials. Scoped creation failures disable tracers with a message while a healthy airflow solver continues. Device loss follows the normal reinitialization path.

## Verification

Run `npm test -- tests/tracers.spec.ts`; set `VENTUS_BROWSER_CHANNEL=msedge` to use installed Edge. Real-GPU cases explicitly skip when no adapter is available.

- Deterministic initialization places markers inside fluid and outside the voxel sphere.
- Uniform 3D velocity verifies signed displacement in batches of 4 and 12 steps.
- Linear shear ux = y/256 and uy = 1/64 checks trilinear interpolation and midpoint integration against an independently calculated analytical position.
- Zero velocity leaves position and generation unchanged.
- A brief diagonal solid-cell crossing and a domain exit restart at the inlet with a new generation.
- UI checks cover slice-free rendering, populated trails, a frozen paused view, reset, toggling, scene changes, and GPU reinitialization.
- An injected shader failure disables tracers while the solver continues stepping.

Analytical GPU positions use an absolute tolerance of approximately 5e-6 cells, with samples exactly representable in half precision. Measurements are attached to the Playwright result. These checks establish behavior in simple fields, not trajectory accuracy for arbitrary unsteady or turbulent flows.

Further work includes emitter controls, lighting, smoke detail, and performance improvements. Keep rendering quality separate from validated flow resolution.
