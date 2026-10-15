// Stato visivo (animazioni a timeline) e disegno su Canvas 2D.
// La logica di gioco è istantanea: qui ogni evento diventa movimento nel tempo.
import { Camera } from './camera';
import { Level, busCells, toWorld } from '../game/types';
import { GameEvent, GameState } from '../game/engine';
import { mulberry32 } from '../game/rng';

/** Colori dei bus e dei passeggeri: saturi e ben distinti tra loro. */
export const PALETTE = ['#ff4d4d', '#3a86ff', '#ffd23f', '#3ecf6a', '#9b5de5', '#ff9f1c', '#ff70c4', '#17c3b2'];
export const OUTLINE = '#1d2340';

const C = {
  grassA: '#a5dc78',
  grassB: '#86c862',
  asphalt: '#4a5175',
  asphaltDark: '#3c4263',
  lot: '#9aa1c0',
  curb: '#eef0f6',
  platform: '#f3ecdc',
  sidewalk: '#e7dfcc',
  bayLine: '#ffc83d',
  glass: '#22294a',
};

const SPEED = 15; // celle al secondo
const FLY = 0.3; // salto del passeggero
const BOARD_GAP = 0.06;
const DIR_ANG = [-Math.PI / 2, 0, Math.PI / 2, Math.PI];
const BUS_H = 0.74;
const BUS_W = 0.8;

// ---------- percorsi con curve vere e accelerazione ----------
type PathPt = { x: number; y: number; a: number; d: number };
interface Motion {
  pts: PathPt[];
  t0: number;
  T: number;
  total: number;
  easeIn: boolean;
  easeOut: boolean;
  /** volo della gru: arco in altezza e rotazione verso lo stallo */
  air?: { a0: number; a1: number };
}

function buildPath(raw: [number, number][]): PathPt[] {
  const p: [number, number][] = [];
  for (const q of raw) {
    const l = p[p.length - 1];
    if (!l || Math.hypot(q[0] - l[0], q[1] - l[1]) > 1e-6) p.push(q);
  }
  const ang = (i: number) => Math.atan2(p[i + 1][1] - p[i][1], p[i + 1][0] - p[i][0]);
  const len = (i: number) => Math.hypot(p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1]);
  if (p.length < 2) return [{ x: p[0][0], y: p[0][1], a: 0, d: 0 }];
  const out: { x: number; y: number; a: number }[] = [{ x: p[0][0], y: p[0][1], a: ang(0) }];
  for (let i = 1; i < p.length - 1; i++) {
    const r = Math.min(0.75, len(i - 1) / 2, len(i) / 2);
    const aIn = ang(i - 1),
      aOut = ang(i);
    const ax = p[i][0] - Math.cos(aIn) * r,
      ay = p[i][1] - Math.sin(aIn) * r;
    const bx = p[i][0] + Math.cos(aOut) * r,
      by = p[i][1] + Math.sin(aOut) * r;
    // curva di Bézier quadratica sull'angolo
    for (let k = 0; k <= 6; k++) {
      const u = k / 6;
      const x = (1 - u) * (1 - u) * ax + 2 * (1 - u) * u * p[i][0] + u * u * bx;
      const y = (1 - u) * (1 - u) * ay + 2 * (1 - u) * u * p[i][1] + u * u * by;
      const tx = 2 * (1 - u) * (p[i][0] - ax) + 2 * u * (bx - p[i][0]);
      const ty = 2 * (1 - u) * (p[i][1] - ay) + 2 * u * (by - p[i][1]);
      out.push({ x, y, a: Math.atan2(ty, tx) });
    }
  }
  const n = p.length - 1;
  out.push({ x: p[n][0], y: p[n][1], a: ang(n - 1) });
  const pts: PathPt[] = [];
  let d = 0;
  out.forEach((q, i) => {
    if (i) d += Math.hypot(q.x - out[i - 1].x, q.y - out[i - 1].y);
    pts.push({ ...q, d });
  });
  return pts;
}

function motion(raw: [number, number][], t0: number, minDur: number, easeIn: boolean, easeOut: boolean): Motion {
  const pts = buildPath(raw);
  const total = pts[pts.length - 1].d;
  const T = Math.max(total / SPEED + (easeIn ? 0.14 : 0) + (easeOut ? 0.12 : 0), minDur, 0.05);
  return { pts, t0, T, total, easeIn, easeOut };
}

function ease(u: number, ei: boolean, eo: boolean) {
  if (ei && eo) return 0.35 * u + 0.65 * u * u * (3 - 2 * u);
  if (ei) return 0.3 * u + 0.7 * u * u;
  if (eo) return 0.3 * u + 0.7 * (1 - (1 - u) * (1 - u));
  return u;
}

function lerpAngle(a: number, b: number, u: number) {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return a + d * u;
}

function sampleMotion(m: Motion, t: number) {
  const u = Math.max(0, Math.min(1, (t - m.t0) / m.T));
  const d = m.total * ease(u, m.easeIn, m.easeOut);
  const pts = m.pts;
  let i = 0;
  while (i < pts.length - 2 && pts[i + 1].d < d) i++;
  const p0 = pts[i],
    p1 = pts[Math.min(i + 1, pts.length - 1)];
  const k = p1.d > p0.d ? (d - p0.d) / (p1.d - p0.d) : 0;
  const a = m.air ? lerpAngle(m.air.a0, m.air.a1, Math.min(1, u * 1.4)) : lerpAngle(p0.a, p1.a, k);
  return { x: p0.x + (p1.x - p0.x) * k, y: p0.y + (p1.y - p0.y) * k, a, u };
}

// ---------- colori ----------
const shadeCache = new Map<string, string>();
export function shade(hex: string, amt: number): string {
  const key = hex + amt.toFixed(3);
  const hit = shadeCache.get(key);
  if (hit) return hit;
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255,
    g = (n >> 8) & 255,
    b = n & 255;
  // scurisce verso il blu notte del contorno, schiarisce verso il bianco
  const [tr, tg, tb] = amt >= 0 ? [29, 35, 64] : [255, 255, 255];
  const k = Math.abs(amt);
  r += (tr - r) * k;
  g += (tg - g) * k;
  b += (tb - b) * k;
  const out = `rgb(${r | 0},${g | 0},${b | 0})`;
  shadeCache.set(key, out);
  return out;
}

// ---------- tipi visivi ----------
type Phase = 'lot' | 'in' | 'stall' | 'out' | 'gone' | 'hidden';

type LBox = { minX: number; maxX: number; minY: number; maxY: number };

interface VBus {
  id: number;
  color: number;
  len: number;
  cap: number;
  lotX: number;
  lotY: number;
  lotA: number;
  slot: number;
  inM: Motion | null;
  outM: Motion | null;
  gone: boolean;
  filledBase: number;
  lands: number[];
  fullAt: number;
  bump: { t0: number; dur: number; dist: number } | null;
  shakeAt: number;
  flashAt: number;
  hintUntil: number;
  dropAt: number;
  hopAt: number;
  /** bus nei garage: quando esce (Infinity = ancora dentro) */
  emergeAt: number;
  next: number;
  garageX: number;
  garageY: number;
  /** ingombro nella griglia, per l'ordine di disegno */
  lb: LBox;
}

interface VGarage {
  id: number;
  x: number;
  y: number;
  a: number;
  lb: LBox;
  cars: number[];
}

