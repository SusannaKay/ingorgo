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

const now = () => performance.now() / 1000;

function loadLevel(n: number) {
  levelNum = n;
  try {
    localStorage.setItem(STORE_KEY, String(n));
  } catch {
    /* modalità privata */
  }
  level = generateLevel(n);
  board = new Board(level);
  state = initialState(level);
  history = [];
  scene = new Scene(level);
  scene.rebuild(state, now());
  overlayShown = false;
  $('overlay').hidden = true;
  layout();
  updateHud();
  if (n === 1) toast('Tocca un bus: esce seguendo la freccia 🚌', 3500);
  else if (n === 2) toast('I passeggeri salgono solo sul bus del loro colore', 3500);
}

function layout() {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const w = window.innerWidth,
    h = window.innerHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const top = $('hud').getBoundingClientRect().bottom + 6;
  const bottom = h - $('bar').getBoundingClientRect().top + 6;
  scene.resize(w, h, top, bottom);
}

function updateHud() {
  $('levelNum').textContent = String(levelNum);
  const label = difficultyLabel(level.stats.difficulty);
  const badge = $('diffBadge');
  badge.textContent = label;
  badge.className = 'pill badge ' + (label === 'Facile' ? '' : label === 'Normale' ? 'normale' : label === 'Difficile' ? 'difficile' : 'super');
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

function showOverlay(emoji: string, title: string, text: string, actions: { label: string; secondary?: boolean; run: () => void }[]) {
  overlayShown = true;
  $('ovEmoji').textContent = emoji;
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
    navigator.vibrate?.(20);
  } else if (res.kind === 'moved') {
    history.push(before);
    scene.apply(res.events, t);
  }
  updateHud();
}

function undo() {
  const prev = history.pop();
  if (!prev) return;
  state = prev;
  scene.rebuild(state, now());
  overlayShown = false;
  $('overlay').hidden = true;
  updateHud();
}

function restart() {
  state = initialState(level);
  history = [];
  scene.rebuild(state, now());
  overlayShown = false;
  updateHud();
}

function extraStall() {
  if (state.extraUsed) return;
  addStall(board, state);
  scene.setStalls(state.slots.length);
  overlayShown = false;
  updateHud();
  toast('Un posto in più per questo livello!');
}

function hint() {
  if (state.status !== 'playing') return;
  const r = solve(board, state, 120_000);
  if (r.result === 'found') {
    scene.hint(r.moves[0], now());
  } else if (r.result === 'none') {
    toast('Da qui non si vince più: prova con Annulla ↶', 3000);
  } else {
    toast('Situazione intricata… prova con Annulla ↶', 2500);
  }
}

// ---------- ciclo principale ----------
function frame() {
  const t = now();
  scene.draw(ctx, t);
  $('queueLeft').textContent = String(level.queue.length - scene.queueLeft(t));
  if (!overlayShown && state.status === 'won' && scene.allBoarded(t)) {
    {
      showOverlay('🎉', 'Livello completato!', `Tutti a bordo in ${state.moves} mosse.`, [
        { label: 'Avanti →', run: () => loadLevel(levelNum + 1) },
      ]);
    }
  } else if (!overlayShown && state.status === 'lost' && scene.isSettled(t)) {
    {
      const actions = [];
      if (!state.extraUsed) actions.push({ label: '+1 posto e continua', run: extraStall });
      actions.push({ label: 'Annulla l’ultima mossa', secondary: true, run: undo });
      actions.push({ label: 'Riprova', secondary: true, run: restart });
      showOverlay('🚧', 'Parcheggio pieno!', 'Nessun bus libero per chi è in testa alla coda.', actions);
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
$('levelPill').style.pointerEvents = 'auto';
$('levelPill').onclick = () => {
  const v = prompt('Vai al livello:', String(levelNum));
  const n = Number(v);
  if (n >= 1) loadLevel(Math.floor(n));
};
window.addEventListener('resize', layout);
document.addEventListener('gesturestart', (e) => e.preventDefault());

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
      return scene.cam.p(vb.lotX, vb.lotY, 0.72);
    },
    status: () => ({ status: state.status, moves: state.moves, qi: state.qi, slots: state.slots.length }),
  };
}
