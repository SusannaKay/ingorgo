// Unisce i risultati di scripts/calibrate.ts in src/game/calibration.ts.
// Uso: npx tsx scripts/write-calibration.ts a.json b.json ...
import { readFileSync, writeFileSync } from 'node:fs';

const all: Record<number, { c: number }> = {};
for (const f of process.argv.slice(2)) Object.assign(all, JSON.parse(readFileSync(f, 'utf8')));
const max = Math.max(...Object.keys(all).map(Number));
let s = '';
for (let n = 1; n <= max; n++) s += all[n] && all[n].c >= 0 ? String.fromCharCode(48 + all[n].c) : '.';
writeFileSync(
  new URL('../src/game/calibration.ts', import.meta.url),
  `// Variante scelta per ogni livello, dal livello 1 in poi: carattere - '0'.\n// Generata da scripts/calibrate.ts: va rigenerata se cambia il generatore.\nexport const CALIBRATION = '${s}';\n`,
);
console.log(`${max} livelli calibrati`);
