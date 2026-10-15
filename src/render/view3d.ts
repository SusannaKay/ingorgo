// Renderer 3D (Three.js): bus giocattolo con luci e ombre morbide, persone istanziate,
// garage, piastrelle del parcheggio e decorazioni del mondo a tema.
// Mondo di gioco (x, y, z-alto) -> Three.js (X = x, Y = z, Z = y).
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { toWorld } from '../game/types';
import { mulberry32 } from '../game/rng';
import { BUS_W, Pose, Timeline, VBus, VGarage } from './timeline';
import { Theme } from './themes';

export const PALETTE = ['#ff4d4d', '#3a86ff', '#ffd23f', '#3ecf6a', '#9b5de5', '#ff9f1c', '#ff70c4', '#17c3b2'];
const INK = '#1d2340';
const PITCH = (51 * Math.PI) / 180;

const V = (x: number, y: number, z = 0) => new THREE.Vector3(x, z, y);

function lighten(hex: string, k: number) {
  return new THREE.Color(hex).lerp(new THREE.Color('#ffffff'), k);
}
function darken(hex: string, k: number) {
  return new THREE.Color(hex).lerp(new THREE.Color(INK), k);
}

// ---------- geometrie e materiali condivisi ----------
const geoCache = new Map<string, THREE.BufferGeometry>();
function geo(key: string, make: () => THREE.BufferGeometry) {
  let g = geoCache.get(key);
  if (!g) {
    g = make();
    geoCache.set(key, g);
  }
  return g;
}
const matCache = new Map<string, THREE.Material>();
function mat<T extends THREE.Material>(key: string, make: () => T): T {
  let m = matCache.get(key) as T | undefined;
  if (!m) {
    m = make();
    matCache.set(key, m);
  }
  return m;
}
const std = (color: THREE.ColorRepresentation, rough = 0.6, extra: THREE.MeshStandardMaterialParameters = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0.02, ...extra });

function arrowShape(a: number, b: number, scale = 1) {
  const pts: [number, number][] = [
    [0.78, 0],
    [0.12, 0.66],
    [0.12, 0.3],
    [-0.66, 0.3],
    [-0.66, -0.3],
    [0.12, -0.3],
    [0.12, -0.66],
  ];
  const k = Math.min(1, 1.15 / a);
  const s = new THREE.Shape();
  pts.forEach(([u, v], i) => {
    const x = u * k * a * scale,
      y = v * b * scale;
    if (i) s.lineTo(x, y);
    else s.moveTo(x, y);
  });
  s.closePath();
  return s;
}

interface BusObj {
  root: THREE.Group;
  inner: THREE.Group;
  bodyMat: THREE.MeshStandardMaterial;
  pick: THREE.Mesh;
  arrow: THREE.Group;
  seats: THREE.Mesh[];
  len: number;
}

interface GarageObj {
  root: THREE.Group;
  label: THREE.Sprite;
  count: number;
}

export class View3D {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(26, 1, 0.5, 200);
  private ray = new THREE.Raycaster();
  private world = new THREE.Group();
  private hemi = new THREE.HemisphereLight();
  private sun = new THREE.DirectionalLight();
  private buses = new Map<number, BusObj>();
  private garages = new Map<number, GarageObj>();
  private bays: THREE.Mesh[] = [];
  private bodies!: THREE.InstancedMesh;
  private heads!: THREE.InstancedMesh;
  private ring!: THREE.Mesh;
  private parts!: THREE.InstancedMesh;
  private tl!: Timeline;
  private theme!: Theme;
  private cssW = 1;
  private cssH = 1;
  private top = 0;
  private bottom = 0;
  private camBase = new THREE.Vector3();
  private fx: CanvasRenderingContext2D;
  private confetti: { x: number; y: number; vx: number; vy: number; rot: number; vr: number; color: string; t0: number; w: number }[] = [];
  private lastCelebrate = -9;
  private tmpM = new THREE.Matrix4();
  private tmpQ = new THREE.Quaternion();
  private tmpS = new THREE.Vector3();
  private tmpP = new THREE.Vector3();
  private tmpC = new THREE.Color();

