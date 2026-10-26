// Genera i livelli 1..N e verifica che siano risolvibili.
// Uso: npm run check-levels -- 200
import { generateLevel, replayWins } from '../src/game/generator';

const N = Number(process.argv[2] ?? 100);
const FROM = Number(process.argv[3] ?? 1);
let problems = 0;
const rows: string[] = [];
let totalMs = 0;
let maxMs = 0;

for (let n = FROM; n < FROM + N; n++) {
  const t0 = performance.now();
  const lvl = generateLevel(n);
  const ms = performance.now() - t0;
  totalMs += ms;
  maxMs = Math.max(maxMs, ms);
  const ok = replayWins(lvl, lvl.solution);
  if (!ok) problems++;
  const s = lvl.stats;
  const hidden = lvl.garages.reduce((a, g) => a + g.cars.length, 0);
  rows.push(
    [
      String(n).padStart(4),
      s.difficulty.toFixed(2),
      `${lvl.w}x${lvl.h}`.padStart(5),
      String(lvl.buses.length).padStart(3),
      String(new Set(lvl.buses.map((b) => b.color)).size),
      String(lvl.stalls),
      `${Math.round(s.fill * 100)}%`.padStart(4),
      String(s.blocked).padStart(3),
      String(s.slides).padStart(4),
      s.tapsOnly ? 'si' : 'no',
      `${lvl.theta ? 'diag' : 'orto'}:${lvl.shape}`.padEnd(15),
      `g${lvl.garages.length}/${hidden}`,
      ok ? 'ok' : 'KO',
      `${ms.toFixed(0)}ms`.padStart(6),
    ].join('  '),
  );
}
console.log('   n  diff   size  bus col K  pieno blc  scor solo-tocchi forma       garage check   gen');
console.log(rows.join('\n'));
console.log(`\nproblemi: ${problems}/${N} · tempo medio ${(totalMs / N).toFixed(0)}ms · max ${maxMs.toFixed(0)}ms`);
process.exit(problems ? 1 : 0);
