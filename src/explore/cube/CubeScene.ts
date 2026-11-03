import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { energyVolume, rhVolume, surfaceVolume, type Cube, type Volume, type ZMode } from './cubeData';
import { INFERNO } from './inferno';
import { ENERGY_LUT } from './colormaps';
import { VolumeBlock } from './VolumeBlock';
import { SURFACE_COLOURS, SURFACE_RH, SurfaceStack } from './SurfaceStack';

/**
 * The 3D datacube view, ported from the prototype in spike/vsm-cube/template.html.
 * Plain three.js, no React: CubePanel owns one instance and mirrors its state
 * into the controls through `onChange`.
 *
 * Index space: x = column (east), y = row from the south edge (north), z = level.
 * Two displays: crossing slices (three planes crossing at the clicked pixel by
 * default) and a cutaway block (scrolling peels the faces away).
 */

export type Display = 'planes' | 'cut';
export type TopMode = 'canopy' | 'slice';
export type Axis = 'x' | 'y' | 'z';
export type CameraState = { position: [number, number, number]; target: [number, number, number] };

export type Snapshot = {
  mode: ZMode;
  display: Display;
  topMode: TopMode;
  vmax: number;
  zStretch: number;
  /** Energy: share of the colour range (0-1) drawn transparent, from the low end. RH mode ignores it. */
  cutoff: number;
  activeAxis: Axis;
  cx: number;
  cy: number;
  cz: number;
  /** RH surfaces: bottom cut in metres. */
  cz0: number;
  nx: number;
  ny: number;
  nz: number;
  unit: string;
  cbarTitle: string;
  zLabel: string;
  zInterpolated: boolean;
  /** RH surfaces: sheet opacity, and each RH with its colour and whether it is drawn. */
  opacity: number;
  levels: { rh: number; colour: string; on: boolean }[];
};

type FaceSpec = {
  axis: Axis;
  tint: number;
  name: string;
  idx: (s: CubeScene) => number;
  p: (s: CubeScene) => number;
  a: (s: CubeScene) => [number, number];
  b: (s: CubeScene) => [number, number];
};

type Face = {
  spec: FaceSpec;
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  tex: THREE.DataTexture | null;
  texIdx: number;
  texKey: string;
};

const HOME_DIR = new THREE.Vector3(1.55, -1.75, 1.15).normalize();
/** How far below the block the ground image lies, as a share of the block's height. */
const GROUND_DROP = 0.16;

export class CubeScene {
  // Read by the face specs.
  cx = 0;
  cy = 0;
  cz = 0;
  /** RH surfaces only: the bottom cut, in metres (the z index of the lowest level kept). */
  cz0 = 0;

  private mode: ZMode = 'energy';
  // Cutaway with an Energy top slice by default (user, 2026-10-29); the
  // canopy-top lid stays an option.
  private display: Display = 'cut';
  private topMode: TopMode = 'slice';
  private vmax = 12;
  // Energy: the low end is see-through, so the structure behind a slice
  // shows. 0.1 = the lowest tenth of the ramp. RH mode is always opaque.
  private cutoff = 0.1;
  private zStretch = 0.9;
  private activeAxis: Axis = 'z';
  private opacity = 0.45;
  private hiddenRh = new Set<number>();

  private cube: Cube | null = null;
  private ground: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> | null = null;
  private groundImage: (CanvasImageSource & { width: number; height: number }) | null = null;
  private probe: { row: number; col: number } | null = null;
  private vol: Volume | null = null;
  /** Camera under the block's mid-height: the ground image (and its labels) go above the block, so it stays behind it. */
  private fromBelow = false;

  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(38, 1, 0.01, 50);
  private controls: OrbitControls;
  private group = new THREE.Group();
  private labels = new THREE.Group();
  private faces: Face[] = [];
  private wire: THREE.LineSegments | null = null;
  private clickLine: THREE.Line | null = null;
  /** The cutaway block (cut display only): raymarched voxels, not six faces. */
  private volume: VolumeBlock | null = null;
  /** RH surfaces mode: the level sheets, clipped by the cutaway box. */
  private surfaces: SurfaceStack | null = null;
  private camLocal = new THREE.Vector3();
  private ray = new THREE.Raycaster();
  private ptr = new THREE.Vector2();
  private wheelAcc = 0;
  private dirty = true;
  private canvas: HTMLCanvasElement;
  private tip: HTMLDivElement;
  private onChange: (s: Snapshot) => void;
  private off: (() => void)[] = [];