  constructor(
    canvas: HTMLCanvasElement,
    private fxCanvas: HTMLCanvasElement,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.fx = fxCanvas.getContext('2d')!;
    this.scene.add(this.world, this.hemi, this.sun, this.sun.target);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1536, 1536);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.sun.shadow.radius = 3;
  }

  // ---------- livello ----------
  setLevel(tl: Timeline, theme: Theme) {
    this.tl = tl;
    this.theme = theme;
    for (const c of [...this.world.children]) this.world.remove(c);
    disposeTree(this.world);
    this.buses.clear();
    this.garages.clear();
    this.scene.background = new THREE.Color(theme.sky);
    this.scene.fog = new THREE.Fog(theme.sky, 60, 120);
    this.hemi.color.set(theme.hemiSky);
    this.hemi.groundColor.set(theme.hemiGround);
    this.hemi.intensity = theme.hemi;
    this.sun.color.set(theme.sun);
    this.sun.intensity = theme.sunPower;
    const W = tl.w,
      H = tl.h;
    const c = V(W / 2, (H - 6) / 2);
    this.sun.position.copy(c).add(new THREE.Vector3(-7, 16, 9));
    this.sun.target.position.copy(c);
    const sc = this.sun.shadow.camera;
    const r = Math.max(W, H) * 0.5 + 9;
    sc.left = -r;
    sc.right = r;
    sc.top = r;
    sc.bottom = -r;
    sc.near = 1;
    sc.far = 60;
    sc.updateProjectionMatrix();

    this.buildEnvironment();
    this.buildStatic();
    this.buildPeople();
    for (const vb of tl.buses) this.buses.set(vb.id, this.makeBus(vb));
    for (const g of tl.garages) this.garages.set(g.id, this.makeGarage(g));
    this.fit();
  }

  /** stalli cambiati (+1 posto): ricostruisce solo la piazzola */
  refreshBays() {
    this.buildStatic(true);
  }

  resize(cssW: number, cssH: number, top: number, bottom: number, dpr: number) {
    this.cssW = cssW;
    this.cssH = cssH;
    this.top = top;
    this.bottom = bottom;
    this.renderer.setPixelRatio(Math.min(dpr, 2));
    this.renderer.setSize(cssW, cssH, false);
    this.fxCanvas.width = Math.round(cssW * dpr);
    this.fxCanvas.height = Math.round(cssH * dpr);
    this.fx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.tl) this.fit();
  }

  /** Avvicina la camera finché tutta la scena entra tra la barra in alto e i pulsanti. */
  private fit() {
    const W = this.tl.w,
      H = this.tl.h;
    const minX = -1.5,
      maxX = W + 1.5,
      minY = -7.4,
      maxY = H + 1.3;
    const target = V((minX + maxX) / 2, (minY + maxY) / 2);
    const dir = new THREE.Vector3(0, Math.sin(PITCH), Math.cos(PITCH));
    const cam = this.camera;
    cam.aspect = this.cssW / this.cssH;
    cam.clearViewOffset();
    const usableW = this.cssW - 10,
      usableH = this.cssH - this.top - this.bottom;
    const corners: THREE.Vector3[] = [];
    for (const x of [minX, maxX]) for (const y of [minY, maxY]) for (const z of [0, 0.9]) corners.push(V(x, y, z));
    const bbox = (d: number) => {
      cam.position.copy(target).addScaledVector(dir, d);
      cam.lookAt(target);
      cam.updateMatrixWorld();
      cam.updateProjectionMatrix();
      let x0 = Infinity,
        x1 = -Infinity,
        y0 = Infinity,
        y1 = -Infinity;
      for (const p of corners) {
        const q = p.clone().project(cam);
        const sx = ((q.x + 1) / 2) * this.cssW,
          sy = ((1 - q.y) / 2) * this.cssH;
        x0 = Math.min(x0, sx);
        x1 = Math.max(x1, sx);
        y0 = Math.min(y0, sy);
        y1 = Math.max(y1, sy);
      }
      return { x0, x1, y0, y1 };
    };
    let lo = 5,
      hi = 300;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      const b = bbox(mid);
      if (b.x1 - b.x0 <= usableW && b.y1 - b.y0 <= usableH) hi = mid;
      else lo = mid;
    }
    const b = bbox(hi);
    const dx = this.cssW / 2 - (b.x0 + b.x1) / 2;
    const dy = this.top + usableH / 2 - (b.y0 + b.y1) / 2;
    cam.setViewOffset(this.cssW, this.cssH, -dx, -dy, this.cssW, this.cssH);
    cam.updateProjectionMatrix();
    this.camBase.copy(cam.position);
    // nebbia solo sull'orizzonte, mai sul parcheggio
    const fog = this.scene.fog as THREE.Fog | null;
    if (fog) {
      fog.near = hi + Math.max(W, H) * 0.9 + 6;
      fog.far = fog.near + 45;
    }
  }

  // ---------- ambiente ----------
  private box(x0: number, y0: number, x1: number, y1: number, z0: number, z1: number, material: THREE.Material, shadow = true) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, z1 - z0, y1 - y0), material);
    m.position.copy(V((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2));
    m.receiveShadow = shadow;
    this.world.add(m);
    return m;
  }

  private buildEnvironment() {
    const T = this.theme;
    const W = this.tl.w,
      H = this.tl.h;
    // terreno con texture puntinata
    const cv = document.createElement('canvas');
    cv.width = cv.height = 256;
    const g = cv.getContext('2d')!;
    g.fillStyle = T.ground;
    g.fillRect(0, 0, 256, 256);
    const rng = mulberry32(this.tl.level.seed);
    for (let i = 0; i < 900; i++) {
      g.fillStyle = rng() < 0.5 ? T.groundSpeck[0] : T.groundSpeck[1];
      g.globalAlpha = 0.35 + rng() * 0.4;
      g.beginPath();
      g.arc(rng() * 256, rng() * 256, 0.8 + rng() * 1.6, 0, Math.PI * 2);
      g.fill();
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(18, 18);
    tex.colorSpace = THREE.SRGBColorSpace;
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), new THREE.MeshStandardMaterial({ map: tex, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.copy(V(W / 2, H / 2 - 3, -0.01));
    ground.receiveShadow = true;
    this.world.add(ground);

    const asphalt = std(T.asphalt, 0.85);
    // strada ad anello, piazzale, cordoli
    this.box(-1, -1, W + 1, H + 1, 0, 0.04, asphalt);
    const curb = std(T.curb, 0.7);
    this.box(-1.14, -1.14, W + 1.14, -1, 0, 0.09, curb);
    this.box(-1.14, H + 1, W + 1.14, H + 1.14, 0, 0.09, curb);
    this.box(-1.14, -1, -1, H + 1, 0, 0.09, curb);
    this.box(W + 1, -1, W + 1.14, H + 1, 0, 0.09, curb);
    this.box(0, 0, W, H, 0, 0.06, std(T.plaza, 0.9));
    // corsia di uscita e marciapiede della fermata
    this.box(-1.15, -5.2, W + 6, -4.3, 0, 0.04, asphalt);
    this.box(-1.15, -7.3, W + 1.15, -5.2, 0, 0.14, std(T.sidewalk, 0.9));
    // linee tratteggiate
    const dashes: [number, number, number][] = [];
    const along = (x0: number, y0: number, x1: number, y1: number) => {
      const len = Math.hypot(x1 - x0, y1 - y0);
      const n = Math.floor(len / 0.55);
      const a = Math.atan2(y1 - y0, x1 - x0);
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n;
        dashes.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, a]);
      }
    };
    along(-0.5, -0.5, W + 0.5, -0.5);
    along(-0.5, H + 0.5, W + 0.5, H + 0.5);
    along(-0.5, -0.5, -0.5, H + 0.5);
    along(W + 0.5, -0.5, W + 0.5, H + 0.5);
    along(-1, this.tl.laneY, W + 6, this.tl.laneY);
    const dm = new THREE.InstancedMesh(new THREE.BoxGeometry(0.26, 0.01, 0.06), new THREE.MeshBasicMaterial({ color: T.night ? '#c9d0ea' : '#ffffff' }), dashes.length);
    dashes.forEach(([x, y, a], i) => {
      this.tmpQ.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -a);
      this.tmpM.compose(V(x, y, 0.045), this.tmpQ, new THREE.Vector3(1, 1, 1));
      dm.setMatrixAt(i, this.tmpM);
    });
    this.world.add(dm);

    // piastrelle del parcheggio (forma libera, anche ruotata)
    const L = this.tl.level;
    const cells: [number, number][] = [];
    for (let y = 0; y < L.gh; y++) for (let x = 0; x < L.gw; x++) if (L.mask[y * L.gw + x]) cells.push([x, y]);
    const tiles = new THREE.InstancedMesh(
      geo('tile', () => new RoundedBoxGeometry(0.95, 0.12, 0.95, 1, 0.04)),
      new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.8 }),
      cells.length,
    );
    tiles.receiveShadow = true;
    this.tmpQ.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -L.theta);
    cells.forEach(([x, y], i) => {
      const [wx, wy] = toWorld(L, x + 0.5, y + 0.5);
      this.tmpM.compose(V(wx, wy, 0.1), this.tmpQ, new THREE.Vector3(1, 1, 1));
      tiles.setMatrixAt(i, this.tmpM);
      tiles.setColorAt(i, this.tmpC.set((x + y) % 2 ? T.lot : T.lotAlt));
    });
    this.world.add(tiles);

    this.decorate();
  }

  /** piazzola degli stalli: separatori e riquadri luminosi per gli stalli liberi */
  private staticGroup = new THREE.Group();
  private buildStatic(only = false) {
    if (only) {
      this.world.remove(this.staticGroup);
      disposeTree(this.staticGroup);
    }
    this.staticGroup = new THREE.Group();
    const T = this.theme;
    const W = this.tl.w;
    const add = (m: THREE.Mesh) => this.staticGroup.add(m);
    const plat = new THREE.Mesh(new THREE.BoxGeometry(W + 2, 0.12, 3.3), std(T.platform, 0.85));
    plat.position.copy(V(W / 2, -2.65, 0.06));
    plat.receiveShadow = true;
    add(plat);
    const bw = this.tl.bayW();
    const yellow = std('#ffc83d', 0.6);
    for (let i = 0; i <= this.tl.K; i++) {
      const s = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.03, 3.05), yellow);
      s.position.copy(V(-1 + bw * i, -2.62, 0.13));
      s.receiveShadow = true;
      add(s);
    }
    this.bays = [];
    for (let i = 0; i < this.tl.K; i++) {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(bw - 0.3, 2.9),
        new THREE.MeshBasicMaterial({ color: '#3a86ff', transparent: true, opacity: 0.2, depthWrite: false }),
      );
      m.rotation.x = -Math.PI / 2;
      m.position.copy(V(this.tl.bayX(i), -2.62, 0.125));
      this.bays.push(m);
      add(m);
    }
    this.world.add(this.staticGroup);
  }

  private decorate() {
    const T = this.theme;
    const W = this.tl.w,
      H = this.tl.h;
    const rng = mulberry32(this.tl.level.seed + 7);
    const spots: [number, number, number][] = [];
    const sides = [-2.1, W + 2.1];
    for (const x of sides) for (let y = -2.8; y < H + 1; y += 2.1 + rng() * 1.2) spots.push([x + (rng() - 0.5) * 0.5, y, 0.8 + rng() * 0.45]);
    for (let x = 0; x < W + 1; x += 2 + rng()) spots.push([x, H + 2.2 + rng() * 0.4, 0.8 + rng() * 0.4]);
    spots.push([-2.2, -6.2, 0.9], [W + 2.3, -6.4, 0.9]);
    for (const [x, y, s] of spots) {
      const k = rng();
      let obj: THREE.Object3D;
      switch (T.id) {
        case 'snow':
          obj = k < 0.7 ? pine(s, true) : snowman(s);
          break;
        case 'beach':
          obj = k < 0.7 ? palm(s, rng) : umbrella(s, rng);
          break;
        case 'night':
          obj = k < 0.55 ? lamp(s) : roundTree(s, '#2f6b4d', rng);
          break;
        case 'desert':
          obj = k < 0.65 ? cactus(s, rng) : rock(s, rng);
          break;
        case 'autumn':
          obj = roundTree(s, ['#e8742c', '#d94a2b', '#f2b33d', '#c2602a'][Math.floor(rng() * 4)], rng);
          break;
        default:
          obj = k < 0.6 ? roundTree(s, '#4fae5a', rng) : bush(s, rng);
      }
      obj.position.copy(V(x, y));
      obj.rotation.y = rng() * Math.PI * 2;
      this.world.add(obj);
    }
    if (T.id === 'beach') {
      const sea = new THREE.Mesh(new THREE.PlaneGeometry(80, 30), std('#4cc3e6', 0.25, { transparent: true, opacity: 0.92 }));
      sea.rotation.x = -Math.PI / 2;
      sea.position.copy(V(W / 2, H + 18.5, 0.02));
      this.world.add(sea);
      const foam = new THREE.Mesh(new THREE.PlaneGeometry(80, 0.5), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.8 }));
      foam.rotation.x = -Math.PI / 2;
      foam.position.copy(V(W / 2, H + 3.7, 0.03));
      this.world.add(foam);
    }
    if (T.night) {
      // qualche lampione illumina davvero la scena
      const lights: [number, number][] = [
        [-1.6, H * 0.3],
        [W + 1.6, H * 0.7],
        [W / 2, -4.0],
      ];
      for (const [x, y] of lights) {
        const pl = new THREE.PointLight('#ffd27a', 9, 9, 1.6);
        pl.position.copy(V(x, y, 2.2));
        this.world.add(pl);
      }
    }
  }

  // ---------- bus ----------
  private makeBus(vb: VBus): BusObj {
    const len = vb.len;
    const Lb = len - 0.16,
      Wb = BUS_W;
    const color = PALETTE[vb.color];
    const root = new THREE.Group();
    const inner = new THREE.Group();
    root.add(inner);
    const bodyMat = std(color, 0.35, { metalness: 0.05 });
    const body = new THREE.Mesh(
      geo(`body${len}`, () => new RoundedBoxGeometry(Lb, 0.54, Wb, 3, 0.14)),
      bodyMat,
    );
    body.position.y = 0.4;
    body.castShadow = true;
    body.receiveShadow = true;
    body.userData.busId = vb.id;
    inner.add(body);
    const white = mat('white', () => std('#ffffff', 0.5));
    const stripe = new THREE.Mesh(geo(`stripe${len}`, () => new THREE.BoxGeometry(Lb - 0.12, 0.05, Wb + 0.012)), white);
    stripe.position.y = 0.31;
    inner.add(stripe);
    const glassMat = mat('glass', () => std('#1f2747', 0.12, { metalness: 0.4 }));
    const glass = new THREE.Mesh(geo(`glass${len}`, () => new RoundedBoxGeometry(Lb - 0.2, 0.21, Wb + 0.016, 2, 0.06)), glassMat);
    glass.position.y = 0.53;
    inner.add(glass);
    const roofMat = mat(`roof${vb.color}`, () => std(lighten(color, 0.32), 0.4));
    const roof = new THREE.Mesh(geo(`roof${len}`, () => new RoundedBoxGeometry(Lb - 0.12, 0.1, Wb - 0.1, 2, 0.045)), roofMat);
    roof.position.y = 0.69;
    roof.castShadow = true;
    inner.add(roof);
    // ruote
    const wheelMat = mat('wheel', () => std('#20253a', 0.7));
    const hubMat = mat('hub', () => std('#d6dbe8', 0.4));
    const wx = Lb / 2 - (len === 3 ? 0.36 : 0.28);
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) {
        const w = new THREE.Mesh(geo('wheel', () => new THREE.CylinderGeometry(0.14, 0.14, 0.12, 16)), wheelMat);
        w.rotation.x = Math.PI / 2;
        w.position.set(sx * wx, 0.14, sz * (Wb / 2 - 0.02));
        inner.add(w);
        const h = new THREE.Mesh(geo('hub', () => new THREE.CylinderGeometry(0.06, 0.06, 0.13, 12)), hubMat);
        h.rotation.x = Math.PI / 2;
        h.position.copy(w.position);
        inner.add(h);
      }
    // fari e luci posteriori
    const head = mat(`headlight${this.theme.night ? 'n' : 'd'}`, () =>
      std('#fff6c8', 0.3, { emissive: new THREE.Color('#ffe69a'), emissiveIntensity: this.theme.night ? 2.2 : 0.6 }),
    );
    const tail = mat('tail', () => std('#ff5a5a', 0.4, { emissive: new THREE.Color('#ff3b3b'), emissiveIntensity: 0.5 }));
    for (const sz of [-1, 1]) {
      const f = new THREE.Mesh(geo('lamp', () => new THREE.BoxGeometry(0.03, 0.07, 0.14)), head);
      f.position.set(Lb / 2 + 0.005, 0.26, sz * 0.25);
      inner.add(f);
      const t = new THREE.Mesh(geo('lamp', () => new THREE.BoxGeometry(0.03, 0.07, 0.14)), tail);
      t.position.set(-Lb / 2 - 0.005, 0.26, sz * 0.25);
      inner.add(t);
    }
    // freccia sul tetto (con contorno scuro)
    const arrow = new THREE.Group();
    const a = Lb / 2,
      b = Wb / 2;
    const arrowMat = mat('arrow', () => new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.4, emissive: new THREE.Color('#ffffff'), emissiveIntensity: 0.15 }));
    const inkMat = mat('ink', () => new THREE.MeshBasicMaterial({ color: INK }));
    const am = new THREE.Mesh(geo(`arrow${len}`, () => new THREE.ShapeGeometry(arrowShape(a, b))), arrowMat);
    const ao = new THREE.Mesh(geo(`arrowo${len}`, () => new THREE.ShapeGeometry(arrowShape(a, b, 1.14))), inkMat);
    am.rotation.x = ao.rotation.x = -Math.PI / 2;
    am.position.y = 0.747;
    ao.position.y = 0.745;
    ao.position.x = -0.02;
    arrow.add(ao, am);
    inner.add(arrow);
    // posti a sedere (visibili quando il bus è nello stallo)
    const seats: THREE.Mesh[] = [];
    const cols = vb.cap / 2;
    for (let i = 0; i < cols; i++)
      for (const v of [-0.19, 0.19]) {
        const s = new THREE.Mesh(geo('seat', () => new THREE.SphereGeometry(0.085, 12, 10)), inkMat);
        s.position.set(-0.78 * a + (1.56 * a * (i + 0.5)) / cols, 0.77, v);
        s.visible = false;
        inner.add(s);
        seats.push(s);
      }
    this.world.add(root);
    return { root, inner, bodyMat, pick: body, arrow, seats, len };
  }

  private makeGarage(g: VGarage): GarageObj {
    // un edificio vero, ben diverso dai bus: muri chiari, tetto rosso, saracinesca a strisce
    const root = new THREE.Group();
    const body = new THREE.Mesh(geo('garage', () => new RoundedBoxGeometry(1.86, 1.15, 0.92, 3, 0.08)), mat('gwall', () => std('#efe6d2', 0.8)));
    body.position.y = 0.575;
    body.castShadow = body.receiveShadow = true;
    root.add(body);
    const base = new THREE.Mesh(geo('gbase', () => new THREE.BoxGeometry(1.9, 0.14, 0.96)), mat('gbase', () => std('#b7ab95', 0.9)));
    base.position.y = 0.07;
    root.add(base);
    // tetto a due falde
    const roof = new THREE.Mesh(
      geo('groof', () => {
        const s = new THREE.Shape();
        s.moveTo(-0.56, 0);
        s.lineTo(0, 0.36);
        s.lineTo(0.56, 0);
        s.closePath();
        const gg = new THREE.ExtrudeGeometry(s, { depth: 2.02, bevelEnabled: false });
        gg.translate(0, 0, -1.01);
        gg.rotateY(Math.PI / 2);
        return gg;
      }),
      mat('groofm', () => std('#e0533d', 0.55)),
    );
    roof.position.y = 1.13;
    roof.castShadow = true;
    root.add(roof);
    // saracinesca sul lato d'uscita
    const door = new THREE.Mesh(geo('door', () => new THREE.BoxGeometry(0.04, 0.82, 0.7)), mat('door', () => std('#4a5070', 0.7)));
    door.position.set(0.93, 0.5, 0);
    root.add(door);
    const slat = mat('slat', () => std('#353a55', 0.8));
    for (let i = 0; i < 5; i++) {
      const r = new THREE.Mesh(geo('slat', () => new THREE.BoxGeometry(0.05, 0.025, 0.7)), slat);
      r.position.set(0.94, 0.2 + i * 0.15, 0);
      root.add(r);
    }
    const tri = new THREE.Mesh(
      geo('gtri', () => {
        const s = new THREE.Shape();
        s.moveTo(0.3, 0);
        s.lineTo(-0.1, 0.3);
        s.lineTo(-0.1, -0.3);
        s.closePath();
        return new THREE.ShapeGeometry(s);
      }),
      mat('gtrim', () => std('#ffd23f', 0.5)),
    );
    tri.rotation.x = -Math.PI / 2;
    tri.position.set(1.2, 0.06, 0);
    root.add(tri);
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture(0), depthTest: false }));
    label.scale.set(0.8, 0.8, 1);
    label.position.set(-0.1, 1.85, 0);
    label.renderOrder = 10;
    root.add(label);
    root.position.copy(V(g.x, g.y));
    root.rotation.y = -g.a;
    this.world.add(root);
    return { root, label, count: -1 };
  }

  // ---------- persone ----------
  private buildPeople() {
    const cap = 220;
    const m = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.55 });
    this.bodies = new THREE.InstancedMesh(geo('pbody', () => new THREE.CapsuleGeometry(0.12, 0.16, 4, 10)), m, cap);
    this.heads = new THREE.InstancedMesh(geo('phead', () => new THREE.SphereGeometry(0.105, 14, 12)), m, cap);
    for (const im of [this.bodies, this.heads]) {
      for (let i = 0; i < cap; i++) im.setColorAt(i, this.tmpC.set('#ffffff'));
      im.castShadow = true;
      im.count = 0;
      im.frustumCulled = false;
      this.world.add(im);
    }
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.17, 0.23, 24), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.9 }));
    this.ring.rotation.x = -Math.PI / 2;
    this.world.add(this.ring);
    const pm = new THREE.MeshBasicMaterial({ color: '#ffffff' });
    this.parts = new THREE.InstancedMesh(geo('part', () => new THREE.SphereGeometry(1, 8, 6)), pm, 240);
    for (let i = 0; i < 240; i++) this.parts.setColorAt(i, this.tmpC.set('#ffffff'));
    this.parts.count = 0;
    this.parts.frustumCulled = false;
    this.world.add(this.parts);
  }

  private personColors = PALETTE.map((c) => new THREE.Color(c));
  private headColors = PALETTE.map((c) => lighten(c, 0.45));

  private putPerson(i: number, x: number, y: number, z: number, color: number, s: number) {
    this.tmpS.set(s, s, s);
    this.tmpQ.identity();
    this.tmpM.compose(this.tmpP.copy(V(x, y, 0.14 + z + 0.2 * s)), this.tmpQ, this.tmpS);
    this.bodies.setMatrixAt(i, this.tmpM);
    this.bodies.setColorAt(i, this.personColors[color]);
    this.tmpM.compose(this.tmpP.copy(V(x, y, 0.14 + z + 0.47 * s)), this.tmpQ, this.tmpS);
    this.heads.setMatrixAt(i, this.tmpM);
    this.heads.setColorAt(i, this.headColors[color]);
  }

  // ---------- fotogramma ----------
  render(now: number) {
    const tl = this.tl;
    const dt = tl.tick(now);

    // tremolio della camera dopo un urto
    const st = now - tl.shakeT;
    this.camera.position.copy(this.camBase);
    if (st > 0 && st < 0.25) {
      const m = 0.06 * (1 - st / 0.25);
      this.camera.position.x += Math.sin(st * 90) * m;
      this.camera.position.y += Math.cos(st * 70) * m * 0.6;
    }

    // stalli liberi che "respirano", rossi quando si perde
    const lost = now - tl.lostAt < 1.6 ? 0.5 + 0.5 * Math.sin((now - tl.lostAt) * 14) : 0;
    this.bays.forEach((m, i) => {
      const mm = m.material as THREE.MeshBasicMaterial;
      if (lost > 0) {
        mm.color.set('#ff4d4d');
        mm.opacity = 0.2 + 0.4 * lost;
        m.visible = true;
      } else {
        mm.color.set('#3a86ff');
        m.visible = !tl.bayBusy(i, now);
        mm.opacity = 0.18 + 0.14 * Math.sin(now * 3 + i);
      }
    });

    // bus
    for (const vb of tl.buses) {
      const o = this.buses.get(vb.id)!;
      const p = tl.pose(vb, now);
      this.placeBus(o, vb, p, now);
    }

    // garage: numero dei bus ancora dentro
    for (const g of tl.garages) {
      const o = this.garages.get(g.id)!;
      const n = g.cars.filter((id) => tl.buses[id].emergeAt > now).length;
      if (n !== o.count) {
        o.count = n;
        const sm = o.label.material as THREE.SpriteMaterial;
        sm.map?.dispose();
        sm.map = labelTexture(n);
        sm.needsUpdate = true;
      }
    }

    // coda di passeggeri e passeggeri in volo
    const target = tl.queueLeft(now);
    let k = 0;
    const q = tl.level.queue;
    const startK = Math.max(tl.qiBase, Math.floor(tl.queueShift) - 1);
    this.ring.visible = false;
    for (let i = startK; i < q.length && k < 180; i++) {
      if (i < target) continue;
      const pos = tl.queuePos(i - tl.queueShift);
      if (!pos) break;
      const bob = tl.walking ? Math.abs(Math.sin(now * 16 + i * 0.9)) * 0.1 : Math.abs(Math.sin(now * 3 + i * 0.7)) * 0.025;
      const isHead = i === target;
      this.putPerson(k++, pos[0], pos[1], bob, q[i], isHead ? 1.15 : 1);
      if (isHead) {
        this.ring.visible = true;
        this.ring.position.copy(V(pos[0], pos[1], 0.15));
      }
    }
    const head = tl.queuePos(0)!;
    for (const f of tl.flights) {
      if (now < f.t0 || k >= 218) continue;
      const u = Math.min(1, (now - f.t0) / (f.t1 - f.t0));
      const e = 1 - (1 - u) * (1 - u);
      const p = tl.pose(tl.buses[f.busId], now);
      const x = head[0] + (p.x - head[0]) * e;
      const y = head[1] + (p.y - head[1]) * e;
      const z = (0.62 + p.z) * u + Math.sin(Math.PI * u) * 1.4;
      this.putPerson(k++, x, y, z, f.color, 1.05 - 0.35 * u);
    }
    for (const im of [this.bodies, this.heads]) {
      im.count = k;
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    }

    // particelle
    let n = 0;
    for (const pt of tl.particles) {
      const t = now - pt.t0;
      if (t < 0 || n >= 240) continue;
      const u = t / pt.life;
      const z = pt.kind === 'spark' ? pt.z + pt.vz * t - 9 * t * t : pt.z + pt.vz * t;
      const s = pt.kind === 'spark' ? pt.size * (1 - u * 0.6) : pt.size * (0.6 + u * 1.4) * (1 - u * 0.5);
      this.tmpS.set(s, s, s);
      this.tmpQ.identity();
      this.tmpM.compose(this.tmpP.copy(V(pt.x + pt.vx * t, pt.y + pt.vy * t, Math.max(0.05, z))), this.tmpQ, this.tmpS);
      this.parts.setMatrixAt(n, this.tmpM);
      this.parts.setColorAt(n, this.tmpC.set(pt.kind === 'spark' ? (n % 2 ? '#fff6b0' : '#ffd23f') : '#ffffff'));
      n++;
    }
    this.parts.count = n;
    this.parts.instanceMatrix.needsUpdate = true;
    if (this.parts.instanceColor) this.parts.instanceColor.needsUpdate = true;

    this.renderer.render(this.scene, this.camera);
    this.drawConfetti(now, dt);
  }

  private placeBus(o: BusObj, vb: VBus, p: Pose, now: number) {
    const visible = p.phase !== 'gone' && p.phase !== 'hidden' && p.alpha > 0.02;
    o.root.visible = visible;
    if (!visible) return;
    o.root.position.copy(V(p.x, p.y, p.z));
    o.root.rotation.y = -p.a;
    const fade = p.phase === 'out' ? p.alpha : 1;
    o.inner.scale.set(p.pop * fade, p.hk * fade, p.pop * fade);
    const inStall = p.phase === 'stall' || p.phase === 'out';
    o.arrow.visible = !inStall;
    // posti: pieni del colore del bus, vuoti scuri; l'ultimo seduto fa "pop"
    if (inStall) {
      const { n, last } = this.tl.seated(vb, now);
      const full = mat(`seat${vb.color}`, () => std(lighten(PALETTE[vb.color], 0.55), 0.5));
      const empty = mat('seatEmpty', () => new THREE.MeshBasicMaterial({ color: darken(PALETTE[vb.color], 0.75) }));
      o.seats.forEach((s, i) => {
        s.visible = true;
        s.material = i < n ? full : empty;
        const pop = i === n - 1 && now - last < 0.2 ? 1 + 0.7 * (1 - (now - last) / 0.2) : 1;
        s.scale.setScalar(i < n ? pop : 0.7);
      });
    } else if (o.seats[0]?.visible) o.seats.forEach((s) => (s.visible = false));
    // urto: lampo rosso; aiuto: bagliore bianco pulsante
    const ft = now - vb.flashAt;
    const em = o.bodyMat.emissive;
    if (ft > 0 && ft < 0.4) {
      em.set('#ff2020');
      o.bodyMat.emissiveIntensity = 0.9 * (1 - ft / 0.4);
    } else if (now < vb.hintUntil && p.phase === 'lot') {
      em.set('#ffffff');
      o.bodyMat.emissiveIntensity = 0.25 + 0.25 * Math.sin(now * 10);
    } else o.bodyMat.emissiveIntensity = 0;
    if (p.phase === 'out' && Math.random() < 0.5) {
      const back = (vb.len - 0.16) / 2 + 0.1;
      this.tl.spawnPuff(p.x - Math.cos(p.a) * back, p.y - Math.sin(p.a) * back, p.a, now);
    }
  }

  // ---------- coriandoli (overlay 2D) ----------
  private drawConfetti(now: number, dt: number) {
    const ctx = this.fx;
    if (this.tl.celebrateAt !== this.lastCelebrate && this.tl.celebrateAt > 0) {
      this.lastCelebrate = this.tl.celebrateAt;
      for (let i = 0; i < 150; i++)
        this.confetti.push({
          x: this.cssW * (0.15 + Math.random() * 0.7),
          y: this.cssH * 0.42 + (Math.random() - 0.5) * 40,
          vx: (Math.random() - 0.5) * 520,
          vy: -300 - Math.random() * 520,
          rot: Math.random() * 6,
          vr: (Math.random() - 0.5) * 14,
          color: PALETTE[i % PALETTE.length],
          t0: now + Math.random() * 0.12,
          w: 6 + Math.random() * 6,
        });
    }
    if (!this.confetti.length && !this.fxDirty) return;
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    this.fxDirty = this.confetti.length > 0;
    this.confetti = this.confetti.filter((q) => now < q.t0 + 3 && q.y < this.cssH + 40);
    for (const q of this.confetti) {
      if (now < q.t0) continue;
      q.vy += 900 * dt;
      q.vx *= 1 - 1.2 * dt;
      q.x += q.vx * dt;
      q.y += q.vy * dt;
      q.rot += q.vr * dt;
      ctx.save();
      ctx.translate(q.x, q.y);
      ctx.rotate(q.rot);
      ctx.scale(1, Math.abs(Math.cos(q.rot * 1.7)) * 0.8 + 0.2);
      ctx.fillStyle = q.color;
      ctx.fillRect(-q.w / 2, -q.w * 0.3, q.w, q.w * 0.6);
      ctx.restore();
    }
  }
  private fxDirty = false;

  // ---------- input ----------
  screenOf(x: number, y: number, z: number): [number, number] {
    const q = V(x, y, z).project(this.camera);
    return [((q.x + 1) / 2) * this.cssW, ((1 - q.y) / 2) * this.cssH];
  }

  hit(sx: number, sy: number, now: number): number | null {
    const tl = this.tl;
    const ndc = new THREE.Vector2((sx / this.cssW) * 2 - 1, -(sy / this.cssH) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    const picks: THREE.Object3D[] = [];
    for (const vb of tl.buses) if (tl.tappable(vb, now)) picks.push(this.buses.get(vb.id)!.pick);
    const hits = this.ray.intersectObjects(picks, false);
    if (hits.length) return hits[0].object.userData.busId as number;
    // tolleranza: il bus più vicino al dito, entro 30 px
    let best: number | null = null;
    let bd = 30;
    for (const vb of tl.buses) {
      if (!tl.tappable(vb, now)) continue;
      const [px, py] = this.screenOf(vb.lotX, vb.lotY, 0.4);
      const d = Math.hypot(px - sx, py - sy);
      if (d < bd) {
        bd = d;
        best = vb.id;
      }
    }
    return best;
  }
}

