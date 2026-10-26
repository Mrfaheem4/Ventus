struct Params {
  grid: vec3<u32>, tau: f32, inlet: vec3<f32>, cs: f32,
  step: u32, ramp_steps: u32, boundary_mode: u32, acceleration_x: f32,
};
struct Link { node: u32, direction: u32 };
@group(0) @binding(0) var<storage, read> state: array<f32>;
@group(0) @binding(1) var<storage, read> links: array<Link>;
@group(0) @binding(2) var<storage, read_write> partials: array<vec4<f32>>;
@group(0) @binding(3) var<uniform> p: Params;
var<private> c: array<vec3<i32>,19> = array<vec3<i32>,19>(
  vec3(0,0,0), vec3(1,0,0), vec3(-1,0,0), vec3(0,1,0), vec3(0,-1,0), vec3(0,0,1), vec3(0,0,-1),
  vec3(1,1,0), vec3(-1,-1,0), vec3(1,-1,0), vec3(-1,1,0),
  vec3(1,0,1), vec3(-1,0,-1), vec3(1,0,-1), vec3(-1,0,1),
  vec3(0,1,1), vec3(0,-1,-1), vec3(0,1,-1), vec3(0,-1,1)
);
var<workgroup> sums: array<vec4<f32>,64>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>, @builtin(local_invocation_index) lane: u32,
  @builtin(workgroup_id) group: vec3<u32>) {
  let count = arrayLength(&links);
  var contribution = vec4<f32>(0.0);
  if (id.x < count) {
    let link = links[id.x];
    let n = p.grid.x*p.grid.y*p.grid.z;
    let population = state[link.direction*n+link.node];
    if (abs(population) < 1e6) {
      var weight = 1.0/36.0;
      if (link.direction <= 6u) { weight = 1.0/18.0; }
      // Body receives +2*f_i*c_i on reflection. Constant reference pressure
      // cancels over the closed body; subtract it to reduce f32 cancellation.
      contribution = vec4<f32>(2.0*(population-weight)*vec3<f32>(c[link.direction]), 0.0);
    } else { contribution.w = 1.0; }
  }
  sums[lane] = contribution;
  workgroupBarrier();
  for (var offset = 32u; offset > 0u; offset = offset/2u) {
    if (lane < offset) { sums[lane] += sums[lane+offset]; }
    workgroupBarrier();
  }
  if (lane == 0u) {
    let groups = (count+63u)/64u;
    partials[((p.step-1u)%16u)*groups+group.x] = sums[0];
  }
}