interface Pose {
  x: number;
  y: number;
  a: number;
  phase: Phase;
  alpha: number;
  z: number; // sollevamento
  hk: number; // schiacciamento verticale
  pop: number; // scala orizzontale
}

interface Flight {
  color: number;
  t0: number;
  t1: number;
  busId: number;
}

interface Particle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  t0: number;
  life: number;
  size: number;
  color: string;
  kind: 'puff' | 'spark';
}

interface Confetti {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vr: number;
  color: string;
  t0: number;
  w: number;
}

interface Drawable {
  lb?: LBox;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  depth: number;
  draw: () => void;
}

export class Scene {
  cam = new Camera(0.14, 0.68, 0.85);
  ctx!: CanvasRenderingContext2D;
  buses: VBus[] = [];
  garages: VGarage[] = [];
  flights: Flight[] = [];
  boardStarts: number[] = [];
  particles: Particle[] = [];
  confetti: Confetti[] = [];
  qiBase = 0;
  lastBoard = 0;
  slotFreeAt: number[] = [];
  bayOwner: number[] = [];
  settleAt = 0;
  K = 5;
  queueShift = 0;
  lostAt = -9;
  private shakeT = -9;
  private lastFrame = 0;
  private cssW = 0;
  private cssH = 0;
  private dpr = 1;
  private bg: HTMLCanvasElement | null = null;
  private bgKey = '';

  constructor(public level: Level) {}

  // ---------- geometria del mondo (in celle) ----------
  get w() {
    return this.level.w;
  }
  get h() {
    return this.level.h;
  }
  bayW() {
    return (this.w + 2) / this.K;
  }
  bayX(i: number) {
    return -1 + this.bayW() * (i + 0.5);
  }
  stallCY(len: number) {
    return -1.15 - len / 2;
  }
  readonly laneY = -4.75;
  readonly rowsY = [-6.0, -6.78];
  readonly spacing = 0.5;
  perRow() {
    return Math.floor((this.w + 1.5) / this.spacing) + 1;
  }
  queuePos(k: number): [number, number] | null {
    const per = this.perRow();
    if (k < 0) return [this.w + 0.75 - k * this.spacing, this.rowsY[0]];
    const row = Math.floor(k / per);
    const i = k - row * per;
    if (row > 1) return null;
    if (row === 0) return [this.w + 0.75 - i * this.spacing, this.rowsY[0]];
    return [-0.75 + i * this.spacing, this.rowsY[1]];
  }

  resize(cssW: number, cssH: number, top: number, bottom: number, dpr: number) {
    this.cssW = cssW;
    this.cssH = cssH;
    this.dpr = dpr;
    const pad = 6;
    this.cam.fit(-1.2, -7.3, this.w + 1.2, this.h + 1.15, 0.8, pad, top, cssW - pad * 2, cssH - top - bottom);
    this.bgKey = '';
  }

  // ---------- stato ----------
  rebuild(state: GameState, now: number, intro = false) {
    this.K = state.slots.length;
    const L = this.level;
    const nextOf = new Map<number, number>();
    for (const b of L.buses) if ((b.prev ?? -1) >= 0) nextOf.set(b.prev!, b.id);
    this.garages = L.garages.map((g) => {
      const lb = boxOf(g);
      const [x, y] = toWorld(L, (lb.minX + lb.maxX) / 2, (lb.minY + lb.maxY) / 2);
      return { id: g.id, x, y, a: DIR_ANG[g.dir] + L.theta, lb, cars: g.cars };
    });
    this.buses = L.buses.map((b) => {
      const lb = boxOf(b);
      const [lotX, lotY] = toWorld(L, (lb.minX + lb.maxX) / 2, (lb.minY + lb.maxY) / 2);
      const g = b.garage !== undefined ? this.garages[b.garage] : null;
      const prev = b.prev ?? -1;
      return {
        id: b.id,
        color: b.color,
        len: b.len,
        cap: b.cap,
        lotX,
        lotY,
        lotA: DIR_ANG[b.dir] + L.theta,
        slot: -1,
        inM: null,
        outM: null,
        gone: false,
        filledBase: 0,
        lands: [],
        fullAt: Infinity,
        bump: null,
        shakeAt: -9,
        flashAt: -9,
        hintUntil: 0,
        dropAt: intro ? now + 0.1 + lotY * 0.05 + lotX * 0.025 : -9,
        hopAt: -9,
        emergeAt: prev < 0 || state.removed[prev] ? -9 : Infinity,
        next: nextOf.get(b.id) ?? -1,
        garageX: g ? g.x : lotX,
        garageY: g ? g.y : lotY,
        lb,
      };
    });
    state.slots.forEach((sb, i) => {
      if (!sb) return;
      const vb = this.buses[sb.id];
      vb.slot = i;
      vb.inM = motion([[this.bayX(i), this.stallCY(vb.len)]], -10, 0, false, false);
      vb.filledBase = sb.filled;
    });
    for (const vb of this.buses) if (state.removed[vb.id] && vb.slot < 0) vb.gone = true;
    this.flights = [];
    this.boardStarts = [];
    this.particles = [];
    this.qiBase = state.qi;
    this.queueShift = state.qi;
    this.lastBoard = now;
    this.slotFreeAt = new Array(this.K).fill(0);
    this.bayOwner = state.slots.map((sb) => (sb ? sb.id : -1));
    this.settleAt = intro ? now + 1.2 : now;
    this.lostAt = -9;
  }

  setStalls(k: number) {
    this.K = k;
    while (this.slotFreeAt.length < k) this.slotFreeAt.push(0);
    while (this.bayOwner.length < k) this.bayOwner.push(-1);
    this.bgKey = '';
  }

  arriveAt(vb: VBus) {
    return vb.inM ? vb.inM.t0 + vb.inM.T : Infinity;
  }

  apply(events: GameEvent[], now: number, lifted = false) {
    for (const e of events) {
      const vb = this.buses[e.id];
      if (e.type === 'enter') {
        if (vb.next >= 0) this.buses[vb.next].emergeAt = now + (lifted ? 0.6 : 0.22);
        let bay = -1;
        for (let i = 0; i < this.K; i++)
          if (this.bayOwner[i] < 0 && (bay < 0 || this.slotFreeAt[i] < this.slotFreeAt[bay])) bay = i;
        if (bay < 0) bay = e.slot;
        this.bayOwner[bay] = vb.id;
        vb.slot = bay;
        vb.bump = null;
        vb.hopAt = now;
        const bx = this.bayX(bay);
        const cy = this.stallCY(vb.len);
        const minDur = Math.max(0, this.slotFreeAt[bay] + 0.05 - now);
        if (lifted) {
          // la gru lo solleva e lo porta in volo dritto allo stallo
          vb.inM = motion([[vb.lotX, vb.lotY], [bx, cy]], now + 0.05, Math.max(minDur, 1.1), true, true);
          vb.inM.air = { a0: vb.lotA, a1: -Math.PI / 2 };
        } else {
          vb.inM = motion(this.exitRoute(vb.lotX, vb.lotY, vb.lotA, bx, cy), now + 0.06, minDur, true, true);
        }
        this.settleAt = Math.max(this.settleAt, this.arriveAt(vb));
      } else if (e.type === 'board') {
        const backlog = this.boardStarts.filter((t) => t > now).length;
        const gap = Math.max(0.024, BOARD_GAP - backlog * 0.004);
        const t0 = Math.max(now, this.arriveAt(vb) + 0.08, this.lastBoard + gap);
        this.lastBoard = t0;
        this.boardStarts.push(t0);
        this.flights.push({ color: e.color, t0, t1: t0 + FLY, busId: e.id });
        vb.lands.push(t0 + FLY);
        this.settleAt = Math.max(this.settleAt, t0 + FLY);
      } else {
        vb.fullAt = (vb.lands[vb.lands.length - 1] ?? now) + 0.02;
        const dep = vb.fullAt + 0.24;
        const bay = vb.slot;
        this.bayOwner[bay] = -1;
        const bx = this.bayX(bay);
        const cy = this.stallCY(vb.len);
        vb.outM = motion(
          [
            [bx, cy],
            [bx, this.laneY],
            [this.w + 4, this.laneY],
          ],
          dep,
          0,
          true,
          false,
        );
        this.slotFreeAt[bay] = dep + 0.32;
        this.settleAt = Math.max(this.settleAt, dep + vb.outM.T);
      }
    }
  }

