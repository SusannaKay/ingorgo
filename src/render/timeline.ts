// Stato visivo indipendente dal renderer: percorsi, tempi, pose di bus e passeggeri.
// La logica di gioco è istantanea; qui ogni evento diventa movimento nel tempo.
// Coordinate del mondo: x verso destra, y verso chi guarda, z in alto.
import { DX, DY, Dir, Level, busCells, toWorld } from '../game/types';
import { GameEvent, GameState } from '../game/engine';

export const SPEED = 25; // celle al secondo
export const FLY = 0.24; // salto del passeggero
const BOARD_GAP = 0.045;
export const DIR_ANG = [-Math.PI / 2, 0, Math.PI / 2, Math.PI];
export const BUS_H = 0.78;
export const BUS_W = 0.8;
export const SLIDE_T = 0.13; // durata dello scivolamento di una cella

// ---------- percorsi con curve vere e accelerazione ----------
type PathPt = { x: number; y: number; a: number; d: number };
export interface Motion {
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
  if (p.length < 2) return [{ x: p[0][0], y: p[0][1], a: 0, d: 0 }];
  const ang = (i: number) => Math.atan2(p[i + 1][1] - p[i][1], p[i + 1][0] - p[i][0]);
  const len = (i: number) => Math.hypot(p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1]);
  const out: { x: number; y: number; a: number }[] = [{ x: p[0][0], y: p[0][1], a: ang(0) }];
  for (let i = 1; i < p.length - 1; i++) {
    const r = Math.min(0.75, len(i - 1) / 2, len(i) / 2);
    const aIn = ang(i - 1),
      aOut = ang(i);
    const ax = p[i][0] - Math.cos(aIn) * r,
      ay = p[i][1] - Math.sin(aIn) * r;
    const bx = p[i][0] + Math.cos(aOut) * r,
      by = p[i][1] + Math.sin(aOut) * r;
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

export function motion(raw: [number, number][], t0: number, minDur: number, easeIn: boolean, easeOut: boolean): Motion {
  const pts = buildPath(raw);
  const total = pts[pts.length - 1].d;
  const T = Math.max(total / SPEED + (easeIn ? 0.08 : 0) + (easeOut ? 0.06 : 0), minDur, 0.05);
  return { pts, t0, T, total, easeIn, easeOut };
}

function ease(u: number, ei: boolean, eo: boolean) {
  if (ei && eo) return 0.35 * u + 0.65 * u * u * (3 - 2 * u);
  if (ei) return 0.3 * u + 0.7 * u * u;
  if (eo) return 0.3 * u + 0.7 * (1 - (1 - u) * (1 - u));
  return u;
}

export function lerpAngle(a: number, b: number, u: number) {
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

// ---------- tipi ----------
export type Phase = 'lot' | 'in' | 'stall' | 'out' | 'gone' | 'hidden';
export type LBox = { minX: number; maxX: number; minY: number; maxY: number };

export interface VBus {
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
  bump: { t0: number; dur: number; dist: number; fx: number; fy: number } | null;
  /** scivolamento in corso: da (sx, sy) a (lotX, lotY) */
  slideT0: number;
  sx: number;
  sy: number;
  /** freccia del suggerimento (angolo nel mondo), null se il consiglio è "esci" */
  hintA: number | null;
  /** cella logica attuale (coda del bus) */
  cell: [number, number];
  shakeAt: number;
  flashAt: number;
  hintUntil: number;
  dropAt: number;
  hopAt: number;
  emergeAt: number;
  garageX: number;
  garageY: number;
  lb: LBox;
}

export interface VGarage {
  id: number;
  x: number;
  y: number;
  a: number;
  lb: LBox;
  cars: number[];
}

export interface Pose {
  x: number;
  y: number;
  a: number;
  phase: Phase;
  alpha: number;
  z: number; // sollevamento
  hk: number; // schiacciamento verticale
  pop: number; // scala orizzontale
}

export interface Flight {
  color: number;
  t0: number;
  t1: number;
  busId: number;
}

export interface Particle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  t0: number;
  life: number;
  size: number;
  kind: 'puff' | 'spark';
}

export function boxOf(b: { x: number; y: number; dir: number; len: number }): LBox {
  const cells = busCells(b as Parameters<typeof busCells>[0]);
  const xs = cells.map((q) => q[0]),
    ys = cells.map((q) => q[1]);
  const pad = 0.08;
  return { minX: Math.min(...xs) + pad, maxX: Math.max(...xs) + 1 - pad, minY: Math.min(...ys) + pad, maxY: Math.max(...ys) + 1 - pad };
}

export class Timeline {
  buses: VBus[] = [];
  garages: VGarage[] = [];
  flights: Flight[] = [];
  boardStarts: number[] = [];
  particles: Particle[] = [];
  qiBase = 0;
  lastBoard = 0;
  slotFreeAt: number[] = [];
  bayOwner: number[] = [];
  settleAt = 0;
  K = 5;
  queueShift = 0;
  walking = false;
  lostAt = -9;
  shakeT = -9;
  celebrateAt = -9;
  private lastTick = 0;

  constructor(public level: Level) {}

  // ---------- geometria del mondo ----------
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
  readonly rowsY = [-5.72, -6.86];
  readonly spacing = 0.86;
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

  // ---------- stato ----------
  rebuild(state: GameState, now: number, intro = false) {
    this.K = state.slots.length;
    const L = this.level;
    this.garages = L.garages.map((g) => {
      const lb = boxOf(g);
      const [x, y] = toWorld(L, (lb.minX + lb.maxX) / 2, (lb.minY + lb.maxY) / 2);
      return { id: g.id, x, y, a: DIR_ANG[g.dir] + L.theta, lb, cars: g.cars };
    });
    this.buses = L.buses.map((b) => {
      const lb = boxOf({ x: state.px[b.id], y: state.py[b.id], dir: b.dir, len: b.len });
      const [lotX, lotY] = toWorld(L, (lb.minX + lb.maxX) / 2, (lb.minY + lb.maxY) / 2);
      const g = b.garage !== undefined ? this.garages[b.garage] : null;
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
        slideT0: -9,
        sx: lotX,
        sy: lotY,
        hintA: null,
        cell: [state.px[b.id], state.py[b.id]],
        shakeAt: -9,
        flashAt: -9,
        hintUntil: 0,
        dropAt: intro ? now + 0.1 + lotY * 0.05 + lotX * 0.025 : -9,
        hopAt: -9,
        emergeAt: state.hidden[b.id] ? Infinity : -9,
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
    this.celebrateAt = -9;
  }

  setStalls(k: number) {
    this.K = k;
    while (this.slotFreeAt.length < k) this.slotFreeAt.push(0);
    while (this.bayOwner.length < k) this.bayOwner.push(-1);
  }

  arriveAt(vb: VBus) {
    return vb.inM ? vb.inM.t0 + vb.inM.T : Infinity;
  }

  private gridOf(vb: VBus): [number, number] {
    return vb.cell;
  }

  /** centro nel mondo di un bus nella cella (x, y) della griglia */
  private worldOf(x: number, y: number, dir: Dir, len: number): [number, number] {
    const lb = boxOf({ x, y, dir, len });
    return toWorld(this.level, (lb.minX + lb.maxX) / 2, (lb.minY + lb.maxY) / 2);
  }

  apply(events: GameEvent[], now: number, lifted = false) {
    let prev: GameEvent['type'] | null = null;
    for (const e of events) {
      const vb = this.buses[e.id];
      const before = prev;
      prev = e.type;
      if (e.type === 'slide') {
        const b = this.level.buses[e.id];
        // posizione attuale (anche a metà di uno scivolamento precedente)
        const p = this.pose(vb, now);
        vb.sx = p.x;
        vb.sy = p.y;
        vb.slideT0 = now;
        // nuova cella: quella vecchia spostata di uno nella direzione dello scorrimento
        const [cx, cy] = this.gridOf(vb);
        [vb.lotX, vb.lotY] = this.worldOf(cx + DX[e.dir], cy + DY[e.dir], b.dir, b.len);
        vb.cell = [cx + DX[e.dir], cy + DY[e.dir]];
        vb.bump = null;
        vb.hintUntil = 0;
        this.settleAt = Math.max(this.settleAt, now + SLIDE_T);
        continue;
      }
      if (e.type === 'emerge') {
        // aspetta che il bus davanti si sia tolto di mezzo
        vb.emergeAt = now + (before === 'slide' ? SLIDE_T * 0.7 : lifted ? 0.6 : 0.22);
        this.settleAt = Math.max(this.settleAt, vb.emergeAt + 0.32);
        continue;
      }
      if (e.type === 'enter') {
        vb.hintUntil = 0;
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
          vb.inM = motion([[vb.lotX, vb.lotY], [bx, cy]], now + 0.05, Math.max(minDur, 0.75), true, true);
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
        const dep = vb.fullAt + 0.18;
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
        this.slotFreeAt[bay] = dep + 0.22;
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
    const pts: [number, number][] = [
      [x, y],
      [x + fx * t, y + fy * t],
    ];
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
    vb.bump = { t0: now, dur, dist: dist + 0.08, fx: Math.cos(vb.lotA), fy: Math.sin(vb.lotA) };
    vb.flashAt = now;
    const hitT = now + dur / 2;
    if (blocker >= 0) this.buses[blocker].shakeAt = hitT;
    const fx = Math.cos(vb.lotA),
      fy = Math.sin(vb.lotA);
    const reach = (vb.len - 0.16) / 2 + dist + 0.08;
    const hx = vb.lotX + fx * reach,
      hy = vb.lotY + fy * reach;
    for (let i = 0; i < 10; i++) {
      const ang = Math.random() * Math.PI * 2;
      this.particles.push({ x: hx, y: hy, z: 0.45, vx: Math.cos(ang) * 2.4, vy: Math.sin(ang) * 2.4, vz: 2 + Math.random() * 2, t0: hitT, life: 0.35, size: 0.07, kind: 'spark' });
    }
    this.shakeT = hitT;
  }

  /** scorrimento impossibile: piccolo colpo nella direzione tentata */
  nudge(id: number, dir: Dir, now: number) {
    const vb = this.buses[id];
    const a = Math.atan2(DY[dir], DX[dir]) + this.level.theta;
    vb.bump = { t0: now, dur: 0.18, dist: 0.13, fx: Math.cos(a), fy: Math.sin(a) };
  }

  /** suggerimento: il bus lampeggia; con una direzione, compare anche una freccia */
  hint(id: number, now: number, dir: Dir | null = null) {
    const vb = this.buses[id];
    vb.hintUntil = now + 3;
    vb.hintA = dir === null ? null : Math.atan2(DY[dir], DX[dir]) + this.level.theta;
  }

  celebrate(now: number) {
    this.celebrateAt = now;
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

  /** passeggeri seduti sul bus (per i posti sul tetto) */
  seated(vb: VBus, now: number) {
    let n = vb.filledBase;
    let last = -9;
    for (const t of vb.lands)
      if (t <= now) {
        n++;
        last = t;
      }
    return { n, last };
  }

  /** stallo occupato (anche da un bus in arrivo) */
  bayBusy(i: number, now: number) {
    return this.buses.some((vb) => vb.slot === i && !vb.gone && !(vb.outM && now >= vb.outM.t0 + 0.25) && vb.inM !== null);
  }

  /** Avanza la coda e le particelle; da chiamare una volta per fotogramma. */
  tick(now: number) {
    const dt = Math.min(0.1, Math.max(0, now - this.lastTick));
    this.lastTick = now;
    const target = this.queueLeft(now);
    const prev = this.queueShift;
    this.queueShift += (target - this.queueShift) * Math.min(1, dt * 10);
    if (Math.abs(target - this.queueShift) < 0.005) this.queueShift = target;
    this.walking = Math.abs(this.queueShift - prev) > 0.0005;
    this.particles = this.particles.filter((q) => now < q.t0 + q.life);
    this.flights = this.flights.filter((f) => now < f.t1 + 0.05);
    return dt;
  }

  spawnPuff(x: number, y: number, a: number, now: number) {
    this.particles.push({
      x,
      y,
      z: 0.25,
      vx: -Math.cos(a) * 0.6 + (Math.random() - 0.5) * 0.3,
      vy: -Math.sin(a) * 0.6 + (Math.random() - 0.5) * 0.3,
      vz: 0.7,
      t0: now,
      life: 0.5,
      size: 0.13,
      kind: 'puff',
    });
  }

  pose(vb: VBus, now: number): Pose {
    const base = { z: 0, hk: 1, pop: 1, alpha: 1 };
    if (vb.gone) return { ...base, x: 0, y: 0, a: 0, phase: 'gone', alpha: 0 };
    if (vb.outM && now >= vb.outM.t0) {
      if (now >= vb.outM.t0 + vb.outM.T) return { ...base, x: 0, y: 0, a: 0, phase: 'gone', alpha: 0 };
      const k = sampleMotion(vb.outM, now);
      const alpha = Math.max(0, Math.min(1, (this.w + 3.4 - k.x) / 1.6));
      return { ...base, x: k.x, y: k.y, a: k.a, phase: 'out', alpha };
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
      const tau = now - arr;
      let hk = 1;
      if (tau < 0.4) hk = 1 - 0.13 * Math.exp(-tau * 9) * Math.cos(tau * 26);
      let pop = 1;
      const tf = now - vb.fullAt;
      if (tf > 0 && tf < 0.18) pop = 1 + 0.12 * Math.sin((Math.PI * tf) / 0.18);
      return { ...base, x: this.bayX(vb.slot), y: this.stallCY(vb.len), a: -Math.PI / 2, phase: 'stall', hk, pop };
    }
    let x = vb.lotX,
      y = vb.lotY;
    const fx = Math.cos(vb.lotA),
      fy = Math.sin(vb.lotA);
    const ts = now - vb.slideT0;
    let squash = 1;
    if (ts < SLIDE_T) {
      const u = Math.max(0, ts / SLIDE_T);
      const e = 1 - (1 - u) * (1 - u) * (1 - u);
      x = vb.sx + (vb.lotX - vb.sx) * e;
      y = vb.sy + (vb.lotY - vb.sy) * e;
      squash = 1 - 0.06 * Math.sin(Math.PI * u);
    }
    let z = 0,
      hk = 1,
      alpha = 1,
      pop = 1;
    if (now < vb.emergeAt) return { ...base, x, y, a: vb.lotA, phase: 'hidden', alpha: 0 };
    const te = now - vb.emergeAt;
    if (te < 0.32) {
      const u = te / 0.32;
      const e = 1 - (1 - u) ** 3;
      return { ...base, x: vb.garageX + (x - vb.garageX) * e, y: vb.garageY + (y - vb.garageY) * e, a: vb.lotA, phase: 'lot', alpha: Math.min(1, u * 3), pop: 0.85 + 0.15 * e };
    }
    const td = now - vb.dropAt;
    if (td < 0) alpha = 0;
    else if (td < 0.38) {
      const u = td / 0.38;
      pop = 0.2 + 0.8 * (1 + 2.7 * (u - 1) ** 3 + 1.7 * (u - 1) ** 2);
      z = 0.9 * Math.sin(Math.PI * u);
      alpha = Math.min(1, u * 4);
    } else if (td < 0.62) hk = 1 - 0.16 * Math.sin((Math.PI * (td - 0.38)) / 0.24);
    if (vb.bump) {
      const u = (now - vb.bump.t0) / vb.bump.dur;
      if (u >= 1) vb.bump = null;
      else if (u > 0) {
        const s = u < 0.5 ? Math.sin((Math.PI / 2) * (u / 0.5)) : 1 - (1 - Math.cos(Math.PI * (u - 0.5))) / 2;
        x += vb.bump.fx * vb.bump.dist * s;
        y += vb.bump.fy * vb.bump.dist * s;
      }
    }
    const st = now - vb.shakeAt;
    if (st > 0 && st < 0.35) {
      const j = 0.09 * Math.sin(st * 60) * (1 - st / 0.35);
      x += -fy * j;
      y += fx * j;
    }
    return { x, y, a: vb.lotA, phase: 'lot', z, hk: hk * squash, pop, alpha };
  }

  /** il bus si può toccare adesso */
  tappable(vb: VBus, now: number) {
    return this.pose(vb, now).phase === 'lot' && now >= vb.dropAt + 0.3 && now >= vb.emergeAt + 0.12;
  }
}
