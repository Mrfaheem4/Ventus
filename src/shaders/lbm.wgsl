struct Params {
  grid: vec3<u32>, tau: f32,
  inlet: vec3<f32>, cs: f32,
  step: u32, ramp_steps: u32, boundary_mode: u32, acceleration_x: f32,
};
@group(0) @binding(0) var<storage, read> source: array<f32>;
@group(0) @binding(1) var<storage, read_write> destination: array<f32>;
@group(0) @binding(2) var<storage, read> flags: array<u32>;
@group(0) @binding(3) var<uniform> p: Params;

var<private> c: array<vec3<i32>, 19> = array<vec3<i32>, 19>(
  vec3(0,0,0), vec3(1,0,0), vec3(-1,0,0), vec3(0,1,0), vec3(0,-1,0), vec3(0,0,1), vec3(0,0,-1),
  vec3(1,1,0), vec3(-1,-1,0), vec3(1,-1,0), vec3(-1,1,0),
  vec3(1,0,1), vec3(-1,0,-1), vec3(1,0,-1), vec3(-1,0,1),
  vec3(0,1,1), vec3(0,-1,-1), vec3(0,1,-1), vec3(0,-1,1)
);
var<private> opposite: array<u32, 19> = array<u32, 19>(0,2,1,4,3,6,5,8,7,10,9,12,11,14,13,16,15,18,17);
fn weight(i: u32) -> f32 {
  if (i == 0u) { return 1.0/3.0; }
  if (i <= 6u) { return 1.0/18.0; }
  return 1.0/36.0;
}
fn equilibrium(i: u32, rho: f32, u: vec3<f32>) -> f32 {
  let cu = dot(vec3<f32>(c[i]), u);
  return weight(i) * rho * (1.0 + 3.0*cu + 4.5*cu*cu - 1.5*dot(u,u));
}
fn index(v: vec3<i32>) -> u32 {
  return u32(v.x) + p.grid.x * (u32(v.y) + p.grid.y * u32(v.z));
}

@compute @workgroup_size(8,8,4)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (any(id >= p.grid)) { return; }
  let n = p.grid.x * p.grid.y * p.grid.z;
  let node = index(vec3<i32>(id));
  if ((flags[node] & 1u) != 0u) {
    for (var i = 0u; i < 19u; i++) { destination[i*n+node] = 0.0; }
    return;
  }
  // Modes 2/3 wrap X for periodic/vortex and forced-channel verification.
  if (p.boundary_mode < 2u && id.x == 0u) {
    let t = min(f32(p.step) / f32(p.ramp_steps), 1.0);
    let velocity = p.inlet * (t*t*(3.0-2.0*t));
    for (var i = 0u; i < 19u; i++) { destination[i*n+node] = equilibrium(i, 1.0, velocity); }
    return;
  }
  if (p.boundary_mode < 2u && id.x == p.grid.x-1u) {
    // First-order zero-gradient outlet: extrapolate previous upstream populations.
    let upstream = node-1u;
    for (var i = 0u; i < 19u; i++) { destination[i*n+node] = source[i*n+upstream]; }
    return;
  }
  var f: array<f32, 19>;
  var rho = 0.0;
  var momentum = vec3<f32>(0.0);
  for (var i = 0u; i < 19u; i++) {
    var src = vec3<i32>(id) - c[i];
    let channel_wall = p.boundary_mode == 3u && (src.y < 0 || src.y >= i32(p.grid.y));
    var direction = i;
    if (p.boundary_mode == 0u) {
      // Half-link specular reflection: flip only the wall-normal component.
      // Tangential populations keep their upstream offsets. Corners flip both.
      var reflected = c[i];
      if (src.y < 0 || src.y >= i32(p.grid.y)) { src.y = i32(id.y); reflected.y = -reflected.y; }
      if (src.z < 0 || src.z >= i32(p.grid.z)) { src.z = i32(id.z); reflected.z = -reflected.z; }
      if (any(reflected != c[i])) {
        for (var j = 0u; j < 19u; j++) { if (all(c[j] == reflected)) { direction = j; break; } }
      }
    } else {
      src.y = (src.y + i32(p.grid.y)) % i32(p.grid.y);
      src.z = (src.z + i32(p.grid.z)) % i32(p.grid.z);
    }
    if (p.boundary_mode >= 2u) { src.x = (src.x + i32(p.grid.x)) % i32(p.grid.x); }
    let upstream = index(src);
    var value = source[direction*n+upstream];
    if (channel_wall || (flags[upstream] & 1u) != 0u) { value = source[opposite[i]*n+node]; }
    f[i] = value;
    rho += value;
    momentum += value * vec3<f32>(c[i]);
  }
  // Guo forcing acts on the streamed/pre-collision state. Default acceleration is zero.
  let force = vec3<f32>(rho*p.acceleration_x, 0.0, 0.0);
  let velocity = (momentum + 0.5*force) / rho;
  for (var i = 0u; i < 19u; i++) {
    let ci = vec3<f32>(c[i]);
    let forcing = weight(i)*(1.0-0.5/p.tau)*dot(3.0*(ci-velocity)+9.0*dot(ci,velocity)*ci, force);
    destination[i*n+node] = f[i] - (f[i] - equilibrium(i, rho, velocity)) / p.tau + forcing;
  }
}
