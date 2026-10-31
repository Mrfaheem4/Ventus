# Thin smoke-style flow lines - 30 October 2026

The default view now uses eleven inlet positions, each with three tightly bundled, soft-edged ribbons. A small GPU kernel traces 3D instantaneous streamlines through the solver velocity texture using normalized-direction midpoint integration at half-cell arc-length intervals. It does not add procedural curls, noise or a turbulence model. Line length is bounded and integration stops at low/invalid speed, domain exit, solid cells, or an intersection with the analytic sphere. The centre line can stop at the front stagnation point; it is not artificially bent around the object.

These are smoke-style streamlines: they show direction in a snapshot of the velocity solution. They are not time-resolved streaklines, particles, transported scalar smoke, or evidence of turbulent motion. A steady solution produces stationary centre paths. Subtle width/opacity wisps now move along them as a visual marker. The default fog-volume implementation, volume ray marcher and now-obsolete interpolation tests were removed. Diagnostic moving tracers remain optional. This change does not implement the planned calculate-then-explore workflow.

Each snapshot has 33 paths, `ceil(nx*1.25/0.5)+1` points per path, and four f32 values per point (position and speed/validity). At Standard this is 85,008 bytes per readback and about 166 KiB of calculation/readback buffers, plus a 32-byte uniform. No scalar density grid, 3D volume upload, ray marching, extra depth target or continuous idle render loop is used. Renderer ribbons use fixed buffers that are updated from the path snapshot. These costs are not total memory or an FPS claim.

Focused checks use a known constant vector field to verify streamline direction, zero velocity to verify no paths, and a sphere to verify termination before the true surface. One UI check verifies rendering, frozen pause, reset, the sphere and empty scene, and shader error reporting. A separate layout check covers desktop and narrow viewports. GPU checks run sequentially; no broad performance or resolution sweep is required for a visual change.

Historical measurements in `measurements/` describe earlier implementations and are not benchmarks of these smoke lines.

## Moving wisps

A small procedural opacity/thickness texture gives the narrow ribbons a less rigid appearance. Path travel time is accumulated from segment lengths and sampled speed; a common simulation-time phase moves texture downstream. Display time interpolates between completed solver-step targets and never advances beyond the latest calculated step. The animation loop aims for at most 30 decorative redraws/s; camera and data changes can request additional renders. Pause freezes it, and reset clears phase. No extra flow-field readbacks or GPU advection passes are added for these wisps.

Each strand has an independent randomly generated seed and noise spacing, so neighbouring strands do not repeat the same wisp sequence with an offset. Seeds remain stable between snapshots and while paused; resetting clears them. Smooth noise varies thickness and opacity without displacing the calculated paths.

This is visual smoke detail, not transported scalar density, a turbulence model, or a physical vortex. Centre paths remain those traced from the solver. Width and opacity noise cannot be used as evidence of CFD accuracy.

Real vortex visualization still requires a sufficiently resolved unsteady velocity field. A future vorticity/Q view can highlight rotational structures with 3D surfaces; it cannot recover sub-grid eddies. The curved-wall method improves surface placement but does not refine the velocity grid.
