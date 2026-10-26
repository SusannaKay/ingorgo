// Ricerca di soluzioni.
// - solveTaps: solo tocchi, senza scorrimenti (il generatore lo usa per scartare i
//   livelli che si vincono senza mai far scorrere un bus).
// - hintMove: la prossima mossa utile per il pulsante "Aiuto".
import { Board, GameState, applyOp, cloneState, initialState, slide, stateKey, tap } from './engine';
import { Dir, Op } from './types';

export type SolveResult =
  | { result: 'found'; moves: number[]; nodes: number }
  | { result: 'none'; nodes: number }
  | { result: 'budget'; nodes: number };

/** DFS con memoria, solo tocchi. */
export function solveTaps(board: Board, start: GameState, budget = 150_000): SolveResult {
  const q = board.level.queue;
  const buses = board.level.buses;
  const seen = new Set<string>();
  const path: number[] = [];
  let nodes = 0;
  let outOfBudget = false;

  const dfs = (s: GameState): boolean => {
    if (s.status === 'won') return true;
    if (s.status === 'lost') return false;
    if (++nodes > budget) {
      outOfBudget = true;
      return false;
    }
    // senza scorrimenti la posizione dei bus dipende solo da chi è uscito
    let k = '';
    for (const r of s.removed) k += r ? '1' : '0';
    for (const b of s.slots.filter((x) => x !== null).sort((a, b) => a!.order - b!.order)) k += `|${b!.color}:${b!.filled}`;
    if (seen.has(k)) return false;
    seen.add(k);
    const upcoming = q.slice(s.qi, s.qi + 12);
    const score = (id: number) => {
      const i = upcoming.indexOf(buses[id].color);
      return i < 0 ? 99 : i;
    };
    const free = board.freeBuses(s).sort((a, b) => score(a) - score(b));
    for (const id of free) {
      const c = cloneState(s);
      tap(board, c, id);
      path.push(id);
      if (dfs(c)) return true;
      path.pop();
      if (outOfBudget) return false;
    }
    return false;
  };

  const ok = dfs(cloneState(start));
  if (ok) return { result: 'found', moves: path.slice(), nodes };
  return outOfBudget ? { result: 'budget', nodes } : { result: 'none', nodes };
}

/** Tutte le mosse possibili da uno stato (i tocchi che fanno perdere subito sono esclusi). */
function moves(board: Board, s: GameState): { op: Op; next: GameState }[] {
  const out: { op: Op; next: GameState }[] = [];
  const n = board.level.buses.length;
  for (let id = 0; id < n; id++) {
    if (!board.visible(s, id)) continue;
    if (board.isFree(s, id)) {
      const c = cloneState(s);
      tap(board, c, id);
      if (c.status !== 'lost') out.push({ op: { id, d: -1 }, next: c });
    }
    for (let d = 0; d < 4; d++) {
      if (!board.canSlide(s, id, d as Dir)) continue;
      const c = cloneState(s);
      slide(board, c, id, d as Dir);
      out.push({ op: { id, d: d as Dir }, next: c });
    }
  }
  return out;
}

class Heap {
  private a: { f: number; i: number }[] = [];
  get size() {
    return this.a.length;
  }
  push(f: number, i: number) {
    const a = this.a;
    a.push({ f, i });
    let k = a.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (a[p].f <= a[k].f) break;
      [a[p], a[k]] = [a[k], a[p]];
      k = p;
    }
  }
  pop(): number {
    const a = this.a;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1,
          r = l + 1;
        let m = k;
        if (l < a.length && a[l].f < a[m].f) m = l;
        if (r < a.length && a[r].f < a[m].f) m = r;
        if (m === k) break;
        [a[m], a[k]] = [a[k], a[m]];
        k = m;
      }
    }
    return top.i;
  }
}

export type Hint = { kind: 'move'; op: Op } | { kind: 'none' } | { kind: 'unknown' };

/**
 * Prossima mossa consigliata:
 * 1. se lo stato è uno di quelli della soluzione prevista, la sua mossa successiva;
 * 2. altrimenti, se pochi scorrimenti riportano su quella soluzione, il primo;
 * 3. altrimenti una ricerca "best-first" con budget limitato.
 */
