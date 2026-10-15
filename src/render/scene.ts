// Stato visivo (animazioni a timeline) e disegno su Canvas 2D.
// La logica è istantanea; qui ogni evento diventa una sequenza di keyframe nel tempo.
import { Camera } from './camera';
import { Level, DX, DY } from '../game/types';
import { GameEvent, GameState } from '../game/engine';

export const PALETTE = ['#ef4444', '#3b82f6', '#facc15', '#22c55e', '#a855f7', '#f97316', '#ec4899', '#22d3ee'];

const SPEED = 19; // celle al secondo
const FLY = 0.22; // volo del passeggero
const BOARD_GAP = 0.055;
const DIR_ANG = [-Math.PI / 2, 0, Math.PI / 2, Math.PI];
const BUS_H = 0.72;
const BUS_W = 0.76;

type Key = { t: number; x: number; y: number; a: number };
type Phase = 'lot' | 'in' | 'stall' | 'out' | 'gone';

interface VBus {
  id: number;
  color: number;
  len: number;
  cap: number;
  lotX: number;
  lotY: number;
  lotA: number;
  /** stallo disegnato (può differire da quello logico, per non far aspettare i bus) */
  slot: number;
  inKeys: Key[] | null;
  outKeys: Key[] | null;
  gone: boolean;
  filledBase: number;
  lands: number[];
  bump: { t0: number; dur: number; dist: number } | null;
  shakeAt: number;
  hintUntil: number;
}

interface Flight {
  color: number;
  t0: number;
  t1: number;
  busId: number;
}

interface Pose {
  x: number;
  y: number;
  a: number;
  phase: Phase;
  alpha: number;
}

interface Drawable {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  depth: number;
  draw: () => void;
}

// ---------- colori ----------
const shadeCache = new Map<string, string>();
function shade(hex: string, amt: number): string {
  const k = hex + amt;
  const hit = shadeCache.get(k);
  if (hit) return hit;
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255,
    g = (n >> 8) & 255,
    b = n & 255;
  if (amt >= 0) {
    r *= 1 - amt;
    g *= 1 - amt;
    b *= 1 - amt;
  } else {
    r += (255 - r) * -amt;
    g += (255 - g) * -amt;
    b += (255 - b) * -amt;
  }
  const out = `rgb(${r | 0},${g | 0},${b | 0})`;
  shadeCache.set(k, out);
  return out;
}

function lerpAngle(a: number, b: number, u: number) {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return a + d * u;
}

function sample(keys: Key[], t: number): Key {
  if (t <= keys[0].t) return keys[0];
  const last = keys[keys.length - 1];
  if (t >= last.t) return last;
  let i = 0;
  while (i < keys.length - 2 && keys[i + 1].t <= t) i++;
  const k0 = keys[i],
    k1 = keys[i + 1];
  const u = (t - k0.t) / Math.max(1e-6, k1.t - k0.t);
  return { t, x: k0.x + (k1.x - k0.x) * u, y: k0.y + (k1.y - k0.y) * u, a: lerpAngle(k0.a, k1.a, u) };
}

/** Polilinea -> keyframe a velocità costante, con curve smussate agli angoli. */
function buildKeys(raw: [number, number][], t0: number, minDur: number): Key[] {
  const pts: [number, number][] = [];
  for (const p of raw) {
    const q = pts[pts.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6) pts.push(p);
  }
  if (pts.length < 2) return [{ t: t0, x: pts[0][0], y: pts[0][1], a: 0 }];
  const ang = (i: number) => Math.atan2(pts[i + 1][1] - pts[i][1], pts[i + 1][0] - pts[i][0]);
  const segLen = (i: number) => Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  const out: { x: number; y: number; a: number }[] = [{ x: pts[0][0], y: pts[0][1], a: ang(0) }];
  for (let i = 1; i < pts.length - 1; i++) {
    const aIn = ang(i - 1),
      aOut = ang(i);
    const tl = Math.min(0.55, segLen(i - 1) / 2, segLen(i) / 2);
    out.push({ x: pts[i][0] - Math.cos(aIn) * tl, y: pts[i][1] - Math.sin(aIn) * tl, a: aIn });
    out.push({ x: pts[i][0] + Math.cos(aOut) * tl, y: pts[i][1] + Math.sin(aOut) * tl, a: aOut });
  }
  const n = pts.length - 1;
  out.push({ x: pts[n][0], y: pts[n][1], a: ang(n - 1) });
  let total = 0;
  for (let i = 1; i < out.length; i++) total += Math.hypot(out[i].x - out[i - 1].x, out[i].y - out[i - 1].y);
  const T = Math.max(total / SPEED, minDur, 0.05);
  const v = total / T;
  let t = t0;
  const keys: Key[] = [{ t, ...out[0] }];
  for (let i = 1; i < out.length; i++) {
    t += Math.hypot(out[i].x - out[i - 1].x, out[i].y - out[i - 1].y) / v;
    keys.push({ t, ...out[i] });
  }
  return keys;
}