// ---------- decorazioni ----------
function roundTree(s: number, leaf: string, rng: () => number) {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(geo('trunk', () => new THREE.CylinderGeometry(0.08, 0.11, 0.6, 8)), mat('trunk', () => std('#8a5a3c', 0.9)));
  trunk.position.y = 0.3;
  trunk.castShadow = true;
  g.add(trunk);
  const lm = mat(`leaf${leaf}`, () => std(leaf, 0.75));
  const blobs: [number, number, number, number][] = [
    [0, 0.85, 0, 0.42],
    [0.22, 0.7, 0.1, 0.3],
    [-0.2, 0.72, -0.08, 0.32],
  ];
  for (const [x, y, z, r] of blobs) {
    const b = new THREE.Mesh(geo('blob', () => new THREE.IcosahedronGeometry(1, 2)), lm);
    b.scale.setScalar(r * (0.9 + rng() * 0.2));
    b.position.set(x, y, z);
    b.castShadow = true;
    g.add(b);
  }
  g.scale.setScalar(s);
  return g;
}

function bush(s: number, rng: () => number) {
  const g = new THREE.Group();
  const lm = mat('bush', () => std('#3f9a4f', 0.8));
  for (let i = 0; i < 3; i++) {
    const b = new THREE.Mesh(geo('blob', () => new THREE.IcosahedronGeometry(1, 2)), lm);
    b.scale.setScalar(0.28 + rng() * 0.08);
    b.position.set((i - 1) * 0.28, 0.22, (rng() - 0.5) * 0.2);
    b.castShadow = true;
    g.add(b);
  }
  const fm = mat('flower', () => std('#ff8fb1', 0.6));
  for (let i = 0; i < 4; i++) {
    const f = new THREE.Mesh(geo('flower', () => new THREE.SphereGeometry(0.05, 6, 5)), fm);
    f.position.set((rng() - 0.5) * 0.7, 0.35 + rng() * 0.15, (rng() - 0.5) * 0.4);
    g.add(f);
  }
  g.scale.setScalar(s * 1.3);
  return g;
}

