import * as THREE from 'three';
import type { Grid } from '../gpu/grid';
import type { SmokeFrame } from './smoke';

export function createSmokeView(grid: Grid,depth: THREE.DepthTexture,camera: THREE.PerspectiveCamera) {
  const volume = new THREE.Data3DTexture(new Uint8Array(1),1,1,1);
  volume.format = THREE.RedFormat; volume.type = THREE.UnsignedByteType;
  volume.minFilter = THREE.LinearFilter; volume.magFilter = THREE.LinearFilter;
  volume.unpackAlignment = 1; volume.needsUpdate = true;
  const bounds = new THREE.Vector3(grid.nx/grid.ny,1,grid.nz/grid.ny);
  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,side: THREE.BackSide,transparent: true,depthWrite: false,depthTest: false,
    uniforms: { density: { value: volume },opaqueDepth: { value: depth },bounds: { value: bounds },
      inverseProjection: { value: camera.projectionMatrixInverse },cameraWorld: { value: camera.matrixWorld },
      screenSize: { value: new THREE.Vector2(1,1) },eye: { value: camera.position } },
    vertexShader: `out vec3 worldPoint;
      void main() { vec4 world = modelMatrix*vec4(position,1.0); worldPoint = world.xyz; gl_Position = projectionMatrix*viewMatrix*world; }`,
    fragmentShader: `precision highp sampler3D;
      in vec3 worldPoint;
      out vec4 result;
      uniform sampler3D density;
      uniform sampler2D opaqueDepth;
      uniform vec3 bounds,eye;
      uniform vec2 screenSize;
      uniform mat4 inverseProjection,cameraWorld;
      void main() {
        vec3 ray = normalize(worldPoint-eye);
        vec3 safeRay = mix(vec3(0.000001),ray,greaterThan(abs(ray),vec3(0.000001)));
        vec3 ta = (-0.5*bounds-eye)/safeRay, tb = (0.5*bounds-eye)/safeRay;
        vec3 a = min(ta,tb), b = max(ta,tb);
        float nearT = max(0.0,max(a.x,max(a.y,a.z)));
        float farT = min(b.x,min(b.y,b.z));
        vec2 uv = gl_FragCoord.xy/screenSize;
        float depth = texture(opaqueDepth,uv).r;
        vec4 viewPoint = inverseProjection*vec4(uv*2.0-1.0,depth*2.0-1.0,1.0);
        vec3 surface = (cameraWorld*vec4(viewPoint.xyz/viewPoint.w,1.0)).xyz;
        farT = min(farT,dot(surface-eye,ray));
        if (farT <= nearT) discard;
        float dt = (farT-nearT)/96.0;
        float alpha = 0.0;
        vec3 color = vec3(0.0);
        for (int i = 0; i < 96; i++) {
          vec3 q = (eye+ray*(nearT+(float(i)+0.5)*dt))/bounds+0.5;
          float d = texture(density,q).r;
          float opacity = 1.0-exp(-d*14.0*dt);
          // Approximate single scattering: density toward the light attenuates it.
          // This shades the transported scalar; it adds no synthetic flow detail.
          float opticalDepth = 0.0;
          for (int j = 1; j <= 4; j++) {
            vec3 lightPoint = q+vec3(-0.025,0.04,0.025)*float(j);
            if (all(greaterThanEqual(lightPoint,vec3(0.0))) && all(lessThanEqual(lightPoint,vec3(1.0))))
              opticalDepth += texture(density,lightPoint).r*0.055;
          }
          float light = 0.3+0.7*exp(-opticalDepth*14.0);
          color += (1.0-alpha)*opacity*vec3(0.86,0.94,1.0)*light;
          alpha += (1.0-alpha)*opacity;
          if (alpha>0.97) break;
        }
        if (alpha<0.002) discard;
        result = vec4(color/max(alpha,0.0001),alpha);
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(bounds.x,bounds.y,bounds.z),material);
  mesh.visible = false; mesh.renderOrder = 5;
  return {
    mesh,
    resize(width: number,height: number) { material.uniforms.screenSize.value.set(width,height); },
    update(frame: SmokeFrame | null) {
      mesh.visible = Boolean(frame);
      if (!frame) return;
      // Dimensions can change only after the old texture has been released.
      if (volume.image.width !== frame.grid.nx || volume.image.height !== frame.grid.ny || volume.image.depth !== frame.grid.nz) volume.dispose();
      volume.image = { data: frame.density,width: frame.grid.nx,height: frame.grid.ny,depth: frame.grid.nz };
      volume.needsUpdate = true;
    },
    dispose() { volume.dispose(); },
  };
}
