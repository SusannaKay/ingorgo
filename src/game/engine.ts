// Logica di gioco pura: nessuna dipendenza dalla grafica.
// La usano il gioco, il generatore, il solver e lo script di verifica.
//
// Due mosse:
// - tocco: il bus esce seguendo la freccia, se la strada fino al bordo è libera;
// - scorrimento: il bus scivola di una cella in una delle 4 direzioni, se le celle
//   d'arrivo sono libere e dentro il parcheggio (come nel gioco del 15).
// I garage fanno uscire il bus successivo appena le 2 celle davanti si liberano.
import { DX, DY, Dir, Level, busCells } from './types';

export interface StallBus {
  id: number;
  color: number;
  cap: number;
  filled: number;
  /** ordine di arrivo: a parità di colore si riempie prima il bus arrivato prima */
  order: number;
}

export type Status = 'playing' | 'won' | 'lost';

/** contenuto di una cella della griglia */
export const EMPTY = -1;
export const WALL = -2; // muro di un garage o fioriera: blocca tutto
export const OUT = -3; // fuori dalla forma del parcheggio: ci si passa uscendo, non ci si parcheggia

export interface GameState {
  px: number[];
  py: number[];
  grid: Int16Array;
  /** ancora dentro il garage */
  hidden: boolean[];
  removed: boolean[];
  remaining: number;
  slots: (StallBus | null)[];
  qi: number;
  arrivals: number;
  status: Status;
  moves: number;
  extraUsed: boolean;
  liftUsed: boolean;
}

export type GameEvent =
  | { type: 'enter'; id: number; slot: number }
  | { type: 'board'; id: number; slot: number; color: number }
  | { type: 'depart'; id: number; slot: number }
  | { type: 'slide'; id: number; dir: Dir }
  | { type: 'emerge'; id: number };

export type TapResult =
  | { kind: 'moved'; events: GameEvent[] }
  | { kind: 'blocked'; blocker: number; dist: number }
  | { kind: 'ignored' };

export type SlideResult = { kind: 'slid'; events: GameEvent[] } | { kind: 'blocked' } | { kind: 'ignored' };

/** Dati fissi del livello: griglia di base con muri e bordi della forma. */
export class Board {
  readonly gw: number;
  readonly gh: number;
  readonly base: Int16Array;

  constructor(readonly level: Level) {
    const { gw, gh } = level;
    this.gw = gw;
    this.gh = gh;
    this.base = new Int16Array(gw * gh);
    for (let i = 0; i < gw * gh; i++) this.base[i] = level.mask[i] ? EMPTY : OUT;
    for (const g of level.garages) for (const [x, y] of busCells(g)) this.base[y * gw + x] = WALL;
    for (const c of level.blocks) this.base[c] = WALL;
  }

  cells(s: GameState, id: number): [number, number][] {
    const b = this.level.buses[id];
    return busCells({ x: s.px[id], y: s.py[id], dir: b.dir, len: b.len });
  }

  /** sul piazzale e toccabile */
  visible(s: GameState, id: number): boolean {
    return !s.removed[id] && !s.hidden[id];
  }

  /** primo ostacolo sulla strada d'uscita (id -1 = muro di un garage) */
  firstBlocker(s: GameState, id: number): { id: number; dist: number } | null {
    const b = this.level.buses[id];
    const { gw, gh } = this;
    let x = s.px[id] + DX[b.dir] * b.len;
    let y = s.py[id] + DY[b.dir] * b.len;
    let k = 0;
    while (x >= 0 && y >= 0 && x < gw && y < gh) {
      const c = s.grid[y * gw + x];
      if (c === WALL) return { id: -1, dist: k };
      if (c >= 0) return { id: c, dist: k };
      x += DX[b.dir];
      y += DY[b.dir];
      k++;
    }
    return null;
  }

  isFree(s: GameState, id: number): boolean {
    return this.visible(s, id) && this.firstBlocker(s, id) === null;
  }

  freeBuses(s: GameState): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.level.buses.length; i++) if (this.isFree(s, i)) out.push(i);
    return out;
  }

  canSlide(s: GameState, id: number, d: Dir): boolean {
    if (!this.visible(s, id)) return false;
    const { gw, gh } = this;
    for (const [x0, y0] of this.cells(s, id)) {
      const x = x0 + DX[d],
        y = y0 + DY[d];
      if (x < 0 || y < 0 || x >= gw || y >= gh) return false;
      const c = s.grid[y * gw + x];
      if (c !== EMPTY && c !== id) return false;
    }
    return true;
  }
}

export function initialState(level: Level): GameState {
  const board = new Board(level);
  const n = level.buses.length;
  const s: GameState = {
    px: level.buses.map((b) => b.x),
    py: level.buses.map((b) => b.y),
    grid: board.base.slice(),
    hidden: level.buses.map((b) => b.garage !== undefined),
    removed: new Array<boolean>(n).fill(false),
    remaining: n,
    slots: Array.from({ length: level.stalls }, () => null),
    qi: 0,
    arrivals: 0,
    status: 'playing',
    moves: 0,
    extraUsed: false,
    liftUsed: false,
  };
  for (let id = 0; id < n; id++) if (!s.hidden[id]) for (const [x, y] of board.cells(s, id)) s.grid[y * level.gw + x] = id;
  return s;
}

