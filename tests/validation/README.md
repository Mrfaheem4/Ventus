# Analytical solver validation

Sphere forces have a separate [measurement and domain study](sphere-drag.md), run with `npm run study:drag`.

The [boundary-distance study](boundary-distance.md), run with `npm run study:boundaries`, separates inlet, outlet, and side-distance effects on an unchanged voxel sphere.

These tests exercise the production D3Q19 WGSL solver on a real WebGPU adapter. They are two-dimensional laminar solutions extruded through a three-dimensional grid. Passing them does not validate automotive turbulence, arbitrary uploaded geometry, or force coefficients.

Run `npm test -- tests/validation/analytical.spec.ts`. On Windows with Edge installed, set `$env:VENTUS_BROWSER_CHANNEL = 'msedge'` and use `npm.cmd test -- tests/validation/analytical.spec.ts`.

Each test saves JSON measurements under its `test-results/` directory and attaches them to the Playwright result. An unavailable GPU produces an explicit skip, not a validation pass. Grid refinement must reduce the final relative L2 error by at least 25%; the numerical thresholds below are acceptance criteria, not guaranteed accuracy for other problems.

## Taylor–Green vortex

Periodic X/Y/Z boundaries; grids 32 × 32 × 2 and 64 × 64 × 2. Test both relaxation times `tau = 0.6` and `tau = 0.9`, using `nu = (tau - 0.5) / 3`.

For `k = 2*pi/N`, initialize:

```text
ux =  U sin(k*x) cos(k*y)
uy = -U cos(k*x) sin(k*y)
uz = 0
rho = 1 + (3*U^2/4) [cos(2*k*x) + cos(2*k*y)]
```

Set `U = 0.01 * 32/N` to preserve Reynolds number on refinement. Initialize both buffers at equilibrium. At times `N^2/8` and `N^2/4`, compare the full velocity field against the analytical amplitude `U*exp(-2*nu*k^2*t)`.

Project the measured velocities onto the original vortex mode and recover viscosity from the amplitude ratio between the two checkpoints. This tests decay rate separately from the initial equilibrium transient. Also check mass conservation.

| Check | N = 32 | N = 64 |
| --- | --- | --- |
| Relative velocity L2 error | < 2.5% | < 1% |
| Relative inferred-viscosity error | < 3% | < 1% |
| Relative mass drift | < 0.01% | < 0.01% |

## Poiseuille channel

Periodic X/Z, stationary half-way bounce-back walls at `y = -0.5` and `y = H - 0.5`. Use grids 8 × 16 × 2 and 8 × 32 × 2, `tau = 0.8`, and `nu = 0.1`.

A constant body acceleration along X is equivalent to a uniform driving pressure gradient for this fully developed flow. Choose `g = 8*nu*0.01/H^2`; the analytical profile at cell centers is:

```text
u(y) = g/(2*nu) * (y + 0.5) * (H - y - 0.5)
v = w = 0
```

Use Guo forcing during collision. The collision-stage velocity is `(momentum + force/2)/rho`. Our buffers store post-collision populations, so readback and the macroscopic shader recover physical velocity as `momentum/rho - g/2`. Seed both buffers with an equilibrium half-impulse shift to represent zero initial physical velocity. This force is available only in the channel verification mode; it is zero in the normal wind tunnel.

Start from rest and evolve for ten slowest viscous diffusion times, `10*H^2/(nu*pi^2)`, rounded up to a 16-step batch. Check the profile at 80% and 100% of that duration to verify near-steady behavior.

| Check | H = 16 | H = 32 |
| --- | --- | --- |
| Relative profile L2 error | < 2% | < 1% |
| Late-time change / nominal peak speed | < 0.1% | < 0.1% |
| Relative mass drift | < 0.1% | < 0.1% |
| Profile symmetry, absolute lattice velocity | < 1e-5 | < 1e-5 |

These channel checks validate stationary planar walls and forcing, not curved obstacle voxelization or a moving road.

## References

- [DL_SDG: relaxation time, viscosity, and LBE forcing](https://dl-sdg.github.io/RESOURCES/DOCUMENTS/LBETheory.html).
- [lbmpy: Guo force model and velocity shifts](https://cs10.gp.rrze.fau.de/pycodegen/lbmpy/sphinx/forcemodels.html).
- [TensorMesh: analytical 2D Taylor–Green solution and convergence](https://docs.tensor-mesh.com/example_gallery/fluid/taylor_green.html).

## Example local run

Edge/WebGPU run on 26 October 2026. Values are rounded, hardware-dependent correctness measurements, not performance benchmarks or accuracy guarantees for other flows.

| Case | Coarse velocity/profile L2 error | Fine L2 error |
| --- | --- | --- |
| Taylor–Green, tau = 0.6 | 0.622% | 0.156% |
| Taylor–Green, tau = 0.9 | 0.773% | 0.207% |
| Poiseuille, tau = 0.8 | 0.290% | 0.128% |

Taylor–Green viscosity errors on the fine grid were approximately 0.0022% and 0.0550%, respectively. Poiseuille late-time changes were approximately 0.021% of the nominal peak speed. The JSON artifacts contain unrounded measurements for each run.

No GPU performance claims are made by these correctness tests. Open-boundary accuracy, more complex geometries, higher-Reynolds-number flows, and force measurements need separate validation.
