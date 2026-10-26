import './style.css';
import { Board, GameState, addStall, cloneState, initialState, lift, slide, tap } from './game/engine';
import { generateLevel } from './game/generator';
import { hintMove } from './game/solver';
import { DX, DY, Dir, Level, difficultyLabel } from './game/types';
import { Timeline } from './render/timeline';
import { View3D } from './render/view3d';
import { Theme, themeForLevel } from './render/themes';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('game');
const fxCanvas = $<HTMLCanvasElement>('fx');
let view: View3D;
try {
  view = new View3D(canvas, fxCanvas);
} catch {
  document.body.innerHTML = '<p style="padding:24px;font:700 18px system-ui">Questo browser non supporta la grafica 3D (WebGL).</p>';
  throw new Error('WebGL non disponibile');
}
let theme: Theme | null = null;
const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug');
const STORE_KEY = 'ingorgo.level';

let saved = 0;
try {
  saved = Number(localStorage.getItem(STORE_KEY));
} catch {
  /* storage non disponibile */
}
let levelNum = Number(params.get('level')) || saved || 1;
let level: Level;
let board: Board;
let state: GameState;
let history: GameState[] = [];
let scene: Timeline;
let overlayShown = false;
let endHandled = false;
let helped = false; // ha usato annulla, aiuto, gru o +1 posto
let liftArmed = false;
let hintExplained = false;

const now = () => performance.now() / 1000;

function seenGarage(): boolean {
  try {
    if (localStorage.getItem('ingorgo.garage')) return true;
    localStorage.setItem('ingorgo.garage', '1');
  } catch {
    /* storage non disponibile */
  }
  return false;
}

// I livelli si generano in anticipo, mentre giochi quello corrente.
const cache = new Map<number, Level>();
function getLevel(n: number): Level {
  let l = cache.get(n);
  if (!l) {
    l = generateLevel(n);
    cache.set(n, l);
  }
  return l;
}
function pregenerate(n: number) {
  const run = () => {
    if (!cache.has(n)) cache.set(n, generateLevel(n));
  };
  const ric = (window as any).requestIdleCallback as ((cb: () => void, o?: object) => void) | undefined;
  if (ric) ric(run, { timeout: 3000 });
  else setTimeout(run, 900);
}

function loadLevel(n: number) {
  levelNum = n;
  try {
    localStorage.setItem(STORE_KEY, String(n));
  } catch {
    /* modalità privata */
  }
  level = getLevel(n);
  board = new Board(level);
  state = initialState(level);
  history = [];
  helped = false;
  scene = new Timeline(level);
  scene.rebuild(state, now(), true);
  const th = themeForLevel(n);
  const newWorld = theme !== null && theme.id !== th.id;
  theme = th;
  view.setLevel(scene, th);
  document.body.style.background = th.page;
  document.body.classList.toggle('night', th.night);
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', th.sky);
  layout();
  overlayShown = false;
  endHandled = false;
  $('overlay').hidden = true;
  updateHud();
  pregenerate(n + 1);
  setLiftArmed(false);
  if (n === 1) toast('Tocca un bus: esce seguendo la freccia. I passeggeri salgono sul bus del loro colore', 4500);
  else if (n === 2) toast('Trascina un bus per farlo scorrere nelle caselle libere, come nel gioco del 15', 4500);
  else if (n === 3) toast('Se tutti i posti si riempiono senza il colore giusto, perdi', 3500);
  else if (n === 4) toast('Il parcheggio ora è in diagonale: trascina lungo le righe delle caselle', 3500);
  else if (level.garages.length && !seenGarage()) toast('Garage: appena lo spazio davanti si libera, esce il bus successivo', 4500);
  else if (newWorld || (n > 1 && (n - 1) % 10 === 0)) toast(`Nuovo mondo: ${th.name}`, 2600);
}

function layout() {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const w = window.innerWidth,
    h = window.innerHeight;
  const top = $('hud').getBoundingClientRect().bottom + 4;
  const bottom = h - $('bar').getBoundingClientRect().top + 4;
  view.resize(w, h, top, bottom, dpr);
}

const TAG_CLASS: Record<string, string> = {
  Facile: '',
  Normale: 'normale',
  Difficile: 'difficile',
  'Super difficile': 'super',
  Estremo: 'estremo',
};

function updateHud() {
  $('levelNum').textContent = String(levelNum);
  const label = difficultyLabel(level.stats.difficulty);
  const badge = $('diffBadge');
  badge.textContent = label;
  badge.className = 'chip tag ' + TAG_CLASS[label];
  $<HTMLButtonElement>('btnUndo').disabled = history.length === 0;
  $<HTMLButtonElement>('btnStall').disabled = state.extraUsed;
  $<HTMLButtonElement>('btnLift').disabled = state.liftUsed;
  if (DEBUG) {
    const d = $('debug');
    d.hidden = false;
    const s = level.stats;
    d.textContent = `diff ${s.difficulty.toFixed(2)}  pieno ${(s.fill * 100).toFixed(0)}%  bloccati ${s.blocked}
${level.w}x${level.h}  bus ${level.buses.length}  stalli ${state.slots.length}  fioriere ${level.blocks.length}
coda ${level.queue.length}  mosse ${state.moves}`;
  }
}