  /** Dal posto nel parcheggio, dritto fino alla strada ad anello, poi allo stallo. */
  private exitRoute(x: number, y: number, a: number, bx: number, cy: number): [number, number][] {
    const W = this.w,
      H = this.h;
    const x0 = -0.5,
      y0 = -0.5,
      x1 = W + 0.5,
      y1 = H + 0.5;
    const fx = Math.cos(a),
      fy = Math.sin(a);
    let t = Infinity;
    let side = 'top';
    const test = (tt: number, sd: string) => {
      if (tt > 1e-6 && tt < t) {
        t = tt;
        side = sd;
      }
    };
    if (fx > 1e-6) test((x1 - x) / fx, 'right');
    if (fx < -1e-6) test((x0 - x) / fx, 'left');
    if (fy > 1e-6) test((y1 - y) / fy, 'bottom');
    if (fy < -1e-6) test((y0 - y) / fy, 'top');
    const P: [number, number] = [x + fx * t, y + fy * t];
    const pts: [number, number][] = [[x, y], P];
    if (side === 'left') pts.push([x0, y0]);
    else if (side === 'right') pts.push([x1, y0]);
    else if (side === 'bottom') {
      const sx = bx < W / 2 ? x0 : x1;
      pts.push([sx, y1], [sx, y0]);
    }
    pts.push([bx, y0], [bx, cy]);
    return pts;
  }

  bump(id: number, blocker: number, dist: number, now: number) {
    const vb = this.buses[id];
    const dur = 0.2 + 0.045 * dist;
    vb.bump = { t0: now, dur, dist: dist + 0.08 };
    vb.flashAt = now;
    const hitT = now + dur / 2;
    this.buses[blocker].shakeAt = hitT;
    // scintille nel punto d'urto
    const fx = Math.cos(vb.lotA),
      fy = Math.sin(vb.lotA);
    const hx = vb.lotX + fx * ((vb.len - 0.18) / 2 + dist + 0.08);
    const hy = vb.lotY + fy * ((vb.len - 0.18) / 2 + dist + 0.08);
    for (let i = 0; i < 9; i++) {
      const a = Math.random() * Math.PI * 2;
      this.particles.push({
        x: hx,
        y: hy,
        z: 0.45,
        vx: Math.cos(a) * 2.2,
        vy: Math.sin(a) * 2.2,
        vz: 2 + Math.random() * 2,
        t0: hitT,
        life: 0.35,
        size: 0.09,
        color: i % 2 ? '#fff6b0' : '#ffd23f',
        kind: 'spark',
      });
    }
    this.shakeT = hitT;
  }

  hint(id: number, now: number) {
    this.buses[id].hintUntil = now + 3;
  }

  celebrate(now: number) {
    const cols = PALETTE;
    for (let i = 0; i < 140; i++) {
      this.confetti.push({
        x: this.cssW * (0.15 + Math.random() * 0.7),
        y: this.cssH * 0.42 + (Math.random() - 0.5) * 40,
        vx: (Math.random() - 0.5) * 520,
        vy: -300 - Math.random() * 520,
        rot: Math.random() * 6,
        vr: (Math.random() - 0.5) * 14,
        color: cols[i % cols.length],
        t0: now + Math.random() * 0.12,
        w: 6 + Math.random() * 6,
      });
    }
  }

  lost(now: number) {
    this.lostAt = now;
  }

  allBoarded(now: number) {
    return now >= this.lastBoard + FLY + 0.35;
  }

  isSettled(now: number) {
    return now >= this.settleAt + 0.2;
  }

  queueLeft(now: number) {
    let n = this.qiBase;
    for (const t of this.boardStarts) if (t <= now) n++;
    return n;
  }

  pose(vb: VBus, now: number): Pose {
    const base = { z: 0, hk: 1, pop: 1, alpha: 1 };
    if (vb.gone) return { ...base, x: 0, y: 0, a: 0, phase: 'gone', alpha: 0 };
    if (vb.outM && now >= vb.outM.t0) {
      if (now >= vb.outM.t0 + vb.outM.T) return { ...base, x: 0, y: 0, a: 0, phase: 'gone', alpha: 0 };
      const k = sampleMotion(vb.outM, now);
      const alpha = Math.max(0, Math.min(1, (this.w + 3.4 - k.x) / 1.6));
      return { ...base, ...k, phase: 'out', alpha };
    }
    if (vb.inM) {
      const arr = this.arriveAt(vb);
      if (now < arr) {
        const k = sampleMotion(vb.inM, now);
        if (vb.inM.air) {
          const u = Math.max(0, Math.min(1, (now - vb.inM.t0) / vb.inM.T));
          return { ...base, x: k.x, y: k.y, a: k.a, phase: 'in', z: Math.sin(Math.PI * u) * 2.6 };
        }
        const hop = now - vb.hopAt < 0.18 ? Math.sin((Math.PI * (now - vb.hopAt)) / 0.18) * 0.12 : 0;
        return { ...base, x: k.x, y: k.y, a: k.a, phase: 'in', z: hop };
      }
      // arrivo nello stallo: piccolo rimbalzo
      const tau = now - arr;
      let hk = 1;
      if (tau < 0.4) hk = 1 - 0.13 * Math.exp(-tau * 9) * Math.cos(tau * 26);
      // bus pieno: si gonfia prima di partire
      let pop = 1;
      const tf = now - vb.fullAt;
      if (tf > 0 && tf < 0.24) pop = 1 + 0.12 * Math.sin((Math.PI * tf) / 0.24);
      return { ...base, x: this.bayX(vb.slot), y: this.stallCY(vb.len), a: -Math.PI / 2, phase: 'stall', hk, pop };
    }
    let x = vb.lotX,
      y = vb.lotY;
    const fx = Math.cos(vb.lotA),
      fy = Math.sin(vb.lotA);
    let z = 0,
      hk = 1,
      alpha = 1;
    // bus ancora nel garage, o che ne sta uscendo
    if (now < vb.emergeAt) return { ...base, x, y, a: vb.lotA, phase: 'hidden', alpha: 0 };
    const te = now - vb.emergeAt;
    if (te < 0.32) {
      const u = te / 0.32;
      const e = 1 - (1 - u) ** 3;
      return { ...base, x: vb.garageX + (x - vb.garageX) * e, y: vb.garageY + (y - vb.garageY) * e, a: vb.lotA, phase: 'lot', alpha: Math.min(1, u * 3), pop: 0.85 + 0.15 * e };
    }
    // entrata a inizio livello: il bus "spunta" con un piccolo salto
    const td = now - vb.dropAt;
    let pop = 1;
    if (td < 0) alpha = 0;
    else if (td < 0.38) {
      const u = td / 0.38;
      const back = 1 + 2.7 * (u - 1) ** 3 + 1.7 * (u - 1) ** 2; // easeOutBack
      pop = 0.2 + 0.8 * back;
      z = 0.9 * Math.sin(Math.PI * u);
      alpha = Math.min(1, u * 4);
    } else if (td < 0.62) hk = 1 - 0.16 * Math.sin((Math.PI * (td - 0.38)) / 0.24);
    if (vb.bump) {
      const u = (now - vb.bump.t0) / vb.bump.dur;
      if (u >= 1) vb.bump = null;
      else if (u > 0) {
        // andata veloce, ritorno morbido
        const s = u < 0.5 ? Math.sin((Math.PI / 2) * (u / 0.5)) : 1 - (1 - Math.cos(Math.PI * (u - 0.5))) / 2;
        const d = vb.bump.dist * s;
        x += fx * d;
        y += fy * d;
      }
    }
    const st = now - vb.shakeAt;
    if (st > 0 && st < 0.35) {
      const j = 0.09 * Math.sin(st * 60) * (1 - st / 0.35);
      x += -fy * j;
      y += fx * j;
    }
    return { x, y, a: vb.lotA, phase: 'lot', z, hk, pop, alpha };
  }

