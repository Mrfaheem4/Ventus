struct Params { grid:vec3<u32>, points:u32, center:vec3<f32>, radius:f32 };
@group(0) @binding(0) var flow:texture_3d<f32>;
@group(0) @binding(1) var<storage,read> flags:array<u32>;
@group(0) @binding(2) var<storage,read_write> paths:array<vec4<f32>>;
@group(0) @binding(3) var<uniform> p:Params;

fn solid(x:vec3<f32>) -> bool {
  let c=vec3<u32>(clamp(floor(x),vec3(0.0),vec3<f32>(p.grid)-vec3(1.0)));
  return (flags[c.x+p.grid.x*(c.y+p.grid.y*c.z)]&1u)!=0u;
}
fn velocity(x:vec3<f32>) -> vec3<f32> {
  let q=clamp(x-vec3(0.5),vec3(0.0),vec3<f32>(p.grid)-vec3(1.0));
  let a=vec3<i32>(floor(q)); let b=min(a+vec3(1),vec3<i32>(p.grid)-vec3(1)); let t=fract(q);
  let v0=mix(textureLoad(flow,vec3(a.x,a.y,a.z),0).xyz,textureLoad(flow,vec3(b.x,a.y,a.z),0).xyz,t.x);
  let v1=mix(textureLoad(flow,vec3(a.x,b.y,a.z),0).xyz,textureLoad(flow,vec3(b.x,b.y,a.z),0).xyz,t.x);
  let v2=mix(textureLoad(flow,vec3(a.x,a.y,b.z),0).xyz,textureLoad(flow,vec3(b.x,a.y,b.z),0).xyz,t.x);
  let v3=mix(textureLoad(flow,vec3(a.x,b.y,b.z),0).xyz,textureLoad(flow,vec3(b.x,b.y,b.z),0).xyz,t.x);
  return mix(mix(v0,v1,t.y),mix(v2,v3,t.y),t.z);
}
fn intersectsBody(a:vec3<f32>, b:vec3<f32>) -> bool {
  if(p.radius<=0.0) { return false; }
  let d=b-a;
  let t=clamp(dot(p.center-a,d)/max(dot(d,d),0.000001),0.0,1.0);
  return distance(a+t*d,p.center)<=p.radius;
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id:vec3<u32>) {
  if(id.x>=33u) { return; }
  // Eleven inlet positions, each a tightly bundled group of three soft strands.
  let emitter=id.x/3u; let strand=f32(id.x%3u)-1.0;
  var x=vec3(0.75,(0.23+0.054*f32(emitter)+0.002*strand)*f32(p.grid.y),(0.5+0.002*strand)*f32(p.grid.z));
  var alive=true;
  for(var i=0u;i<p.points;i++) {
    let v=velocity(x); let speed=length(v);
    alive=alive && speed>0.000001 && all(abs(v)<vec3(0.31)) && !solid(x);
    if(!alive) { paths[id.x*p.points+i]=vec4(0.0,0.0,0.0,-1.0); continue; }
    paths[id.x*p.points+i]=vec4(x,speed);
    // Arc-length RK2: instantaneous streamlines, not simulated smoke mass or
    // artificially sped-up fluid. No procedural curls or turbulence are added.
    let midpoint=x+0.25*v/speed;
    let vm=velocity(midpoint); let sm=length(vm);
    if(!(sm>0.000001 && all(abs(vm)<vec3(0.31)))) { alive=false; continue; }
    let next=x+0.5*vm/sm;
    alive=!any(next<vec3(0.0)) && !any(next>=vec3<f32>(p.grid)) && !solid(midpoint) && !solid(next) && !intersectsBody(x,next);
    x=next;
  }
}
