// Logica di gioco pura: nessuna dipendenza dalla grafica.
// La usano il gioco, il generatore, il solver e lo script di verifica.
import { Level, busCells, pathCells } from './types';

export interface StallBus {
  id: number;
  color: number;
  cap: number;
  filled: number;
  /** ordine di arrivo: a parità di colore si riempie prima il bus arrivato prima */
  order: number;
}

export type Status = 'playing' | 'won' | 'lost';

export interface GameState {
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
  | { type: 'depart'; id: number; slot: number };

export type TapResult =
  | { kind: 'moved'; events: GameEvent[] }
  | { kind: 'blocked'; blocker: number; dist: number }
  | { kind: 'ignored' };

/**
 * Precalcoli statici di un livello. I bus si muovono solo uscendo, quindi i blocchi
 * sono fissi. Le celle davanti a un garage sono condivise da tutti i suoi bus, in
 * ordine: è occupata dal primo non ancora uscito.
 */
export class Board {
  readonly occ: number[][];
  readonly wall: Uint8Array;
  readonly paths: number[][];
  readonly blockers: number[][];
  /** blocchi + bus precedente nel garage */
  readonly deps: number[][];
  readonly prev: number[];

  constructor(readonly level: Level) {
    const { gw, gh, buses } = level;
    this.occ = Array.from({ length: gw * gh }, () => []);
    this.wall = new Uint8Array(gw * gh);
    for (const b of buses) for (const [x, y] of busCells(b)) this.occ[y * gw + x].push(b.id);
    for (const g of level.garages) for (const [x, y] of busCells(g)) this.wall[y * gw + x] = 1;
    this.prev = buses.map((b) => b.prev ?? -1);
    this.paths = buses.map((b) => pathCells(b, gw, gh).map(([x, y]) => y * gw + x));
    this.blockers = this.paths.map((p, id) => {
      const seen: number[] = [];
      for (const c of p) for (const o of this.occ[c]) if (o !== id && !seen.includes(o)) seen.push(o);
      return seen;
    });
    this.deps = this.blockers.map((bl, id) => (this.prev[id] >= 0 ? [...bl, this.prev[id]] : bl));
  }

  /** il bus è fuori dal garage (o non ne ha uno) */
  visible(s: GameState, id: number): boolean {
    const p = this.prev[id];
    return p < 0 || s.removed[p];
  }

  isFree(s: GameState, id: number): boolean {
    for (const b of this.deps[id]) if (!s.removed[b]) return false;
    return true;
  }

  firstBlocker(s: GameState, id: number): { id: number; dist: number } | null {
    const p = this.paths[id];
    for (let k = 0; k < p.length; k++) {
      if (this.wall[p[k]]) return { id: -1, dist: k };
      for (const o of this.occ[p[k]]) if (!s.removed[o]) return { id: o, dist: k };
    }
    return null;
  }

  freeBuses(s: GameState): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.level.buses.length; i++) if (!s.removed[i] && this.isFree(s, i)) out.push(i);
    return out;
  }
}

export function initialState(level: Level): GameState {
  return {
    removed: level.buses.map(() => false),
    remaining: level.buses.length,
    slots: Array.from({ length: level.stalls }, () => null),
    qi: 0,
    arrivals: 0,
    status: 'playing',
    moves: 0,
    extraUsed: false,
    liftUsed: false,
  };
}

export function cloneState(s: GameState): GameState {
  return {
    ...s,
    removed: s.removed.slice(),
    slots: s.slots.map((b) => (b ? { ...b } : null)),
  };
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
  s.removed[id] = true;
  s.remaining--;
  s.moves++;
  s.slots[slot] = { id, color: bus.color, cap: bus.cap, filled: 0, order: s.arrivals++ };
  const events: GameEvent[] = [{ type: 'enter', id, slot }];
  settle(board, s, events);
  return { kind: 'moved', events };
}

/** Tocco su un bus. Modifica `s` sul posto. */
export function tap(board: Board, s: GameState, id: number): TapResult {
  if (s.status !== 'playing' || s.removed[id] || !board.visible(s, id)) return { kind: 'ignored' };
  const blk = board.firstBlocker(s, id);
  if (blk) return { kind: 'blocked', blocker: blk.id, dist: blk.dist };
  return enterStall(board, s, id);
}

/** Boost "gru": solleva un bus qualsiasi (anche bloccato) e lo porta in uno stallo. Una volta per livello. */
export function lift(board: Board, s: GameState, id: number): TapResult {
  if (s.liftUsed || s.status !== 'playing' || s.removed[id] || !board.visible(s, id)) return { kind: 'ignored' };
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
