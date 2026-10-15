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
import { Bus, CAPACITY, DX, DY, Dir, Level, busCells, pathCells } from './types';

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
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

// Dente di sega su blocchi di 10 livelli: salita, livello "respiro", boss al decimo.
const SAW = [0, 0.15, 0.3, 0.1, 0.4, 0.55, 0.2, 0.65, 0.78, 1];

export function difficultyForLevel(n: number): number {
  const intro = Math.min(1, (n - 1) / 15); // i primi livelli non hanno picchi
  const ramp = 1 - Math.exp(-(n - 1) / 70);
  return clamp01(0.03 + 0.62 * ramp + 0.35 * SAW[(n - 1) % 10] * intro);
}

export function paramsForLevel(n: number): GenParams {
  const d = difficultyForLevel(n);
  const stalls = d > 0.75 ? 4 : 5;
  return {
    difficulty: d,
    w: Math.round(lerp(4, 7, Math.sqrt(d))),
    h: Math.round(lerp(5, 10, Math.sqrt(d))),
    targetBuses: Math.round(lerp(5, 28, Math.sqrt(d))),
    longRatio: lerp(0.15, 0.5, d),
    colors: Math.round(lerp(2, 6, d)),
    stalls,
    maxOcc: Math.max(1, Math.min(stalls, Math.round(lerp(2, stalls + 0.4, d)))),
    pRelease: lerp(0.25, 0.9, d),
    lateBias: lerp(0, 0.8, d),
    blockBias: lerp(0.3, 0.95, d),
    targetWinRate: lerp(0.97, 0.15, d),
    candidates: n <= 3 ? 3 : 18,
    playouts: 80,
  };
}

/** Passo 1: piazzamento inverso. Restituisce i bus in ordine di piazzamento. */
function placeBuses(rng: Rng, p: GenParams): Bus[] {
  const { w, h } = p;
  const grid = new Int16Array(w * h).fill(-1);
  const pathCount = new Int16Array(w * h); // quante strade d'uscita passano da ogni cella
  const buses: Bus[] = [];
  let fails = 0;

  while (buses.length < p.targetBuses && fails < 300) {
    let best: Bus | null = null;
    let bestScore = -1;
    let firstValid: Bus | null = null;
    for (let k = 0; k < 14; k++) {
      const len = rng() < p.longRatio ? 3 : 2;
      const dir = randInt(rng, 4) as Dir;
      const x = randInt(rng, w);
      const y = randInt(rng, h);
      const cand: Bus = { id: buses.length, x, y, dir, len, color: 0, cap: CAPACITY[len] };
      const cells = busCells(cand);
      if (!cells.every(([cx, cy]) => cx >= 0 && cy >= 0 && cx < w && cy < h && grid[cy * w + cx] < 0)) continue;
      // la strada davanti deve essere libera dai bus piazzati prima
      if (!pathCells(cand, w, h).every(([cx, cy]) => grid[cy * w + cx] < 0)) continue;
      const score = cells.reduce((s, [cx, cy]) => s + pathCount[cy * w + cx], 0) + rng() * 0.5;
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
    for (const [cx, cy] of busCells(chosen)) grid[cy * w + cx] = chosen.id;
    for (const [cx, cy] of pathCells(chosen, w, h)) pathCount[cy * w + cx]++;
    buses.push(chosen);
  }
  return buses;
}

/** Catena di blocchi più lunga (profondità del grafo "chi deve uscire prima di chi"). */
function longestChain(board: Board): number {
  const n = board.level.buses.length;
  const memo = new Array<number>(n).fill(-1);
  const depth = (i: number): number => {
    if (memo[i] >= 0) return memo[i];
    let d = 1;
    for (const b of board.blockers[i]) d = Math.max(d, 1 + depth(b));
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
    for (let i = 0; i < n; i++) if (!removed[i] && board.blockers[i].every((b) => removed[b])) free.push(i);
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

/** Giocatore simulato "ragionevole ma distratto": misura la difficoltà percepita. */
export function playout(board: Board, rng: Rng): boolean {
  const { level } = board;
  const s = initialState(level);
  while (s.status === 'playing') {
    const free = board.freeBuses(s);
    if (!free.length) return false;
    const front = level.queue[s.qi];
    const r = rng();
    const match = free.filter((id) => level.buses[id].color === front);
    let id: number;
    if (match.length && r < 0.75) id = pick(rng, match);
    else {
      const soon = new Set(level.queue.slice(s.qi, s.qi + 6));
      const near = free.filter((i) => soon.has(level.buses[i].color));
      id = near.length && r < 0.9 ? pick(rng, near) : pick(rng, free);
    }
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
  const placed = placeBuses(rng, p);
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
    w: p.w,
    h: p.h,
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
    const gap = Math.abs(lvl.stats.winRate - p.targetWinRate) + Math.max(0, p.targetBuses - lvl.buses.length) * 0.02;
    if (gap < bestGap) {
      bestGap = gap;
      best = lvl;
    }
  }
  if (!best) throw new Error(`Impossibile generare il livello ${n}`);
  best.stats.candidates = p.candidates;
  return best;
}