function pine(s: number, snowy: boolean) {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(geo('trunk', () => new THREE.CylinderGeometry(0.08, 0.11, 0.6, 8)), mat('trunk', () => std('#8a5a3c', 0.9)));
  trunk.position.y = 0.2;
  g.add(trunk);
  const green = mat('pine', () => std('#2f7d5b', 0.8));
  const snow = mat('snowcap', () => std('#ffffff', 0.9));
  [0.55, 0.85, 1.12].forEach((y, i) => {
    const r = 0.5 - i * 0.12;
    const c = new THREE.Mesh(geo(`cone${i}`, () => new THREE.ConeGeometry(r, 0.55, 10)), green);
    c.position.y = y;
    c.castShadow = true;
    g.add(c);
    if (snowy) {
      const cap = new THREE.Mesh(geo(`capc${i}`, () => new THREE.ConeGeometry(r * 0.55, 0.26, 10)), snow);
      cap.position.y = y + 0.16;
      g.add(cap);
    }
  });
  g.scale.setScalar(s);
  return g;
}

function snowman(s: number) {
  const g = new THREE.Group();
  const snow = mat('snowman', () => std('#ffffff', 0.85));
  [
    [0.32, 0.3],
    [0.24, 0.78],
    [0.17, 1.13],
  ].forEach(([r, y]) => {
    const b = new THREE.Mesh(geo('ball', () => new THREE.SphereGeometry(1, 16, 12)), snow);
    b.scale.setScalar(r);
    b.position.y = y;
    b.castShadow = true;
    g.add(b);
  });
  const nose = new THREE.Mesh(geo('nose', () => new THREE.ConeGeometry(0.04, 0.2, 8)), mat('carrot', () => std('#ff8a2b', 0.6)));
  nose.rotation.z = -Math.PI / 2;
  nose.position.set(0.24, 1.13, 0);
  g.add(nose);
  const hat = new THREE.Mesh(geo('hat', () => new THREE.CylinderGeometry(0.12, 0.12, 0.18, 12)), mat('hat', () => std('#2b2f45', 0.7)));
  hat.position.y = 1.36;
  g.add(hat);
  g.scale.setScalar(s * 0.9);
  return g;
}

