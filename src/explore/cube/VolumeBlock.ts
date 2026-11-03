import * as THREE from 'three';
import type { Volume } from './cubeData';

/**
 * The cutaway block as a real volume: each pixel walks its ray voxel by voxel
 * through the kept part of the cube (Amanatides–Woo traversal) and draws the
 * first voxel that is not see-through. With nothing transparent this looks
 * exactly like a solid block; with the dark end transparent, the inside shows.
 *
 * The six textured faces it replaces could only ever be a hollow shell.
 * `pick` runs the same walk on the CPU for the tooltip and the wheel.
 *
 * Works in the group's index space: x = column, y = row from the south, z = level.
 */

const NODATA = -9999;
// Same tints as the faces: top brightest, x faces darkest, so the voxel walls read.
const SHADE = [0.74, 0.86, 1.0];

const vertexShader = /* glsl */ `
varying vec3 vPos;
void main() {
  vPos = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const fragmentShader = /* glsl */ `
precision highp float;
precision highp sampler3D;
uniform sampler3D uVol;
uniform sampler2D uLut;
uniform vec3 uBoxMin;
uniform vec3 uBoxMax;
uniform vec3 uCam;
uniform float uVmax;
uniform float uCutoff;
uniform mat4 projectionMatrix;
uniform mat4 modelViewMatrix;
varying vec3 vPos;