export class Scene {
  cam = new Camera();
  ctx!: CanvasRenderingContext2D;
  buses: VBus[] = [];
  flights: Flight[] = [];
  boardStarts: number[] = [];
  qiBase = 0;
  lastBoard = 0;
  slotFreeAt: number[] = [];
  bayOwner: number[] = [];
  settleAt = 0;
  K = 5;
  queueShift = 0;
  private lastFrame = 0;
  private cssW = 0;
  private cssH = 0;

  constructor(public level: Level) {}

  // ---------- layout del mondo (coordinate in celle) ----------
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
    return -1.12 - len / 2;
  }
  readonly laneY = -4.75;
  readonly rowsY = [-5.6, -6.15];
  queueSpacing = 0.36;
  perRow() {
    return Math.floor((this.w + 1.6) / this.queueSpacing) + 1;
  }
  queuePos(k: number): [number, number] | null {
    const per = this.perRow();
    const row = Math.floor(k / per);
    const i = k - row * per;
    if (row > 1) return null;
    if (row === 0) return [this.w + 0.8 - i * this.queueSpacing, this.rowsY[0]];
    return [-0.8 + i * this.queueSpacing, this.rowsY[1]];
  }

  resize(cssW: number, cssH: number, top: number, bottom: number) {
    this.cssW = cssW;
    this.cssH = cssH;
    const pad = 10;
    this.cam.fit(-1.4, -6.55, this.w + 1.4, this.h + 1.15, 0.8, pad, top, cssW - pad * 2, cssH - top - bottom);
  }

  // ---------- stato ----------
  rebuild(state: GameState, now: number) {
    this.K = state.slots.length;
    this.buses = this.level.buses.map((b) => ({
      id: b.id,
      color: b.color,
      len: b.len,
      cap: b.cap,
      lotX: b.x + 0.5 + (DX[b.dir] * (b.len - 1)) / 2,
      lotY: b.y + 0.5 + (DY[b.dir] * (b.len - 1)) / 2,
      lotA: DIR_ANG[b.dir],
      slot: -1,
      inKeys: null,
      outKeys: null,
      gone: false,
      filledBase: 0,
      lands: [],
      bump: null,
      shakeAt: -9,
      hintUntil: 0,
    }));
    state.slots.forEach((sb, i) => {
      if (!sb) return;
      const vb = this.buses[sb.id];
      vb.slot = i;
      vb.inKeys = [{ t: -1, x: this.bayX(i), y: this.stallCY(vb.len), a: -Math.PI / 2 }];
      vb.filledBase = sb.filled;
    });
    for (const vb of this.buses) if (state.removed[vb.id] && vb.slot < 0) vb.gone = true;
    this.flights = [];
    this.boardStarts = [];
    this.qiBase = state.qi;
    this.queueShift = state.qi;
    this.lastBoard = now;
    this.slotFreeAt = new Array(this.K).fill(0);
    this.bayOwner = state.slots.map((sb) => (sb ? sb.id : -1));
    this.settleAt = now;
  }

  setStalls(k: number) {
    this.K = k;
    while (this.slotFreeAt.length < k) this.slotFreeAt.push(0);
    while (this.bayOwner.length < k) this.bayOwner.push(-1);
  }

  arriveAt(vb: VBus) {
    return vb.inKeys ? vb.inKeys[vb.inKeys.length - 1].t : Infinity;
  }

  apply(events: GameEvent[], now: number) {
    for (const e of events) {
      const vb = this.buses[e.id];
      if (e.type === 'enter') {
        // stallo libero che si svuota prima
        let bay = -1;
        for (let i = 0; i < this.K; i++)
          if (this.bayOwner[i] < 0 && (bay < 0 || this.slotFreeAt[i] < this.slotFreeAt[bay])) bay = i;
        if (bay < 0) bay = e.slot;
        this.bayOwner[bay] = vb.id;
        vb.slot = bay;
        vb.bump = null;
        const bx = this.bayX(bay);
        const cy = this.stallCY(vb.len);
        const { lotX: x, lotY: y } = vb;
        const W = this.w,
          H = this.h;
        const dir = DIR_ANG.indexOf(vb.lotA);
        let pts: [number, number][];
        if (dir === 0) pts = [[x, y], [x, -0.5], [bx, -0.5], [bx, cy]];
        else if (dir === 1) pts = [[x, y], [W + 0.5, y], [W + 0.5, -0.5], [bx, -0.5], [bx, cy]];
        else if (dir === 3) pts = [[x, y], [-0.5, y], [-0.5, -0.5], [bx, -0.5], [bx, cy]];
        else {
          const side = bx < W / 2 ? -0.5 : W + 0.5;
          pts = [[x, y], [x, H + 0.5], [side, H + 0.5], [side, -0.5], [bx, -0.5], [bx, cy]];
        }
        const minDur = Math.max(0, this.slotFreeAt[bay] + 0.05 - now);
        vb.inKeys = buildKeys(pts, now, minDur);
        this.settleAt = Math.max(this.settleAt, this.arriveAt(vb));
      } else if (e.type === 'board') {
        // più passeggeri in attesa di salire = imbarco più rapido
        const backlog = this.boardStarts.filter((t) => t > now).length;
        const gap = Math.max(0.022, BOARD_GAP - backlog * 0.004);
        const t0 = Math.max(now, this.arriveAt(vb), this.lastBoard + gap);
        this.lastBoard = t0;
        this.boardStarts.push(t0);
        this.flights.push({ color: e.color, t0, t1: t0 + FLY, busId: e.id });
        vb.lands.push(t0 + FLY);
        this.settleAt = Math.max(this.settleAt, t0 + FLY);
      } else {
        const dep = (vb.lands[vb.lands.length - 1] ?? now) + 0.15;
        const bay = vb.slot;
        this.bayOwner[bay] = -1;
        const bx = this.bayX(bay);
        const cy = this.stallCY(vb.len);
        vb.outKeys = buildKeys(
          [
            [bx, cy],
            [bx, this.laneY],
            [this.w + 3.5, this.laneY],
          ],
          dep,
          0,
        );
        this.slotFreeAt[bay] = dep + (cy - this.laneY + vb.len / 2 + 0.4) / SPEED;
        this.settleAt = Math.max(this.settleAt, vb.outKeys[vb.outKeys.length - 1].t);
      }
    }
  }

  bump(id: number, blocker: number, dist: number, now: number) {
    const vb = this.buses[id];
    const dur = 0.18 + 0.05 * dist;
    vb.bump = { t0: now, dur, dist: dist + 0.1 };
    this.buses[blocker].shakeAt = now + dur / 2;
  }

  hint(id: number, now: number) {
    this.buses[id].hintUntil = now + 3;
  }

  /** tutti i passeggeri programmati sono saliti */
  allBoarded(now: number) {
    return now >= this.lastBoard + FLY + 0.3;
  }

  isSettled(now: number) {
    return now >= this.settleAt + 0.15;
  }

  queueLeft(now: number) {
    let n = this.qiBase;
    for (const t of this.boardStarts) if (t <= now) n++;
    return n;
  }

  pose(vb: VBus, now: number): Pose {
    if (vb.gone) return { x: 0, y: 0, a: 0, phase: 'gone', alpha: 0 };
    if (vb.outKeys && now >= vb.outKeys[0].t) {
      const last = vb.outKeys[vb.outKeys.length - 1];
      if (now >= last.t) return { x: 0, y: 0, a: 0, phase: 'gone', alpha: 0 };
      const k = sample(vb.outKeys, now);
      const alpha = Math.max(0, Math.min(1, (this.w + 3.2 - k.x) / 1.8));
      return { x: k.x, y: k.y, a: k.a, phase: 'out', alpha };
    }
    if (vb.inKeys) {
      if (now < this.arriveAt(vb)) {
        const k = sample(vb.inKeys, now);
        return { x: k.x, y: k.y, a: k.a, phase: 'in', alpha: 1 };
      }
      return { x: this.bayX(vb.slot), y: this.stallCY(vb.len), a: -Math.PI / 2, phase: 'stall', alpha: 1 };
    }
    let x = vb.lotX,
      y = vb.lotY;
    const fx = Math.cos(vb.lotA),
      fy = Math.sin(vb.lotA);
    if (vb.bump) {
      const u = (now - vb.bump.t0) / vb.bump.dur;
      if (u >= 1) vb.bump = null;
      else if (u > 0) {
        const d = vb.bump.dist * Math.sin(Math.PI * u);
        x += fx * d;
        y += fy * d;
      }
    }
    const st = now - vb.shakeAt;
    if (st > 0 && st < 0.3) {
      const j = 0.07 * Math.sin(st * 70) * (1 - st / 0.3);
      x += -fy * j;
      y += fx * j;
    }
    return { x, y, a: vb.lotA, phase: 'lot', alpha: 1 };
  }

  // ---------- input ----------
  hit(sx: number, sy: number, now: number): number | null {
    const cands: { id: number; depth: number; hull: [number, number][] }[] = [];
    for (const vb of this.buses) {
      const p = this.pose(vb, now);
      if (p.phase !== 'lot') continue;
      const pts: [number, number][] = [];
      for (const [u, v] of [
        [1, 1],
        [1, -1],
        [-1, -1],
        [-1, 1],
      ]) {
        const [gx, gy] = this.local(p, vb.len, u, v);
        pts.push(this.cam.p(gx, gy, 0), this.cam.p(gx, gy, BUS_H));
      }
      cands.push({ id: vb.id, depth: this.cam.depth(p.x, p.y), hull: convexHull(pts) });
    }
    cands.sort((a, b) => b.depth - a.depth);
    for (const c of cands) if (pointInPoly(sx, sy, c.hull)) return c.id;
    // tolleranza: bus più vicino al punto toccato (sul terreno)
    const [gx, gy] = this.cam.ground(sx, sy + BUS_H * 0.5 * this.cam.zk * this.cam.s);
    let best: number | null = null;
    let bd = 0.75;
    for (const vb of this.buses) {
      if (this.pose(vb, now).phase !== 'lot') continue;
      const fx = Math.cos(vb.lotA),
        fy = Math.sin(vb.lotA);
      // distanza dal segmento centrale del bus
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

  private local(p: { x: number; y: number; a: number }, len: number, u: number, v: number): [number, number] {
    const a = (len - 0.18) / 2,
      b = BUS_W / 2;
    const fx = Math.cos(p.a),
      fy = Math.sin(p.a);
    return [p.x + fx * u * a - fy * v * b, p.y + fy * u * a + fx * v * b];
  }

  // ---------- disegno ----------
  draw(ctx: CanvasRenderingContext2D, now: number) {
    this.ctx = ctx;
    const dt = Math.min(0.1, now - this.lastFrame);
    this.lastFrame = now;
    const target = this.queueLeft(now);
    this.queueShift += (target - this.queueShift) * Math.min(1, dt * 14);
    if (Math.abs(target - this.queueShift) < 0.01) this.queueShift = target;

    const g = ctx.createLinearGradient(0, 0, 0, this.cssH);
    g.addColorStop(0, '#a7e08a');
    g.addColorStop(1, '#6fc275');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.cssW, this.cssH);
    this.drawGround(now);

    const items: Drawable[] = [];
    for (const vb of this.buses) {
      const p = this.pose(vb, now);
      if (p.phase === 'gone') continue;
      const xs: number[] = [],
        ys: number[] = [];
      for (const [u, v] of [
        [1, 1],
        [1, -1],
        [-1, -1],
        [-1, 1],
      ]) {
        const [gx, gy] = this.local(p, vb.len, u, v);
        xs.push(gx);
        ys.push(gy);
      }
      items.push({
        minX: Math.min(...xs),
        maxX: Math.max(...xs),
        minY: Math.min(...ys),
        maxY: Math.max(...ys),
        depth: this.cam.depth(p.x, p.y),
        draw: () => this.drawBus(vb, p, now),
      });
    }
    // coda
    const total = this.level.queue.length;
    const startK = Math.max(this.qiBase, Math.floor(this.queueShift) - 1);
    for (let k = startK; k < total; k++) {
      if (k < target) continue;
      const pos = this.queuePos(k - this.queueShift);
      if (!pos) break;
      const color = this.level.queue[k];
      const [x, y] = pos;
      items.push({
        minX: x - 0.1,
        maxX: x + 0.1,
        minY: y - 0.1,
        maxY: y + 0.1,
        depth: this.cam.depth(x, y),
        draw: () => this.drawPerson(x, y, 0, color, 1),
      });
    }
    const sn = Math.sin(this.cam.yaw);
    items.sort((A, B) => {
      if (A.maxY <= B.minY + 1e-3) return -1;
      if (B.maxY <= A.minY + 1e-3) return 1;
      if (A.maxX <= B.minX + 1e-3) return sn >= 0 ? -1 : 1;
      if (B.maxX <= A.minX + 1e-3) return sn >= 0 ? 1 : -1;
      return A.depth - B.depth;
    });
    for (const it of items) it.draw();

    // passeggeri in volo
    const head = this.queuePos(0)!;
    this.flights = this.flights.filter((f) => now < f.t1 + 0.05);
    for (const f of this.flights) {
      if (now < f.t0) continue;
      const u = Math.min(1, (now - f.t0) / (f.t1 - f.t0));
      const p = this.pose(this.buses[f.busId], now);
      const x = head[0] + (p.x - head[0]) * u;
      const y = head[1] + (p.y - head[1]) * u;
      const z = 0.75 * u + Math.sin(Math.PI * u) * 1.1;
      this.drawPerson(x, y, z, f.color, 1 - u * 0.3);
    }
  }

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
      ctx.stroke();
    }
  }

  private rect(x0: number, y0: number, x1: number, y1: number, fill: string, z = 0) {
    const c = this.cam;
    this.poly([c.p(x0, y0, z), c.p(x1, y0, z), c.p(x1, y1, z), c.p(x0, y1, z)], fill);
  }

  /** lastra rialzata (marciapiedi, piazzole) */
  private slab(x0: number, y0: number, x1: number, y1: number, hgt: number, color: string) {
    const c = this.cam;
    const faces: [number, number, number, number, number, number][] = [
      [x0, y1, x1, y1, 0, 1],
      [x1, y0, x1, y1, 1, 0],
      [x0, y0, x0, y1, -1, 0],
      [x0, y0, x1, y0, 0, -1],
    ];
    for (const [ax, ay, bx, by, nx, ny] of faces) {
      if (!c.faceVisible(nx, ny)) continue;
      this.poly([c.p(ax, ay, 0), c.p(bx, by, 0), c.p(bx, by, hgt), c.p(ax, ay, hgt)], shade(color, 0.25));
    }
    this.rect(x0, y0, x1, y1, color, hgt);
  }

  private dashes(x0: number, y0: number, x1: number, y1: number) {
    const c = this.cam;
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = Math.max(1, c.s * 0.05);
    ctx.setLineDash([c.s * 0.28, c.s * 0.22]);
    ctx.beginPath();
    const a = c.p(x0, y0),
      b = c.p(x1, y1);
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.stroke();
    ctx.restore();
  }

  private drawGround(now: number) {
    const W = this.w,
      H = this.h;
    const c = this.cam;
    const ctx = this.ctx;
    // marciapiede della coda
    this.slab(-1.35, -6.55, W + 1.35, -5.18, 0.1, '#e7e5e4');
    // corsia di uscita + anello stradale
    this.rect(-1.35, -5.18, W + 3.6, -4.3, '#4b5563');
    this.dashes(-1.2, this.laneY, W + 3.5, this.laneY);
    this.rect(-1, -1, W + 1, H + 1, '#4b5563');
    // piazzole degli stalli
    this.slab(-1, -4.3, W + 1, -1, 0.06, '#d6d3d1');
    const bw = this.bayW();
    ctx.save();
    ctx.strokeStyle = '#eab308';
    ctx.lineWidth = Math.max(1.5, c.s * 0.07);
    for (let i = 0; i <= this.K; i++) {
      const x = -1 + bw * i;
      const a = c.p(x, -1, 0.06),
        b = c.p(x, -4.1, 0.06);
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
    }
    ctx.restore();
    // stalli che si libereranno a breve: bordo pulsante
    for (let i = 0; i < this.K; i++) {
      const busy = this.buses.some((vb) => vb.slot === i && !vb.gone && !(vb.outKeys && now >= vb.outKeys[0].t));
      if (!busy) this.rect(-1 + bw * i + 0.12, -4.1, -1 + bw * (i + 1) - 0.12, -1.15, 'rgba(255,255,255,0.35)', 0.06);
    }
    // segnaletica strada
    this.dashes(-0.5, -0.5, W + 0.5, -0.5);
    this.dashes(-0.5, H + 0.5, W + 0.5, H + 0.5);
    this.dashes(-0.5, -0.5, -0.5, H + 0.5);
    this.dashes(W + 0.5, -0.5, W + 0.5, H + 0.5);
    // parcheggio
    this.slab(0, 0, W, H, 0.04, '#9ca3af');
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 1; x < W; x++) {
      const a = c.p(x, 0, 0.04),
        b = c.p(x, H, 0.04);
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
    }
    for (let y = 1; y < H; y++) {
      const a = c.p(0, y, 0.04),
        b = c.p(W, y, 0.04);
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
    }
    ctx.stroke();
    ctx.restore();
  }

  private drawBus(vb: VBus, p: Pose, now: number) {
    const ctx = this.ctx;
    const c = this.cam;
    const base = PALETTE[vb.color];
    ctx.save();
    ctx.globalAlpha = p.alpha;
    const L = (u: number, v: number) => this.local(p, vb.len, u, v);
    const corners = [L(1, 1), L(1, -1), L(-1, -1), L(-1, 1)];
    // ombra
    this.poly(
      corners.map(([x, y]) => c.p(x + 0.1, y + 0.12, 0)),
      'rgba(0,0,0,0.22)',
    );
    const z0 = 0.06,
      z1 = BUS_H;
    const fx = Math.cos(p.a),
      fy = Math.sin(p.a);
    // facce: [A, B, normale, tipo]
    const faces: [[number, number], [number, number], number, number, 'front' | 'side' | 'back'][] = [
      [corners[1], corners[0], fx, fy, 'front'],
      [corners[0], corners[3], -fy, fx, 'side'],
      [corners[3], corners[2], -fx, -fy, 'back'],
      [corners[2], corners[1], fy, -fx, 'side'],
    ];
    const at = (A: [number, number], B: [number, number], t: number, z: number) =>
      c.p(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, z);
    const quad = (A: [number, number], B: [number, number], t0: number, t1: number, za: number, zb: number, fill: string) =>
      this.poly([at(A, B, t0, za), at(A, B, t1, za), at(A, B, t1, zb), at(A, B, t0, zb)], fill);

    for (const [A, B, nx, ny, kind] of faces) {
      if (!c.faceVisible(nx, ny)) continue;
      const facing = nx * Math.sin(c.yaw) + ny * Math.cos(c.yaw);
      quad(A, B, 0, 1, z0, z1, shade(base, 0.34 - 0.16 * facing));
      quad(A, B, 0, 1, z0, z0 + 0.1, 'rgba(0,0,0,0.35)');
      const glass = '#1e293b';
      if (kind === 'front') {
        quad(A, B, 0.1, 0.9, 0.36, 0.63, glass);
        quad(A, B, 0.12, 0.3, 0.38, 0.45, 'rgba(255,255,255,0.35)');
        quad(A, B, 0.08, 0.22, 0.2, 0.28, '#fef9c3');
        quad(A, B, 0.78, 0.92, 0.2, 0.28, '#fef9c3');
      } else if (kind === 'back') {
        quad(A, B, 0.2, 0.8, 0.45, 0.62, glass);
      } else {
        const n = vb.len * 2 - 1;
        const span = 0.84 / n;
        for (let k = 0; k < n; k++) quad(A, B, 0.08 + k * span + 0.02, 0.08 + (k + 1) * span - 0.02, 0.4, 0.6, glass);
        // ruote
        ctx.fillStyle = '#111827';
        for (const t of vb.len === 3 ? [0.15, 0.85] : [0.2, 0.8]) {
          const [wx, wy] = at(A, B, t, 0.1);
          ctx.beginPath();
          ctx.ellipse(wx, wy, c.s * 0.11, c.s * 0.11 * c.zk, 0, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    // tetto
    const roof = corners.map(([x, y]) => c.p(x, y, z1));
    this.poly(roof, shade(base, -0.12));
    const inner = [L(0.9, 0.78), L(0.9, -0.78), L(-0.9, -0.78), L(-0.9, 0.78)].map(([x, y]) => c.p(x, y, z1));
    this.poly(inner, shade(base, -0.28));

    const a = (vb.len - 0.18) / 2;
    if (p.phase === 'lot' || p.phase === 'in') {
      // freccia sulla direzione di marcia
      const arrow: [number, number][] = [
        [0.72, 0],
        [0.12, 0.62],
        [0.12, 0.26],
        [-0.62, 0.26],
        [-0.62, -0.26],
        [0.12, -0.26],
        [0.12, -0.62],
      ];
      const scaleU = Math.min(1, 1.1 / a);
      this.poly(
        arrow.map(([u, v]) => {
          const [x, y] = L(u * scaleU, v);
          return c.p(x, y, z1);
        }),
        'rgba(255,255,255,0.92)',
        shade(base, 0.35),
        1,
      );
    } else {
      // posti: pieni/vuoti
      const filled = vb.filledBase + vb.lands.filter((t) => t <= now).length;
      const cols = vb.cap / 2;
      const r = Math.min(0.13, (0.75 * a) / cols) * c.s;
      let k = 0;
      for (let i = 0; i < cols; i++) {
        for (const v of [-0.42, 0.42]) {
          const u = -0.8 + (1.6 * (i + 0.5)) / cols;
          const [x, y] = L(u, v);
          const [sx, sy] = c.p(x, y, z1);
          ctx.beginPath();
          ctx.ellipse(sx, sy, r, r * c.squash, 0, 0, Math.PI * 2);
          ctx.fillStyle = k < filled ? '#ffffff' : 'rgba(0,0,0,0.28)';
          ctx.fill();
          if (k < filled) {
            ctx.strokeStyle = shade(base, 0.4);
            ctx.lineWidth = 1.5;
            ctx.stroke();
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
      ctx.lineWidth = 3 + pulse * 3;
      ctx.strokeStyle = `rgba(255,255,255,${0.6 + 0.4 * pulse})`;
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawPerson(x: number, y: number, z: number, color: number, alpha: number) {
    const ctx = this.ctx;
    const c = this.cam;
    const s = c.s;
    const base = PALETTE[color];
    ctx.save();
    ctx.globalAlpha = alpha;
    if (z > 0.05) {
      const [gx, gy] = c.p(x, y, 0);
      ctx.fillStyle = 'rgba(0,0,0,0.15)';
      ctx.beginPath();
      ctx.ellipse(gx, gy, s * 0.1, s * 0.1 * c.squash, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    const [px, py] = c.p(x, y, z + 0.1);
    const bw = s * 0.2,
      bh = s * 0.3 * c.zk;
    ctx.fillStyle = shade(base, 0.05);
    ctx.strokeStyle = shade(base, 0.45);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(px - bw / 2, py - bh, bw, bh, bw * 0.45);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(px, py - bh - s * 0.08, s * 0.085, 0, Math.PI * 2);
    ctx.fillStyle = shade(base, -0.45);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
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