function palm(s: number, rng: () => number) {
  const g = new THREE.Group();
  const bark = mat('palmbark', () => std('#a8794e', 0.9));
  let x = 0;
  for (let i = 0; i < 5; i++) {
    const seg = new THREE.Mesh(geo('palmseg', () => new THREE.CylinderGeometry(0.07, 0.09, 0.32, 8)), bark);
    x += 0.04;
    seg.position.set(x, 0.16 + i * 0.3, 0);
    seg.rotation.z = -0.12;
    seg.castShadow = true;
    g.add(seg);
  }
  const leaf = mat('palmleaf', () => std('#3fae5d', 0.7, { side: THREE.DoubleSide }));
  for (let i = 0; i < 6; i++) {
    const l = new THREE.Mesh(geo('palmleafg', () => new THREE.SphereGeometry(1, 10, 6)), leaf);
    l.scale.set(0.55, 0.05, 0.16);
    const a = (i / 6) * Math.PI * 2 + rng() * 0.3;
    l.position.set(x + Math.cos(a) * 0.4, 1.58, Math.sin(a) * 0.4);
    l.rotation.y = -a;
    l.rotation.z = -0.35;
    l.castShadow = true;
    g.add(l);
  }
  g.scale.setScalar(s);
  return g;
}

function umbrella(s: number, rng: () => number) {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(geo('upole', () => new THREE.CylinderGeometry(0.025, 0.025, 1.1, 6)), mat('upole', () => std('#ffffff', 0.5)));
  pole.position.y = 0.55;
  g.add(pole);
  const cols = ['#ff4d4d', '#3a86ff', '#ffd23f', '#ff70c4'];
  const top = new THREE.Mesh(geo('utop', () => new THREE.ConeGeometry(0.62, 0.28, 12)), mat(`utop${cols[0]}`, () => std(cols[Math.floor(rng() * 4)], 0.6)));
  top.position.y = 1.15;
  top.castShadow = true;
  g.add(top);
  g.scale.setScalar(s);
  return g;
}

