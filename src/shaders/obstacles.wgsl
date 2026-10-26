// Apply solid flags without changing fluid populations (including test initial fields).
struct Params { grid: vec3<u32>, tau: f32, inlet: vec3<f32>, cs: f32 };
@group(0) @binding(0) var<storage, read_write> state_a: array<f32>;
@group(0) @binding(1) var<storage, read_write> state_b: array<f32>;
@group(0) @binding(2) var<storage, read> flags: array<u32>;
@group(0) @binding(3) var<uniform> p: Params;
@group(0) @binding(4) var field: texture_storage_3d<rgba16float, write>;
@compute @workgroup_size(8,8,4)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (any(id >= p.grid)) { return; }
  let n = p.grid.x*p.grid.y*p.grid.z;
  let node = id.x+p.grid.x*(id.y+p.grid.y*id.z);
  if ((flags[node] & 1u) == 0u) { return; }
  for (var i = 0u; i < 19u; i++) {
    state_a[i*n+node] = 0.0;
    state_b[i*n+node] = 0.0;
  }
  textureStore(field, vec3<i32>(id), vec4<f32>(0.0));
}