  /** Camera distance of the home view: smaller = bigger cube (the saved page has room for it). */
  private homeDistance: number;
  /** Double-click on the cube: the pixel column under the pointer (row 0 = north). */
  private onPickColumn?: (row: number, col: number) => void;
  /** The column the tooltip is showing, for the double-click. */
  private hoverCol: { ix: number; iy: number } | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    tip: HTMLDivElement,
    onChange: (s: Snapshot) => void,
    opts: { homeDistance?: number; onPickColumn?: (row: number, col: number) => void } = {},
  ) {
    this.homeDistance = opts.homeDistance ?? 2.75;
    this.onPickColumn = opts.onPickColumn;
    this.canvas = canvas;
    this.tip = tip;
    this.onChange = onChange;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.localClippingEnabled = true; // the RH surfaces are cut by the cutaway box
    this.scene.background = new THREE.Color(0xffffff);
    this.camera.up.set(0, 0, 1);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.rotateSpeed = 0.6;
    this.controls.enableZoom = false; // the wheel slices; zoom is shift+wheel or pinch
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    this.controls.addEventListener('change', () => (this.dirty = true));
    this.resetView();

    this.scene.add(this.group);
    this.scene.add(this.labels);
    // Only the RH surfaces are lit (everything else is unlit colour): soft
    // light all round plus a sun from the north-west, as in a hillshade.
    // A flat surface comes out at about its own colour: (1.9 + 2.0 * 0.65) / pi.
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.9));
    const sun = new THREE.DirectionalLight(0xffffff, 2.0);
    sun.position.set(-1, 1, 1.2);
    this.scene.add(sun);

    this.listen(canvas, 'pointermove', (ev) => this.showTip(ev as PointerEvent));
    this.listen(canvas, 'pointerleave', () => (this.tip.style.display = 'none'));
    this.listen(canvas, 'dblclick', (ev) => {
      this.showTip(ev as MouseEvent);
      if (this.hoverCol && this.onPickColumn && this.vol) {
        this.onPickColumn(this.vol.ny - 1 - this.hoverCol.iy, this.hoverCol.ix);
      }
    });
    this.listen(canvas, 'pointerdown', () => canvas.focus({ preventScroll: true }));
    this.listen(canvas, 'wheel', (ev) => this.onWheel(ev as WheelEvent), { passive: false });
    // On the canvas, not the window: arrow keys elsewhere pan the map.
    this.listen(canvas, 'keydown', (ev) => this.onKey(ev as KeyboardEvent));

    this.renderer.setAnimationLoop(() => {
      const moved = this.controls.update();
      if (moved || this.dirty) {
        this.group.updateMatrixWorld();
        this.group.worldToLocal(this.camLocal.copy(this.camera.position));
        if (this.volume) this.volume.setCamera(this.camLocal);
        this.surfaces?.sortFor(this.camLocal.z);
        const below = !!this.vol && this.camLocal.z < this.vol.nz / 2;
        if (below !== this.fromBelow) {
          this.fromBelow = below;
          this.placeGround();
        }
        this.renderer.render(this.scene, this.camera);
        this.dirty = false;
      }
    });
  }

  private listen(el: EventTarget, type: string, fn: (ev: Event) => void, opts?: AddEventListenerOptions) {
    el.addEventListener(type, fn, opts);
    this.off.push(() => el.removeEventListener(type, fn, opts));
  }

  destroy() {
    this.renderer.setAnimationLoop(null);
    for (const f of this.off) f();
    this.clearFaces();
    this.clearLabels();
    this.setGround(null);
    this.controls.dispose();
    this.renderer.dispose();
  }

  resize(w: number, h: number) {
    if (w < 1 || h < 1) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  /** PNG of the current view, e.g. for a figure. */
  snapshot(): string {
    this.renderer.render(this.scene, this.camera);
    return this.canvas.toDataURL('image/png');
  }

  // ------------------------------------------------------------ setters ----

  setCube(cube: Cube) {
    this.cube = cube;
    this.probe = null;
    this.loadVolume(true);
  }

  setMode(mode: ZMode) {
    if (mode === this.mode) return;
    this.mode = mode;
    // The surfaces have no slices to show: always the cutaway box.
    if (mode === 'surfaces' && this.display !== 'cut') {
      this.display = 'cut';
      this.topMode = 'slice';
      if (this.cube) return this.loadVolume(true);
    }
    if (this.cube) this.loadVolume(false);
  }

  setDisplay(display: Display) {
    if (display === this.display || !this.vol || this.mode === 'surfaces') return;
    this.display = display;
    this.topMode = 'slice';
    this.defaultCuts();
    this.buildFaces();
    this.updateFaces();
  }

  setTopMode(topMode: TopMode) {
    this.topMode = topMode;
    // In the cutaway the canopy top is a separate lid face: add or drop it.
    if (this.display === 'cut' && this.vol) this.buildFaces();
    this.updateFaces();
  }

  setVmax(vmax: number) {
    if (!(vmax > 0)) return;
    this.vmax = vmax;
    this.updateFaces();
  }

  /** The ramp for the current mode, fixed: heights inferno (the VSM convention), energy YlGn. */
  lut(): Uint8Array {
    return this.mode === 'rh' ? INFERNO : ENERGY_LUT;
  }

  /** The transparency in effect: none for RH (user, 2026-10-30). */
  private activeCutoff() {
    return this.mode === 'rh' ? 0 : this.cutoff;
  }

  setCutoff(c: number) {
    this.cutoff = Math.max(0, Math.min(1, c));
    this.updateFaces();
  }

  setZStretch(z: number) {
    this.zStretch = z;
    this.layout();
    this.updateSurfaces();
    this.emit();
  }

  /** RH surfaces: opacity of every sheet. */
  setOpacity(o: number) {
    this.opacity = Math.max(0.05, Math.min(1, o));
    this.surfaces?.setOpacity(this.opacity);
    this.dirty = true;
    this.emit();
  }

  /** RH surfaces: draw or hide one level. */
  toggleLevel(rh: number) {
    if (this.hiddenRh.has(rh)) this.hiddenRh.delete(rh);
    else this.hiddenRh.add(rh);
    this.surfaces?.setHidden(this.hiddenRh);
    this.dirty = true;
    this.emit();
  }

  setActive(axis: Axis) {
    if (axis === this.activeAxis) return;
    this.activeAxis = axis;
    this.emit();
  }

  /** Slider value: x = column, y = row counted from the NORTH edge, z = level. */
  setCut(axis: Axis, value: number) {
    if (!this.vol) return;
    if (axis === 'x') this.cx = value;
    else if (axis === 'y') this.cy = this.vol.ny - 1 - value;
    else this.cz = value;
    this.activeAxis = axis;
    this.clampCuts();
    this.updateFaces();
  }

  /** RH surfaces: raise the bottom cut, in metres; stays at least 1 m under the top. */
  setBottom(value: number) {
    if (!this.vol) return;
    this.cz0 = value;
    this.clampCuts();
    this.updateFaces();
  }

  /** Restore a shared view: z mode, display, slice positions, transparency. */
  applyView(
    v: {
      mode: ZMode;
      display: Display;
      cx: number;
      cy: number;
      cz: number;
      cutoff: number;
      topMode?: TopMode;
      vmax?: number;
      zStretch?: number;
      opacity?: number;
      hidden?: number[];
      cz0?: number;
    },
    probe: { row: number; col: number } | null = null,
  ) {
    if (!this.cube) return;
    // Taken as already applied, so the pin arriving next does not move the shared slices.
    this.probe = probe;
    this.mode = v.mode;
    this.display = v.mode === 'surfaces' ? 'cut' : v.display;
    this.topMode = 'slice';
    if (v.opacity && v.opacity > 0) this.opacity = Math.min(1, v.opacity);
    if (v.hidden) this.hiddenRh = new Set(v.hidden);
    this.cutoff = Math.max(0, Math.min(1, v.cutoff));
    this.vol = this.makeVolume(this.cube);
    this.vmax = v.vmax && v.vmax > 0 ? v.vmax : this.vol.vmax;
    if (v.topMode) this.topMode = v.topMode;
    if (v.zStretch && v.zStretch > 0) this.zStretch = v.zStretch;
    this.cx = v.cx;
    this.cy = v.cy;
    this.cz = v.cz;
    this.cz0 = v.cz0 ?? 0;
    this.clampCuts();
    this.layout();
    this.buildFaces();
    this.updateFaces();
  }

  resetCuts() {
    this.defaultCuts();
    this.updateFaces();
  }

  /** Where the camera is, for a saved page to open on the same view. */
  cameraState(): CameraState {
    return {
      position: this.camera.position.toArray() as [number, number, number],
      target: this.controls.target.toArray() as [number, number, number],
    };
  }

  setCameraState(c: CameraState) {
    this.camera.position.fromArray(c.position);
    this.controls.target.fromArray(c.target);
    this.controls.update();
    this.dirty = true;
  }

  resetView() {
    // Aimed a little below the block's centre, so the ground image under it is in view too.
    this.controls.target.set(0, 0, -0.08);
    this.camera.position.copy(HOME_DIR).multiplyScalar(this.homeDistance).add(this.controls.target);
    this.controls.update();
    this.dirty = true;
  }

  // ------------------------------------------------------------- volume ----

  private makeVolume(cube: Cube): Volume {
    return this.mode === 'rh' ? rhVolume(cube) : this.mode === 'surfaces' ? surfaceVolume(cube) : energyVolume(cube);
  }

  private loadVolume(newCube: boolean) {
    if (!this.cube) return;
    const prevNz = this.vol?.nz;
    this.vol = this.makeVolume(this.cube);
    this.vmax = this.vol.vmax;
    if (newCube || prevNz === undefined) this.defaultCuts();
    else this.cz = Math.round((this.cz / prevNz) * this.vol.nz);
    this.clampCuts();
    this.layout();
    this.buildFaces();
    this.updateFaces();
  }

  /**
   * The pin dragged to another pixel of the window: move the green line there,
   * and the crossing slices with it.
   */
  setProbe(probe: { row: number; col: number } | null) {
    const same = probe?.row === this.probe?.row && probe?.col === this.probe?.col;
    this.probe = probe;
    if (same || !this.vol || !this.clickLine) return;
    const [ix, iy] = this.clickIndex();
    const pos = this.clickLine.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < 2; i++) pos.setXY(i, ix + 0.5, iy + 0.5);
    pos.needsUpdate = true;
    this.clickLine.geometry.computeBoundingSphere();
    if (this.display === 'planes') {
      this.cx = ix;
      this.cy = iy;
    }
    this.updateFaces();
  }

  /** The pixel the card is reading: the dragged pin, else the click. */
  private clickIndex(): [number, number] {
    const { row, col } = this.probe ?? this.cube!.meta.click;
    return [col, this.vol!.ny - 1 - row];
  }

  private defaultCuts() {
    const v = this.vol!;
    if (this.display === 'planes') {
      // Crossing slices sitting on the outer faces would look like an empty
      // box: cross them at the clicked pixel instead.
      [this.cx, this.cy] = this.clickIndex();
      this.cz = Math.round(v.nz * 0.4);
    } else {
      this.cx = v.nx - 1;
      this.cy = 0;
      this.cz = v.nz - 1;
    }
    this.cz0 = 0;
  }

  private clampCuts() {
    const { nx, ny, nz } = this.vol!;
    this.cx = Math.max(0, Math.min(nx - 1, this.cx));
    this.cy = Math.max(0, Math.min(ny - 1, this.cy));
    this.cz = Math.max(0, Math.min(nz - 1, this.cz));
    this.cz0 = this.mode === 'surfaces' ? Math.max(0, Math.min(this.cz, this.cz0)) : 0;
  }

  private layout() {
    if (!this.vol) return;
    const { nx, ny, nz } = this.vol;
    const zs = this.zStretch;
    this.group.scale.set(1 / nx, 1 / ny, zs / nz);
    this.group.position.set(-0.5, -0.5, -zs / 2);
    this.labels.scale.copy(this.group.scale);
    this.labels.position.copy(this.group.position);
    this.dirty = true;
  }

  // -------------------------------------------------------------- faces ----

  private clearFaces() {
    for (const f of this.faces) {
      this.group.remove(f.mesh);
      f.mesh.geometry.dispose();
      f.mesh.material.dispose();
      f.tex?.dispose();
    }
    this.faces.length = 0;
    for (const obj of [this.wire, this.clickLine]) {
      if (!obj) continue;
      this.group.remove(obj);
      obj.geometry.dispose();
      (obj.material as THREE.Material).dispose();
    }
    this.wire = this.clickLine = null;
    if (this.volume) {
      this.group.remove(this.volume.mesh);
      this.volume.dispose();
      this.volume = null;
    }
    if (this.surfaces) {
      this.group.remove(this.surfaces.group);
      this.surfaces.dispose();
      this.surfaces = null;
    }
  }

  private makeFace(spec: FaceSpec) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
    geom.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(8), 2));
    geom.setIndex([0, 1, 2, 0, 2, 3]);
    const mat = new THREE.MeshBasicMaterial({
      side: THREE.DoubleSide,
      color: new THREE.Color().setScalar(spec.tint),
      alphaTest: 0.5,
    });
    const mesh = new THREE.Mesh(geom, mat);
    this.group.add(mesh);
    this.faces.push({ spec, mesh, tex: null, texIdx: -1, texKey: '' });
  }

  private buildFaces() {
    this.clearFaces();
    const { nx, ny, nz } = this.vol!;
    if (this.mode === 'surfaces') {
      this.surfaces = new SurfaceStack(this.cube!, this.opacity, this.hiddenRh);
      this.group.add(this.surfaces.group);
    } else if (this.display === 'cut') {
      // Block = x in [0, cx+1], y in [cy, ny], z in [0, cz+1], drawn as a volume
      // so the see-through dark end shows the inside rather than a hollow shell.
      this.volume = new VolumeBlock(this.vol!, this.lut());
      this.group.add(this.volume.mesh);
      // Energy + canopy top: an opaque lid at the cut height, as before.
      if (this.mode === 'energy' && this.topMode === 'canopy') {
        this.makeFace({
          axis: 'z',
          tint: 1.0,
          name: 'top',
          idx: (s) => s.cz,
          p: (s) => s.cz + 1,
          a: (s) => [0, s.cx + 1],
          b: (s) => [s.cy, ny],
        });
      }
    } else {
      this.makeFace({
        axis: 'z',
        tint: 1.0,
        name: 'z slice',
        idx: (s) => s.cz,
        p: (s) => s.cz + 0.5,
        a: () => [0, nx],
        b: () => [0, ny],
      });
      this.makeFace({
        axis: 'y',
        tint: 0.9,
        name: 'y slice',
        idx: (s) => s.cy,
        p: (s) => s.cy + 0.5,
        a: () => [0, nx],
        b: () => [0, nz],
      });
      this.makeFace({
        axis: 'x',
        tint: 0.8,
        name: 'x slice',
        idx: (s) => s.cx,
        p: (s) => s.cx + 0.5,
        a: () => [0, ny],
        b: () => [0, nz],
      });
    }

    this.wire = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(nx, ny, nz)),
      new THREE.LineBasicMaterial({ color: 0xb5c0bb }),
    );
    this.wire.position.set(nx / 2, ny / 2, nz / 2);
    this.group.add(this.wire);

    // The clicked pixel, top to bottom, in the map pin's green. Drawn through the faces so it can be
    // found inside the block too.
    const [ix, iy] = this.clickIndex();
    this.clickLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(ix + 0.5, iy + 0.5, -nz * 0.04),
        new THREE.Vector3(ix + 0.5, iy + 0.5, nz * 1.08),
      ]),
      new THREE.LineBasicMaterial({ color: 0x10796a, depthTest: false, transparent: true, opacity: 0.9 }),
    );
    this.clickLine.renderOrder = 10;
    this.group.add(this.clickLine);

    this.buildLabels();
    this.buildGround();
  }

  // ------------------------------------------------------------- ground ----

  /** Satellite image under the block, already warped onto the window (row 0 = north). */
  setGround(image: (CanvasImageSource & { width: number; height: number }) | null) {
    this.groundImage = image;
    this.buildGround();
  }

  private buildGround() {
    if (this.ground) {
      this.group.remove(this.ground);
      this.ground.geometry.dispose();
      this.ground.material.map?.dispose();
      this.ground.material.dispose();
      this.ground = null;
    }
    if (!this.groundImage || !this.vol) {
      this.dirty = true;
      return;
    }
    const { nx, ny } = this.vol;
    const tex = new THREE.Texture(this.groundImage as HTMLCanvasElement);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    tex.needsUpdate = true;
    // PlaneGeometry's v = 0 edge is -y (south); flipY puts image row 0 (north) at +y.
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(nx, ny),
      new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }),
    );
    this.ground.position.set(nx / 2, ny / 2, this.groundZ());
    this.group.add(this.ground);
    this.dirty = true;
  }

  /** Under the block, or over it when looking up from below: always behind the data. */
  private groundZ() {
    const nz = this.vol!.nz;
    return this.fromBelow ? nz * (1 + GROUND_DROP) : -nz * GROUND_DROP;
  }

  /** The camera crossed the block's mid-height: move the ground image and the E/N labels to the far side. */
  private placeGround() {
    if (!this.vol) return;
    const z = this.groundZ();
    this.ground?.position.setZ(z);
    for (const sp of this.labels.children) if (sp.userData.onGround) sp.position.setZ(z);
    this.dirty = true;
  }

  /** Texture of one slice: x -> (u = y, v = z); y -> (u = x, v = z); z -> (u = x, v = y). */
  private sliceDims(axis: Axis): [number, number] {
    const { nx, ny, nz } = this.vol!;
    return axis === 'x' ? [ny, nz] : axis === 'y' ? [nx, nz] : [nx, ny];
  }

  private voxel(ix: number, iy: number, iz: number) {
    const v = this.vol!;
    return v.data[(iz * v.ny + iy) * v.nx + ix];
  }

  private sliceValue(axis: Axis, idx: number, a: number, b: number) {
    return axis === 'x' ? this.voxel(idx, a, b) : axis === 'y' ? this.voxel(a, idx, b) : this.voxel(a, b, idx);
  }

  /** Energy mode: the top face shows the canopy top (RH98) clipped at the cut, not the bin. */
  private canopyFace(face: Face) {
    return this.mode === 'energy' && this.topMode === 'canopy' && face.spec.axis === 'z' && face.spec.name !== 'bottom';
  }

  private texKey() {
    return `${this.mode}|${this.display}|${this.vmax}|${this.topMode}|${this.activeCutoff()}`;
  }

  private fillTexture(face: Face, idx: number) {
    const [w, h] = this.sliceDims(face.spec.axis);
    if (!face.tex || face.tex.image.width !== w || face.tex.image.height !== h) {
      face.tex?.dispose();
      face.tex = new THREE.DataTexture(new Uint8Array(w * h * 4), w, h, THREE.RGBAFormat);
      face.tex.magFilter = face.tex.minFilter = THREE.NearestFilter;
      face.tex.colorSpace = THREE.SRGBColorSpace;
      face.mesh.material.map = face.tex;
      face.mesh.material.needsUpdate = true;
    }
    const px = face.tex.image.data as Uint8Array;
    // Crossing slices in Energy mode: an empty height bin is air, draw nothing.
    const hideEmpty = this.mode === 'energy' && this.display === 'planes';
    // Textured faces in the cutaway are only the canopy lid, which stays opaque;
    // the block's own transparency is handled by the volume.
    const cutoff = this.display === 'planes' ? this.activeCutoff() : 0;
    const canopy = this.canopyFace(face);
    const vmax = canopy ? 50 : this.vmax; // canopy top: the VSM height convention, inferno 0-50 m
    const cmap = this.vol!.canopy;
    // Heights (the canopy lid included) keep inferno; energy uses the chosen ramp.
    const lut = canopy ? INFERNO : this.lut();
    for (let b = 0; b < h; b++)
      for (let a = 0; a < w; a++) {
        const o = (b * w + a) * 4;
        const v = canopy && cmap ? Math.min(cmap[b * w + a], idx + 1) : this.sliceValue(face.spec.axis, idx, a, b);
        if (Number.isNaN(v)) {
          // No data: not drawn (the cutaway volume and the RH surfaces leave it empty too).
          px[o + 3] = 0;
          continue;
        }
        let t = v / vmax;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const k = Math.round(t * 255) * 3;
        px[o] = lut[k];
        px[o + 1] = lut[k + 1];
        px[o + 2] = lut[k + 2];
        px[o + 3] = (hideEmpty && v === 0) || t < cutoff ? 0 : 255;
      }
    face.tex.needsUpdate = true;
    face.texIdx = idx;
    face.texKey = this.texKey();
  }

  /** Quad at plane coordinate p along the axis, spanning [a0,a1] x [b0,b1] in the other two. */
  private setQuad(face: Face, p: number, a0: number, a1: number, b0: number, b1: number) {
    const [w, h] = this.sliceDims(face.spec.axis);
    const g = face.mesh.geometry;
    const pos = g.attributes.position.array as Float32Array;
    const uv = g.attributes.uv.array as Float32Array;
    const ax = face.spec.axis;
    [
      [a0, b0],
      [a1, b0],
      [a1, b1],
      [a0, b1],
    ].forEach(([a, b], i) => {
      const x = ax === 'x' ? p : a;
      const y = ax === 'y' ? p : ax === 'x' ? a : b;
      const z = ax === 'z' ? p : b;
      pos[i * 3] = x;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = z;
      uv[i * 2] = a / w;
      uv[i * 2 + 1] = b / h;
    });
    g.attributes.position.needsUpdate = true;
    g.attributes.uv.needsUpdate = true;
    g.computeBoundingSphere();
  }

  private updateFaces() {
    if (!this.vol) return;
    const key = this.texKey();
    if (this.volume) {
      const v = this.vol;
      this.volume.update([0, this.cx + 1, this.cy, v.ny, 0, this.cz + 1], this.vmax, this.activeCutoff());
      this.volume.setLut(this.lut());
    }
    this.updateSurfaces();
    for (const f of this.faces) {
      const idx = f.spec.idx(this);
      if (f.texIdx !== idx || f.texKey !== key) this.fillTexture(f, idx);
      const [a0, a1] = f.spec.a(this);
      const [b0, b1] = f.spec.b(this);
      this.setQuad(f, f.spec.p(this), a0, a1, b0, b1);
    }
    this.dirty = true;
    this.emit();
  }

  /** Clip the RH surfaces to the cutaway box; the planes are in world space, so also after a z stretch. */
  private updateSurfaces() {
    if (!this.surfaces || !this.vol) return;
    this.group.updateMatrixWorld();
    this.surfaces.update(this.cx + 1, this.cy, this.cz0, this.cz + 1, this.group.matrixWorld);
    this.dirty = true;
  }

  private emit() {
    const v = this.vol;
    if (!v || !this.cube) return;
    this.onChange({
      mode: this.mode,
      display: this.display,
      topMode: this.topMode,
      vmax: this.vmax,
      zStretch: this.zStretch,
      cutoff: this.cutoff,
      activeAxis: this.activeAxis,
      cx: this.cx,
      cy: this.cy,
      cz: this.cz,
      cz0: this.cz0,
      nx: v.nx,
      ny: v.ny,
      nz: v.nz,
      unit: v.unit,
      cbarTitle: v.cbarTitle,
      zLabel: v.zLabel(this.cz),
      zInterpolated: this.mode === 'rh' && this.cube.meta.interpolated_rh.includes(this.cz + 1),
      opacity: this.opacity,
      levels: SURFACE_RH.map((rh, i) => ({ rh, colour: SURFACE_COLOURS[i], on: !this.hiddenRh.has(rh) })),
    });
  }

  // ------------------------------------------------------------- labels ----

  private clearLabels() {
    while (this.labels.children.length) {
      const s = this.labels.children.pop() as THREE.Sprite;
      s.material.map?.dispose();
      s.material.dispose();
    }
  }

  private textSprite(text: string, size = 13, color = '#47544e') {
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d')!;
    const font = `${size * 4}px system-ui, sans-serif`;
    ctx.font = font;
    const w = Math.ceil(ctx.measureText(text).width) + 16;
    const h = size * 4 + 16;
    c.width = w;
    c.height = h;
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 8, h / 2);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
    const k = (0.0006 * size) / 11;
    sp.scale.set(w * k, h * k, 1);
    return sp;
  }

  private buildLabels() {
    this.clearLabels();
    const v = this.vol!;
    const m = this.cube!.meta;
    const { nx, ny, nz } = v;
    // Sprites live in index space but keep their screen size: undo the group's x/y scale.
    const put = (sp: THREE.Sprite, x: number, y: number, z: number) => {
      sp.scale.set(sp.scale.x * nx, sp.scale.y * ny, 1);
      sp.position.set(x, y, z);
      sp.renderOrder = 20; // over the ground image, which lies right under the axis labels
      this.labels.add(sp);
      return sp;
    };
    // Along the ground image's edges, which carry the distances.
    const zg = this.groundZ();
    for (const sp of [
      put(this.textSprite(`E →  ${(nx * m.res_m[0]).toFixed(0)} m`), nx / 2, -6, zg),
      put(this.textSprite(`N →  ${(ny * m.res_m[1]).toFixed(0)} m`), nx + 7, ny / 2, zg),
    ])
      sp.userData.onGround = true;
    put(this.textSprite(v.zTop, 13, '#2c3a34'), -4, -4, nz + 1);
    put(this.textSprite(v.zBottom, 13, '#2c3a34'), -4, -4, -1);
    put(this.textSprite(v.zName, 13, '#10796a'), -6, -6, nz / 2);
  }

  // -------------------------------------------------------- interaction ----

  private pick(ev: { clientX: number; clientY: number }) {
    const r = this.canvas.getBoundingClientRect();
    this.ptr.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.ptr, this.camera);
    const hit = this.ray.intersectObjects(
      this.faces.map((f) => f.mesh),
      false,
    )[0];
    if (!hit || !hit.uv) return null;
    const face = this.faces.find((f) => f.mesh === hit.object)!;
    const [w, h] = this.sliceDims(face.spec.axis);
    const a = Math.min(w - 1, Math.floor(hit.uv.x * w));
    const b = Math.min(h - 1, Math.floor(hit.uv.y * h));
    return { face, a, b };
  }

  /** The pointer's ray in index space. */
  private localRay(ev: { clientX: number; clientY: number }) {
    const r = this.canvas.getBoundingClientRect();
    this.ptr.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.ptr, this.camera);
    this.group.updateMatrixWorld();
    const inv = this.group.matrixWorld.clone().invert();
    const o = this.ray.ray.origin.clone().applyMatrix4(inv);
    const d = this.ray.ray.origin.clone().add(this.ray.ray.direction).applyMatrix4(inv).sub(o);
    return { o, d };
  }

  /** Cutaway: the voxel under the pointer, walked like the shader does. */
  private pickVoxel(ev: { clientX: number; clientY: number }) {
    if (!this.volume) return null;
    const { o, d } = this.localRay(ev);
    return this.volume.pick(o, d);
  }

  /** RH surfaces: the first visible level under the pointer. */
  private pickSurface(ev: { clientX: number; clientY: number }) {
    if (!this.surfaces) return null;
    const { o, d } = this.localRay(ev);
    return this.surfaces.pick(o, d);
  }

  /** Tooltip footer: what a double-click does, when it does something. */
  private pickHint() {
    return this.onPickColumn ? '<br><span class="ex-cube__tip-hint">double-click: move the pin here</span>' : '';
  }

  private showTip(ev: { clientX: number; clientY: number }) {
    this.hoverCol = null;
    if (this.surfaces) {
      const s = this.pickSurface(ev);
      if (s) this.setActive(s.entryAxis);
      if (!s?.hit) {
        this.tip.style.display = 'none';
        return;
      }
      const m = this.cube!.meta;
      const { rh, ix, iy, value } = s.hit;
      this.tip.innerHTML =
        `<b>RH${rh}</b> · ${(ix * m.res_m[0]).toFixed(0)} m E · ${(iy * m.res_m[1]).toFixed(0)} m N` +
        `<br>height: <b>${value.toFixed(1)} m</b>` +
        (m.interpolated_rh.includes(rh) ? ' (missing in the archive, filled from the RH just below and above)' : '') +
        this.pickHint();
      this.hoverCol = { ix, iy };
      this.tip.style.display = 'block';
      this.tip.style.left = `${ev.clientX + 14}px`;
      this.tip.style.top = `${ev.clientY + 14}px`;
      return;
    }
    const lid = this.vol && this.pick(ev);
    if (!lid && this.volume) {
      const hit = this.pickVoxel(ev);
      if (!hit?.voxel) {
        this.tip.style.display = 'none';
        if (hit) this.setActive(hit.entryAxis);
        return;
      }
      const v = this.vol!;
      const m = this.cube!.meta;
      const { ix, iy, iz, value } = hit.voxel;
      this.tip.innerHTML =
        `<b>block</b> · ${(ix * m.res_m[0]).toFixed(0)} m E · ${(iy * m.res_m[1]).toFixed(0)} m N · ${v.zLabel(iz)}` +
        `<br>${v.cbarTitle}: <b>${Number.isNaN(value) ? 'no data' : v.fmt(value)}</b>` +
        this.pickHint();
      this.hoverCol = { ix, iy };
      this.tip.style.display = 'block';
      this.tip.style.left = `${ev.clientX + 14}px`;
      this.tip.style.top = `${ev.clientY + 14}px`;
      this.setActive(hit.entryAxis);
      return;
    }
    const hover = lid;
    if (!hover) {
      this.tip.style.display = 'none';
      return;
    }
    const v = this.vol!;
    const m = this.cube!.meta;
    const { face, a, b } = hover;
    const ax = face.spec.axis;
    const idx = face.texIdx;
    const ix = ax === 'x' ? idx : a;
    const iy = ax === 'y' ? idx : ax === 'x' ? a : b;
    const iz = ax === 'z' ? idx : b;
    const val = this.voxel(ix, iy, iz);
    const where = `<b>${face.spec.name}</b> · ${(ix * m.res_m[0]).toFixed(0)} m E · ${(iy * m.res_m[1]).toFixed(0)} m N`;
    if (this.canopyFace(face) && v.canopy) {
      const c = v.canopy[iy * v.nx + ix];
      this.tip.innerHTML =
        `${where}<br>canopy top RH98: <b>${Number.isNaN(c) ? 'no data' : c.toFixed(1) + ' m'}</b>` +
        (c > iz + 1 ? ` · cut at ${iz + 1} m` : '');
    } else {
      this.tip.innerHTML = `${where} · ${v.zLabel(iz)}<br>${v.cbarTitle}: <b>${Number.isNaN(val) ? 'no data' : v.fmt(val)}</b>`;
    }
    this.tip.innerHTML += this.pickHint();
    this.hoverCol = { ix, iy };
    this.tip.style.display = 'block';
    this.tip.style.left = `${ev.clientX + 14}px`;
    this.tip.style.top = `${ev.clientY + 14}px`;
    this.setActive(ax);
  }

  /** Deeper = towards the hidden corner (west / north / down). */
  step(axis: Axis, n: number) {
    if (!this.vol) return;
    if (axis === 'x') this.cx -= n;
    else if (axis === 'y') this.cy += n;
    else this.cz -= n;
    this.clampCuts();
    this.updateFaces();
  }

  private onWheel(ev: WheelEvent) {
    ev.preventDefault();
    if (ev.shiftKey || ev.ctrlKey || ev.metaKey) {
      // Zoom; a trackpad pinch arrives as ctrl+wheel.
      const d = this.camera.position.clone().sub(this.controls.target);
      const k = Math.exp(ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0015));
      const len = Math.max(0.6, Math.min(12, d.length() * k));
      this.camera.position.copy(this.controls.target).add(d.setLength(len));
      this.dirty = true;
      return;
    }
    this.wheelAcc += ev.deltaY;
    const steps = Math.trunc(this.wheelAcc / 24);
    if (!steps) return;
    this.wheelAcc -= steps * 24;
    // RH surfaces: option/alt + scroll moves the bottom cut (up = raise it).
    if (ev.altKey && this.mode === 'surfaces') {
      this.setBottom(this.cz0 - steps);
      return;
    }
    // The face under the pointer moves: a slice, the canopy lid, or the side of
    // the cutaway volume the pointer is over.
    const h = this.pick(ev);
    const axis = h
      ? h.face.spec.axis
      : (this.pickVoxel(ev)?.entryAxis ?? this.pickSurface(ev)?.entryAxis ?? this.activeAxis);
    // RH surfaces seen from below: the face under the pointer is the bottom
    // cut; scrolling down peels it upwards, as scrolling down lowers the top.
    if (axis === 'z' && this.mode === 'surfaces' && this.fromBelow) {
      this.setBottom(this.cz0 + steps);
      this.showTip(ev);
      return;
    }
    this.step(axis, steps);
    this.showTip(ev);
  }

  private onKey(ev: KeyboardEvent) {
    const k = ev.key.toLowerCase();
    const n = ev.shiftKey ? 5 : 1;
    if (k === 'x' || k === 'y' || k === 'z') this.setActive(k);
    else if (k === 'arrowleft' || k === 'arrowdown') this.step(this.activeAxis, n);
    else if (k === 'arrowright' || k === 'arrowup') this.step(this.activeAxis, -n);
    else if (k === 'r') this.resetView();
    else return;
    ev.preventDefault();
    ev.stopPropagation();
  }
}