function lamp(s: number) {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(geo('lpole', () => new THREE.CylinderGeometry(0.04, 0.05, 1.5, 8)), mat('lpole', () => std('#3a405c', 0.6)));
  pole.position.y = 0.75;
  pole.castShadow = true;
  g.add(pole);
  const bulb = new THREE.Mesh(
    geo('bulb', () => new THREE.SphereGeometry(0.13, 12, 10)),
    mat('bulb', () => std('#ffe9a8', 0.3, { emissive: new THREE.Color('#ffd27a'), emissiveIntensity: 2.5 })),
  );
  bulb.position.y = 1.55;
  g.add(bulb);
  g.scale.setScalar(s);
  return g;
}

function cactus(s: number, rng: () => number) {
  const g = new THREE.Group();
  const cm = mat('cactus', () => std('#4f9a5a', 0.75));
  const main = new THREE.Mesh(geo('cmain', () => new THREE.CapsuleGeometry(0.14, 0.8, 4, 10)), cm);
  main.position.y = 0.55;
  main.castShadow = true;
  g.add(main);
  for (const side of [-1, 1]) {
    if (rng() < 0.3) continue;
    const arm = new THREE.Mesh(geo('carm', () => new THREE.CapsuleGeometry(0.08, 0.3, 4, 8)), cm);
    arm.position.set(side * 0.24, 0.65 + rng() * 0.2, 0);
    arm.castShadow = true;
    g.add(arm);
  }
  g.scale.setScalar(s);
  return g;
}