  // ---------- input ----------
  hit(sx: number, sy: number, now: number): number | null {
    const cands: { id: number; depth: number; hull: [number, number][] }[] = [];
    for (const vb of this.buses) {
      const p = this.pose(vb, now);
      if (p.phase !== 'lot' || now < vb.dropAt + 0.3 || now < vb.emergeAt + 0.12) continue;
      const pts: [number, number][] = [];
      for (const [u, v] of CORNERS) {
        const [gx, gy] = this.local(p, vb.len, u, v);
        pts.push(this.cam.p(gx, gy, 0), this.cam.p(gx, gy, BUS_H));
      }
      cands.push({ id: vb.id, depth: this.cam.depth(p.x, p.y), hull: convexHull(pts) });
    }
    cands.sort((a, b) => b.depth - a.depth);
    for (const c of cands) if (pointInPoly(sx, sy, c.hull)) return c.id;
    const [gx, gy] = this.cam.ground(sx, sy + BUS_H * 0.5 * this.cam.zk * this.cam.s);
    let best: number | null = null;
    let bd = 0.8;
    for (const vb of this.buses) {
      if (this.pose(vb, now).phase !== 'lot' || now < vb.emergeAt + 0.12) continue;
      const fx = Math.cos(vb.lotA),
        fy = Math.sin(vb.lotA);
      const half = (vb.len - 1) / 2;
      const t = Math.max(-half, Math.min(half, (gx - vb.lotX) * fx + (gy - vb.lotY) * fy));
      const d = Math.hypot(gx - (vb.lotX + fx * t), gy - (vb.lotY + fy * t));
      if (d < bd) {
        bd = d;
        best = vb.id;
      }
    }
    return best;
  }

  private local(p: { x: number; y: number; a: number; pop?: number }, len: number, u: number, v: number): [number, number] {
    const pop = p.pop ?? 1;
    const a = ((len - 0.16) / 2) * pop,
      b = (BUS_W / 2) * pop;
    const fx = Math.cos(p.a),
      fy = Math.sin(p.a);
    return [p.x + fx * u * a - fy * v * b, p.y + fy * u * a + fx * v * b];
  }

  // ---------- disegno ----------
  draw(ctx: CanvasRenderingContext2D, now: number) {
    this.ctx = ctx;
    const dt = Math.min(0.1, Math.max(0, now - this.lastFrame));
    this.lastFrame = now;
    const target = this.queueLeft(now);
    const prevShift = this.queueShift;
    this.queueShift += (target - this.queueShift) * Math.min(1, dt * 10);
    if (Math.abs(target - this.queueShift) < 0.005) this.queueShift = target;
    const walking = Math.abs(this.queueShift - prevShift) > 0.0005;

    this.ensureBackground();
    ctx.save();
    const st = now - this.shakeT;
    if (st > 0 && st < 0.25) {
      const m = 4 * (1 - st / 0.25);
      ctx.translate(Math.sin(st * 90) * m, Math.cos(st * 70) * m * 0.6);
    }
    ctx.drawImage(this.bg!, 0, 0, this.cssW, this.cssH);
    this.drawBays(now);

    const items: Drawable[] = [];
    for (const g of this.garages) {
      items.push({ lb: g.lb, ...this.worldBox(g.x, g.y, g.a, 2), depth: this.cam.depth(g.x, g.y), draw: () => this.drawGarage(g, now) });
    }
    for (const vb of this.buses) {
      const p = this.pose(vb, now);
      if (p.phase === 'gone' || p.phase === 'hidden') continue;
      const xs: number[] = [],
        ys: number[] = [];
      for (const [u, v] of CORNERS) {
        const [gx, gy] = this.local(p, vb.len, u, v);
        xs.push(gx);
        ys.push(gy);
      }
      items.push({
        lb: p.phase === 'lot' ? vb.lb : undefined,
        minX: Math.min(...xs),
        maxX: Math.max(...xs),
        minY: Math.min(...ys),
        maxY: Math.max(...ys),
        depth: this.cam.depth(p.x, p.y),
        draw: () => this.drawBus(vb, p, now),
      });
    }
    // coda di passeggeri
    const total = this.level.queue.length;
    const startK = Math.max(this.qiBase, Math.floor(this.queueShift) - 1);
    for (let k = startK; k < total; k++) {
      if (k < target) continue;
      const slotK = k - this.queueShift;
      const pos = this.queuePos(slotK);
      if (!pos) break;
      const color = this.level.queue[k];
      const [x, y] = pos;
      const isHead = k === target;
      const bob = walking ? Math.abs(Math.sin(now * 16 + k * 0.9)) * 0.1 : Math.abs(Math.sin(now * 3 + k * 0.7)) * 0.025;
      items.push({
        minX: x - 0.15,
        maxX: x + 0.15,
        minY: y - 0.15,
        maxY: y + 0.15,
        depth: this.cam.depth(x, y),
        draw: () => this.drawPerson(x, y, bob, color, isHead ? 1.12 : 1, 1, isHead),
      });
    }
    const sn = Math.sin(this.cam.yaw);
    // direzione "verso chi guarda" nelle coordinate della griglia
    const th = this.level.theta;
    const vx = Math.cos(th) * sn + Math.sin(th) * Math.cos(this.cam.yaw);
    const vy = -Math.sin(th) * sn + Math.cos(th) * Math.cos(this.cam.yaw);
    items.sort((A, B) => {
      if (A.lb && B.lb) {
        const a = A.lb,
          b = B.lb;
        const sx = a.maxX <= b.minX + 1e-3 ? 1 : b.maxX <= a.minX + 1e-3 ? -1 : 0;
        const sy = a.maxY <= b.minY + 1e-3 ? 1 : b.maxY <= a.minY + 1e-3 ? -1 : 0;
        const sc = sx * vx + sy * vy;
        if (Math.abs(sc) > 1e-3) return sc > 0 ? -1 : 1;
        return A.depth - B.depth;
      }
      if (this.level.theta && (A.lb || B.lb)) return A.depth - B.depth;
      if (A.maxY <= B.minY + 1e-3) return -1;
      if (B.maxY <= A.minY + 1e-3) return 1;
      if (A.maxX <= B.minX + 1e-3) return sn >= 0 ? -1 : 1;
      if (B.maxX <= A.minX + 1e-3) return sn >= 0 ? 1 : -1;
      return A.depth - B.depth;
    });
    for (const it of items) it.draw();

    // passeggeri che saltano sul bus
    const head = this.queuePos(0)!;
    this.flights = this.flights.filter((f) => now < f.t1 + 0.05);
    for (const f of this.flights) {
      if (now < f.t0) continue;
      const u = Math.min(1, (now - f.t0) / (f.t1 - f.t0));
      const e = 1 - (1 - u) * (1 - u);
      const p = this.pose(this.buses[f.busId], now);
      const x = head[0] + (p.x - head[0]) * e;
      const y = head[1] + (p.y - head[1]) * e;
      const z = BUS_H * u + Math.sin(Math.PI * u) * 1.4;
      this.drawPerson(x, y, z, f.color, 1.1 - 0.35 * u, 1, false);
    }
    this.drawParticles(now);
    ctx.restore();
    this.drawConfetti(now, dt);
  }

