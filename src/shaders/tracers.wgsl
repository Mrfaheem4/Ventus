struct Params { grid: vec3<u32>, steps: u32 };
@group(0) @binding(0) var flow: texture_3d<f32>;
@group(0) @binding(1) var<storage, read> flags: array<u32>;
// xyz: cell coordinates; w: respawn generation, so renderers never join exits to inlets.
@group(0) @binding(2) var<storage, read_write> particles: array<vec4<f32>>;
@group(0) @binding(3) var<uniform> p: Params;

fn hash(value: u32) -> u32 {
  var x = value;
  x = (x ^ (x >> 16u))*0x7feb352du;
  x = (x ^ (x >> 15u))*0x846ca68bu;
  return x ^ (x >> 16u);
}
fn unit(value: u32) -> f32 { return f32(hash(value) & 0x00ffffffu)/16777216.0; }
fn seed(id: u32, generation: f32) -> vec4<f32> {
  let key = id*97u+u32(generation)*7919u;
  return vec4(1.25, 1.0+unit(key+1u)*f32(p.grid.y-2u), 1.0+unit(key+2u)*f32(p.grid.z-2u), generation);
}
fn outside(x: vec3<f32>) -> bool {
  return any(x < vec3(0.5)) || any(x >= vec3<f32>(p.grid)-vec3(0.5));
}
fn solid(cell: vec3<i32>) -> bool {
  if (any(cell < vec3(0)) || any(cell >= vec3<i32>(p.grid))) { return true; }
  let node = u32(cell.x)+p.grid.x*(u32(cell.y)+p.grid.y*u32(cell.z));
  return (flags[node] & 1u) != 0u;
}
fn velocity(x: vec3<f32>) -> vec3<f32> {
  let q = clamp(x-vec3(0.5), vec3(0.0), vec3<f32>(p.grid)-vec3(1.0));
  let lo = vec3<i32>(floor(q));
  let hi = min(lo+vec3(1), vec3<i32>(p.grid)-vec3(1));
  let t = fract(q);
  let a = mix(textureLoad(flow, vec3(lo.x,lo.y,lo.z),0).xyz, textureLoad(flow,vec3(hi.x,lo.y,lo.z),0).xyz,t.x);
  let b = mix(textureLoad(flow, vec3(lo.x,hi.y,lo.z),0).xyz, textureLoad(flow,vec3(hi.x,hi.y,lo.z),0).xyz,t.x);
  let c = mix(textureLoad(flow, vec3(lo.x,lo.y,hi.z),0).xyz, textureLoad(flow,vec3(hi.x,lo.y,hi.z),0).xyz,t.x);
  let d = mix(textureLoad(flow, vec3(lo.x,hi.y,hi.z),0).xyz, textureLoad(flow,vec3(hi.x,hi.y,hi.z),0).xyz,t.x);
  return mix(mix(a,b,t.y),mix(c,d,t.y),t.z);
}
// Test the bounded (at most 2x2x2) voxel neighborhood of a one-step
// segment. Slab intersections catch even brief diagonal corner crossings.
fn blocked(a: vec3<f32>, b: vec3<f32>) -> bool {
  let lo = vec3<i32>(floor(min(a,b)));
  let hi = vec3<i32>(floor(max(a,b)));
  let delta = b-a;
  let parallel = abs(delta)<vec3(1e-8);
  let inverse = sign(delta)/max(abs(delta),vec3(1e-8));
  var hit = false;
  for (var z = 0; z < 2; z++) { for (var y = 0; y < 2; y++) { for (var x = 0; x < 2; x++) {
    let cell = lo+vec3(x,y,z);
    if (all(cell <= hi) && solid(cell)) {
      let lower = vec3<f32>(cell);
      let upper = lower+vec3(1.0);
      let parallelMiss = any(parallel & ((a<lower) | (a>upper)));
      let ta = (lower-a)*inverse;
      let tb = (upper-a)*inverse;
      let near = select(min(ta,tb),vec3(-1e20),parallel);
      let far = select(max(ta,tb),vec3(1e20),parallel);
      let enter = max(0.0,max(near.x,max(near.y,near.z)));
      let leave = min(1.0,min(far.x,min(far.y,far.z)));
      hit = hit || (!parallelMiss && enter <= leave);
    }
  } } }
  return hit;
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= arrayLength(&particles)) { return; }
  var particle = particles[id.x];
  // Latest end-of-batch velocity is frozen over this batch. One lattice-time
  // midpoint substep per solver step; render frames never drive this clock.
  for (var i = 0u; i < p.steps; i++) {
    let v = velocity(particle.xyz);
    if (!all(abs(v)<vec3(0.31))) { particle = seed(id.x,particle.w+1.0); break; }
    let mid = particle.xyz+0.5*v;
    if (outside(mid) || blocked(particle.xyz,mid)) { particle = seed(id.x,particle.w+1.0); break; }
    let vm = velocity(mid);
    if (!all(abs(vm)<vec3(0.31))) { particle = seed(id.x,particle.w+1.0); break; }
    let end = particle.xyz+vm;
    if (outside(end) || blocked(particle.xyz,end)) { particle = seed(id.x,particle.w+1.0); break; }
    particle = vec4(end,particle.w);
  }
  particles[id.x] = particle;
}