export function cloneState(s: GameState): GameState {
  return {
    ...s,
    px: s.px.slice(),
    py: s.py.slice(),
    grid: s.grid.slice(),
    hidden: s.hidden.slice(),
    removed: s.removed.slice(),
    slots: s.slots.map((b) => (b ? { ...b } : null)),
  };
}

/** Chiave compatta dello stato, per il solver e per riconoscere posizioni già viste. */
export function stateKey(s: GameState): string {
  let k = String.fromCharCode(...Array.from(s.grid, (v) => v + 4));
  for (const h of s.hidden) k += h ? '1' : '0';
  const st = s.slots.filter((x) => x !== null).sort((a, b) => a!.order - b!.order);
  for (const b of st) k += `|${b!.color}:${b!.filled}:${b!.cap}`;
  return k + '#' + s.qi;
}

/** I garage fanno uscire il bus successivo se le 2 celle davanti sono libere. */
function emerge(board: Board, s: GameState, events: GameEvent[]) {
  const { gw } = board;
  for (const g of board.level.garages) {
    const id = g.cars.find((c) => s.hidden[c]);
    if (id === undefined) continue;
    const cells = board.cells(s, id);
    if (!cells.every(([x, y]) => s.grid[y * gw + x] === EMPTY)) continue;
    s.hidden[id] = false;
    for (const [x, y] of cells) s.grid[y * gw + x] = id;
    events.push({ type: 'emerge', id });
  }
}

/** Fa salire i passeggeri finché la testa della coda trova un bus del suo colore, poi aggiorna lo stato. */
function settle(board: Board, s: GameState, events: GameEvent[]) {
  const q = board.level.queue;
  while (s.qi < q.length) {
    const c = q[s.qi];
    let best = -1;
    for (let i = 0; i < s.slots.length; i++) {
      const b = s.slots[i];
      if (b && b.color === c && b.filled < b.cap && (best < 0 || b.order < s.slots[best]!.order)) best = i;
    }
    if (best < 0) break;
    const b = s.slots[best]!;
    b.filled++;
    s.qi++;
    events.push({ type: 'board', id: b.id, slot: best, color: c });
    if (b.filled === b.cap) {
      events.push({ type: 'depart', id: b.id, slot: best });
      s.slots[best] = null;
    }
  }
  if (s.remaining === 0 && s.qi >= q.length && s.slots.every((x) => x === null)) s.status = 'won';
  else if (s.slots.every((x) => x !== null)) s.status = 'lost';
  else s.status = 'playing';
}

function enterStall(board: Board, s: GameState, id: number): TapResult {
  const slot = s.slots.indexOf(null);
  if (slot < 0) return { kind: 'ignored' };
  const bus = board.level.buses[id];
  for (const [x, y] of board.cells(s, id)) s.grid[y * board.gw + x] = EMPTY;
  s.removed[id] = true;
  s.remaining--;
  s.moves++;
  s.slots[slot] = { id, color: bus.color, cap: bus.cap, filled: 0, order: s.arrivals++ };
  const events: GameEvent[] = [{ type: 'enter', id, slot }];
  emerge(board, s, events);
  settle(board, s, events);
  return { kind: 'moved', events };
}

/** Tocco su un bus: esce se la strada è libera. Modifica `s` sul posto. */
export function tap(board: Board, s: GameState, id: number): TapResult {
  if (s.status !== 'playing' || !board.visible(s, id)) return { kind: 'ignored' };
  const blk = board.firstBlocker(s, id);
  if (blk) return { kind: 'blocked', blocker: blk.id, dist: blk.dist };
  return enterStall(board, s, id);
}

/** Scorrimento di una cella. Modifica `s` sul posto. */
export function slide(board: Board, s: GameState, id: number, d: Dir): SlideResult {
  if (s.status !== 'playing' || !board.visible(s, id)) return { kind: 'ignored' };
  if (!board.canSlide(s, id, d)) return { kind: 'blocked' };
  const { gw } = board;
  for (const [x, y] of board.cells(s, id)) s.grid[y * gw + x] = EMPTY;
  s.px[id] += DX[d];
  s.py[id] += DY[d];
  for (const [x, y] of board.cells(s, id)) s.grid[y * gw + x] = id;
  s.moves++;
  const events: GameEvent[] = [{ type: 'slide', id, dir: d }];
  emerge(board, s, events);
  return { kind: 'slid', events };
}

/** Esegue una mossa qualsiasi; true se è andata a buon fine. */
export function applyOp(board: Board, s: GameState, op: { id: number; d: number }): boolean {
  if (op.d < 0) return tap(board, s, op.id).kind === 'moved';
  return slide(board, s, op.id, op.d as Dir).kind === 'slid';
}

/** Boost "gru": solleva un bus qualsiasi (anche bloccato) e lo porta in uno stallo. Una volta per livello. */
export function lift(board: Board, s: GameState, id: number): TapResult {
  if (s.liftUsed || s.status !== 'playing' || !board.visible(s, id)) return { kind: 'ignored' };
  const r = enterStall(board, s, id);
  if (r.kind === 'moved') s.liftUsed = true;
  return r;
}

/** Boost "+1 posto": aggiunge uno stallo (una volta per livello), anche per riprendere una partita persa. */
export function addStall(board: Board, s: GameState): boolean {
  if (s.extraUsed || s.status === 'won') return false;
  s.extraUsed = true;
  s.slots.push(null);
  settle(board, s, []);
  return true;
}
