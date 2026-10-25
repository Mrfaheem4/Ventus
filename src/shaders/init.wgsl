// At rest, D3Q19 equilibrium is simply f_i = w_i * rho, with rho = 1.
// Layout matches the 32-byte solver parameter block described in the README.
struct Params {
  grid: vec3<u32>,
  tau: f32,
  inlet: vec3<f32>,
  cs: f32,
};

@group(0) @binding(0) var<storage, read_write> state_a: array<f32>;
@group(0) @binding(1) var<storage, read_write> state_b: array<f32>;
@group(0) @binding(2) var<storage, read_write> flags: array<u32>;
@group(0) @binding(3) var<uniform> params: Params;
@group(0) @binding(4) var field: texture_storage_3d<rgba16float, write>;

@compute @workgroup_size(8, 8, 4)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (any(id >= params.grid)) { return; }
  let count = params.grid.x * params.grid.y * params.grid.z;
  let node = id.x + params.grid.x * (id.y + params.grid.y * id.z);
  for (var i = 0u; i < 19u; i++) {
    var weight = 1.0 / 36.0;
    if (i == 0u) { weight = 1.0 / 3.0; }
    else if (i <= 6u) { weight = 1.0 / 18.0; }
    state_a[i * count + node] = weight;
    state_b[i * count + node] = weight;
  }
  flags[node] = 0u; // All cells are fluid; boundary flags come with the solver.
  // xyz = velocity; w = pressure variation (rho - 1), not absolute pressure.
  textureStore(field, vec3<i32>(id), vec4<f32>(0.0));
}
