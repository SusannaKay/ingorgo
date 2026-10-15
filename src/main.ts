import './style.css';
import { Board, GameState, addStall, cloneState, initialState, tap } from './game/engine';
import { generateLevel } from './game/generator';
import { solve } from './game/solver';
import { Level, difficultyLabel } from './game/types';
import { Scene } from './render/scene';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('game');
const ctx = canvas.getContext('2d')!;
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
let scene: Scene;
let overlayShown = false;
let endHandled = false;
let helped = false; // ha usato annulla, aiuto o +1 posto

const now = () => performance.now() / 1000;

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
  scene = new Scene(level);
  layout();
  scene.rebuild(state, now(), true);
  overlayShown = false;
  endHandled = false;
  $('overlay').hidden = true;
  updateHud();
  pregenerate(n + 1);
  if (n === 1) toast('Tocca un bus: esce seguendo la freccia', 3500);
  else if (n === 2) toast('I passeggeri salgono solo sul bus del loro colore', 3500);
  else if (n === 3) toast('Se tutti i posti si riempiono senza il colore giusto, perdi', 3500);
}

function layout() {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const w = window.innerWidth,
    h = window.innerHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const top = $('hud').getBoundingClientRect().bottom + 4;
  const bottom = h - $('bar').getBoundingClientRect().top + 4;
  scene.resize(w, h, top, bottom, dpr);
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
  if (DEBUG) {
    const d = $('debug');
    d.hidden = false;
    const s = level.stats;
    d.textContent = `diff ${s.difficulty.toFixed(2)}  win ${(s.winRate * 100).toFixed(0)}% (target ${(s.targetWinRate * 100).toFixed(0)}%)
${level.w}x${level.h}  bus ${level.buses.length}  stalli ${state.slots.length}  catena ${s.maxChain}
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
function onTap(sx: number, sy: number) {
  if (overlayShown || state.status !== 'playing') return;
  const t = now();
  const id = scene.hit(sx, sy, t);
  if (id === null) return;
  const before = cloneState(state);
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
  resetEnd();
  updateHud();
  toast('Un posto in più per questo livello');
}

function hint() {
  if (state.status !== 'playing') return;
  helped = true;
  const r = solve(board, state, 120_000);
  if (r.result === 'found') scene.hint(r.moves[0], now());
  else if (r.result === 'none') toast('Da qui non si vince più: annulla qualche mossa', 3000);
  else toast('Situazione intricata: prova ad annullare una mossa', 2500);
}

// ---------- ciclo principale ----------
function frame() {
  const t = now();
  scene.draw(ctx, t);
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
  onTap(e.clientX, e.clientY);
});
$('btnUndo').onclick = undo;
$('btnRestart').onclick = restart;
$('btnStall').onclick = extraStall;
$('btnHint').onclick = hint;

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
// ridisegna lo sfondo quando arrivano i font
document.fonts?.ready.then(() => layout());

loadLevel(levelNum);
requestAnimationFrame(frame);

if (DEBUG) {
  // agganci per i test automatici
  (window as any).__game = {
    free: () => board.freeBuses(state),
    scene: () => scene,
    solution: () => solve(board, state, 200_000),
    screenOf: (id: number) => {
      const vb = scene.buses[id];
      return scene.cam.p(vb.lotX, vb.lotY, 0.74);
    },
    status: () => ({ status: state.status, moves: state.moves, qi: state.qi, slots: state.slots.length }),
  };
}
