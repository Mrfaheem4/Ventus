# Ventus — WebGPU 3D LBM Wind Tunnel

A real-time, browser-native 3D wind tunnel. It solves incompressible-ish airflow with the **Lattice Boltzmann Method (D3Q19, BGK collision)** in **WebGPU compute shaders (WGSL)**, voxelizes uploaded CAD meshes (OBJ / glTF) on the GPU, and visualizes the result with a **volume raymarcher** and a **200k-particle streamline tracer**.

> **Status:** design / pre-alpha. The numbers in this document marked _(target)_ are goals from the engineering spec, not measurements. Replace them with your own benchmarks as soon as you have them (see [Benchmarking](#13-benchmarking)).

---

## Table of contents

1. [Features](#1-features)
2. [Browser & hardware requirements](#2-browser--hardware-requirements)
3. [Quick start](#3-quick-start)
4. [Architecture](#4-architecture)
5. [Numerical method](#5-numerical-method)
6. [Units, scaling, and choosing parameters](#6-units-scaling-and-choosing-parameters)
7. [GPU memory layout and limits](#7-gpu-memory-layout-and-limits)
8. [Reference WGSL (fused stream + collide)](#8-reference-wgsl-fused-stream--collide)
9. [Boundary conditions](#9-boundary-conditions)
10. [Mesh voxelization](#10-mesh-voxelization)
11. [Force & coefficient measurement](#11-force--coefficient-measurement)
12. [Visualization](#12-visualization)
13. [Benchmarking](#13-benchmarking)
14. [Validation suite](#14-validation-suite)
15. [Known pitfalls in the original spec](#15-known-pitfalls-in-the-original-spec)
16. [Stability & robustness](#16-stability--robustness)
17. [Project structure](#17-project-structure)
18. [Roadmap](#18-roadmap)
19. [References](#19-references)

---

## 1. Features

| Area       | Feature                                                                                                    |
| ---------- | ---------------------------------------------------------------------------------------------------------- |
| Solver     | D3Q19 lattice, BGK (single relaxation time) collision, fused pull-stream + collide kernel                  |
| Memory     | Structure-of-Arrays (SoA) distributions, ping-pong buffers                                                 |
| Geometry   | OBJ / glTF upload, GPU triangle-box SAT voxelization, interior fill, auto-fit to domain                    |
| Boundaries | Half-way bounce-back (solids), equilibrium/Zou-He inlet, zero-gradient outlet, free-slip or periodic sides |
| Analysis   | Drag / lift / side force and Cd / Cl / Cs via momentum exchange, live plots                                |
| Rendering  | Volume raymarch (pressure / speed / vorticity / Q-criterion), slice planes, RK2 particle streamlines       |
| UX         | Orbit camera, angle-of-attack / yaw controls, live re-voxelization, probe tool, pause / step               |

## 2. Browser & hardware requirements

- A browser with **WebGPU** enabled (current Chrome / Edge, recent Safari and Firefox builds; check caniuse for the latest status). Always feature-detect: `if (!navigator.gpu) { showFallbackMessage(); }`.
- A discrete or recent integrated GPU. 128³ needs roughly **350 MB** of VRAM; 256³ needs **>2.7 GB** (see [section 7](#7-gpu-memory-layout-and-limits)).
- **You must request higher device limits.** Defaults are too small for this project (see below). Always read `adapter.limits` and request what you need, with a graceful fallback to a smaller grid.

```ts
const adapter = await navigator.gpu.requestAdapter({
  powerPreference: "high-performance",
});
if (!adapter) throw new Error("No WebGPU adapter");

const need = {
  maxStorageBufferBindingSize: Math.min(
    adapter.limits.maxStorageBufferBindingSize,
    1 << 31,
  ),
  maxBufferSize: Math.min(adapter.limits.maxBufferSize, 1 << 31),
};
const device = await adapter.requestDevice({
  requiredLimits: need,
  requiredFeatures: adapter.features.has("timestamp-query")
    ? ["timestamp-query"]
    : [],
});

device.lost.then((info) => {
  // GPU reset / tab backgrounded / driver crash
  console.error("Device lost:", info.reason, info.message);
  // Re-create device, re-upload geometry, restart from last checkpoint or equilibrium.
});
```

## 3. Quick start

The app is set up directly in this repository with **React + Vite + TypeScript + Tailwind CSS**. WGSL can be kept in separate `.wgsl` files imported with `?raw`. The solver and rendering milestones below remain planned work.

Use Node.js **22.12+** (Node 24 LTS recommended).

```bash
npm install
npm run dev
```

Open the local URL printed by Vite. On Windows PowerShell, use `npm.cmd` if script execution policy blocks `npm.ps1`.

Installed tooling:

- React and React DOM for the app UI.
- Vite, TypeScript, ESLint, and React lint plugins for development.
- Tailwind CSS with the official `@tailwindcss/vite` plugin.
- `@webgpu/types` configured in `tsconfig.app.json` for WebGPU APIs.
- Three.js and its types for the planned OBJ/glTF loaders and orbit camera (`three/addons/`).
- `@playwright/test` for GPU startup and lifecycle checks. Simulation validation tests will follow with the solver.

Commands: `npm run dev`, `npm run build`, `npm run lint`, `npm test`, and `npm run preview`.

For browser checks, install the test browser once with `npx playwright install chromium`, then run `npm test`. To use an existing Edge installation in PowerShell instead:

```powershell
$env:VENTUS_BROWSER_CHANNEL = 'msedge'
npm.cmd test
```

The suite covers startup, unsupported browsers, adapter/device failures, smaller-grid fallback, resource cleanup, and device loss/recovery. It also attempts real WebGPU initialization; that check is reported as skipped if the test environment has no adapter. Mocked lifecycle checks do not establish physical solver accuracy.

TypeScript is held on the 6.0 release line to satisfy the current `typescript-eslint` peer dependency; the latest TypeScript 7 release is not yet supported by that lint tooling.

WebGPU requires a **secure context** (`https://` or `localhost`). The app initializes an adapter/device and allocates a **64 × 32 × 32** startup grid (65,536 cells), falling back to **32 × 16 × 16** or **16 × 8 × 8** when adapter limits or allocation errors require it. The initial resources total about **10.25 MiB**, excluding driver overhead: two D3Q19 f32 distribution buffers, u32 cell flags, a 32-byte parameter buffer, and an rgba16float velocity/pressure texture. Adapter limits are not a measure of free GPU memory.

The panel shows GPU readiness, grid dimensions, memory estimates, and device limits. Reinitialization releases previous resources. Device loss pauses readiness and offers manual reinitialization. Resources are allocated but not initialized to fluid equilibrium; there is no airflow solver or flow visualization yet. These small grids are development defaults, not validated automotive simulation settings.

## 4. Architecture

```
 CAD upload ──► Parse (OBJ/glTF) ──► Normalize + place in domain
                                           │
                                           ▼
                                  GPU voxelizer (SAT shell)
                                           │
                                           ▼
                                  Interior fill (parity / flood)
                                           │
                                           ▼
                                      node_flags[]
                                           │
        ┌──────────────────────────────────┘
        ▼
  ┌──────────── per frame: K sub-steps ────────────┐
  │  LBM fused stream+collide  (A ─► B)            │
  │  swap A/B                                      │
  └────────────────────────────────────────────────┘
        │
        ▼
  Macroscopic pass (rho, u) ─► 3D texture (+ optional force reduction)
        │
        ├──► Volume raymarch (fragment shader)
        └──► Particle advect (RK2, compute) ─► instanced draw
```

**Two things the original spec leaves implicit and you should decide early:**

1. **Sub-stepping.** One LBM step per rendered frame at 60 FPS is a slow simulation (60 lattice steps/s). Run **K LBM steps per frame** (e.g. 4–20), and render only once. Make K adjustable and auto-tune it against a frame-time budget.
2. **Ping-pong is a bind-group swap, not a copy.** Create two bind groups (A→B and B→A) up front and alternate them. Never recreate bind groups per frame.

## 5. Numerical method

**Lattice:** D3Q19 with `c_s² = 1/3`.

| Index `i` | Velocity `c_i`                  | Weight `w_i` |
| --------- | ------------------------------- | ------------ |
| 0         | (0,0,0)                         | 1/3          |
| 1–6       | (±1,0,0), (0,±1,0), (0,0,±1)    | 1/18         |
| 7–18      | (±1,±1,0), (±1,0,±1), (0,±1,±1) | 1/36         |

**Recommended ordering (opposite pairs are adjacent, so `opp(i)` is a lookup or a cheap bit trick):**

```
 0: ( 0, 0, 0)
 1: ( 1, 0, 0)   2: (-1, 0, 0)
 3: ( 0, 1, 0)   4: ( 0,-1, 0)
 5: ( 0, 0, 1)   6: ( 0, 0,-1)
 7: ( 1, 1, 0)   8: (-1,-1, 0)   9: ( 1,-1, 0)  10: (-1, 1, 0)
11: ( 1, 0, 1)  12: (-1, 0,-1)  13: ( 1, 0,-1)  14: (-1, 0, 1)
15: ( 0, 1, 1)  16: ( 0,-1,-1)  17: ( 0, 1,-1)  18: ( 0,-1, 1)

OPP = [0, 2,1, 4,3, 6,5, 8,7, 10,9, 12,11, 14,13, 16,15, 18,17]
```

**Collision (BGK):**

```
f_i*(x,t) = f_i(x,t) − (1/τ) · ( f_i − f_i^eq )
f_i^eq    = w_i · ρ · [ 1 + 3(c_i·u) + 4.5(c_i·u)² − 1.5|u|² ]
```

**Streaming:** `f_i(x, t+1) = f_i*(x − c_i, t)` (pull form: each thread reads from its upstream neighbors and writes only to its own cell, which gives coalesced writes and no write races).

**Macroscopic recovery:**

```
ρ   = Σ f_i
ρu  = Σ f_i c_i
p   = ρ / 3          (lattice units, c_s² = 1/3)
ν   = (2τ − 1) / 6   (lattice units)
```

**Stability limits to enforce in the UI (not just document):**

| Quantity           | Safe range                                  | Why                                    |
| ------------------ | ------------------------------------------- | -------------------------------------- | ----------------------- | --------------------------------------- |
| `τ`                | > 0.5, practically **≥ 0.505–0.52** for BGK | Viscosity → 0 makes BGK blow up        |
| Lattice velocity ` | u                                           | `                                      | **≤ 0.1** (Mach ≲ 0.17) | LBM is weakly compressible; error ∝ Ma² |
| Density            | stays near 1.0                              | Large excursions mean you are unstable |

If Re is high, BGK alone will go unstable. Plan for **Smagorinsky LES** (cheap) and later **TRT / MRT / regularized / cumulant** collision (see [roadmap](#18-roadmap)).

## 6. Units, scaling, and choosing parameters

This is the section most LBM projects get wrong. The solver works in **lattice units** (Δx = Δt = 1). You map to physical units with three numbers.

```
Δx        = L_phys / L_lat                 (metres per cell)
Δt        = u_lat · Δx / U_phys            (seconds per step)
ν_lat     = (2τ − 1) / 6
Re        = U_phys · L_phys / ν_phys  =  u_lat · L_lat / ν_lat
```

**Workflow:**

1. Pick the model's characteristic length in cells, `L_lat` (e.g. 32 cells across a 128³ domain).
2. Pick `u_lat` (start at **0.05**).
3. Choose `τ`, which fixes the Reynolds number the simulation can represent:

| `τ`   | `ν_lat` | Re at `L_lat=32, u_lat=0.05`      |
| ----- | ------- | --------------------------------- |
| 0.60  | 0.0333  | ~48                               |
| 0.55  | 0.0167  | ~96                               |
| 0.51  | 0.00333 | ~480                              |
| 0.505 | 0.00167 | ~960 (needs LES/better collision) |

Real cars/aircraft are at Re of 10⁶–10⁷. **A 128³ browser simulation cannot resolve that.** Be honest in the UI: label results as _qualitative_ unless validated at matching Re, and show the effective Re and Mach number on screen.

**Domain sizing rules of thumb (L = model length, H = height):**

- Upstream of the body: **≥ 1–2 L**
- Downstream: **≥ 4–6 L** (wake needs room; shorter boxes reflect pressure waves)
- Sides / top: **≥ 1.5–2 H** each, or use free-slip walls
- **Blockage ratio** (frontal area / cross-section) **< 5 %**, otherwise forces are inflated

This means a 128³ cube is usually a _long box_ (e.g. 256×96×96 or 192×96×96), not a cube. The spec assumes a cube; allow arbitrary `nx, ny, nz`.

## 7. GPU memory layout and limits

**SoA index:** `dist[i * N + node]`, with `node = x + nx*(y + ny*z)` and `N = nx*ny*nz`.

**Per-node cost (ping-pong, f32):**

```
2 buffers × 19 dirs × 4 B = 152 B
+ flags (u32) 4 B
+ velocity/pressure texture (rgba16float) 8 B
≈ 164 B / node
```

| Grid | Nodes      | Total VRAM | One distribution buffer |
| ---- | ---------- | ---------- | ----------------------- |
| 64³  | 262 144    | ~43 MB     | ~20 MB                  |
| 128³ | 2 097 152  | ~344 MB    | ~159 MB                 |
| 192³ | 7 077 888  | ~1.16 GB   | ~538 MB                 |
| 256³ | 16 777 216 | ~2.75 GB   | ~1.27 GB                |

### The default-limit trap

WebGPU's **default** `maxStorageBufferBindingSize` is **128 MiB (134 217 728 B)** and default `maxBufferSize` is **256 MiB**. The spec's 128³ distribution buffer is ~159 MB, so **it fails on default limits.** Options:

1. **Request higher limits** from the adapter (most desktop GPUs allow ≥ 1–2 GiB). Do this first.
2. **Split by direction:** use several storage buffers (e.g. 19 separate or 5 groups) and bind them all. Watch `maxStorageBuffersPerShaderStage` (default 8 on some tiers; request more). This works on weaker adapters.
3. **Use the AA-pattern / "esoteric twist" scheme** to keep **one** distribution buffer instead of two (halves memory, ~76 B/node, makes 256³ ≈ 1.3 GB). More complex indexing but a well-documented optimization.
4. **Store distributions as `f_i − w_i`** (shifted populations) for better f32 precision; later optionally store as f16 to halve bandwidth (precision tradeoffs apply).

### Other layout notes

- **Uniform struct alignment:** `vec3` is 16-byte aligned. Put a scalar right after each `vec3` to fill the padding (as the reference shader below does), and keep the total size a multiple of 16.
- **Flags:** use `u32` bitfields so you can pack more than "solid": `bit0 = solid`, `bit1 = inlet`, `bit2 = outlet`, `bit3 = moving wall`, `bit4 = near-surface (for forces)`.
- **Precision of the render texture:** `rgba16float` has ~3 significant decimal digits. Density deviations in LBM are ~10⁻³–10⁻², so storing raw `ρ` near 1.0 **destroys the pressure signal**. Store `(ρ − 1) · scale` (or `p − p∞`) instead.
- **Particle buffer (32 B/particle):** `pos: vec3<f32>`, `age: f32`, `vel: vec3<f32>`, `seed/life: f32`. 200k × 32 B = 6.4 MB.

## 8. Reference WGSL (fused stream + collide)

The original spec's shader is a stub, and its "bounce-back" (`if solid { return; }`) does not implement bounce-back; it just skips the cell. This is a corrected reference you can start from. It implements pull streaming, half-way bounce-back, an equilibrium inlet, and BGK with optional Smagorinsky.

```wgsl
// lbm.wgsl
struct Params {
  grid  : vec3<u32>,   // nx, ny, nz
  tau   : f32,         // base relaxation time
  inlet : vec3<f32>,   // inlet velocity (lattice units)
  cs    : f32,         // Smagorinsky constant (0 = off)
};

@group(0) @binding(0) var<storage, read>       f_in  : array<f32>;
@group(0) @binding(1) var<storage, read_write> f_out : array<f32>;
@group(0) @binding(2) var<storage, read>       flags : array<u32>;
@group(0) @binding(3) var<uniform>             P     : Params;

const SOLID  : u32 = 1u;
const INLET  : u32 = 2u;
const OUTLET : u32 = 4u;

// Use var<private> (not const) so these can be indexed dynamically.
var<private> C : array<vec3<i32>, 19> = array<vec3<i32>, 19>(
  vec3( 0, 0, 0),
  vec3( 1, 0, 0), vec3(-1, 0, 0), vec3( 0, 1, 0), vec3( 0,-1, 0), vec3( 0, 0, 1), vec3( 0, 0,-1),
  vec3( 1, 1, 0), vec3(-1,-1, 0), vec3( 1,-1, 0), vec3(-1, 1, 0),
  vec3( 1, 0, 1), vec3(-1, 0,-1), vec3( 1, 0,-1), vec3(-1, 0, 1),
  vec3( 0, 1, 1), vec3( 0,-1,-1), vec3( 0, 1,-1), vec3( 0,-1, 1)
);
var<private> W : array<f32, 19> = array<f32, 19>(
  1.0/3.0,
  1.0/18.0, 1.0/18.0, 1.0/18.0, 1.0/18.0, 1.0/18.0, 1.0/18.0,
  1.0/36.0, 1.0/36.0, 1.0/36.0, 1.0/36.0, 1.0/36.0, 1.0/36.0,
  1.0/36.0, 1.0/36.0, 1.0/36.0, 1.0/36.0, 1.0/36.0, 1.0/36.0
);
var<private> OPP : array<u32, 19> = array<u32, 19>(
  0u, 2u,1u, 4u,3u, 6u,5u, 8u,7u, 10u,9u, 12u,11u, 14u,13u, 16u,15u, 18u,17u
);

fn feq(i: u32, rho: f32, u: vec3<f32>) -> f32 {
  let cu = dot(vec3<f32>(C[i]), u);
  return W[i] * rho * (1.0 + 3.0*cu + 4.5*cu*cu - 1.5*dot(u, u));
}

@compute @workgroup_size(8, 8, 4)   // 256 invocations: the default WebGPU maximum
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let g = P.grid;
  if (any(id >= g)) { return; }

  let N    = g.x * g.y * g.z;
  let node = id.x + g.x * (id.y + g.y * id.z);
  let fl   = flags[node];

  if ((fl & SOLID) != 0u) { return; }          // solid cells hold no fluid

  // ---- Pull streaming with half-way bounce-back ----
  var f : array<f32, 19>;
  for (var i = 0u; i < 19u; i++) {
    let src = vec3<i32>(id) - C[i];
    var v : f32;
    let inside = all(src >= vec3<i32>(0)) && all(src < vec3<i32>(g));
    if (inside) {
      let s = u32(src.x) + g.x * (u32(src.y) + g.y * u32(src.z));
      if ((flags[s] & SOLID) != 0u) {
        v = f_in[OPP[i] * N + node];           // reflect own post-collision population
      } else {
        v = f_in[i * N + s];
      }
    } else {
      v = f_in[OPP[i] * N + node];             // placeholder: replace with real domain BCs
    }
    f[i] = v;
  }

  // ---- Macroscopic moments ----
  var rho = 0.0;
  var m   = vec3<f32>(0.0);
  for (var i = 0u; i < 19u; i++) {
    rho += f[i];
    m   += f[i] * vec3<f32>(C[i]);
  }
  var u = m / rho;

  // ---- Inlet: impose equilibrium at prescribed velocity ----
  if ((fl & INLET) != 0u) { rho = 1.0; u = P.inlet; }

  // ---- Optional Smagorinsky LES: local effective tau ----
  var tau = P.tau;
  if (P.cs > 0.0) {
    // Non-equilibrium momentum flux tensor Π^neq
    var pxx=0.0; var pyy=0.0; var pzz=0.0; var pxy=0.0; var pxz=0.0; var pyz=0.0;
    for (var i = 0u; i < 19u; i++) {
      let fn_ = f[i] - feq(i, rho, u);
      let c = vec3<f32>(C[i]);
      pxx += c.x*c.x*fn_; pyy += c.y*c.y*fn_; pzz += c.z*c.z*fn_;
      pxy += c.x*c.y*fn_; pxz += c.x*c.z*fn_; pyz += c.y*c.z*fn_;
    }
    let Q = sqrt(pxx*pxx + pyy*pyy + pzz*pzz + 2.0*(pxy*pxy + pxz*pxz + pyz*pyz));
    let cs2 = P.cs * P.cs;
    tau = 0.5 * (P.tau + sqrt(P.tau*P.tau + 18.0 * 1.41421356 * cs2 * Q / rho));
    // NOTE: verify this formula against a reference before relying on it (see Validation).
  }

  // ---- BGK collide + write own cell (coalesced) ----
  let omega = 1.0 / tau;
  for (var i = 0u; i < 19u; i++) {
    let fe = feq(i, rho, u);
    if ((fl & INLET) != 0u) {
      f_out[i * N + node] = fe;                         // inlet: pure equilibrium
    } else {
      f_out[i * N + node] = f[i] - omega * (f[i] - fe); // BGK
    }
  }
}
```

> The Smagorinsky formula is included as a starting point and **must be validated** (e.g. against a published implementation) before you trust it. Start with `cs = 0` and get plain BGK correct first.

**Workgroup size note:** the original spec uses `@workgroup_size(8,8,8)` = **512 invocations**. WebGPU's default `maxComputeInvocationsPerWorkgroup` is **256**, so that pipeline **fails to compile on default limits**. Use `(8,8,4)`, `(4,8,8)`, or `(64,1,1)`/`(32,4,2)` variants and benchmark. The claim that 512 "perfectly matches warp bounds" is not accurate; warps are 32 (NVIDIA), 32 or 64 (AMD), 32 (Apple), and any multiple works. Tune empirically.

## 9. Boundary conditions

The spec mentions only solids and "inlet/outlet flags". A wind tunnel needs all of these defined:

| Boundary         | Recommended approach                                                | Notes                                                                                                                       |
| ---------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Model surface    | **Half-way bounce-back** (above)                                    | Second order is possible with interpolated bounce-back (Bouzidi) for curved surfaces; staircase voxels give a rough surface |
| Inlet (−X)       | Equilibrium at (ρ=1, u=U) to start; **Zou-He** or regularized later | Equilibrium inlet is robust but slightly reflective                                                                         |
| Outlet (+X)      | **Zero-gradient / convective** (`f(nx−1) = f(nx−2)`)                | A hard reflection here corrupts the whole domain                                                                            |
| Side / top walls | **Free-slip** (specular reflection) or periodic                     | No-slip walls create a boundary layer and raise effective blockage                                                          |
| Floor            | Free-slip, or no-slip + **moving wall** (rolling road) for cars     | Moving-wall bounce-back adds `2 w_i ρ (c_i·u_w)/c_s²`                                                                       |
| Domain corners   | Define precedence (solid > inlet > outlet > wall)                   | Corner cells are a classic source of NaNs                                                                                   |

**Initialization:** fill every cell with `f_i = feq(ρ=1, u=U_inlet)` (impulsive start) or ramp the inlet velocity over a few thousand steps. An impulsive start sends a strong pressure wave through the domain; a ramp is gentler and more stable.

## 10. Mesh voxelization

The spec's "SAT compute shader" produces a **surface shell only**. To get a solid you also need:

1. **Normalize the model:** compute AABB, center, uniformly scale to fit the target `L_lat`, apply user rotation (angle of attack, yaw). Do this once on CPU; upload transformed vertices.
2. **Triangle-box SAT:** one thread per triangle, loop over the triangle's voxel AABB, test the 13 axes (3 box normals, 1 triangle normal, 9 edge cross-products). Write `flags[node] |= SOLID` using `atomicOr` (or `atomicStore` of a constant; all writers write the same value, but use atomics to stay spec-correct).
3. **Interior fill** (required for closed meshes), choose one:
   - **Ray-parity:** cast a +X ray per (y,z) column, toggle inside/outside at each triangle crossing. Fast on GPU; breaks on non-watertight meshes and at grazing edges.
   - **Flood fill from the outside:** BFS/iterative dilation of "exterior" from a domain corner; everything not reached and not shell is interior. Robust but needs several passes.
4. **Mesh hygiene (CPU side, with clear errors):** non-manifold edges, holes, flipped normals, degenerate triangles, units (mm vs m), huge triangle counts. Offer a decimation warning above ~1–2 M triangles.
5. **Don't claim "a fraction of a millisecond"** without a triangle count. Cost scales with triangles × voxels-per-triangle; a 1M-triangle car at coarse resolution is closer to a few ms.
6. **Thin features** (mirrors, antennas, trailing edges thinner than a cell) vanish or turn into leaks. Warn the user and offer conservative (thickened) voxelization.

**Re-voxelization at runtime:** clear flags → voxelize → fill → _re-initialize newly-fluid cells_ (set to equilibrium at local ρ, u) and zero newly-solid cells. Skipping this when the user drags/rotates the model produces pressure spikes.

## 11. Force & coefficient measurement

Not in the original spec, but it is what turns a visual toy into a wind tunnel.

**Momentum-exchange method:** for every fluid cell `x_f` adjacent to a solid via direction `i`:

```
F += c_i · ( f_i*(x_f) + f_opp(i)(x_f) )         // per boundary link, lattice units
```

Sum over all links on the GPU (workgroup reduction → atomics or a second reduction pass), read back asynchronously every N frames (`mapAsync` on a small staging buffer; never block the frame).

```
Cd = F_x / ( 0.5 · ρ · U² · A_ref )
Cl = F_y / ( 0.5 · ρ · U² · A_ref )
```

`A_ref` is the model's frontal (projected) area in cells². Compute it by projecting the voxelized solid along X. Show force-vs-time and a **time-averaged** Cd (drag oscillates with vortex shedding). Discard the initial transient.

## 12. Visualization

**Macroscopic pass:** compute ρ, u per cell from the distributions into `velocity_pressure_tex` (3D, `rgba16float`, write-only storage in compute, sampled in render). Pack `rgb = u`, `a = (ρ−1)·scale`.

**Volume raymarcher (fragment shader, full-screen or box proxy):**

- Ray-box intersection with the domain AABB, fixed step count (64–256) with jittered start to hide banding.
- Transfer function: 1D colormap texture; ship **perceptually uniform** maps (viridis / turbo), not rainbow.
- Selectable scalar: speed, pressure, vorticity magnitude, **Q-criterion** (much better vortex visualization than raw vorticity). Compute vorticity/Q in the macro pass with central differences into a second texture channel or texture.
- Early ray termination on accumulated opacity; render at half resolution + upsample on slow GPUs.
- Slice planes (x/y/z) are cheap and often more readable than a full volume. Offer both.

**Particles (compute + render):**

- RK2 (midpoint) advection with **trilinear** sampling of the velocity texture (use `textureSampleLevel` with a linear sampler).
- Convert lattice velocity to cells/step and scale by a user "flow speed" factor.
- **Respawn** particles that leave the domain, enter a solid, or exceed lifetime; spawn them near the inlet with a seeded hash RNG (no `Math.random` on GPU).
- Render as instanced camera-facing quads or short line trails (ping-pong a fading trail texture or store a short history). Color by speed. Skip depth writes, use additive blending.
- **Smoke / streak lines** (continuous seeding from a rake) read more like a real wind tunnel than uniform random particles. Offer a seed-rake tool.

**UI essentials:** orbit camera, FPS + sim-steps/s + MLUPS readout, effective Re and Mach, Cd/Cl plot, pause/step, wireframe of the model, domain box, colorbar with units.

## 13. Benchmarking

The spec's numbers (RTX 4090 1.12 ms, 1 872 MLUPS, etc.) are arithmetic-consistent (`2 097 152 / t`), but they are **targets, not measurements**, and they ignore WebGPU overhead (validation, command encoding, browser scheduling). Measure your own.

- **GPU time:** use `timestamp-query` (when available) with `timestampWrites` on compute passes. Report **median** and **p95** over ≥ 1 000 steps after a warm-up.
- **Wall time:** also measure with `device.queue.onSubmittedWorkDone()`.
- **MLUPS** = `(nx·ny·nz · steps) / seconds / 1e6`.
- **Bandwidth sanity check:** each step moves ≈ `152 B × N` (19 reads + 19 writes, f32) plus flags. Compare to the GPU's memory bandwidth to see how close you are to the roofline. LBM is **memory-bound**, so if you are far below it, look at coalescing, workgroup shape, and branch divergence from the solid/fluid test.
- Log browser, OS, GPU, driver, grid size, workgroup size, K sub-steps, and f32 vs f16 with every result.

| GPU         | Grid | Workgroup | ms/step | MLUPS | Date |
| ----------- | ---- | --------- | ------- | ----- | ---- |
| _(fill in)_ |      |           |         |       |      |

## 14. Validation suite

Build these **before** adding visual polish. A pretty simulation that is wrong is worse than an ugly one that is right.

| Test                                    | What it checks                      | Expected                                                     |
| --------------------------------------- | ----------------------------------- | ------------------------------------------------------------ |
| **Uniform flow, no obstacle**           | Inlet/outlet BCs, no spurious drift | Constant `u`, ρ ≈ 1                                          |
| **Poiseuille (channel) flow**           | Viscosity, wall BC                  | Parabolic profile matching analytic solution                 |
| **Taylor-Green vortex**                 | Viscosity ↔ τ mapping, solver order | Exponential decay at the analytic rate                       |
| **Lid-driven cavity (Re 100/400/1000)** | Full 3D solver                      | Match Ghia et al. centerline profiles                        |
| **Flow past a sphere**                  | Obstacle BC, forces                 | Cd ≈ 1.09 at Re 100 (± few %)                                |
| **Flow past a cylinder (2.5D)**         | Vortex shedding                     | Strouhal ≈ 0.16–0.17 at Re 100                               |
| **Grid convergence**                    | Numerical accuracy                  | Error decreases as resolution doubles                        |
| **Mass conservation**                   | No leaks                            | Σρ constant (closed domain)                                  |
| **CPU reference**                       | Shader correctness                  | GPU result matches a simple TypeScript/Python D3Q19 to ~1e-5 |

Automate these as headless tests (e.g. Playwright with a WebGPU-enabled Chromium flag) so every shader change gets regression-checked. Also add a **NaN/Inf detector** (see below).

## 15. Known pitfalls in the original spec

A quick list of things to fix or reconsider before implementing:

1. **`@workgroup_size(8,8,8)` = 512 invocations exceeds the default 256 limit.** Use ≤ 256 or request a higher limit (and still expect many GPUs to cap at 256).
2. **Distribution buffers (~159 MB) exceed the default 128 MiB storage-binding limit.** Request higher limits or split the buffers.
3. **"Bounce-back" is `return`.** That skips the cell; it does not reflect populations. See [section 8](#8-reference-wgsl-fused-stream--collide).
4. **Voxelizer yields a shell, not a solid.** Interior fill is missing.
5. **Domain assumed cubic.** Wind tunnels want long, thin domains.
6. **No outlet/side/floor boundary definitions.**
7. **No unit mapping** (lattice ↔ physical), no Mach/Re safeguards.
8. **No force measurement** (drag/lift), the core output of a wind tunnel.
9. **`rgba16float` pressure** loses the tiny density deviations; store `ρ−1`.
10. **"100 % coalescing"** is overstated. Pull-streaming reads at shifted offsets and will not be perfectly aligned; writes are coalesced. Treat as "good", not "perfect".
11. **TDR guidance is misleading.** Splitting across multiple _command buffers_ does not shorten any single dispatch. If one dispatch is too long, split the **work** (z-slabs/tiles) across several dispatches or submits. In browsers, also expect watchdog timers; keep per-submit GPU time small (tens of ms).
12. **Benchmarks are unverified targets**, and "PRODUCTION READY / 2.4.0-RELEASE" is premature for a design that has no working shader. Mark versions honestly.
13. **256³ is under-specified.** At ~2.75 GB (or 1.27 GB per buffer) it needs buffer splitting or the AA-pattern; it is not just a bigger dispatch.
14. **Uniform struct padding** is not specified (`vec3` alignment). Make it explicit.
15. **BGK at low viscosity is unstable**; the spec has no collision upgrade path or LES.

## 16. Stability & robustness

- **NaN/blow-up detection:** every N steps run a tiny reduction that flags `!isFinite(ρ)`, `ρ ≤ 0`, or `|u| > 0.3`. On trigger: pause, show a message ("Simulation unstable: increase τ, lower inlet speed, or refine the grid"), offer auto-fix.
- **Inlet ramp:** accelerate from 0 to target speed over a few hundred to few thousand steps.
- **Clamp** lattice velocity in the macroscopic pass for rendering, not in the solver.
- **Device loss:** handle `device.lost`, rebuild resources, restore from equilibrium.
- **Tab visibility:** pause simulation when hidden (`document.visibilityState`).
- **Dispatch pacing:** adapt K (sub-steps/frame) to hold ~12–14 ms of GPU work per frame; never queue unbounded work.
- **Error scopes:** wrap resource creation with `device.pushErrorScope("validation")` / `popErrorScope()` and surface errors in the UI during development.
- **Determinism:** seed all RNG; identical inputs should produce identical results on the same GPU (useful for regression tests).

## 17. Project structure

```
webgpu-windtunnel/
├─ README.md
├─ index.html
├─ package.json
├─ src/
│  ├─ main.ts                 # bootstrap, feature detection, main loop
│  ├─ gpu/
│  │  ├─ device.ts            # adapter/device, limits, device-lost handling
│  │  ├─ buffers.ts           # SoA buffers, ping-pong, bind groups
│  │  ├─ timing.ts            # timestamp queries, MLUPS
│  │  └─ debug.ts             # error scopes, NaN detector, readback helpers
│  ├─ sim/
│  │  ├─ lbm.ts               # pipeline setup, step scheduling, sub-stepping
│  │  ├─ units.ts             # lattice ↔ physical conversion, Re/Ma checks
│  │  ├─ boundaries.ts        # BC flag setup (inlet/outlet/walls)
│  │  └─ forces.ts            # momentum exchange + async readback
│  ├─ geometry/
│  │  ├─ loaders.ts           # OBJ / glTF parsing
│  │  ├─ normalize.ts         # fit/center/rotate into domain
│  │  ├─ voxelize.ts          # SAT shell + interior fill dispatch
│  │  └─ validate.ts          # watertightness, degenerate triangles
│  ├─ render/
│  │  ├─ volume.ts            # raymarcher
│  │  ├─ particles.ts         # RK2 advection + draw
│  │  ├─ slices.ts
│  │  ├─ colormaps.ts
│  │  └─ camera.ts
│  ├─ ui/
│  │  ├─ panel.ts             # controls (Re, speed, AoA, view mode)
│  │  ├─ plots.ts             # Cd/Cl vs time
│  │  └─ overlays.ts          # Re, Mach, MLUPS, warnings
│  └─ shaders/
│     ├─ lbm.wgsl
│     ├─ init.wgsl
│     ├─ macroscopic.wgsl
│     ├─ voxelize_sat.wgsl
│     ├─ voxelize_fill.wgsl
│     ├─ forces.wgsl
│     ├─ particles.wgsl
│     └─ volume.wgsl
├─ tests/
│  ├─ cpu_reference/          # slow, simple D3Q19 for comparison
│  └─ validation/             # Poiseuille, Taylor-Green, sphere Cd, ...
└─ assets/models/             # sample OBJ/glTF (sphere, cylinder, car, wing)
```

## 18. Roadmap

**Milestone 1: Correct solver (no graphics beyond a slice)**

- [ ] Device setup with required limits and fallbacks
- [ ] D3Q19 fused kernel, ping-pong, init to equilibrium
- [ ] Inlet / outlet / free-slip side walls
- [ ] 2D slice render of speed and pressure
- [ ] CPU reference + Poiseuille and Taylor-Green tests passing

**Milestone 2: Obstacles and forces**

- [ ] Hard-coded sphere / cylinder obstacles with bounce-back
- [ ] Momentum-exchange forces, Cd and Strouhal validation
- [ ] Unit mapping, Re/Ma readout, stability guards

**Milestone 3: CAD pipeline**

- [ ] OBJ / glTF loader, normalize, SAT voxelization, interior fill
- [ ] Live rotate / move with correct re-initialization
- [ ] Mesh validation warnings

**Milestone 4: Visualization**

- [ ] Volume raymarcher with colormaps and Q-criterion
- [ ] RK2 particles, seed rake, trails
- [ ] Probe tool, colorbars, screenshots / video capture

**Milestone 5: Performance & accuracy**

- [ ] Workgroup / layout tuning, benchmark table filled in
- [ ] AA-pattern single-buffer streaming
- [ ] f16 population storage (optional)
- [ ] Smagorinsky LES → TRT / MRT / cumulant collision
- [ ] Interpolated bounce-back (Bouzidi) for curved surfaces
- [ ] Moving-wall rolling road
- [ ] Adaptive sub-stepping to frame budget

**Stretch**

- [ ] Multi-resolution / local grid refinement
- [ ] Thermal coupling (D3Q7 advection-diffusion)
- [ ] Export: forces CSV, VTK volume, glTF streamlines
- [ ] Shareable URLs for scene settings
- [ ] Mobile-friendly reduced-resolution mode

## 19. References

- Krüger et al., _The Lattice Boltzmann Method: Principles and Practice_ (Springer, 2017). The standard textbook.
- Lehmann, M. et al., work on **FluidX3D** (OpenCL LBM) for memory-efficient layouts and the esoteric-twist streaming scheme. The best reference for performance ideas.
- Zou & He (1997), pressure and velocity boundary conditions for LBM.
- Bouzidi, Firdaouss & Lallemand (2001), interpolated bounce-back.
- Ghia, Ghia & Shin (1982), lid-driven cavity benchmark data.
- WebGPU and WGSL specifications (W3C); `maxComputeInvocationsPerWorkgroup`, `maxStorageBufferBindingSize` and friends are listed under "Limits".

---

## License

MIT

## Contributing

Open an issue before large changes. Any change to a shader should come with a passing validation test and a benchmark note.
