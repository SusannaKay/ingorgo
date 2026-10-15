// Proiezione assonometrica ("finto 3D"): rotazione `yaw` sul piano + schiacciamento
// verticale per l'inclinazione della camera + altezza z verso l'alto dello schermo.
export class Camera {
  s = 40; // pixel per cella
  ox = 0;
  oy = 0;
  private c = 1;
  private sn = 0;

  constructor(
    public yaw = 0.16, // 0 = vista frontale 3/4, ~0.78 = isometrico classico a rombo
    public squash = 0.66, // inclinazione: 1 = dall'alto, 0.5 = molto radente
    public zk = 0.85, // quanto "sale" l'altezza
  ) {
    this.setYaw(yaw);
  }

  setYaw(y: number) {
    this.yaw = y;
    this.c = Math.cos(y);
    this.sn = Math.sin(y);
  }

  p(x: number, y: number, z = 0): [number, number] {
    const rx = x * this.c - y * this.sn;
    const ry = x * this.sn + y * this.c;
    return [this.ox + rx * this.s, this.oy + (ry * this.squash - z * this.zk) * this.s];
  }

  /** profondità per l'ordinamento (più grande = più vicino allo schermo) */
  depth(x: number, y: number) {
    return x * this.sn + y * this.c;
  }

  /** punto dello schermo -> punto sul terreno (z = 0) */
  ground(sx: number, sy: number): [number, number] {
    const rx = (sx - this.ox) / this.s;
    const ry = (sy - this.oy) / (this.s * this.squash);
    return [rx * this.c + ry * this.sn, -rx * this.sn + ry * this.c];
  }

  /** una faccia verticale con normale (nx, ny) è rivolta verso lo spettatore? */
  faceVisible(nx: number, ny: number) {
    return nx * this.sn + ny * this.c > 0.02;
  }

  fit(minX: number, minY: number, maxX: number, maxY: number, maxZ: number, vx: number, vy: number, vw: number, vh: number) {
    this.s = 1;
    this.ox = 0;
    this.oy = 0;
    const pts: [number, number][] = [];
    for (const x of [minX, maxX]) for (const y of [minY, maxY]) for (const z of [0, maxZ]) pts.push(this.p(x, y, z));
    const xs = pts.map((q) => q[0]);
    const ys = pts.map((q) => q[1]);
    const bw = Math.max(...xs) - Math.min(...xs);
    const bh = Math.max(...ys) - Math.min(...ys);
    this.s = Math.min(vw / bw, vh / bh);
    this.ox = vx + vw / 2 - ((Math.max(...xs) + Math.min(...xs)) / 2) * this.s;
    this.oy = vy + vh / 2 - ((Math.max(...ys) + Math.min(...ys)) / 2) * this.s;
  }
}