  private worldBox(x: number, y: number, a: number, len: number) {
    const xs: number[] = [],
      ys: number[] = [];
    for (const [u, v] of CORNERS) {
      const [gx, gy] = this.local({ x, y, a }, len, u, v);
      xs.push(gx);
      ys.push(gy);
    }
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  }

  /** Garage: casetta con porta sul davanti e numero dei bus ancora dentro. */
  private drawGarage(g: VGarage, now: number) {
    const ctx = this.ctx;
    const c = this.cam;
    const base = '#7d74d9';
    const lw = Math.max(1.2, c.s * 0.045);
    const p = { x: g.x, y: g.y, a: g.a, pop: 1.02 };
    const L = (u: number, v: number) => this.local(p, 2, u, v);
    const corners = [L(1, 1), L(1, -1), L(-1, -1), L(-1, 1)];
    const H = 0.95;
    this.poly(
      corners.map(([x, y]) => c.p(x + 0.12, y + 0.16, 0.06)),
      'rgba(29,35,64,0.25)',
    );
    const fx = Math.cos(g.a),
      fy = Math.sin(g.a);
    const faces: [[number, number], [number, number], number, number, boolean][] = [
      [corners[1], corners[0], fx, fy, true],
      [corners[0], corners[3], -fy, fx, false],
      [corners[3], corners[2], -fx, -fy, false],
      [corners[2], corners[1], fy, -fx, false],
    ];
    const at = (A: [number, number], B: [number, number], t: number, z: number) => c.p(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, z);
    for (const [A, B, nx, ny, front] of faces) {
      if (!c.faceVisible(nx, ny)) continue;
      const facing = nx * Math.sin(c.yaw) + ny * Math.cos(c.yaw);
      this.poly([at(A, B, 0, 0.08), at(A, B, 1, 0.08), at(A, B, 1, H), at(A, B, 0, H)], shade(base, 0.2 - 0.12 * facing), OUTLINE, lw);
      // strisce ondulate della lamiera
      for (let k = 1; k < 6; k++) {
        const z = 0.08 + (H - 0.08) * (k / 6);
        const a1 = at(A, B, 0.04, z),
          b1 = at(A, B, 0.96, z);
        ctx.strokeStyle = 'rgba(29,35,64,0.18)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(a1[0], a1[1]);
        ctx.lineTo(b1[0], b1[1]);
        ctx.stroke();
      }
      if (front) this.poly([at(A, B, 0.12, 0.08), at(A, B, 0.88, 0.08), at(A, B, 0.88, 0.74), at(A, B, 0.12, 0.74)], '#1a1f3a', OUTLINE, lw * 0.8);
    }
    const roof = corners.map(([x, y]) => c.p(x, y, H));
    this.poly(roof, shade(base, -0.15), OUTLINE, lw);
    // numero di bus ancora dentro
    const inside = g.cars.filter((id) => this.buses[id].emergeAt > now).length;
    const [rx, ry] = c.p(g.x, g.y, H);
    const r = c.s * 0.36;
    ctx.beginPath();
    ctx.ellipse(rx, ry, r, r * 0.8, 0, 0, Math.PI * 2);
    ctx.fillStyle = inside ? '#ffd23f' : '#c9cede';
    ctx.fill();
    ctx.lineWidth = lw;
    ctx.strokeStyle = OUTLINE;
    ctx.stroke();
    ctx.fillStyle = OUTLINE;
    ctx.font = `${Math.round(r * 1.25)}px 'Lilita One', 'Arial Rounded MT Bold', system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(inside), rx, ry + r * 0.08);
    // freccia della direzione di uscita sul tetto
    const tip = c.p(...L(1.0, 0), H),
      bl = c.p(...L(0.62, 0.42), H),
      br = c.p(...L(0.62, -0.42), H);
    this.poly([tip, bl, br], '#ffffff', OUTLINE, lw * 0.8);
  }

  // ---------- sfondo statico (renderizzato una volta) ----------
  private ensureBackground() {
    const key = `${this.cssW}x${this.cssH}@${this.dpr}|${this.K}|${this.cam.s.toFixed(3)}`;
    if (this.bg && this.bgKey === key) return;
    this.bgKey = key;
    const cv = this.bg ?? document.createElement('canvas');
    cv.width = Math.round(this.cssW * this.dpr);
    cv.height = Math.round(this.cssH * this.dpr);
    const g = cv.getContext('2d')!;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const real = this.ctx;
    this.ctx = g;
    this.paintBackground();
    this.ctx = real;
    this.bg = cv;
  }

  private paintBackground() {
    const ctx = this.ctx;
    const c = this.cam;
    const W = this.w,
      H = this.h;
    const rng = mulberry32(this.level.seed);
    // prato con fili d'erba e fiorellini
    const grad = ctx.createLinearGradient(0, 0, 0, this.cssH);
    grad.addColorStop(0, C.grassA);
    grad.addColorStop(1, C.grassB);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, this.cssW, this.cssH);
    ctx.lineCap = 'round';
    for (let i = 0; i < (this.cssW * this.cssH) / 260; i++) {
      const x = rng() * this.cssW,
        y = rng() * this.cssH;
      ctx.strokeStyle = rng() < 0.5 ? 'rgba(40,110,50,0.18)' : 'rgba(255,255,255,0.16)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + (rng() - 0.5) * 3, y - 3 - rng() * 3);
      ctx.stroke();
    }
    for (let i = 0; i < (this.cssW * this.cssH) / 9000; i++) {
      ctx.fillStyle = rng() < 0.5 ? '#ffffff' : '#ffe27a';
      ctx.beginPath();
      ctx.arc(rng() * this.cssW, rng() * this.cssH, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }

    // marciapiede della fermata
    this.slab(-1.15, -7.25, W + 1.15, -5.2, 0.12, C.sidewalk);
    ctx.save();
    ctx.strokeStyle = 'rgba(29,35,64,0.09)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = -1.15; x < W + 1.15; x += 0.5) {
      const a = c.p(x, -7.25, 0.12),
        b = c.p(x, -5.2, 0.12);
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
    }
    for (let y = -7.25; y < -5.2; y += 0.6) {
      const a = c.p(-1.15, y, 0.12),
        b = c.p(W + 1.15, y, 0.12);
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
    }
    ctx.stroke();
    ctx.restore();

    // corsia di uscita
    this.rect(-1.15, -5.2, W + 4, -4.3, C.asphalt);
    this.dashes(-1.0, this.laneY, W + 4, this.laneY, 'rgba(255,255,255,0.55)');

    // anello stradale con cordolo
    this.slab(-1.12, -1.12, W + 1.12, H + 1.12, 0.05, C.curb);
    this.rect(-1, -1, W + 1, H + 1, C.asphalt, 0.05);

    // piazzola degli stalli
    this.slab(-1, -4.3, W + 1, -1, 0.1, C.platform);
    const bw = this.bayW();
    for (let i = 0; i < this.K; i++) {
      this.rect(-1 + bw * i + 0.1, -4.15, -1 + bw * (i + 1) - 0.1, -1.1, 'rgba(255,255,255,0.65)', 0.1);
    }
    ctx.save();
    ctx.strokeStyle = C.bayLine;
    ctx.lineWidth = Math.max(2, c.s * 0.09);
    ctx.lineCap = 'round';
    for (let i = 0; i <= this.K; i++) {
      const x = -1 + bw * i;
      const a = c.p(x, -1.08, 0.1),
        b = c.p(x, -4.15, 0.1);
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
    }
    ctx.restore();

    // segnaletica
    this.dashes(-0.5, -0.5, W + 0.5, -0.5);
    this.dashes(-0.5, H + 0.5, W + 0.5, H + 0.5);
    this.dashes(-0.5, -0.5, -0.5, H + 0.5);
    this.dashes(W + 0.5, -0.5, W + 0.5, H + 0.5);

    // piazzale e piastrelle del parcheggio (forma libera, anche ruotata)
    this.rect(0, 0, W, H, '#cfd4e6', 0.05);
    this.drawTiles();


    // cespugli ai bordi
    const spots: [number, number, number][] = [
      [-1.75, 1.2, 0.5],
      [-1.8, H * 0.55, 0.6],
      [-1.7, H - 0.4, 0.45],
      [W + 1.75, 0.6, 0.55],
      [W + 1.8, H * 0.45, 0.45],
      [W + 1.7, H - 1, 0.6],
      [-1.75, -2.6, 0.45],
      [W + 1.75, -2.9, 0.5],
      [W * 0.25, H + 1.8, 0.55],
      [W * 0.7, H + 1.75, 0.5],
    ];
    for (const [x, y, r] of spots) this.bush(x, y, r, rng);
  }

  private drawTiles() {
    const L = this.level;
    const c = this.cam;
    const lw = Math.max(1, c.s * 0.035);
    const hgt = 0.12;
    const tiles: [number, number][][] = [];
    for (let y = 0; y < L.gh; y++)
      for (let x = 0; x < L.gw; x++)
        if (L.mask[y * L.gw + x])
          tiles.push([
            toWorld(L, x, y),
            toWorld(L, x + 1, y),
            toWorld(L, x + 1, y + 1),
            toWorld(L, x, y + 1),
          ]);
    // prima i fianchi visibili di tutte le piastrelle, poi i piani: le vicine coprono i fianchi interni
    for (const t of tiles) {
      for (let i = 0; i < 4; i++) {
        const A = t[i],
          B = t[(i + 1) % 4];
        const nx = B[1] - A[1],
          ny = -(B[0] - A[0]);
        if (!c.faceVisible(nx, ny)) continue;
        this.poly([c.p(A[0], A[1], 0.05), c.p(B[0], B[1], 0.05), c.p(B[0], B[1], hgt), c.p(A[0], A[1], hgt)], shade(C.lot, 0.3), OUTLINE, lw);
      }
    }
    tiles.forEach((t, i) => {
      const [x0, y0] = t[0];
      const checker = (Math.round(x0 * 7 + y0 * 3) + i) % 2 === 0;
      this.poly(
        t.map(([x, y]) => c.p(x, y, hgt)),
        checker ? C.lot : shade(C.lot, 0.04),
      );
    });
    // contorno della forma: bordo scuro solo sui lati esterni
    const ctx = this.ctx;
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = lw * 1.3;
    ctx.beginPath();
    for (let y = 0; y < L.gh; y++)
      for (let x = 0; x < L.gw; x++) {
        if (!L.mask[y * L.gw + x]) continue;
        const nb: [number, number, [number, number], [number, number]][] = [
          [x, y - 1, [x, y], [x + 1, y]],
          [x + 1, y, [x + 1, y], [x + 1, y + 1]],
          [x, y + 1, [x + 1, y + 1], [x, y + 1]],
          [x - 1, y, [x, y + 1], [x, y]],
        ];
        for (const [nx, ny, A, B] of nb) {
          const outside = nx < 0 || ny < 0 || nx >= L.gw || ny >= L.gh || !L.mask[ny * L.gw + nx];
          if (!outside) continue;
          const a = c.p(...toWorld(L, A[0], A[1]), hgt),
            b = c.p(...toWorld(L, B[0], B[1]), hgt);
          ctx.moveTo(a[0], a[1]);
          ctx.lineTo(b[0], b[1]);
        }
      }
    ctx.stroke();
  }

  private bush(x: number, y: number, r: number, rng: () => number) {
    const ctx = this.ctx;
    const c = this.cam;
    const [sx, sy] = c.p(x, y, 0);
    const s = c.s * r;
    ctx.fillStyle = 'rgba(29,35,64,0.18)';
    ctx.beginPath();
    ctx.ellipse(sx + s * 0.2, sy + s * 0.15, s * 1.05, s * 0.55, 0, 0, Math.PI * 2);
    ctx.fill();
    const blobs = [
      [-0.45, -0.35, 0.6],
      [0.4, -0.4, 0.62],
      [0, -0.75, 0.68],
    ];
    for (const [bx, by, br] of blobs) {
      ctx.beginPath();
      ctx.arc(sx + bx * s, sy + by * s, br * s, 0, Math.PI * 2);
      ctx.fillStyle = '#3f9a4f';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = OUTLINE;
      ctx.stroke();
    }
    for (const [bx, by, br] of blobs) {
      ctx.beginPath();
      ctx.arc(sx + bx * s - br * s * 0.18, sy + by * s - br * s * 0.2, br * s * 0.55, 0, Math.PI * 2);
      ctx.fillStyle = '#5cbf63';
      ctx.fill();
    }
    if (rng() < 0.6) {
      ctx.fillStyle = '#ff8fb1';
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.arc(sx + (rng() - 0.5) * s * 1.2, sy - s * (0.3 + rng() * 0.7), Math.max(1.5, s * 0.08), 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // ---------- primitive ----------
  private poly(pts: [number, number][], fill: string, stroke?: string, lw = 1) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = lw;
      ctx.lineJoin = 'round';
      ctx.stroke();
    }
  }

  private rect(x0: number, y0: number, x1: number, y1: number, fill: string, z = 0) {
    const c = this.cam;
    this.poly([c.p(x0, y0, z), c.p(x1, y0, z), c.p(x1, y1, z), c.p(x0, y1, z)], fill);
  }

  private slab(x0: number, y0: number, x1: number, y1: number, hgt: number, color: string) {
    const c = this.cam;
    const lw = Math.max(1, c.s * 0.035);
    const faces: [number, number, number, number, number, number][] = [
      [x0, y1, x1, y1, 0, 1],
      [x1, y0, x1, y1, 1, 0],
      [x0, y0, x0, y1, -1, 0],
      [x0, y0, x1, y0, 0, -1],
    ];
    for (const [ax, ay, bx, by, nx, ny] of faces) {
      if (!c.faceVisible(nx, ny)) continue;
      this.poly([c.p(ax, ay, 0), c.p(bx, by, 0), c.p(bx, by, hgt), c.p(ax, ay, hgt)], shade(color, 0.28), OUTLINE, lw);
    }
    this.poly([c.p(x0, y0, hgt), c.p(x1, y0, hgt), c.p(x1, y1, hgt), c.p(x0, y1, hgt)], color, OUTLINE, lw);
  }

  private dashes(x0: number, y0: number, x1: number, y1: number, color = 'rgba(255,255,255,0.7)') {
    const c = this.cam;
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1.5, c.s * 0.07);
    ctx.lineCap = 'round';
    ctx.setLineDash([c.s * 0.25, c.s * 0.3]);
    ctx.beginPath();
    const a = c.p(x0, y0, 0.05),
      b = c.p(x1, y1, 0.05);
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.stroke();
    ctx.restore();
  }

  /** Stalli liberi che "respirano", rosso lampeggiante quando si perde. */
  private drawBays(now: number) {
    const bw = this.bayW();
    const lostPulse = now - this.lostAt < 1.6 ? 0.5 + 0.5 * Math.sin((now - this.lostAt) * 14) : 0;
    for (let i = 0; i < this.K; i++) {
      const busy = this.buses.some(
        (vb) => vb.slot === i && !vb.gone && !(vb.outM && now >= vb.outM.t0 + 0.25) && vb.inM !== null,
      );
      const x0 = -1 + bw * i + 0.16,
        x1 = -1 + bw * (i + 1) - 0.16;
      if (lostPulse > 0) this.rect(x0, -4.1, x1, -1.15, `rgba(255,77,77,${0.15 + 0.35 * lostPulse})`, 0.1);
      else if (!busy) {
        const a = 0.18 + 0.12 * Math.sin(now * 3 + i);
        this.rect(x0, -4.1, x1, -1.15, `rgba(58,134,255,${a})`, 0.1);
      }
    }
  }

  private drawBus(vb: VBus, p: Pose, now: number) {
    const ctx = this.ctx;
    const c = this.cam;
    const base = PALETTE[vb.color];
    const lw = Math.max(1.2, c.s * 0.045);
    ctx.save();
    ctx.globalAlpha = p.alpha;
    const L = (u: number, v: number) => this.local(p, vb.len, u, v);
    const corners = [L(1, 1), L(1, -1), L(-1, -1), L(-1, 1)];
    const zb = p.z; // sollevamento (caduta, saltello)
    const zh = (z: number) => zb + z * p.hk;

    // ombra morbida sul terreno
    const shadowA = 0.24 * Math.max(0.3, 1 - zb / 5);
    this.poly(
      [L(1.08, 1.12), L(1.08, -1.12), L(-1.08, -1.12), L(-1.08, 1.12)].map(([x, y]) => c.p(x + 0.12, y + 0.16, 0.06)),
      `rgba(29,35,64,${shadowA})`,
    );

    const fx = Math.cos(p.a),
      fy = Math.sin(p.a);
    const faces: [[number, number], [number, number], number, number, 'front' | 'side' | 'back'][] = [
      [corners[1], corners[0], fx, fy, 'front'],
      [corners[0], corners[3], -fy, fx, 'side'],
      [corners[3], corners[2], -fx, -fy, 'back'],
      [corners[2], corners[1], fy, -fx, 'side'],
    ];
    const at = (A: [number, number], B: [number, number], t: number, z: number) =>
      c.p(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, zh(z));
    const quad = (A: [number, number], B: [number, number], t0: number, t1: number, za: number, zb2: number, fill: string, stroke?: string) =>
      this.poly([at(A, B, t0, za), at(A, B, t1, za), at(A, B, t1, zb2), at(A, B, t0, zb2)], fill, stroke, lw * 0.8);

    const z0 = 0.12,
      z1 = BUS_H;
    for (const [A, B, nx, ny, kind] of faces) {
      if (!c.faceVisible(nx, ny)) continue;
      const facing = nx * Math.sin(c.yaw) + ny * Math.cos(c.yaw);
      // ruote (sotto la carrozzeria)
      if (kind === 'side') {
        for (const t of vb.len === 3 ? [0.17, 0.83] : [0.22, 0.78]) {
          const [wx, wy] = at(A, B, t, 0.13);
          ctx.beginPath();
          ctx.ellipse(wx, wy, c.s * 0.13, c.s * 0.13 * c.zk, 0, 0, Math.PI * 2);
          ctx.fillStyle = OUTLINE;
          ctx.fill();
          ctx.beginPath();
          ctx.ellipse(wx, wy, c.s * 0.055, c.s * 0.055 * c.zk, 0, 0, Math.PI * 2);
          ctx.fillStyle = '#c9cede';
          ctx.fill();
        }
      }
      quad(A, B, 0, 1, z0, z1, shade(base, 0.22 - 0.12 * facing), OUTLINE);
      if (kind === 'front') {
        quad(A, B, 0.1, 0.9, 0.38, 0.64, C.glass);
        quad(A, B, 0.16, 0.36, 0.42, 0.6, 'rgba(255,255,255,0.28)');
        quad(A, B, 0.08, 0.24, 0.2, 0.29, '#fff7c2');
        quad(A, B, 0.76, 0.92, 0.2, 0.29, '#fff7c2');
      } else if (kind === 'back') {
        quad(A, B, 0.18, 0.82, 0.44, 0.63, C.glass);
        quad(A, B, 0.1, 0.22, 0.2, 0.28, '#ff6b6b');
        quad(A, B, 0.78, 0.9, 0.2, 0.28, '#ff6b6b');
      } else {
        // fascia bianca della livrea + finestrini continui con montanti
        quad(A, B, 0.02, 0.98, 0.24, 0.31, 'rgba(255,255,255,0.85)');
        quad(A, B, 0.07, 0.93, 0.41, 0.63, C.glass);
        const n = vb.len * 2;
        for (let k = 1; k < n; k++) {
          const t = 0.07 + (0.86 * k) / n;
          quad(A, B, t - 0.012, t + 0.012, 0.41, 0.63, shade(base, 0.1));
        }
        quad(A, B, 0.1, 0.3, 0.47, 0.6, 'rgba(255,255,255,0.18)');
      }
    }

    // tetto
    const roof = corners.map(([x, y]) => c.p(x, y, zh(z1)));
    this.poly(roof, shade(base, -0.18), OUTLINE, lw);
    const inner = [L(0.88, 0.74), L(0.88, -0.74), L(-0.88, -0.74), L(-0.88, 0.74)].map(([x, y]) => c.p(x, y, zh(z1)));
    this.poly(inner, shade(base, -0.34));
    // riflesso sul bordo del tetto
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = Math.max(1, c.s * 0.04);
    ctx.beginPath();
    const r1 = c.p(...L(0.8, -0.62), zh(z1)),
      r2 = c.p(...L(-0.8, -0.62), zh(z1));
    ctx.moveTo(r1[0], r1[1]);
    ctx.lineTo(r2[0], r2[1]);
    ctx.stroke();

    // lampo rosso quando è bloccato
    const ft = now - vb.flashAt;
    if (ft > 0 && ft < 0.4) this.poly(roof, `rgba(255,60,60,${0.55 * (1 - ft / 0.4)})`);

    const a = (vb.len - 0.16) / 2;
    if (p.phase === 'lot' || p.phase === 'in') {
      const arrow: [number, number][] = [
        [0.78, 0],
        [0.12, 0.66],
        [0.12, 0.3],
        [-0.66, 0.3],
        [-0.66, -0.3],
        [0.12, -0.3],
        [0.12, -0.66],
      ];
      const k = Math.min(1, 1.15 / a);
      this.poly(
        arrow.map(([u, v]) => {
          const [x, y] = L(u * k, v);
          return c.p(x, y, zh(z1));
        }),
        '#ffffff',
        OUTLINE,
        lw * 0.9,
      );
    } else {
      // posti: teste dei passeggeri già saliti
      const lands = vb.lands.filter((t) => t <= now);
      const filled = vb.filledBase + lands.length;
      const lastLand = lands.length ? lands[lands.length - 1] : -9;
      const cols = vb.cap / 2;
      const r = Math.min(0.16, (0.8 * a) / cols) * c.s;
      let k = 0;
      for (let i = 0; i < cols; i++) {
        for (const v of [-0.42, 0.42]) {
          const u = -0.78 + (1.56 * (i + 0.5)) / cols;
          const [x, y] = L(u, v);
          const [sx, sy] = c.p(x, y, zh(z1));
          let rr = r;
          if (k === filled - 1 && now - lastLand < 0.2) rr *= 1 + 0.6 * (1 - (now - lastLand) / 0.2);
          ctx.beginPath();
          ctx.ellipse(sx, sy, rr, rr * c.squash, 0, 0, Math.PI * 2);
          if (k < filled) {
            ctx.fillStyle = shade(base, -0.45);
            ctx.fill();
            ctx.strokeStyle = OUTLINE;
            ctx.lineWidth = 1.3;
            ctx.stroke();
          } else {
            ctx.fillStyle = 'rgba(29,35,64,0.32)';
            ctx.fill();
          }
          k++;
        }
      }
    }
    if (now < vb.hintUntil && p.phase === 'lot') {
      const pulse = 0.5 + 0.5 * Math.sin(now * 10);
      ctx.beginPath();
      roof.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.lineWidth = 3 + pulse * 4;
      ctx.strokeStyle = `rgba(255,255,255,${0.6 + 0.4 * pulse})`;
      ctx.stroke();
    }
    ctx.restore();

    // fumo dallo scappamento quando parte pieno
    if (p.phase === 'out' && Math.random() < 0.5) {
      const [bx, by] = L(-1.05, 0.5);
      this.particles.push({
        x: bx,
        y: by,
        z: 0.2,
        vx: -fx * 0.6 + (Math.random() - 0.5) * 0.3,
        vy: -fy * 0.6 + (Math.random() - 0.5) * 0.3,
        vz: 0.6,
        t0: now,
        life: 0.5,
        size: 0.14,
        color: 'rgba(255,255,255,0.85)',
        kind: 'puff',
      });
    }
  }

  private drawPerson(x: number, y: number, z: number, color: number, scale: number, alpha: number, head = false) {
    const ctx = this.ctx;
    const c = this.cam;
    const s = c.s * scale;
    const base = PALETTE[color];
    ctx.save();
    ctx.globalAlpha = alpha;
    const [gx, gy] = c.p(x, y, 0.12);
    ctx.fillStyle = 'rgba(29,35,64,0.2)';
    ctx.beginPath();
    ctx.ellipse(gx, gy, s * 0.17, s * 0.17 * c.squash, 0, 0, Math.PI * 2);
    ctx.fill();
    if (head) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(gx, gy, s * 0.26, s * 0.26 * c.squash, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    const [px, py] = c.p(x, y, 0.12 + z);
    const bw = s * 0.34,
      bh = s * 0.4 * c.zk;
    ctx.lineWidth = Math.max(1.3, c.s * 0.04);
    ctx.strokeStyle = OUTLINE;
    ctx.fillStyle = base;
    ctx.beginPath();
    ctx.roundRect(px - bw / 2, py - bh, bw, bh, [bw * 0.5, bw * 0.5, bw * 0.2, bw * 0.2]);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath();
    ctx.roundRect(px - bw * 0.3, py - bh * 0.88, bw * 0.18, bh * 0.55, bw * 0.09);
    ctx.fill();
    const hr = s * 0.15;
    const hy = py - bh - hr * 0.75;
    ctx.beginPath();
    ctx.arc(px, hy, hr, 0, Math.PI * 2);
    ctx.fillStyle = shade(base, -0.5);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = OUTLINE;
    ctx.beginPath();
    ctx.arc(px - hr * 0.35, hy - hr * 0.05, Math.max(0.8, hr * 0.15), 0, Math.PI * 2);
    ctx.arc(px + hr * 0.35, hy - hr * 0.05, Math.max(0.8, hr * 0.15), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private drawParticles(now: number) {
    const ctx = this.ctx;
    const c = this.cam;
    this.particles = this.particles.filter((q) => now < q.t0 + q.life);
    for (const q of this.particles) {
      const t = now - q.t0;
      if (t < 0) continue;
      const u = t / q.life;
      const x = q.x + q.vx * t,
        y = q.y + q.vy * t;
      const z = q.kind === 'spark' ? q.z + q.vz * t - 9 * t * t : q.z + q.vz * t;
      const [sx, sy] = c.p(x, y, Math.max(0, z));
      ctx.globalAlpha = 1 - u;
      ctx.fillStyle = q.color;
      if (q.kind === 'spark') {
        const r = q.size * c.s * (1 - u * 0.5);
        star(ctx, sx, sy, r);
      } else {
        ctx.beginPath();
        ctx.arc(sx, sy, q.size * c.s * (0.6 + u * 1.4), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  private drawConfetti(now: number, dt: number) {
    const ctx = this.ctx;
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
}

const CORNERS: [number, number][] = [
  [1, 1],
  [1, -1],
  [-1, -1],
  [-1, 1],
];

function star(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    const rr = i % 2 ? r * 0.4 : r;
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fill();
}

function convexHull(pts: [number, number][]): [number, number][] {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: [number, number][] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function pointInPoly(x: number, y: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i],
      [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function boxOf(b: { x: number; y: number; dir: number; len: number }): LBox {
  const cells = busCells(b as any);
  const xs = cells.map((q) => q[0]),
    ys = cells.map((q) => q[1]);
  const pad = 0.08;
  return { minX: Math.min(...xs) + pad, maxX: Math.max(...xs) + 1 - pad, minY: Math.min(...ys) + pad, maxY: Math.max(...ys) + 1 - pad };
}
