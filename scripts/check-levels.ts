// Genera i livelli 1..N e verifica che siano risolvibili e ben calibrati.
// Uso: npm run check-levels -- 200
import { Board, initialState } from '../src/game/engine';
import { generateLevel, replayWins } from '../src/game/generator';
import { solve } from '../src/game/solver';

const N = Number(process.argv[2] ?? 100);
let problems = 0;
const rows: string[] = [];
let totalMs = 0;
let maxMs = 0;

for (let n = 1; n <= N; n++) {
  const t0 = performance.now();
  const lvl = generateLevel(n);
  const ms = performance.now() - t0;
  totalMs += ms;
  maxMs = Math.max(maxMs, ms);
  const replay = replayWins(lvl, lvl.solution);
  const board = new Board(lvl);
  const sol = solve(board, initialState(lvl), 300_000);
  const ok = replay && sol.result === 'found';
  if (!ok) problems++;
  const s = lvl.stats;
  rows.push(
    [
      String(n).padStart(3),
      s.difficulty.toFixed(2),
      `${lvl.w}x${lvl.h}`.padStart(5),
      String(lvl.buses.length).padStart(3),
      String(new Set(lvl.buses.map((b) => b.color)).size),
      String(lvl.stalls),
      String(s.maxChain).padStart(2),
      `${Math.round(s.winRate * 100)}%`.padStart(4),
      `${Math.round(s.targetWinRate * 100)}%`.padStart(4),
      ok ? 'ok' : `KO(${replay ? '' : 'replay '}${sol.result})`,
      `${ms.toFixed(0)}ms`.padStart(6),
    ].join('  '),
  );
}
console.log('  n  diff   size  bus col K ch  win  tgt  check   gen');
console.log(rows.join('\n'));
console.log(`\nproblemi: ${problems}/${N} · tempo medio ${(totalMs / N).toFixed(0)}ms · max ${maxMs.toFixed(0)}ms`);
process.exit(problems ? 1 : 0);