function rock(s: number, rng: () => number) {
  const r = new THREE.Mesh(geo('rock', () => new THREE.DodecahedronGeometry(0.4, 0)), mat('rock', () => std('#b9835a', 0.95)));
  r.scale.set(s * (1 + rng() * 0.4), s * 0.7, s);
  r.position.y = 0.15;
  r.castShadow = true;
  const g = new THREE.Group();
  g.add(r);
  return g;
}

function labelTexture(n: number) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const g = cv.getContext('2d')!;
  g.beginPath();
  g.arc(64, 64, 52, 0, Math.PI * 2);
  g.fillStyle = n ? '#ffd23f' : '#c9cede';
  g.fill();
  g.lineWidth = 9;
  g.strokeStyle = INK;
  g.stroke();
  g.fillStyle = INK;
  g.font = "72px 'Lilita One', 'Arial Rounded MT Bold', system-ui, sans-serif";
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(n), 64, 70);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** libera geometrie e materiali non condivisi */
function disposeTree(root: THREE.Object3D) {
  const shared = new Set<unknown>([...geoCache.values(), ...matCache.values()]);
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry && !shared.has(m.geometry)) m.geometry.dispose();
    const ms = m.material;
    if (ms) for (const x of Array.isArray(ms) ? ms : [ms]) if (!shared.has(x)) x.dispose();
  });
}
