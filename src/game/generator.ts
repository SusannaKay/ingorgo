// Generatore di livelli a difficoltà crescente.
//
// Costruzione all'indietro, come si mescola un gioco del 15: si parte dal parcheggio
// vuoto e si applicano mosse inverse.
// - "rientro": un bus nuovo compare in un punto da cui avrebbe la strada libera
//   (in avanti: quel bus esce);
// - "scorrimento": un bus già piazzato scivola di una cella (in avanti: scivola indietro);
// - "rimessa": il bus davanti a un garage ci rientra e subito un'altra mossa occupa
//   quelle celle (in avanti: quella mossa le libera e il garage fa uscire il bus).
// Rovesciando la sequenza si ottiene una soluzione valida. La coda dei passeggeri si
// costruisce simulando l'ordine d'uscita della soluzione con pochi stalli occupati:
// ogni livello è risolvibile per costruzione (e lo si verifica rigiocandolo).
import { Board, initialState, applyOp } from './engine';
import { solveTaps } from './solver';
import { CALIBRATION } from './calibration';
import { Rng, mulberry32, randInt, pick, shuffle } from './rng';
import { Bus, CAPACITY, DX, DY, Dir, Garage, Level, Op, busCells, toWorld } from './types';

export interface GenParams {
  difficulty: number;
  w: number;
  h: number;
  /** quota di celle del parcheggio da occupare */
  fill: number;
  longRatio: number; // quota di bus lunghi (3 celle)
  colors: number;
  stalls: number;
  maxOcc: number; // stalli che la soluzione prevista tiene occupati al massimo
  pRelease: number; // quanto "presto" la soluzione prevista fa uscire i bus
  lateBias: number; // quanto la coda chiede colori di bus arrivati per ultimi
  blockBias: number; // quanto i rientri cercano di bloccare la strada ad altri bus
  /** probabilità di intercalare scorrimenti tra un rientro e l'altro */
  mixSlides: number;
  /** scorrimenti finali di "mescolamento" */
  scramble: number;
  /** pretendere che senza scorrimenti non si vinca */
  needSlides: boolean;
  /** ostacoli fissi nel parcheggio */
  blocks: number;
  /** quanto il mescolamento sceglie gli scorrimenti che bloccano più bus */
  adversarial: number;
  candidates: number;
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
    h: Math.round(lerp(5, 9, Math.sqrt(t)) + o),
    fill: n === 1 ? 0.5 : Math.min(0.9, lerp(0.58, 0.84, t) + 0.05 * o),
    longRatio: lerp(0.15, 0.5, t),
    colors: Math.round(lerp(2, 6, t) + o),
    stalls,
    maxOcc: Math.max(1, Math.min(stalls, Math.round(lerp(2, stalls + 0.6, t)))),
    pRelease: lerp(0.3, 0.95, t),
    lateBias: lerp(0, 0.9, t),
    blockBias: lerp(0.35, 1, t),
    mixSlides: n === 1 ? 0 : lerp(0.25, 0.6, t),
    scramble: n === 1 ? 0 : n === 2 ? 12 : Math.round(lerp(8, 90, t) + 60 * o),
    needSlides: n >= 2,
    blocks: n === 1 ? 0 : n <= 3 ? 1 : Math.round(lerp(1, 5, t) + 2 * o),
    adversarial: n === 1 ? 0 : lerp(0.5, 0.95, t),
    candidates: n <= 3 ? 6 : Math.round(lerp(8, 16, t)),
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

const G_EMPTY = -1,
  G_WALL = -2,
  G_OUT = -3;

interface Built {
  buses: Bus[];
  garages: Garage[];
  blocks: number[];
  ops: Op[];
}

/** Passo 1: costruzione all'indietro (vedi in cima al file). */
function construct(rng: Rng, p: GenParams, L: Layout): Built {
  const { gw, gh, mask } = L;
  const grid = new Int16Array(gw * gh);
  for (let i = 0; i < gw * gh; i++) grid[i] = mask[i] ? G_EMPTY : G_OUT;
  const px: number[] = [],
    py: number[] = [],
    dirs: Dir[] = [],
    lens: number[] = [],
    hidden: boolean[] = [];
  const rev: Op[] = []; // mosse inverse, nell'ordine in cui sono fatte
  interface G {
    id: number;
    x: number;
    y: number;
    dir: Dir;
    fx: number;
    fy: number;
    stack: number[];
  }
  const gars: G[] = [];
  let occupied = 0;

  const inB = (x: number, y: number) => x >= 0 && y >= 0 && x < gw && y < gh;
  const cellsOf = (x: number, y: number, dir: Dir, len: number) => busCells({ x, y, dir, len });
  const cellsId = (id: number) => cellsOf(px[id], py[id], dirs[id], lens[id]);
  const put = (id: number, v: number) => {
    for (const [x, y] of cellsId(id)) grid[y * gw + x] = v;
  };
  const pathClear = (x: number, y: number, dir: Dir, len: number) => {
    let cx = x + DX[dir] * len,
      cy = y + DY[dir] * len;
    while (inB(cx, cy)) {
      const c = grid[cy * gw + cx];
      if (c === G_WALL || c >= 0) return false;
      cx += DX[dir];
      cy += DY[dir];
    }
    return true;
  };
  const canPlace = (x: number, y: number, dir: Dir, len: number) =>
    cellsOf(x, y, dir, len).every(([cx, cy]) => inB(cx, cy) && grid[cy * gw + cx] === G_EMPTY) && pathClear(x, y, dir, len);
  const place = (x: number, y: number, dir: Dir, len: number) => {
    const id = px.length;
    px.push(x);
    py.push(y);
    dirs.push(dir);
    lens.push(len);
    hidden.push(false);
    put(id, id);
    occupied += len;
    rev.push({ id, d: -1 });
    return id;
  };
  const footprint = (g: G) => cellsOf(g.fx, g.fy, g.dir, 2);
  const covered = (g: G) => footprint(g).some(([x, y]) => grid[y * gw + x] >= 0);
  /** il garage con bus nascosti deve avere sempre le celle davanti occupate */
  const invariant = () => gars.every((g) => !g.stack.length || covered(g));
  const canMove = (id: number, d: Dir) => {
    for (const [x0, y0] of cellsId(id)) {
      const x = x0 + DX[d],
        y = y0 + DY[d];
      if (!inB(x, y)) return false;
      const c = grid[y * gw + x];
      if (c !== G_EMPTY && c !== id) return false;
    }
    put(id, G_EMPTY);
    px[id] += DX[d];
    py[id] += DY[d];
    put(id, id);
    const ok = invariant();
    put(id, G_EMPTY);
    px[id] -= DX[d];
    py[id] -= DY[d];
    put(id, id);
    return ok;
  };
  const move = (id: number, d: Dir) => {
    put(id, G_EMPTY);
    px[id] += DX[d];
    py[id] += DY[d];
    put(id, id);
    rev.push({ id, d });
  };
  const visibleIds = () => px.map((_, i) => i).filter((i) => !hidden[i]);

  // garage: 2 celle di muro + 2 celle davanti dove compare il bus
  for (let g = 0; g < p.garages; g++) {
    for (let k = 0; k < 150; k++) {
      const dir = randInt(rng, 4) as Dir;
      const x = randInt(rng, gw),
        y = randInt(rng, gh);
      const fx = x + DX[dir] * 2,
        fy = y + DY[dir] * 2;
      const cells = [...cellsOf(x, y, dir, 2), ...cellsOf(fx, fy, dir, 2)];
      if (!cells.every(([cx, cy]) => inB(cx, cy) && grid[cy * gw + cx] === G_EMPTY)) continue;
      if (!pathClear(fx, fy, dir, 2)) continue;
      for (const [cx, cy] of cellsOf(x, y, dir, 2)) grid[cy * gw + cx] = G_WALL;
      gars.push({ id: gars.length, x, y, dir, fx, fy, stack: [] });
      break;
    }
  }
  // fioriere: celle singole, mai davanti a un garage
  const blocks: number[] = [];
  const reserved = new Set<number>();
  for (const g of gars) for (const [cx, cy] of footprint(g)) reserved.add(cy * gw + cx);
  for (let k = 0; k < 200 && blocks.length < p.blocks; k++) {
    const x = randInt(rng, gw),
      y = randInt(rng, gh);
    const c = y * gw + x;
    if (grid[c] !== G_EMPTY || reserved.has(c)) continue;
    // niente fioriere attaccate tra loro: meglio sparse
    if ([0, 1, 2, 3].some((d) => inB(x + DX[d], y + DY[d]) && blocks.includes((y + DY[d]) * gw + x + DX[d]))) continue;
    grid[c] = G_WALL;
    blocks.push(c);
  }
  const freeCells = Array.from(grid).filter((c) => c === G_EMPTY).length;
  /** bus visibili che adesso non potrebbero uscire */
  const blockedCount = () => {
    let n = 0;
    for (let id = 0; id < px.length; id++) if (!hidden[id] && !pathClear(px[id], py[id], dirs[id], lens[id])) n++;
    return n;
  };

  let last: Op | null = null;
  const randomSlide = (): boolean => {
    const ids = visibleIds();
    if (!ids.length) return false;
    // alcuni candidati validi; spesso si sceglie quello che lascia più bus bloccati
    const cands: Op[] = [];
    for (let k = 0; k < 24 && cands.length < 6; k++) {
      const id = pick(rng, ids);
      const d = randInt(rng, 4) as Dir;
      // niente avanti-e-indietro: annullerebbe la mossa precedente
      if (last && last.id === id && last.d === (d + 2) % 4) continue;
      if (cands.some((c) => c.id === id && c.d === d)) continue;
      if (canMove(id, d)) cands.push({ id, d });
    }
    if (!cands.length) return false;
    let chosen = cands[0];
    if (cands.length > 1 && rng() < p.adversarial) {
      let best = -1;
      for (const c of cands) {
        move(c.id, c.d as Dir);
        const score = blockedCount() + rng() * 0.5;
        rev.pop();
        put(c.id, G_EMPTY);
        px[c.id] -= DX[c.d as Dir];
        py[c.id] -= DY[c.d as Dir];
        put(c.id, c.id);
        if (score > best) {
          best = score;
          chosen = c;
        }
      }
    }
    move(chosen.id, chosen.d as Dir);
    last = chosen;
    return true;
  };

  const tryNewBus = (): boolean => {
    // quante strade d'uscita passano per ogni cella: lì un bus nuovo blocca di più
    const hits = new Int16Array(gw * gh);
    for (const id of visibleIds()) {
      const dir = dirs[id];
      let cx = px[id] + DX[dir] * lens[id],
        cy = py[id] + DY[dir] * lens[id];
      while (inB(cx, cy)) {
        hits[cy * gw + cx]++;
        cx += DX[dir];
        cy += DY[dir];
      }
    }
    let best: [number, number, Dir, number] | null = null;
    let first: [number, number, Dir, number] | null = null;
    let bestScore = -1;
    for (let k = 0; k < 30; k++) {
      const len = rng() < p.longRatio ? 3 : 2;
      const dir = randInt(rng, 4) as Dir;
      const x = randInt(rng, gw),
        y = randInt(rng, gh);
      if (!canPlace(x, y, dir, len)) continue;
      const score = cellsOf(x, y, dir, len).reduce((a, [cx, cy]) => a + hits[cy * gw + cx], 0) + rng() * 0.5;
      if (!first) first = [x, y, dir, len];
      if (score > bestScore) {
        bestScore = score;
        best = [x, y, dir, len];
      }
    }
    const c = rng() < p.blockBias ? best : first;
    if (!c) return false;
    place(...c);
    last = null;
    return true;
  };

  const tryGarage = (g: G): boolean => {
    const occ = grid[g.fy * gw + g.fx];
    const isCar = occ >= 0 && px[occ] === g.fx && py[occ] === g.fy && dirs[occ] === g.dir && lens[occ] === 2;
    if (!isCar) {
      if (canPlace(g.fx, g.fy, g.dir, 2)) {
        place(g.fx, g.fy, g.dir, 2);
        return true;
      }
      return false;
    }
    // rimessa: il bus rientra nel garage...
    put(occ, G_EMPTY);
    hidden[occ] = true;
    g.stack.push(occ);
    occupied -= 2;
    // ...e subito un'altra mossa inversa occupa le celle davanti
    const fp = footprint(g);
    const covers: (() => boolean)[] = [
      () => (canPlace(g.fx, g.fy, g.dir, 2) ? (place(g.fx, g.fy, g.dir, 2), true) : false),
      () => {
        for (let k = 0; k < 24; k++) {
          const [cx, cy] = pick(rng, fp);
          const len = rng() < p.longRatio ? 3 : 2;
          const dir = randInt(rng, 4) as Dir;
          const off = randInt(rng, len);
          const x = cx - DX[dir] * off,
            y = cy - DY[dir] * off;
          if (canPlace(x, y, dir, len)) {
            place(x, y, dir, len);
            return true;
          }
        }
        return false;
      },
      () => {
        for (const id of shuffle(rng, visibleIds())) {
          for (const d of shuffle(rng, [0, 1, 2, 3] as Dir[])) {
            if (!canMove(id, d)) continue; // canMove pretende già le celle del garage coperte
            move(id, d);
            return true;
          }
        }
        return false;
      },
    ];
    const order = rng() < 0.5 ? [0, 1, 2] : shuffle(rng, [0, 1, 2]);
    for (const i of order) {
      if (covers[i]()) {
        last = null;
        return true;
      }
    }
    g.stack.pop();
    hidden[occ] = false;
    put(occ, occ);
    occupied += 2;
    return false;
  };

  const target = Math.round(p.fill * freeCells);
  let fails = 0;
  for (let step = 0; step < 3000 && occupied < target && fails < 400; step++) {
    const r = rng();
    let ok: boolean;
    const needy = gars.filter((g) => g.stack.length < p.garageCars);
    if (needy.length && r < 0.3) ok = tryGarage(pick(rng, needy));
    else if (px.length && rng() < p.mixSlides) {
      ok = false;
      for (let k = 1 + randInt(rng, 3); k > 0; k--) ok = randomSlide() || ok;
    } else ok = tryNewBus();
    if (!ok) fails++;
  }
  // garage rimasti senza bus: qualche tentativo in più, mescolando un po' se serve
  for (const g of gars) {
    for (let k = 0; k < 80 && g.stack.length < p.garageCars; k++) if (!tryGarage(g)) randomSlide();
  }
  for (let i = 0; i < p.scramble; i++) randomSlide();

  // un garage rimasto vuoto diventa piazzale normale (togliere un muro non rompe la soluzione)
  const kept = gars.filter((g) => g.stack.length > 0);
  gars.length = 0;
  kept.forEach((g, i) => gars.push({ ...g, id: i }));
  const buses: Bus[] = px.map((x, id) => {
    const g = gars.find((gg) => gg.stack.includes(id));
    const b: Bus = { id, x, y: py[id], dir: dirs[id], len: lens[id], color: 0, cap: CAPACITY[lens[id]] };
    if (g) b.garage = g.id;
    return b;
  });
  const garages: Garage[] = gars.map((g) => ({ id: g.id, x: g.x, y: g.y, dir: g.dir, len: 2, cars: g.stack.slice().reverse() }));
  const ops: Op[] = rev
    .slice()
    .reverse()
    .map((o) => (o.d < 0 ? o : { id: o.id, d: ((o.d + 2) % 4) as Dir }));
  return { buses, garages, blocks, ops };
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

/** Verifica che la soluzione prevista vinca davvero nel motore di gioco. */
export function replayWins(level: Level, ops: Op[]): boolean {
  const board = new Board(level);
  const s = initialState(level);
  for (const op of ops) if (!applyOp(board, s, op)) return false;
  return s.status === 'won';
}

function buildCandidate(rng: Rng, p: GenParams, n: number, seed: number): Level {
  const L = buildLayout(rng, p);
  const { buses: placed, garages, blocks, ops } = construct(rng, p, L);
  const colors = Math.min(p.colors, placed.length);
  const palette = shuffle(rng, [0, 1, 2, 3, 4, 5, 6, 7]).slice(0, colors);
  const colorBag = shuffle(
    rng,
    placed.map((_, i) => palette[i % colors]),
  );
  const buses = placed.map((b, i) => ({ ...b, color: colorBag[i] }));
  const exitOrder = ops.filter((o) => o.d < 0).map((o) => buses[o.id]);
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
    blocks,
    garages,
    stalls: p.stalls,
    buses,
    queue: buildQueue(rng, exitOrder, p),
    solution: ops,
    stats: { difficulty: p.difficulty, slides: 0, fill: 0, blocked: 0, tapsOnly: false, candidates: 0 },
  };
  const board = new Board(level);
  const s = initialState(level);
  let used = 0;
  for (let i = 0; i < s.grid.length; i++) if (s.grid[i] >= 0) used++;
  const free = level.mask.reduce((a, m, i) => a + (m && board.base[i] !== -2 ? 1 : 0), 0);
  const vis = buses.filter((b) => b.garage === undefined);
  level.stats.slides = ops.filter((o) => o.d >= 0).length;
  level.stats.fill = used / Math.max(1, free);
  level.stats.blocked = vis.filter((b) => !board.isFree(s, b.id)).length;
  return level;
}

/** Una variante del livello (deterministica); null se la verifica fallisce. */
export function buildLevelCandidate(n: number, c: number, override?: Partial<GenParams>): Level | null {
  const p = { ...paramsForLevel(n), ...override };
  const seed = (n * 7919 + 1013) >>> 0;
  const rng = mulberry32((seed + Math.imul(c + 1, 0x9e3779b1)) >>> 0);
  const lvl = buildCandidate(rng, p, n, seed);
  if (!replayWins(lvl, lvl.solution)) return null; // non dovrebbe mai succedere: è una rete di sicurezza
  if (p.needSlides) lvl.stats.tapsOnly = solveTaps(new Board(lvl), initialState(lvl), 3_000).result === 'found';
  lvl.stats.candidates = p.candidates;
  return lvl;
}

/**
 * Livello n. Per i livelli calibrati (vedi scripts/calibrate.ts) si genera direttamente
 * la variante scelta; oltre, si sceglie al volo tra alcune varianti con criteri veloci.
 */
export function generateLevel(n: number, override?: Partial<GenParams>): Level {
  const chosen = override ? undefined : calibrated(n);
  if (chosen !== undefined) {
    const lvl = buildLevelCandidate(n, chosen);
    if (lvl) return lvl;
  }
  const p = { ...paramsForLevel(n), ...override };
  let best: Level | null = null;
  let bestScore = Infinity;
  const maxC = p.needSlides ? p.candidates * 3 : p.candidates;
  for (let c = 0; c < maxC; c++) {
    const lvl = buildLevelCandidate(n, c, override);
    if (!lvl) continue;
    // si scartano i livelli vincibili senza scorrere e quelli troppo vuoti
    const score =
      (p.needSlides && lvl.stats.tapsOnly ? 10 : 0) +
      Math.abs(lvl.stats.fill - p.fill) * 4 -
      (lvl.stats.blocked / Math.max(1, lvl.buses.length)) * 0.5;
    if (score < bestScore) {
      bestScore = score;
      best = lvl;
    }
    if (bestScore < 0.12 && c >= 2) break; // già buono: inutile cercare oltre
  }
  if (!best) throw new Error(`Impossibile generare il livello ${n}`);
  return best;
}

function calibrated(n: number): number | undefined {
  const ch = CALIBRATION.charCodeAt(n - 1);
  if (Number.isNaN(ch) || ch === 46) return undefined; // '.' = non calibrato
  return ch - 48;
}
