// Calibrazione della difficoltà, da lanciare quando cambia il generatore.
// Per ogni livello prova più varianti, misura quanto fatica a vincerle una ricerca che
// non conosce la soluzione e sceglie quella più vicina allo sforzo voluto per quel livello.
// Uso: npx tsx scripts/calibrate.ts DA A file.json   (poi scripts/write-calibration.ts)
import { writeFileSync } from 'node:fs';
import { Board, initialState } from '../src/game/engine';
import { buildLevelCandidate, paramsForLevel } from '../src/game/generator';
import { effort } from '../src/game/solver';

const FROM = Number(process.argv[2] ?? 1);
const TO = Number(process.argv[3] ?? 50);
const OUT = process.argv[4] ?? 'calibration.json';
const VARIANTS = 10;
const BUDGET = 3000;

/** sforzo voluto: da poche posizioni (mosse ovvie) al budget pieno (livelli più duri) */
export function targetEffort(d: number): number {
  const t = Math.max(0, Math.min(1, d));
  return 6 * Math.pow(BUDGET / 6, Math.pow(t, 1.3));
}

const res: Record<number, { c: number; effort: number; target: number }> = {};
for (let n = FROM; n <= TO; n++) {
  const p = paramsForLevel(n);
  const target = targetEffort(p.difficulty);
  let best = -1,
    bestGap = Infinity,
    bestE = 0;
  for (let c = 0; c < VARIANTS; c++) {
    const lvl = buildLevelCandidate(n, c);
    if (!lvl) continue;
    if (p.needSlides && lvl.stats.tapsOnly) continue;
    const e = effort(new Board(lvl), initialState(lvl), BUDGET);
    const eff = Number.isFinite(e) ? e : BUDGET * 2;
    const gap = Math.abs(Math.log(eff) - Math.log(target));
    if (gap < bestGap) {
      bestGap = gap;
      best = c;
      bestE = eff;
    }
  }
  res[n] = { c: best, effort: bestE, target: Math.round(target) };
  console.log(n, p.difficulty.toFixed(2), JSON.stringify(res[n]));
  writeFileSync(OUT, JSON.stringify(res));
}
