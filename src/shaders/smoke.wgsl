struct Params { fluid: vec3<u32>, steps: u32, smoke: vec3<u32>, step: u32 };
@group(0) @binding(0) var flow: texture_3d<f32>;
@group(0) @binding(1) var<storage, read> flags: array<u32>;
@group(0) @binding(2) var<storage, read> source: array<f32>;
@group(0) @binding(3) var<storage, read_write> destination: array<f32>;
@group(0) @binding(4) var<uniform> p: Params;

fn node(v: vec3<u32>) -> u32 { return v.x+p.smoke.x*(v.y+p.smoke.y*v.z); }
fn solid(x: vec3<f32>) -> bool {
  let cell = vec3<u32>(clamp(floor(x),vec3(0.0),vec3<f32>(p.fluid)-vec3(1.0)));
  return (flags[cell.x+p.fluid.x*(cell.y+p.fluid.y*cell.z)] & 1u) != 0u;
}
fn velocity(x: vec3<f32>) -> vec3<f32> {
  let q = clamp(x-vec3(0.5),vec3(0.0),vec3<f32>(p.fluid)-vec3(1.0));
  let a = vec3<i32>(floor(q)); let b = min(a+vec3(1),vec3<i32>(p.fluid)-vec3(1)); let t = fract(q);
  let v0 = mix(textureLoad(flow,vec3(a.x,a.y,a.z),0).xyz,textureLoad(flow,vec3(b.x,a.y,a.z),0).xyz,t.x);
  let v1 = mix(textureLoad(flow,vec3(a.x,b.y,a.z),0).xyz,textureLoad(flow,vec3(b.x,b.y,a.z),0).xyz,t.x);
  let v2 = mix(textureLoad(flow,vec3(a.x,a.y,b.z),0).xyz,textureLoad(flow,vec3(b.x,a.y,b.z),0).xyz,t.x);
  let v3 = mix(textureLoad(flow,vec3(a.x,b.y,b.z),0).xyz,textureLoad(flow,vec3(b.x,b.y,b.z),0).xyz,t.x);
  return mix(mix(v0,v1,t.y),mix(v2,v3,t.y),t.z);
}
// Bounded Catmull-Rom reconstruction reduces the numerical diffusion of
// repeated linear remapping. Clamp each interpolation to its central pair
// so sharp fronts cannot create negative concentration or new extrema.
fn cubic(a: f32, b: f32, c: f32, d: f32, t: f32) -> f32 {
  let v = b+0.5*t*(c-a+t*(2.0*a-5.0*b+4.0*c-d+t*(3.0*(b-c)+d-a)));
  return clamp(v,min(b,c),max(b,c));
}
fn tap(cell: vec3<i32>) -> f32 {
  let c = vec3<u32>(clamp(cell,vec3(0),vec3<i32>(p.smoke)-vec3(1)));
  return source[node(c)];
}
fn density(x: vec3<f32>) -> f32 {
  let q = clamp(x*vec3<f32>(p.smoke)/vec3<f32>(p.fluid)-vec3(0.5),vec3(0.0),vec3<f32>(p.smoke)-vec3(1.0));
  let cell = vec3<i32>(floor(q)); let t = fract(q);
  var zs: array<f32,4>;
  for (var z = 0; z < 4; z++) {
    var ys: array<f32,4>;
    for (var y = 0; y < 4; y++) {
      let c = cell+vec3(0,y-1,z-1);
      ys[y] = cubic(tap(c+vec3(-1,0,0)),tap(c),tap(c+vec3(1,0,0)),tap(c+vec3(2,0,0)),t.x);
    }
    zs[z] = cubic(ys[0],ys[1],ys[2],ys[3],t.y);
  }
  return cubic(zs[0],zs[1],zs[2],zs[3],t.z);
}
@compute @workgroup_size(8,4,4)
fn advect(@builtin(global_invocation_id) id: vec3<u32>) {
  if (any(id >= p.smoke)) { return; }
  let origin = (vec3<f32>(id)+vec3(0.5))*vec3<f32>(p.fluid)/vec3<f32>(p.smoke);
  if (solid(origin)) { destination[node(id)] = 0.0; return; }
  // Prescribed inlet smoke concentration. Pulsing changes emission only,
  // never the air velocity, and makes transport visible in laminar flow.
  if (id.x == 0u) {
    let uv = origin.yz/vec2<f32>(p.fluid.yz);
    let z = (uv.y-0.5)/0.035;
    var jets = 0.0;
    for (var j = 0; j < 7; j++) {
      let y = (uv.x-(0.26+0.08*f32(j)))/0.022;
      jets += exp(-0.5*(y*y+z*z));
    }
    destination[node(id)] = min(1.0,jets)*(0.8+0.2*sin(f32(p.step)*0.008));
    return;
  }
  var x = origin;
  var remaining = f32(p.steps);
  var blocked = false;
  // Midpoint backtrace, split into <=2 lattice-time intervals. Concentration
  // is sampled once, reducing diffusion versus repeated remapping.
  for (var i = 0; i < 8; i++) {
    if (remaining > 0.0) {
      let dt = min(2.0,remaining);
      let v = velocity(x);
      let mid = x-0.5*dt*v;
      let end = x-dt*velocity(mid);
      blocked = blocked || solid(mid) || solid(end) || !all(abs(v)<vec3(0.31));
      x = end; remaining -= dt;
    }
  }
  var value = density(x);
  if (blocked || any(x < vec3(0.0)) || any(x >= vec3<f32>(p.fluid))) { value = 0.0; }
  destination[node(id)] = clamp(value,0.0,1.0);
}

@group(1) @binding(0) var<storage, read> final_density: array<f32>;
@group(1) @binding(1) var<storage, read_write> packed: array<u32>;
@compute @workgroup_size(64)
fn pack(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= arrayLength(&packed)) { return; }
  var value = 0u;
  for (var i = 0u; i < 4u; i++) {
    let n = id.x*4u+i;
    if (n < arrayLength(&final_density)) { value |= u32(clamp(final_density[n],0.0,1.0)*255.0+0.5) << (i*8u); }
  }
  packed[id.x] = value;
}
