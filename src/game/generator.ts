// Generatore di livelli a difficoltà crescente.
//
// 1. Piazzamento inverso: ogni nuovo bus deve avere la strada libera rispetto ai bus
//    piazzati PRIMA di lui. Può però bloccare quelli precedenti. Quindi l'ordine inverso
//    di piazzamento è sempre un'uscita valida: niente incastri circolari.
// 2. Si sceglie un ordine d'uscita compatibile con i blocchi e si costruisce la coda
//    simulando quell'ordine con al massimo `maxOcc` stalli occupati: il livello è
//    risolvibile per costruzione.
// 3. Si generano più candidati e si tiene quello la cui % di vittoria di un giocatore
//    simulato è più vicina all'obiettivo del livello.
import { Board, initialState, tap } from './engine';
import { Rng, mulberry32, randInt, pick, shuffle } from './rng';
import { Bus, CAPACITY, Dir, Garage, Level, busCells, pathCells, toWorld } from './types';

export interface GenParams {
  difficulty: number;
  w: number;
  h: number;
  targetBuses: number;
  longRatio: number; // quota di bus lunghi (3 celle)
  colors: number;
  stalls: number;
  maxOcc: number; // stalli che la soluzione prevista tiene occupati al massimo
  pRelease: number; // quanto "presto" la soluzione prevista fa uscire i bus
  lateBias: number; // quanto la coda chiede colori di bus arrivati per ultimi
  blockBias: number; // quanto il piazzamento cerca di creare blocchi
  targetWinRate: number;
  candidates: number;
  playouts: number;
  /** parcheggio ruotato di 45° */
  diagonal: boolean;
  /** forma del parcheggio */
  shape: string;
  garages: number;
  garageCars: number;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

// Dente di sega su blocchi di 10 livelli: salita, livello "respiro", boss al decimo.
const SAW = [0, 0.2, 0.4, 0.1, 0.5, 0.65, 0.25, 0.75, 0.85, 1];

/**
 * Difficoltà 0..1.3: sale in fretta (sfida vera già verso il livello 30) e oltre il 100
 * entra in "overdrive" (>1), dove gli stalli scendono a 3 e i colori aumentano.
 */
export function difficultyForLevel(n: number): number {
  const intro = Math.min(1, (n - 1) / 8); // i primissimi livelli non hanno picchi
  const ramp = 1 - Math.exp(-(n - 1) / 22);
  const overdrive = 0.3 * Math.min(1, Math.max(0, n - 100) / 300);
  const d = 0.06 + 0.64 * ramp + 0.3 * SAW[(n - 1) % 10] * intro + overdrive;
  return Math.max(0, Math.min(1.3, d));
}

export function paramsForLevel(n: number): GenParams {
  const d = difficultyForLevel(n);
  const t = clamp01(d); // parte "normale" della curva
  const o = clamp01((d - 1) / 0.3); // parte overdrive
  const stalls = d > 1.15 ? 3 : d > 0.55 ? 4 : 5;
  return {
    difficulty: d,
    w: Math.round(lerp(4, 7, Math.sqrt(t))),
    h: Math.round(lerp(5, 10, Math.sqrt(t)) + o),
    targetBuses: Math.round(lerp(5, 28, Math.sqrt(t)) + 4 * o),
    longRatio: lerp(0.15, 0.55, t),
    colors: Math.round(lerp(2, 6, t) + o),
    stalls,
    maxOcc: Math.max(1, Math.min(stalls, Math.round(lerp(2, stalls + 0.6, t)))),
    pRelease: lerp(0.3, 0.95, t),
    lateBias: lerp(0, 0.9, t),
    blockBias: lerp(0.35, 1, t),
    targetWinRate: Math.max(0.03, lerp(1, 0.12, t) - 0.08 * o),
    candidates: n <= 3 ? 3 : Math.round(lerp(10, 28, t)),
    playouts: 60,
    ...structureForLevel(n, t, o),
  };
}

const SHAPES = ['rect', 'blob', 'ring', 'diamond', 'twin', 'blob', 'hourglass'];

/** Forma, orientamento e garage: varia di livello in livello (deterministico). */
function structureForLevel(n: number, t: number, o: number) {
  const r = mulberry32(n * 2654435761 + 97);
  if (n <= 3) return { diagonal: false, shape: 'rect', garages: 0, garageCars: 0 };
  if (n === 4) return { diagonal: true, shape: 'rect', garages: 0, garageCars: 0 };
  const diagonal = r() < 0.6;
  const shape = n < 7 ? (r() < 0.5 ? 'rect' : 'blob') : pick(r, SHAPES);
  let garages = 0;
  if (n === 8) garages = 1; // primo garage: livello di presentazione
  else if (n > 8) garages = (r() < 0.25 + 0.5 * t ? 1 : 0) + (t > 0.6 && r() < 0.4 ? 1 : 0) + (o > 0.3 ? 1 : 0);
  return { diagonal, shape, garages, garageCars: Math.round(lerp(2, 4, t)) + (r() < 0.3 ? 1 : 0) };
}

interface Layout {
  w: number;
  h: number;
  gw: number;
  gh: number;
  theta: number;
  tx: number;
  ty: number;
  mask: number[];
  cells: number;
}

/** Celle della griglia che stanno dentro la forma scelta, nel riquadro w × h del mondo. */
function buildLayout(rng: Rng, p: GenParams): Layout {
  // forme ruotate o irregolari perdono celle ai bordi: riquadro un po' più grande
  const grow = p.diagonal || p.shape !== 'rect' ? 1 : 0;
  const W = Math.min(8, p.w + grow),
    H = Math.min(11, p.h + grow);
  const theta = p.diagonal ? Math.PI / 4 : 0;
  let gw = W,
    gh = H,
    tx = 0,
    ty = 0;
  if (p.diagonal) {
    const N = Math.ceil((W + H) / Math.SQRT2) + 2;
    gw = gh = N;
    // il centro della griglia va al centro del riquadro
    const [cx, cy] = toWorld({ theta, tx: 0, ty: 0 }, N / 2, N / 2);
    tx = W / 2 - cx;
    ty = H / 2 - cy;
  }
  const circles: [number, number, number][] = [];
  for (let i = 0; i < 4; i++) circles.push([(rng() - 0.5) * 0.9, (rng() - 0.5) * 0.9, 0.55 + rng() * 0.3]);
  const inside = (u: number, v: number): boolean => {
    switch (p.shape) {
      case 'blob':
        return circles.some(([a, b, r]) => (u - a) ** 2 + (v - b) ** 2 < r * r) && Math.abs(u) < 1 && Math.abs(v) < 1;
      case 'ring':
        return u * u + v * v < 1.15 && u * u + v * v > 0.16;
      case 'diamond':
        return Math.abs(u) + Math.abs(v) < 1.25;
      case 'twin':
        return (u + 0.4) ** 2 + (v + 0.45) ** 2 < 0.42 || (u - 0.4) ** 2 + (v - 0.45) ** 2 < 0.42 || Math.abs(u + v) < 0.35;
      case 'hourglass':
        return Math.abs(u) < 0.32 + 0.68 * Math.abs(v);
      default:
        return true;
    }
  };
  const m = p.diagonal ? 0.6 : 0.5;
  const build = (useShape: boolean) => {
    const mask = new Array<number>(gw * gh).fill(0);
    let cells = 0;
    for (let y = 0; y < gh; y++)
      for (let x = 0; x < gw; x++) {
        const [wx, wy] = toWorld({ theta, tx, ty }, x + 0.5, y + 0.5);
        if (wx < m - 1e-6 || wy < m - 1e-6 || wx > W - m + 1e-6 || wy > H - m + 1e-6) continue;
        if (useShape && !inside((wx - W / 2) / (W / 2), (wy - H / 2) / (H / 2))) continue;
        mask[y * gw + x] = 1;
        cells++;
      }
    return { mask, cells };
  };
  let { mask, cells } = build(true);
  if (cells < W * H * 0.45) ({ mask, cells } = build(false)); // forma troppo piccola: torna al riquadro pieno
  return { w: W, h: H, gw, gh, theta, tx, ty, mask, cells };
}

/**
 * Passo 1: piazzamento inverso. Prima i garage (i loro muri non si spostano mai, quindi
 * nessuna strada d'uscita può attraversarli), poi i bus. Restituisce garage e bus;
 * i bus nascosti nei garage condividono le celle davanti al garage.
 */
function placeBuses(rng: Rng, p: GenParams, L: Layout): { buses: Bus[]; garages: Garage[] } {
  const { gw, gh, mask } = L;
  const EMPTY = -1,
    WALL = -2;
  const grid = new Int32Array(gw * gh).fill(EMPTY);
  const pathCount = new Int16Array(gw * gh);
  const buses: Bus[] = [];
  const garages: Garage[] = [];
  const inMaskFree = (cells: [number, number][]) =>
    cells.every(([cx, cy]) => cx >= 0 && cy >= 0 && cx < gw && cy < gh && mask[cy * gw + cx] === 1 && grid[cy * gw + cx] === EMPTY);
  const pathClear = (b: Pick<Bus, 'x' | 'y' | 'dir' | 'len'>) => pathCells(b, gw, gh).every(([cx, cy]) => grid[cy * gw + cx] === EMPTY);

  // garage: 2 celle di muro + 2 celle davanti dove compare il bus
  for (let g = 0; g < p.garages; g++) {
    for (let k = 0; k < 120; k++) {
      const dir = randInt(rng, 4) as Dir;
      const x = randInt(rng, gw),
        y = randInt(rng, gh);
      const body = { x, y, dir, len: 2 };
      const front = { x: x + DXY[dir][0] * 2, y: y + DXY[dir][1] * 2, dir, len: 2 };
      if (!inMaskFree([...busCells(body), ...busCells(front)]) || !pathClear(front)) continue;
      const gar: Garage = { id: g, ...body, cars: [] };
      for (const [cx, cy] of busCells(body)) grid[cy * gw + cx] = WALL;
      for (let c = 0; c < p.garageCars; c++) {
        const bus: Bus = { id: buses.length, ...front, color: 0, cap: CAPACITY[2], garage: g, prev: c ? buses.length - 1 : -1 };
        gar.cars.push(bus.id);
        buses.push(bus);
      }
      for (const [cx, cy] of busCells(front)) grid[cy * gw + cx] = gar.cars[0];
      for (const [cx, cy] of pathCells(front, gw, gh)) pathCount[cy * gw + cx]++;
      garages.push(gar);
      break;
    }
  }

  const target = buses.length + Math.round((p.targetBuses * L.cells) / (p.w * p.h));
  let fails = 0;
  while (buses.length < target && fails < 400) {
    let best: Bus | null = null;
    let bestScore = -1;
    let firstValid: Bus | null = null;
    for (let k = 0; k < 24; k++) {
      const len = rng() < p.longRatio ? 3 : 2;
      const dir = randInt(rng, 4) as Dir;
      const cand: Bus = { id: buses.length, x: randInt(rng, gw), y: randInt(rng, gh), dir, len, color: 0, cap: CAPACITY[len] };
      const cells = busCells(cand);
      // celle libere e dentro la forma, strada davanti libera dai bus piazzati prima
      if (!inMaskFree(cells) || !pathClear(cand)) continue;
      const score = cells.reduce((acc, [cx, cy]) => acc + pathCount[cy * gw + cx], 0) + rng() * 0.5;
      if (!firstValid) firstValid = cand;
      if (score > bestScore) {
        bestScore = score;
        best = cand;
      }
    }
    const chosen = rng() < p.blockBias ? best : firstValid;
    if (!chosen) {
      fails++;
      continue;
    }
    for (const [cx, cy] of busCells(chosen)) grid[cy * gw + cx] = chosen.id;
    for (const [cx, cy] of pathCells(chosen, gw, gh)) pathCount[cy * gw + cx]++;
    buses.push(chosen);
  }
  return { buses, garages };
}

const DXY: [number, number][] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

/** Catena di blocchi più lunga (profondità del grafo "chi deve uscire prima di chi"). */
function longestChain(board: Board): number {
  const n = board.level.buses.length;
  const memo = new Array<number>(n).fill(-1);
  const depth = (i: number): number => {
    if (memo[i] >= 0) return memo[i];
    let d = 1;
    for (const b of board.deps[i]) d = Math.max(d, 1 + depth(b));
    return (memo[i] = d);
  };
  let m = 0;
  for (let i = 0; i < n; i++) m = Math.max(m, depth(i));
  return m;
}

/** Ordine di uscita casuale compatibile con i blocchi (estensione lineare casuale). */
function randomExitOrder(rng: Rng, board: Board): number[] {
  const n = board.level.buses.length;
  const out: number[] = [];
  const removed = new Array<boolean>(n).fill(false);
  while (out.length < n) {
    const free: number[] = [];
    for (let i = 0; i < n; i++) if (!removed[i] && board.deps[i].every((b) => removed[b])) free.push(i);
    const id = pick(rng, free);
    removed[id] = true;
    out.push(id);
  }
  return out;
}

/** Passo 2: costruisce la coda simulando l'ordine d'uscita previsto. */
function buildQueue(rng: Rng, order: Bus[], p: GenParams): number[] {
  const waiting: { color: number; rem: number }[] = [];
  const q: number[] = [];
  let next = 0;
  const occLimit = Math.min(p.maxOcc, p.stalls);
  while (next < order.length || waiting.length) {
    const mustRelease = waiting.length === 0;
    const canRelease = next < order.length && waiting.length < occLimit;
    if (mustRelease || (canRelease && rng() < p.pRelease)) {
      const b = order[next++];
      waiting.push({ color: b.color, rem: b.cap });
      continue;
    }
    // chiede un colore tra i bus in attesa: i livelli difficili preferiscono quelli arrivati per ultimi
    const idx = rng() < p.lateBias ? waiting.length - 1 - randInt(rng, Math.min(2, waiting.length)) : 0;
    const c = waiting[idx].color;
    const j = waiting.findIndex((x) => x.color === c); // come nel gioco: sale sul primo arrivato
    waiting[j].rem--;
    q.push(c);
    if (waiting[j].rem === 0) waiting.splice(j, 1);
  }
  return q;
}

/**
 * Giocatore simulato "esperto ma umano": non fa mai una mossa che perde subito,
 * preferisce il colore in testa alla coda e quelli richiesti a breve, ma non
 * calcola in profondità e ogni tanto sceglie a istinto. La sua % di vittorie
 * misura la difficoltà percepita.
 */
export function playout(board: Board, rng: Rng): boolean {
  const { level } = board;
  const s = initialState(level);
  while (s.status === 'playing') {
    const free = board.freeBuses(s);
    if (!free.length) return false;
    const look = level.queue.slice(s.qi, s.qi + 10);
    const freeSlots = s.slots.filter((x) => x === null).length;
    const scored = free.map((id) => {
      const c = level.buses[id].color;
      const i = look.indexOf(c);
      let score = i < 0 ? 12 : i; // prima arriva il colore, meglio è
      // con un solo stallo libero, un colore sbagliato fa perdere subito
      if (freeSlots === 1 && c !== look[0]) score += 100;
      return { id, score: score + rng() * 3 };
    });
    scored.sort((a, b) => a.score - b.score);
    const id = rng() < 0.85 ? scored[0].id : scored[Math.min(scored.length - 1, 1 + Math.floor(rng() * 2))].id;
    tap(board, s, id);
  }
  return s.status === 'won';
}

export function winRate(board: Board, seed: number, playouts: number): number {
  const rng = mulberry32(seed);
  let wins = 0;
  for (let i = 0; i < playouts; i++) if (playout(board, rng)) wins++;
  return wins / playouts;
}

/** Verifica che la soluzione prevista vinca davvero nel motore di gioco. */
export function replayWins(level: Level, moves: number[]): boolean {
  const board = new Board(level);
  const s = initialState(level);
  for (const id of moves) {
    if (tap(board, s, id).kind !== 'moved') return false;
  }
  return s.status === 'won';
}

function buildCandidate(rng: Rng, p: GenParams, n: number, seed: number): Level {
  const L = buildLayout(rng, p);
  const { buses: placed, garages } = placeBuses(rng, p, L);
  const colors = Math.min(p.colors, placed.length);
  const palette = shuffle(rng, [0, 1, 2, 3, 4, 5, 6, 7]).slice(0, colors);
  const colorBag = shuffle(
    rng,
    placed.map((_, i) => palette[i % colors]),
  );
  const buses = placed.map((b, i) => ({ ...b, color: colorBag[i] }));
  const level: Level = {
    number: n,
    seed,
    w: L.w,
    h: L.h,
    gw: L.gw,
    gh: L.gh,
    theta: L.theta,
    tx: L.tx,
    ty: L.ty,
    mask: L.mask,
    shape: p.shape,
    garages,
    stalls: p.stalls,
    buses,
    queue: [],
    solution: [],
    stats: { difficulty: p.difficulty, winRate: 1, targetWinRate: p.targetWinRate, maxChain: 0, candidates: 0 },
  };
  const board = new Board(level);
  const order = randomExitOrder(rng, board);
  level.queue = buildQueue(rng, order.map((i) => buses[i]), p);
  level.solution = order;
  level.stats.maxChain = longestChain(board);
  return level;
}

export function generateLevel(n: number, override?: Partial<GenParams>): Level {
  const p = { ...paramsForLevel(n), ...override };
  const seed = (n * 7919 + 1013) >>> 0;
  const rng = mulberry32(seed);
  let best: Level | null = null;
  let bestGap = Infinity;
  for (let c = 0; c < p.candidates; c++) {
    const lvl = buildCandidate(rng, p, n, seed);
    if (!replayWins(lvl, lvl.solution)) continue; // non dovrebbe mai succedere: è una rete di sicurezza
    const board = new Board(lvl);
    lvl.stats.winRate = winRate(board, seed + c, p.playouts);
    // penalizza livelli con pochi bus rispetto all'obiettivo (griglia troppo piena)
    const gap = Math.abs(lvl.stats.winRate - p.targetWinRate) + Math.max(0, p.targetBuses * 0.7 - lvl.buses.length) * 0.02;
    if (gap < bestGap) {
      bestGap = gap;
      best = lvl;
    }
  }
  if (!best) throw new Error(`Impossibile generare il livello ${n}`);
  best.stats.candidates = p.candidates;
  return best;
}
