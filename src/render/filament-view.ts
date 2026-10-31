import * as THREE from 'three';
import type { Grid } from '../gpu/grid';
import type { FilamentFrame } from './filaments';

export function createFilamentView(grid:Grid) {
  const material=new THREE.ShaderMaterial({
    transparent:true,depthWrite:false,side:THREE.DoubleSide,
    uniforms:{width:{value:0.0095},flowTime:{value:0}},
    vertexShader:`attribute vec3 tangent; attribute float edge; attribute float fade;
      attribute float travelTime; attribute float strandSeed;
      uniform float width; uniform float flowTime;
      varying float vEdge; varying float vFade; varying float vPhase; varying float vSeed;
      float noise(float x,float seed){
        float a=floor(x),t=fract(x); t=t*t*(3.0-2.0*t);
        return mix(fract(sin(a*127.1+seed*311.7)*43758.545),fract(sin((a+1.0)*127.1+seed*311.7)*43758.545),t);
      }
      void main(){
        vec3 right=normalize(cross(tangent,cameraPosition-position));
        vEdge=edge;vFade=fade;
        // Arrival time along the calculated path moves the texture downstream
        // at its sampled velocity. Only thickness varies, never the flow path.
        vSeed=strandSeed;
        vPhase=(travelTime-flowTime)*(0.006+0.004*fract(strandSeed*0.173));
        float swelling=0.86+0.28*noise(vPhase*0.65,vSeed+47.2);
        gl_Position=projectionMatrix*viewMatrix*vec4(position+right*width*edge*swelling,1.0);
      }`,
    fragmentShader:`varying float vEdge; varying float vFade; varying float vPhase; varying float vSeed;
      float noise(float x,float seed){
        float a=floor(x),t=fract(x); t=t*t*(3.0-2.0*t);
        return mix(fract(sin(a*127.1+seed*311.7)*43758.545),fract(sin((a+1.0)*127.1+seed*311.7)*43758.545),t);
      }
      void main(){
        // A defined core with a faint, broader veil gives each stream body
        // without filling the space between the inlet streams with fog.
        float core=exp(-vEdge*vEdge*6.0)*0.22;
        float veil=exp(-vEdge*vEdge*2.0)*0.07;
        float edgeFade=1.0-smoothstep(0.72,1.0,abs(vEdge));
        float wisps=0.78+0.32*noise(vPhase,vSeed)+0.08*noise(vPhase*1.73+7.0,vSeed+19.7);
        float alpha=(core+veil)*edgeFade*vFade*wisps;
        gl_FragColor=vec4(0.88,0.95,1.0,alpha);
      }`,
  });
  const mesh=new THREE.Mesh(new THREE.BufferGeometry(),material);mesh.visible=false;mesh.frustumCulled=false;
  let capacity=0, running=false, phase=0, from=0, target=0, changed=0, interval=40, arrived:number|null=null;
  let seeds:Float32Array|null=null;
  function sample(now:number) {
    if(running)phase=from+(target-from)*Math.min(1,Math.max(0,(now-changed)/interval));
    material.uniforms.flowTime.value=phase;
    return phase;
  }
  return {
    mesh,
    sample,
    setRunning(value:boolean) {
      const now=performance.now();sample(now);running=value;from=phase;changed=now;
    },
    update(frame:FilamentFrame|null) {
      const now=performance.now();sample(now);
      mesh.visible=Boolean(frame);
      if(!frame){
        phase=from=target=0;arrived=null;interval=40;seeds=null;sample(now);
        mesh.geometry.setDrawRange(0,0);return 0;
      }
      if(frame.step<target){phase=0;arrived=null;}
      if(arrived!==null)interval=Math.max(16,Math.min(200,interval*0.8+(now-arrived)*0.2));
      from=phase;target=frame.step;changed=now;arrived=now;
      if(!running)phase=target;
      sample(now);
      if(seeds?.length!==frame.lines){
        const random=crypto.getRandomValues(new Uint32Array(frame.lines));
        seeds=Float32Array.from(random,value=>1+value/4294967296*8192);
      }
      const needed=frame.lines*frame.points*2;
      if(needed!==capacity){
        mesh.geometry.dispose();capacity=needed;
        const geometry=new THREE.BufferGeometry();
        for(const name of ['position','tangent'])geometry.setAttribute(name,new THREE.BufferAttribute(new Float32Array(needed*3),3).setUsage(THREE.DynamicDrawUsage));
        for(const name of ['edge','fade','travelTime','strandSeed'])geometry.setAttribute(name,new THREE.BufferAttribute(new Float32Array(needed),1).setUsage(THREE.DynamicDrawUsage));
        geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(frame.lines*(frame.points-1)*6),1));mesh.geometry=geometry;
      }
      const {attributes,index}=mesh.geometry;let vertices=0,indices=0;
      const toWorld=(n:number)=>new THREE.Vector3(frame.positions[n]/grid.ny-grid.nx/grid.ny/2,frame.positions[n+1]/grid.ny-0.5,frame.positions[n+2]/grid.ny-grid.nz/grid.ny/2);
      for(let line=0;line<frame.lines;line++){
        let previous=-1,travel=0;
        for(let i=0;i<frame.points;i++){
          const n=(line*frame.points+i)*4;
          if(frame.positions[n+3]<0)break;
          const point=toWorld(n), before=toWorld(i>0?n-4:n), after=toWorld(i<frame.points-1 && frame.positions[n+7]>=0?n+4:n);
          const tangent=after.sub(before);if(tangent.lengthSq()<1e-12)break;
          if(i>0){
            const distance=Math.hypot(frame.positions[n]-frame.positions[n-4],frame.positions[n+1]-frame.positions[n-3],frame.positions[n+2]-frame.positions[n-2]);
            travel+=distance/Math.max(0.000001,(frame.positions[n+3]+frame.positions[n-1])*0.5);
          }
          for(const edge of [-1,1]){
            attributes.position.setXYZ(vertices,point.x,point.y,point.z);
            attributes.tangent.setXYZ(vertices,tangent.x,tangent.y,tangent.z);
            attributes.edge.setX(vertices,edge);attributes.fade.setX(vertices,1-0.35*i/frame.points);vertices++;
            attributes.travelTime.setX(vertices-1,travel);
            attributes.strandSeed.setX(vertices-1,seeds[line]);
          }
          if(previous>=0){index!.array.set([previous,previous+1,vertices-2,previous+1,vertices-1,vertices-2],indices);indices+=6;}
          previous=vertices-2;
        }
      }
      Object.values(attributes).forEach(attribute=>{attribute.needsUpdate=true;});index!.needsUpdate=true;
      mesh.geometry.setDrawRange(0,indices);return indices/6;
    },
    dispose(){mesh.geometry.dispose();material.dispose();},
  };
}