export function hintMove(board: Board, s: GameState): Hint {
  if (s.status !== 'playing') return { kind: 'none' };
  const level = board.level;
  const onPath = new Map<string, number>();
  const r = initialState(level);
  for (let i = 0; i < level.solution.length; i++) {
    onPath.set(stateKey(r), i);
    if (!applyOp(board, r, level.solution[i])) break;
  }
  const k0 = stateKey(s);
  const i0 = onPath.get(k0);
  if (i0 !== undefined) return { kind: 'move', op: level.solution[i0] };

  // 2. solo scorrimenti, in ampiezza
  {
    const seen = new Set<string>([k0]);
    let frontier: { s: GameState; first: Op }[] = [];
    const n = level.buses.length;
    const expand = (st: GameState, first: Op | null) => {
      const out: { s: GameState; first: Op }[] = [];
      for (let id = 0; id < n; id++) {
        for (let d = 0; d < 4; d++) {
          if (!board.canSlide(st, id, d as Dir)) continue;
          const c = cloneState(st);
          slide(board, c, id, d as Dir);
          const k = stateKey(c);
          if (seen.has(k)) continue;
          seen.add(k);
          const f = first ?? { id, d: d as Dir };
          if (onPath.has(k)) return { hit: f, out };
          out.push({ s: c, first: f });
        }
      }
      return { hit: null, out };
    };
    const e0 = expand(s, null);
    if (e0.hit) return { kind: 'move', op: e0.hit };
    frontier = e0.out;
    while (frontier.length && seen.size < 8000) {
      const next: { s: GameState; first: Op }[] = [];
      for (const f of frontier) {
        const e = expand(f.s, f.first);
        if (e.hit) return { kind: 'move', op: e.hit };
        next.push(...e.out);
        if (seen.size >= 8000) break;
      }
      frontier = next;
    }
  }

  // 3. ricerca guidata: meno passeggeri e meno bus rimasti, a parità di passi
  const q = level.queue;
  const h = (st: GameState) => (q.length - st.qi) + 3 * st.remaining;
  const nodes: { s: GameState; first: Op | null; depth: number }[] = [{ s, first: null, depth: 0 }];
  const heap = new Heap();
  heap.push(h(s), 0);
  const seen = new Set<string>([k0]);
  let expanded = 0;
  while (heap.size && expanded < 5_000) {
    const node = nodes[heap.pop()];
    expanded++;
    for (const m of moves(board, node.s)) {
      const first = node.first ?? m.op;
      if (m.next.status === 'won') return { kind: 'move', op: first };
      const k = stateKey(m.next);
      if (seen.has(k)) continue;
      seen.add(k);
      nodes.push({ s: m.next, first, depth: node.depth + 1 });
      heap.push(h(m.next) + 0.4 * (node.depth + 1), nodes.length - 1);
    }
  }
  return heap.size ? { kind: 'unknown' } : { kind: 'none' };
}

/**
 * Sforzo di una ricerca "best-first" che non conosce la soluzione: quante posizioni
 * deve esaminare prima di vincere. Pochi = le mosse ovvie bastano; tanti = ci sono
 * trappole. Infinity se non vince entro il budget. Usato per calibrare la difficoltà.
 */
export function effort(board: Board, start: GameState, budget: number): number {
  const q = board.level.queue;
  const h = (st: GameState) => q.length - st.qi + 3 * st.remaining;
  const nodes: { s: GameState; depth: number }[] = [{ s: start, depth: 0 }];
  const heap = new Heap();
  heap.push(h(start), 0);
  const seen = new Set<string>([stateKey(start)]);
  let expanded = 0;
  while (heap.size && expanded < budget) {
    const node = nodes[heap.pop()];
    expanded++;
    for (const m of moves(board, node.s)) {
      if (m.next.status === 'won') return expanded;
      const k = stateKey(m.next);
      if (seen.has(k)) continue;
      seen.add(k);
      nodes.push({ s: m.next, depth: node.depth + 1 });
      heap.push(h(m.next) + 0.4 * (node.depth + 1), nodes.length - 1);
    }
  }
  return Infinity;
}
