// Tipi condivisi tra logica, generatore e rendering.

/** 0 = Nord (-y), 1 = Est (+x), 2 = Sud (+y), 3 = Ovest (-x) */
export type Dir = 0 | 1 | 2 | 3;
export const DX = [0, 1, 0, -1] as const;
export const DY = [-1, 0, 1, 0] as const;

/** Posti per lunghezza del bus (in celle). */
export const CAPACITY: Record<number, number> = { 2: 4, 3: 6 };

export interface Bus {
  id: number;
  /** cella posteriore (coordinate della griglia) */
  x: number;
  y: number;
  dir: Dir;
  len: number;
  color: number;
  cap: number;
  /** indice del garage da cui esce (solo per i bus nascosti nei garage) */
  garage?: number;
  /** bus che deve uscire dal garage prima di questo (-1 se è il primo) */
  prev?: number;
}

/** Garage: occupa `len` celle e sforna i suoi bus uno alla volta nelle celle davanti. */
export interface Garage {
  id: number;
  x: number;
  y: number;
  dir: Dir;
  len: number;
  cars: number[];
}

export interface LevelStats {
  difficulty: number; // 0..1
  winRate: number; // % vittorie del giocatore simulato
  targetWinRate: number;
  maxChain: number; // catena di blocchi più lunga
  candidates: number;
}

export interface Level {
  number: number;
  seed: number;
  /** dimensioni del riquadro del parcheggio nel mondo */
  w: number;
  h: number;
  /** griglia logica (ruotata di `theta` e traslata di tx, ty nel mondo) */
  gw: number;
  gh: number;
  theta: number;
  tx: number;
  ty: number;
  /** 1 = cella del parcheggio, 0 = fuori forma */
  mask: number[];
  shape: string;
  garages: Garage[];
  stalls: number;
  buses: Bus[];
  /** colori dei passeggeri, in ordine di coda */
  queue: number[];
  /** un ordine di uscita vincente (garantito per costruzione) */
  solution: number[];
  stats: LevelStats;
}

/** griglia -> mondo */
export function toWorld(l: Pick<Level, 'theta' | 'tx' | 'ty'>, x: number, y: number): [number, number] {
  const c = Math.cos(l.theta),
    s = Math.sin(l.theta);
  return [l.tx + c * x - s * y, l.ty + s * x + c * y];
}

export function busCells(b: Pick<Bus, 'x' | 'y' | 'dir' | 'len'>): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < b.len; i++) out.push([b.x + DX[b.dir] * i, b.y + DY[b.dir] * i]);
  return out;
}

/** Celle davanti al muso del bus, fino al bordo del parcheggio, in ordine. */
export function pathCells(b: Pick<Bus, 'x' | 'y' | 'dir' | 'len'>, w: number, h: number): [number, number][] {
  const out: [number, number][] = [];
  let x = b.x + DX[b.dir] * b.len;
  let y = b.y + DY[b.dir] * b.len;
  while (x >= 0 && y >= 0 && x < w && y < h) {
    out.push([x, y]);
    x += DX[b.dir];
    y += DY[b.dir];
  }
  return out;
}

export function difficultyLabel(d: number): string {
  if (d < 0.3) return 'Facile';
  if (d < 0.55) return 'Normale';
  if (d < 0.8) return 'Difficile';
  if (d <= 1.02) return 'Super difficile';
  return 'Estremo';
}