let toastTimer = 0;
function toast(msg: string, ms = 2200) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove('show'), ms);
}

const ART = {
  win: `<svg viewBox="0 0 64 64"><path d="M32 6l7.6 15.4 17 2.5-12.3 12 2.9 16.9L32 44.8l-15.2 8 2.9-16.9-12.3-12 17-2.5z" fill="#fff" stroke="#1d2340" stroke-width="4" stroke-linejoin="round"/></svg>`,
  lose: `<svg viewBox="0 0 64 64"><rect x="8" y="20" width="48" height="16" rx="4" fill="#fff" stroke="#1d2340" stroke-width="4"/><path d="M18 20l-8 16M32 20l-8 16M46 20l-8 16" stroke="#1d2340" stroke-width="5"/><path d="M16 36v18M48 36v18" stroke="#1d2340" stroke-width="5" stroke-linecap="round"/></svg>`,
};

function showOverlay(kind: 'win' | 'lose', title: string, text: string, actions: { label: string; secondary?: boolean; run: () => void }[]) {
  overlayShown = true;
  const art = $('ovArt');
  art.innerHTML = ART[kind];
  art.style.background = kind === 'win' ? '#ffd23f' : '#ff4d4d';
  $('ovTitle').textContent = title;
  $('ovText').textContent = text;
  const box = $('ovActions');
  box.innerHTML = '';
  for (const a of actions) {
    const b = document.createElement('button');
    b.textContent = a.label;
    if (a.secondary) b.className = 'secondary';
    b.onclick = () => {
      $('overlay').hidden = true;
      a.run();
    };
    box.appendChild(b);
  }
  $('overlay').hidden = false;
}

// ---------- azioni ----------
function playing() {
  return !overlayShown && state.status === 'playing';
}

/** tocco senza trascinare: il bus esce (o la gru lo solleva) */
function onTap(id: number) {
  if (!playing()) return;
  const t = now();
  const before = cloneState(state);
  if (liftArmed) {
    const r = lift(board, state, id);
    setLiftArmed(false);
    if (r.kind === 'moved') {
      helped = true;
      history.push(before);
      scene.apply(r.events, t, true);
      navigator.vibrate?.([10, 30, 10]);
    }
    updateHud();
    return;
  }
  const res = tap(board, state, id);
  if (res.kind === 'blocked') {
    scene.bump(id, res.blocker, res.dist, t);
    navigator.vibrate?.(25);
  } else if (res.kind === 'moved') {
    history.push(before);
    scene.apply(res.events, t);
    navigator.vibrate?.(8);
  }
  updateHud();
}

/** vettore sullo schermo di una cella nella direzione d, vicino al bus */
function screenStep(id: number, d: Dir): [number, number] {
  const vb = scene.buses[id];
  const c = Math.cos(level.theta),
    sn = Math.sin(level.theta);
  const wx = c * DX[d] - sn * DY[d],
    wy = sn * DX[d] + c * DY[d];
  const [x0, y0] = view.screenOf(vb.lotX, vb.lotY, 0.4);
  const [x1, y1] = view.screenOf(vb.lotX + wx, vb.lotY + wy, 0.4);
  return [x1 - x0, y1 - y0];
}

/** direzione della griglia più vicina al trascinamento e lunghezza di una cella sullo schermo */
function dragDir(id: number, dx: number, dy: number): { d: Dir; cell: number } {
  let best: Dir = 0,
    bestDot = -Infinity,
    cell = 40;
  for (let d = 0; d < 4; d++) {
    const [sx, sy] = screenStep(id, d as Dir);
    const len = Math.hypot(sx, sy) || 1;
    const dot = (dx * sx + dy * sy) / len;
    if (dot > bestDot) {
      bestDot = dot;
      best = d as Dir;
      cell = len;
    }
  }
  return { d: best, cell };
}

interface Drag {
  id: number;
  x: number;
  y: number;
  slid: boolean;
  nudged: boolean;
}
let drag: Drag | null = null;

function onDragMove(e: PointerEvent) {
  if (!drag || !playing() || liftArmed) return;
  const dx = e.clientX - drag.x,
    dy = e.clientY - drag.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 12) return;
  const { d, cell } = dragDir(drag.id, dx, dy);
  if (dist < Math.max(12, cell * 0.42)) return;
  const t = now();
  const before = cloneState(state);
  const r = slide(board, state, drag.id, d);
  if (r.kind === 'slid') {
    // un trascinamento lungo può far scorrere più celle: si annulla tutto in una volta
    if (!drag.slid) history.push(before);
    drag.slid = true;
    scene.apply(r.events, t);
    navigator.vibrate?.(5);
    updateHud();
  } else if (r.kind === 'blocked' && !drag.nudged) {
    drag.nudged = true;
    scene.nudge(drag.id, d, t);
    navigator.vibrate?.(15);
  }
  drag.x = e.clientX;
  drag.y = e.clientY;
}

function setLiftArmed(on: boolean) {
  liftArmed = on;
  $('btnLift').classList.toggle('armed', on);
}

