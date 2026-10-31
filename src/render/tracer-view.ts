import * as THREE from "three";
import type { Grid } from "../gpu/grid";
import { TRACER_COUNT } from "./tracer-seeds";
import type { TracerFrame } from "./tracer-seeds";

const HISTORY = 96;

export function createTracerView(grid: Grid) {
  const count = TRACER_COUNT;
  const group = new THREE.Group();
  group.visible = false;
  const heads = new Float32Array(count * 3);
  const trails = new Float32Array(count * (HISTORY - 1) * 6);
  const colors = new Float32Array(trails.length);
  const history = new Float32Array(count * HISTORY * 3);
  const lengths = new Uint32Array(count);
  const generations = new Float32Array(count).fill(-1);
  let cursor = 0;
  const headGeometry = new THREE.BufferGeometry().setAttribute(
    "position",
    new THREE.BufferAttribute(heads, 3).setUsage(THREE.DynamicDrawUsage),
  );
  const trailPositions = new THREE.BufferAttribute(trails, 3).setUsage(
    THREE.DynamicDrawUsage,
  );
  const trailColors = new THREE.BufferAttribute(colors, 3).setUsage(
    THREE.DynamicDrawUsage,
  );
  const trailGeometry = new THREE.BufferGeometry()
    .setAttribute("position", trailPositions)
    .setAttribute("color", trailColors);
  headGeometry.setDrawRange(0, 0);
  trailGeometry.setDrawRange(0, 0);
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.3, "rgba(255,255,255,0.65)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 32, 32);
  const texture = new THREE.CanvasTexture(canvas);
  const points = new THREE.Points(
    headGeometry,
    new THREE.PointsMaterial({
      color: "#dcf7ff",
      map: texture,
      size: 0.006,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  const lines = new THREE.LineSegments(
    trailGeometry,
    new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.65,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  // Particle positions move outside their first bounding sphere; do not reuse it.
  points.frustumCulled = false;
  lines.frustumCulled = false;
  group.add(lines, points);
  const color = new THREE.Color("#c6eaff");
  return {
    group,
    update(frame: TracerFrame | null) {
      if (!frame) {
        lengths.fill(0);
        generations.fill(-1);
        cursor = 0;
        headGeometry.setDrawRange(0, 0);
        trailGeometry.setDrawRange(0, 0);
        group.visible = false;
        return { count: 0, segments: 0, step: 0 };
      }
      if (frame.positions.length !== count * 4)
        throw new Error("Tracer frame size does not match renderer.");
      let vertex = 0;
      for (let i = 0; i < count; i++) {
        const source = i * 4;
        if (generations[i] !== frame.positions[source + 3]) {
          lengths[i] = 0;
          generations[i] = frame.positions[source + 3];
        }
        const position = [
          frame.positions[source] / grid.ny - grid.nx / grid.ny / 2,
          frame.positions[source + 1] / grid.ny - 0.5,
          frame.positions[source + 2] / grid.ny - grid.nz / grid.ny / 2,
        ];
        heads.set(position, i * 3);
        history.set(position, (i * HISTORY + cursor) * 3);
        lengths[i] = Math.min(HISTORY, lengths[i] + 1);
        for (let age = 0; age < lengths[i] - 1; age++) {
          for (let end = 0; end < 2; end++) {
            const offset =
              (i * HISTORY + ((cursor - age - end + HISTORY) % HISTORY)) * 3;
            for (let axis = 0; axis < 3; axis++)
              trails[vertex * 3 + axis] = history[offset + axis];
            const fade = (1 - (age + end) / HISTORY) ** 2;
            colors[vertex * 3] = color.r * fade;
            colors[vertex * 3 + 1] = color.g * fade;
            colors[vertex * 3 + 2] = color.b * fade;
            vertex++;
          }
        }
      }
      cursor = (cursor + 1) % HISTORY;
      headGeometry.attributes.position.needsUpdate = true;
      trailPositions.clearUpdateRanges();
      trailPositions.addUpdateRange(0, vertex * 3);
      trailColors.clearUpdateRanges();
      trailColors.addUpdateRange(0, vertex * 3);
      trailGeometry.attributes.position.needsUpdate = true;
      trailGeometry.attributes.color.needsUpdate = true;
      headGeometry.setDrawRange(0, count);
      trailGeometry.setDrawRange(0, vertex);
      group.visible = true;
      return { count, segments: vertex / 2, step: frame.step };
    },
  };
}
