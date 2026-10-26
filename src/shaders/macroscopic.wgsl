struct Params { grid: vec3<u32>, tau: f32, inlet: vec3<f32>, cs: f32 };
struct Health { min_density: atomic<u32>, max_density: atomic<u32>, max_speed: atomic<u32>, invalid: atomic<u32> };
@group(0) @binding(0) var<storage, read> state: array<f32>;
@group(0) @binding(1) var<uniform> p: Params;
@group(0) @binding(2) var field: texture_storage_3d<rgba16float, write>;
@group(0) @binding(3) var<storage, read_write> health: Health;
@group(0) @binding(4) var<storage, read> flags: array<u32>;
var<private> c: array<vec3<i32>,19> = array<vec3<i32>,19>(
  vec3(0,0,0), vec3(1,0,0), vec3(-1,0,0), vec3(0,1,0), vec3(0,-1,0), vec3(0,0,1), vec3(0,0,-1),
  vec3(1,1,0), vec3(-1,-1,0), vec3(1,-1,0), vec3(-1,1,0),
  vec3(1,0,1), vec3(-1,0,-1), vec3(1,0,-1), vec3(-1,0,1),
  vec3(0,1,1), vec3(0,-1,-1), vec3(0,1,-1), vec3(0,-1,1)
);
@compute @workgroup_size(8,8,4)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (any(id >= p.grid)) { return; }
  let n = p.grid.x*p.grid.y*p.grid.z;
  let node = id.x+p.grid.x*(id.y+p.grid.y*id.z);
  if ((flags[node] & 1u) != 0u) { textureStore(field, vec3<i32>(id), vec4<f32>(0.0)); return; }
  var rho = 0.0;
  var momentum = vec3<f32>(0.0);
  var valid = true;
  for (var i = 0u; i < 19u; i++) {
    let value = state[i*n+node];
    valid = valid && abs(value) < 1e6;
    rho += value;
    momentum += value*vec3<f32>(c[i]);
  }
  let velocity = momentum/rho;
  let speed = length(velocity);
  if (!(valid && rho > 0.0 && rho < 1e6 && speed <= 0.3)) {
    atomicAdd(&health.invalid, 1u);
    textureStore(field, vec3<i32>(id), vec4<f32>(0.0));
    return;
  }
  // Positive finite f32 bit patterns preserve ordering for unsigned atomics.
  atomicMin(&health.min_density, bitcast<u32>(rho));
  atomicMax(&health.max_density, bitcast<u32>(rho));
  atomicMax(&health.max_speed, bitcast<u32>(speed));
  // Preserve small pressure variations in half precision. p' = field.w / 3000.
  textureStore(field, vec3<i32>(id), vec4<f32>(velocity, (rho-1.0)*1000.0));
}