function armLift() {
  if (state.liftUsed || state.status !== 'playing') return;
  if (liftArmed) {
    setLiftArmed(false);
    return;
  }
  setLiftArmed(true);
  toast('Tocca il bus da sollevare, anche se è bloccato', 2600);
}

function resetEnd() {
  overlayShown = false;
  endHandled = false;
  $('overlay').hidden = true;
}

function undo() {
  const prev = history.pop();
  if (!prev) return;
  helped = true;
  state = prev;
  scene.rebuild(state, now());
  resetEnd();
  updateHud();
}

function restart() {
  state = initialState(level);
  history = [];
  scene.rebuild(state, now(), true);
  resetEnd();
  updateHud();
}

function extraStall() {
  if (state.extraUsed) return;
  helped = true;
  addStall(board, state);
  scene.setStalls(state.slots.length);
  view.refreshBays();
  resetEnd();
  updateHud();
  toast('Un posto in più per questo livello');
}

function hint() {
  if (state.status !== 'playing') return;
  helped = true;
  const r = hintMove(board, state);
  if (r.kind === 'move') {
    scene.hint(r.op.id, now(), r.op.d < 0 ? null : (r.op.d as Dir));
    if (r.op.d >= 0 && !hintExplained) {
      hintExplained = true;
      toast('Fai scorrere il bus nella direzione della freccia gialla', 2600);
    }
  } else if (r.kind === 'none') toast('Da qui non si vince più: annulla qualche mossa', 3000);
  else toast('Situazione intricata: prova ad annullare qualche mossa', 2500);
}

// ---------- ciclo principale ----------
function frame() {
  const t = now();
  view.render(t);
  $('queueLeft').textContent = String(level.queue.length - scene.queueLeft(t));
  if (!overlayShown && state.status === 'won' && scene.allBoarded(t)) {
    if (!endHandled) {
      endHandled = true;
      scene.celebrate(t);
      navigator.vibrate?.([30, 40, 30]);
      setTimeout(() => {
        const text = helped ? `${state.moves} mosse.` : `${state.moves} mosse, senza aiuti.`;
        showOverlay('win', 'Tutti a bordo!', text, [{ label: `Livello ${levelNum + 1}`, run: () => loadLevel(levelNum + 1) }]);
      }, 900);
    }
  } else if (!overlayShown && state.status === 'lost' && scene.isSettled(t)) {
    if (!endHandled) {
      endHandled = true;
      scene.lost(t);
      navigator.vibrate?.(60);
      setTimeout(() => {
        if (state.status !== 'lost') return;
        const actions = [];
        if (!state.extraUsed) actions.push({ label: '+1 posto e continua', run: extraStall });
        actions.push({ label: 'Annulla l’ultima mossa', secondary: true, run: undo });
        actions.push({ label: 'Ricomincia il livello', secondary: true, run: restart });
        showOverlay('lose', 'Parcheggio pieno', 'Nessun bus in attesa ha il colore di chi è in testa alla coda.', actions);
      }, 1100);
    }
  }
  requestAnimationFrame(frame);
}

canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (!playing()) return;
  const id = view.hit(e.clientX, e.clientY, now());
  if (id === null) return;
  if (liftArmed) {
    onTap(id);
    return;
  }
  drag = { id, x: e.clientX, y: e.clientY, slid: false, nudged: false };
  canvas.setPointerCapture?.(e.pointerId);
});
canvas.addEventListener('pointermove', onDragMove);
const endDrag = (e: PointerEvent) => {
  if (!drag) return;
  const d = drag;
  drag = null;
  canvas.releasePointerCapture?.(e.pointerId);
  if (!d.slid && !d.nudged && e.type === 'pointerup') onTap(d.id);
};
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
$('btnUndo').onclick = undo;
$('btnRestart').onclick = restart;
$('btnStall').onclick = extraStall;
$('btnHint').onclick = hint;
$('btnLift').onclick = armLift;

// selettore del livello
$('levelPill').onclick = () => {
  const input = $<HTMLInputElement>('pickerInput');
  input.value = String(levelNum);
  $('picker').hidden = false;
  setTimeout(() => input.select(), 50);
};
$('pickerCancel').onclick = () => ($('picker').hidden = true);
$('pickerForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const n = Math.floor(Number($<HTMLInputElement>('pickerInput').value));
  $('picker').hidden = true;
  if (n >= 1) loadLevel(n);
});

window.addEventListener('resize', () => {
  layout();
});
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.fonts?.ready.then(() => layout());

loadLevel(levelNum);
requestAnimationFrame(frame);

if (DEBUG) {
  // agganci per i test automatici
  (window as any).__game = {
    free: () => board.freeBuses(state),
    scene: () => scene,
    solution: () => level.solution,
    screenOf: (id: number) => {
      const vb = scene.buses[id];
      return view.screenOf(vb.lotX, vb.lotY, 0.74);
    },
    step: (id: number, d: Dir) => screenStep(id, d),
    status: () => ({ status: state.status, moves: state.moves, qi: state.qi, slots: state.slots.length }),
  };
}
