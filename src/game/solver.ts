// Solver DFS con memoria degli stati già visti.
// Lo stato logico è piccolo: quali bus sono usciti + contenuto degli stalli
// (la posizione nella coda ne è una conseguenza).
import { Board, GameState, cloneState, tap } from './engine';

export type SolveResult =
  | { result: 'found'; moves: number[]; nodes: number }
  | { result: 'none'; nodes: number }
  | { result: 'budget'; nodes: number };

function key(s: GameState): string {
  let k = '';
  for (const r of s.removed) k += r ? '1' : '0';
  const st = s.slots.filter((x) => x !== null).sort((a, b) => a!.order - b!.order);
  for (const b of st) k += `|${b!.color}:${b!.filled}:${b!.cap}`;
  return k;
}

export function solve(board: Board, start: GameState, budget = 150_000): SolveResult {
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
    const k = key(s);
    if (seen.has(k)) return false;
    seen.add(k);

    // Ordine euristico: prima i bus del colore in testa alla coda, poi quelli richiesti a breve.
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