void main() {
  vec3 ro = uCam;
  vec3 rd = normalize(vPos - uCam);
  vec3 inv = 1.0 / rd;
  vec3 ta = (uBoxMin - ro) * inv;
  vec3 tb = (uBoxMax - ro) * inv;
  vec3 tsm = min(ta, tb);
  vec3 tbg = max(ta, tb);
  float tn = max(max(tsm.x, tsm.y), tsm.z);
  float tf = min(min(tbg.x, tbg.y), tbg.z);
  if (tf <= max(tn, 0.0)) discard;

  int axis = tsm.x > tsm.y ? (tsm.x > tsm.z ? 0 : 2) : (tsm.y > tsm.z ? 1 : 2);
  float t = max(tn, 0.0);
  ivec3 lo = ivec3(uBoxMin);
  ivec3 hi = ivec3(uBoxMax) - 1;
  ivec3 vox = clamp(ivec3(floor(ro + rd * (t + 1e-4))), lo, hi);
  ivec3 stp = ivec3(sign(rd));
  vec3 tDelta = abs(inv);
  vec3 tNext = (vec3(vox) + max(vec3(stp), 0.0) - ro) * inv;

  for (int i = 0; i < 400; i++) {
    float v = texelFetch(uVol, vox, 0).r;
    float u = clamp(v / uVmax, 0.0, 1.0);
    // No data (< -9000) is empty space, like the transparent end of the ramp.
    if (v > -9000.0 && u >= uCutoff) {
      vec3 col = texture(uLut, vec2(u * 255.0 / 256.0 + 0.5 / 256.0, 0.5)).rgb;
      float shade = axis == 0 ? ${SHADE[0].toFixed(2)} : axis == 1 ? ${SHADE[1].toFixed(2)} : ${SHADE[2].toFixed(2)};
      gl_FragColor = vec4(col * shade, 1.0);
      vec4 clip = projectionMatrix * modelViewMatrix * vec4(ro + rd * t, 1.0);
      gl_FragDepth = clip.z / clip.w * 0.5 + 0.5;
      return;
    }
    if (tNext.x < tNext.y) {
      if (tNext.x < tNext.z) { vox.x += stp.x; t = tNext.x; tNext.x += tDelta.x; axis = 0; }
      else { vox.z += stp.z; t = tNext.z; tNext.z += tDelta.z; axis = 2; }
    } else {
      if (tNext.y < tNext.z) { vox.y += stp.y; t = tNext.y; tNext.y += tDelta.y; axis = 1; }
      else { vox.z += stp.z; t = tNext.z; tNext.z += tDelta.z; axis = 2; }
    }
    if (any(lessThan(vox, lo)) || any(greaterThan(vox, hi))) discard;
  }
  discard;
}
`;

/** `entryAxis`: the face of the kept block the ray enters through; `voxel`: the first one drawn, if any. */
export type VoxelPick = {
  entryAxis: 'x' | 'y' | 'z';
  voxel: { ix: number; iy: number; iz: number; value: number } | null;
};

export class VolumeBlock {
  readonly mesh: THREE.Mesh<THREE.BoxGeometry, THREE.ShaderMaterial>;
  private tex: THREE.Data3DTexture;
  private lut: THREE.DataTexture;
  private data: Float32Array;
  private nx: number;
  private ny: number;
  private boxMin = new THREE.Vector3();
  private boxMax = new THREE.Vector3();
  private vmax = 1;
  private cutoff = 0;

  private lutSrc: Uint8Array | null = null;

  constructor(vol: Volume, ramp: Uint8Array) {
    const { nx, ny, nz } = vol;
    this.nx = nx;
    this.ny = ny;
    this.data = new Float32Array(vol.data.length);
    for (let i = 0; i < vol.data.length; i++) this.data[i] = Number.isNaN(vol.data[i]) ? NODATA : vol.data[i];

    this.tex = new THREE.Data3DTexture(this.data, nx, ny, nz);
    this.tex.format = THREE.RedFormat;
    this.tex.type = THREE.FloatType;
    this.tex.minFilter = this.tex.magFilter = THREE.NearestFilter;
    this.tex.unpackAlignment = 1;
    this.tex.needsUpdate = true;

    this.lut = new THREE.DataTexture(new Uint8Array(256 * 4), 256, 1, THREE.RGBAFormat);
    this.lut.minFilter = this.lut.magFilter = THREE.NearestFilter;
    this.setLut(ramp);

    // Back faces, so the walk also starts when the camera is inside the box.
    const geom = new THREE.BoxGeometry(nx, ny, nz);
    geom.translate(nx / 2, ny / 2, nz / 2);
    this.mesh = new THREE.Mesh(
      geom,
      new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        side: THREE.BackSide,
        uniforms: {
          uVol: { value: this.tex },
          uLut: { value: this.lut },
          uBoxMin: { value: this.boxMin },
          uBoxMax: { value: this.boxMax },
          uCam: { value: new THREE.Vector3() },
          uVmax: { value: 1 },
          uCutoff: { value: 0 },
        },
      }),
    );
  }

  /** Kept part of the block, in voxels: [x0, x1) x [y0, y1) x [z0, z1). */
  update(box: [number, number, number, number, number, number], vmax: number, cutoff: number) {
    this.boxMin.set(box[0], box[2], box[4]);
    this.boxMax.set(box[1], box[3], box[5]);
    this.vmax = vmax;
    this.cutoff = cutoff;
    const u = this.mesh.material.uniforms;
    u.uVmax.value = vmax;
    u.uCutoff.value = cutoff;
  }

  /** Colour ramp, [r, g, b] * 256. */
  setLut(ramp: Uint8Array) {
    if (ramp === this.lutSrc) return;
    this.lutSrc = ramp;
    const px = this.lut.image.data as Uint8Array;
    for (let i = 0; i < 256; i++) {
      px[i * 4] = ramp[i * 3];
      px[i * 4 + 1] = ramp[i * 3 + 1];
      px[i * 4 + 2] = ramp[i * 3 + 2];
      px[i * 4 + 3] = 255;
    }
    this.lut.needsUpdate = true;
  }

  /** Camera position in index space; call before every render. */
  setCamera(local: THREE.Vector3) {
    (this.mesh.material.uniforms.uCam.value as THREE.Vector3).copy(local);
  }

  /** The same walk as the shader, for a ray in index space. */
  pick(ro: THREE.Vector3, rd: THREE.Vector3): VoxelPick | null {
    const o = [ro.x, ro.y, ro.z];
    const d = [rd.x, rd.y, rd.z];
    const lo = [this.boxMin.x, this.boxMin.y, this.boxMin.z];
    const hi = [this.boxMax.x, this.boxMax.y, this.boxMax.z];
    let tn = -Infinity;
    let tf = Infinity;
    let entry = 2;
    for (let k = 0; k < 3; k++) {
      const a = (lo[k] - o[k]) / d[k];
      const b = (hi[k] - o[k]) / d[k];
      const s = Math.min(a, b);
      if (s > tn) {
        tn = s;
        entry = k;
      }
      tf = Math.min(tf, Math.max(a, b));
    }
    if (!(tf > Math.max(tn, 0))) return null;
    const entryAxis = (['x', 'y', 'z'] as const)[entry];
    const t = Math.max(tn, 0);
    const vox = [0, 1, 2].map((k) => Math.min(hi[k] - 1, Math.max(lo[k], Math.floor(o[k] + d[k] * (t + 1e-4)))));
    const stp = d.map((v) => Math.sign(v));
    const tDelta = d.map((v) => Math.abs(1 / v));
    const tNext = [0, 1, 2].map((k) => (vox[k] + Math.max(stp[k], 0) - o[k]) / d[k]);
    for (let i = 0; i < 400; i++) {
      const v = this.data[(vox[2] * this.ny + vox[1]) * this.nx + vox[0]];
      const u = Math.min(1, Math.max(0, v / this.vmax));
      if (v > -9000 && u >= this.cutoff) {
        return { entryAxis, voxel: { ix: vox[0], iy: vox[1], iz: vox[2], value: v } };
      }
      const k = tNext[0] < tNext[1] ? (tNext[0] < tNext[2] ? 0 : 2) : tNext[1] < tNext[2] ? 1 : 2;
      vox[k] += stp[k];
      tNext[k] += tDelta[k];
      if (vox[k] < lo[k] || vox[k] >= hi[k]) return { entryAxis, voxel: null };
    }
    return { entryAxis, voxel: null };
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.tex.dispose();
    this.lut.dispose();
  }
}
