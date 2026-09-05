'use strict';
/* Mobile-first scan review.
 *
 * The crop is a RATIO-LOCKED rectangle {cx, cy, w, h, angle}, not four free
 * corners: pages come from a sheet-fed ADF, not a handheld camera, so there is
 * no perspective to correct and a free quad only offers ways to damage a scan.
 * Corners are derived when the server is called, so the backend never learns
 * about frames.
 *
 * The canvas rotates the IMAGE by -angle, so the frame always draws
 * axis-aligned. That is what makes the straighten dial legible against the
 * screen edges, and it collapses hit-testing to point-in-rectangle.
 */

// Portrait h/w, mirroring frame.ratio() on the server. Read from the ISO
// millimetre sizes, NOT sqrt(2): A4 1.414286, A5 1.418919, A6 1.409524 differ.
const PAPER_MM = { A4: [210, 297], A5: [148, 210], A6: [105, 148] };
const RATIO = {};
for (const [k, [w, h]] of Object.entries(PAPER_MM)) RATIO[k] = h / w;

const MIN_SIDE = 64;      // source px; warp() dies under 8, and a frame smaller
                          // than its own grab band is unusable
const BAND_MAX = 24;        // screen px: half-extent of a corner's grab zone
const MOVE_THRESHOLD = 10;  // screen px of travel before a move begins
const ZOOM_MIN = 1, ZOOM_MAX = 8;
const LOUPE_ZOOM = 3;     // magnification of the corner views while dragging
const LOUPE_SIZE = 96;    // CSS px, square
const LOUPE_PAD = 10;     // CSS px clear of the safe area's edges
const DIAL_RANGE = 15;    // degrees either side of the detected angle
const DIAL_STEP = 0.1;    // the dial snaps to this, matching the +/- buttons

const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');
const gridCv = document.getElementById('grid');
const gctx = gridCv.getContext('2d');
const dial = document.getElementById('dial');
const dctx = dial.getContext('2d');

const state = {
  page: null, img: null,
  // Bumped by every showPage(). Anything that resumes after an await
  // compares against it and gives up if a newer page has since started.
  gen: 0,
  documents: [], docIndex: 0, pageIndex: 0,
  // Edits are kept per page id, so stepping away and back does not silently
  // throw away work. Navigation you cannot trust is worse than none.
  edits: {},
  frame: null,                // {cx, cy, w, h, angle} in source px
  detectedAngle: 0,
  format: 'A4', orientation: 'portrait', rotation: 0,
  view: { zoom: 1, panX: 0, panY: 0 },
  mode: 'crop', grid: true, film: true, peek: false, pageSetup: false,
  history: [],
  // Wide screens have room for the filename inline; a phone does not.
  titleOpen: window.matchMedia('(min-width: 561px)').matches,
};
window.state = state;

const q = id => document.querySelector(`[data-testid="${id}"]`);
function say(m, c) {
  const e = q('status');
  e.textContent = m || '';
  e.style.color = c || 'var(--dim)';
}

/* Every action here talks to the server, over a phone's Wi-Fi, while reviewing
 * documents that must not be lost. A bare `await fetch` rejects when the phone
 * walks out of range; the handler then aborts mid-way and the UI is left saying
 * "accepting…" for ever with the page still pending, so the operator taps again.
 * Every request goes through here so a failure is always visible, and every
 * entry point through guard() so it is always caught.
 *
 * `r.ok` is checked here too: /api/queue answers 401 with a plain-text body, and
 * `r.json()` on that throws a SyntaxError that used to leave a blank canvas with
 * no message and no way back except a reload.
 */
async function request(url, opts) {
  let r;
  try {
    r = await fetch(url, opts);
  } catch {
    throw new Error('network unreachable');
  }
  if (!r.ok) throw new Error(`server said ${r.status}`);
  return r;
}

/* Catch and report, so no entry point can fail silently.
 *
 * `exclusive` additionally serialises the DECISIONS - accept, reject, send.
 * A double-tap there would otherwise report a failure for a decision that in
 * fact succeeded, because the second POST 404s precisely because the first one
 * worked and the page is no longer pending.
 *
 * Navigation is deliberately NOT exclusive. Stepping fetches the next scan, so
 * an exclusive chevron drops the second of two quick taps and the operator
 * advances one document instead of two - worse than the double-request it
 * would have avoided.
 *
 * Only user-facing entry points are wrapped. load() and showPage() must stay
 * unwrapped: accept() awaits them internally, and a busy check there would
 * silently skip the reload instead of deferring it.
 */
let busy = false;
function guard(fn, what, exclusive = true) {
  return async (...args) => {
    if (exclusive) {
      if (busy) return;
      busy = true;
    }
    try {
      await fn(...args);
    } catch (e) {
      say(`${what} failed: ${e.message}`, 'var(--err)');
    } finally {
      if (exclusive) busy = false;
    }
  };
}

window.addEventListener('unhandledrejection', e => {
  const m = (e.reason && e.reason.message) || e.reason;
  say(`unexpected error: ${m}`, 'var(--err)');
});

/* True when there is a page to act on.
 *
 * The empty queue is the app's NORMAL terminal state - documents.build() drops
 * a document once every page is closed, so sending the last one leaves
 * state.frame null. updateNav() disabled accept/reject/undo/reset but not the
 * rest of the toolbar, and straighten, peek, the format chips, swap, rotate and
 * the nudges all dereference the frame: dialValue() is literally
 * `state.frame.angle - state.detectedAngle`. */
function haveFrame() { return !!state.frame; }

function ratioOf(fmt, orientation) {
  return orientation === 'landscape' ? 1 / RATIO[fmt] : RATIO[fmt];
}

function cornersOf(f) {
  const hw = f.w / 2, hh = f.h / 2;
  const a = f.angle * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(
    ([x, y]) => [f.cx + x * ca - y * sa, f.cy + x * sa + y * ca]);
}
window.cornersOf = cornersOf;

/** Canvas px per source px that fits the whole scan, before user zoom. */
function baseScale() {
  if (!state.img) return 1;
  const pad = 40;
  return Math.min((cv.width - pad) / state.img.naturalWidth,
                  (cv.height - pad) / state.img.naturalHeight);
}

/** Degrees the whole view is turned by, so the output rotation is VISIBLE
 *  rather than only showing up in the final PDF. */
function viewRot() { return state.rotation; }

function toScreen([x, y]) {
  const f = state.frame, v = state.view, s = baseScale() * v.zoom;
  const a = (viewRot() - f.angle) * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
  const dx = x - f.cx, dy = y - f.cy;
  return [cv.width / 2 + v.panX + (dx * ca - dy * sa) * s,
          cv.height / 2 + v.panY + (dx * sa + dy * ca) * s];
}
/** Screen -> image, measured against an EXPLICIT frame.
 *
 * This has to be explicit. The origin is the frame's centre, and a drag handler
 * that mutates the centre and then measures the next delta against the moved
 * origin re-counts its own movement every event: a 100px drag moved the frame
 * 8.5x too far, worse the more pointer events arrived. Every gesture therefore
 * measures against `grabFrame` - the frame as it was when the drag began.
 */
function toImageWith(f, [sx, sy]) {
  const v = state.view, s = baseScale() * v.zoom;
  const px = (sx - cv.width / 2 - v.panX) / s;
  const py = (sy - cv.height / 2 - v.panY) / s;
  const a = (f.angle - viewRot()) * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
  return [f.cx + px * ca - py * sa, f.cy + px * sa + py * ca];
}
function toImage(p) { return toImageWith(state.frame, p); }

/** A screen-space delta as an image-space delta: rotation and scale only, no
 *  origin, so it cannot drift as the frame moves. */
function screenDeltaToImage(f, [dsx, dsy]) {
  const s = baseScale() * state.view.zoom;
  const a = (f.angle - viewRot()) * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
  return [(dsx * ca - dsy * sa) / s, (dsx * sa + dsy * ca) / s];
}
window.toScreen = toScreen; window.toImage = toImage;

/** The frame as an axis-aligned screen rectangle - it is never tilted here. */
function frameRectOnScreen() {
  const f = state.frame, v = state.view, s = baseScale() * v.zoom;
  // At 90/270 the frame is still axis-aligned on screen, but lying on its side.
  const turned = viewRot() % 180 !== 0;
  const w = (turned ? f.h : f.w) * s, h = (turned ? f.w : f.h) * s;
  return { x: cv.width / 2 + v.panX - w / 2, y: cv.height / 2 + v.panY - h / 2, w, h };
}
window.frameRectOnScreen = frameRectOnScreen;

function canvasPt(e) {
  const b = cv.getBoundingClientRect();
  return [(e.clientX - b.left) * (cv.width / b.width),
          (e.clientY - b.top) * (cv.height / b.height)];
}

function resize() {
  const dpr = window.devicePixelRatio || 1;
  for (const c of [cv, gridCv]) {
    c.width = Math.round(c.clientWidth * dpr);
    c.height = Math.round(c.clientHeight * dpr);
  }
  // The dial has its own canvas and render() does not touch it, so rotating
  // the phone in straighten mode left it at the old backing size, stretched by
  // CSS, until the next dial interaction.
  if (state.mode === 'straighten') drawDial();
  render();
}
window.addEventListener('resize', resize);

// ------------------------------------------------------------------ render

/** True when nothing has been changed on this page, so Reset has no work. */
function isPristine() {
  const s = state.page && state.page.seeded;
  if (!s || !state.frame) return true;
  const f = state.frame;
  return Math.abs(f.cx - s.cx) < 0.01 && Math.abs(f.cy - s.cy) < 0.01
      && Math.abs(f.w - s.w) < 0.01 && Math.abs(f.h - s.h) < 0.01
      && Math.abs(f.angle - s.angle) < 1e-6
      && state.format === s.format && state.orientation === s.orientation
      && state.rotation === 0;
}
window.isPristine = isPristine;

function syncActions() {
  q('btn-undo').disabled = state.history.length === 0;
  q('btn-reset').disabled = isPristine();
}
window.syncActions = syncActions;

function render() {
  syncZoomUI();
  if (!ctx) return;
  syncActions();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#0d0f13';
  ctx.fillRect(0, 0, cv.width, cv.height);
  if (!state.img || !state.frame) return;
  if (state.peek) return;                 // peek paints its own thing

  const f = state.frame, v = state.view, s = baseScale() * v.zoom;
  ctx.save();
  ctx.translate(cv.width / 2 + v.panX, cv.height / 2 + v.panY);
  ctx.rotate((viewRot() - f.angle) * Math.PI / 180);
  ctx.scale(s, s);
  ctx.translate(-f.cx, -f.cy);
  ctx.drawImage(state.img, 0, 0);
  ctx.restore();

  const r = frameRectOnScreen();
  // Drawn in BOTH modes: the frame is draggable in both, and hiding it in
  // straighten mode meant dragging something invisible, which read as the
  // gesture being broken rather than merely unlit.
  dimOutside(r); hatchOutsideScan();
  drawGrid(r);                            // always called; clears when grid off
  drawBrackets(r);
  drawLoupes();
  if (state.page) showFlags();
}
window.render = render;

function dimOutside(r) {
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.beginPath();
  ctx.rect(0, 0, cv.width, cv.height);
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.fill('evenodd');
  ctx.restore();
}

/** Mark the part of the frame that falls beyond the scan.
 *
 * The frame is deliberately NOT clamped into the image: a sheet fed flush to
 * the leading edge genuinely has a corner outside the captured area, and
 * clamping it left -3.00 degrees of residual skew on a real A6. warp() fills
 * that sliver white; this makes it visible before accepting rather than a
 * surprise afterwards.
 */
function hatchOutsideScan() {
  if (!state.page) return;
  const W = state.page.width, H = state.page.height;
  const p = [[0, 0], [W, 0], [W, H], [0, H]].map(toScreen);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, cv.width, cv.height);
  ctx.moveTo(p[0][0], p[0][1]);
  for (let i = 1; i < 4; i++) ctx.lineTo(p[i][0], p[i][1]);
  ctx.closePath();
  ctx.fillStyle = 'rgba(210,153,34,0.18)';
  ctx.fill('evenodd');
  ctx.restore();
}

function drawBrackets(r) {
  const L = Math.min(34, r.w / 4, r.h / 4);
  ctx.save();
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 4; ctx.lineCap = 'square';
  const corners = [[r.x, r.y, 1, 1], [r.x + r.w, r.y, -1, 1],
                   [r.x + r.w, r.y + r.h, -1, -1], [r.x, r.y + r.h, 1, -1]];
  for (const [x, y, sx, sy] of corners) {
    ctx.beginPath();
    ctx.moveTo(x + sx * L, y); ctx.lineTo(x, y); ctx.lineTo(x, y + sy * L);
    ctx.stroke();
  }
  ctx.restore();
}

/** The reference raster, clipped to the frame and therefore aligned to the
 *  OUTPUT. On its own layer so "grid off" is exactly zero painted pixels. */
function drawGrid(r) {
  const dpr = window.devicePixelRatio || 1;
  gctx.setTransform(1, 0, 0, 1, 0, 0);
  gctx.clearRect(0, 0, gridCv.width, gridCv.height);
  if (!state.grid || state.peek) return;
  gctx.save();
  gctx.beginPath(); gctx.rect(r.x, r.y, r.w, r.h); gctx.clip();
  const step = Math.min(r.w, r.h) / 10;
  gctx.strokeStyle = 'rgba(120,180,255,0.75)'; gctx.lineWidth = 1 * dpr;
  gctx.beginPath();
  for (let x = r.x + step; x < r.x + r.w - 0.5; x += step) {
    gctx.moveTo(x, r.y); gctx.lineTo(x, r.y + r.h);
  }
  for (let y = r.y + step; y < r.y + r.h - 0.5; y += step) {
    gctx.moveTo(r.x, y); gctx.lineTo(r.x + r.w, y);
  }
  gctx.stroke();
  // A stronger centre cross: one unambiguous horizontal and vertical reference.
  gctx.strokeStyle = 'rgba(255,70,70,0.95)'; gctx.lineWidth = 2 * dpr;
  gctx.beginPath();
  gctx.moveTo(r.x + r.w / 2, r.y); gctx.lineTo(r.x + r.w / 2, r.y + r.h);
  gctx.moveTo(r.x, r.y + r.h / 2); gctx.lineTo(r.x + r.w, r.y + r.h / 2);
  gctx.stroke();
  gctx.restore();
}

/** The canvas area not hidden behind the floating bars.
 *
 * Measured from the bars rather than hardcoded: they change height with the
 * mode, and a loupe tucked under the top bar would be invisible exactly when
 * it is needed. */
function safeArea() {
  const dpr = window.devicePixelRatio || 1;
  const h = id => {
    const el = document.getElementById(id);
    return el ? el.getBoundingClientRect().height * dpr : 0;
  };
  const pad = LOUPE_PAD * dpr;
  return { x: pad, y: h('top') + pad,
           w: cv.width - 2 * pad,
           h: cv.height - h('top') - h('controls') - 2 * pad };
}

/** Magnified views of the frame's corners, so a corner can be put on a paper
 *  edge exactly rather than by eye.
 *
 * Pinned to the screen corners: while moving the frame the finger is in the
 * middle, so nothing is covered, and the top-left loupe showing the top-left
 * corner needs no explaining. While dragging one corner to resize, only that
 * corner is shown, and it moves to the opposite side of the screen so the hand
 * is not over it.
 */
function drawLoupes() {
  state.loupes = [];
  if (!grab || state.peek || !state.img) return;
  if (grab.kind === 'move' && !moveArmed) return;

  const dpr = window.devicePixelRatio || 1;
  const size = LOUPE_SIZE * dpr;
  const area = safeArea();
  if (area.h < size * 2 || area.w < size * 2) return;   // no room; skip quietly

  const turn = ((viewRot() / 90) | 0) % 4;
  const spots = [[area.x, area.y],
                 [area.x + area.w - size, area.y],
                 [area.x + area.w - size, area.y + area.h - size],
                 [area.x, area.y + area.h - size]];

  const corners = cornersOf(state.frame);
  const spotOf = i => (i + turn) % 4;                   // where corner i is drawn
  let show;
  if (grab.kind === 'corner') {
    // The dragged corner and its two neighbours - which is exactly the set that
    // MOVES. The opposite corner is the anchor and stays put, so watching it
    // tells you nothing, and leaving it out frees its screen corner for the
    // dragged one, which would otherwise sit under your hand.
    show = [[(grab.ix + 1) % 4, spotOf((grab.ix + 1) % 4)],
            [(grab.ix + 3) % 4, spotOf((grab.ix + 3) % 4)],
            [grab.ix, (spotOf(grab.ix) + 2) % 4]];
  } else {
    show = [0, 1, 2, 3].map(i => [i, spotOf(i)]);
  }

  const s = baseScale() * state.view.zoom * LOUPE_ZOOM;
  for (const [ci, spot] of show) {
    const [lx, ly] = spots[spot];
    const cxm = lx + size / 2, cym = ly + size / 2;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(lx, ly, size, size, 12 * dpr);
    ctx.clip();
    // Same amber as the main view's out-of-scan hatch, so a corner sitting off
    // the paper reads as "past the edge of the scan" rather than as a black
    // hole where the loupe failed to draw.
    ctx.fillStyle = '#241d10';
    ctx.fillRect(lx, ly, size, size);

    ctx.save();
    ctx.translate(cxm, cym);
    ctx.rotate((viewRot() - state.frame.angle) * Math.PI / 180);
    ctx.scale(s, s);
    ctx.translate(-corners[ci][0], -corners[ci][1]);
    ctx.drawImage(state.img, 0, 0);
    // The frame's own outline, so the corner is seen against the paper edge.
    ctx.strokeStyle = 'rgba(74,158,255,0.95)';
    ctx.lineWidth = 1.5 * dpr / s;
    ctx.beginPath();
    ctx.moveTo(corners[0][0], corners[0][1]);
    for (let i = 1; i < 4; i++) ctx.lineTo(corners[i][0], corners[i][1]);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();

    // The crossbar: dead centre of the loupe IS the corner. An even line width
    // on integer coordinates stays crisp; a 1px line at dpr 1 straddles two
    // device pixels and washes out to half strength.
    ctx.strokeStyle = 'rgba(255,70,70,0.95)';
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.moveTo(lx, cym); ctx.lineTo(lx + size, cym);
    ctx.moveTo(cxm, ly); ctx.lineTo(cxm, ly + size);
    ctx.stroke();
    ctx.restore();

    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.roundRect(lx, ly, size, size, 12 * dpr);
    ctx.stroke();
    state.loupes.push({ x: lx, y: ly, size, corner: ci, spot });
  }
}
window.drawLoupes = drawLoupes;
window.LOUPE_ZOOM_FOR_TEST = LOUPE_ZOOM;

// ------------------------------------------------------------- hit testing

/** Half-extent of a corner's grab zone, in canvas px.
 *
 * Capped at a quarter of the frame's smaller screen dimension: a fixed 24px
 * zone would swallow the interior of a small or zoomed-out frame and leave
 * nothing to grab for moving it.
 */
/* Half-extent of a corner's grab zone.
 *
 * BAND_MAX on any ordinary frame. The cap is what matters on a small one: at a
 * third of the shorter side the four corner zones still leave a third of it in
 * the middle, so there is always a core to drag the frame by. hitTest() used to
 * undo this with Math.max(22 * dpr, b) to keep a 44px touch target - but a
 * frame small enough for the cap to bind has no room for a 44px target that is
 * not also the whole frame, so the two intents cannot both hold. The core wins:
 * a corner that is slightly small is still reachable, whereas a frame you
 * cannot move at all has no way back. */
function bandWidth() {
  const r = frameRectOnScreen();
  const dpr = window.devicePixelRatio || 1;
  return Math.min(BAND_MAX * dpr, Math.min(r.w, r.h) / 3);
}
window.bandWidth = bandWidth;

/** What is under this canvas point: a corner, an edge, the movable core, or nothing. */
function hitTest([sx, sy]) {
  const r = frameRectOnScreen(), b = bandWidth();
  const corner = b;
  const pts = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]];
  const turn = ((viewRot() / 90) | 0) % 4;
  for (let s = 0; s < 4; s++) {
    if (Math.abs(sx - pts[s][0]) <= corner && Math.abs(sy - pts[s][1]) <= corner)
      // Screen corner -> frame corner. With the view turned by 90 the frame's
      // top-left is drawn at the screen's top-right.
      return { kind: 'corner', ix: (s - turn + 4) % 4 };
  }
  if (sx > r.x && sx < r.x + r.w && sy > r.y && sy < r.y + r.h)
    return { kind: 'move', ix: -1 };
  return { kind: null, ix: -1 };            // outside: inert, so steadying the
                                            // phone cannot nudge a settled crop
}
window.hitTest = hitTest;

/** Frame-local coordinates. The frame is axis-aligned on screen, so this is
 *  just the inverse rotation about its centre. */
function toLocalWith(f, [x, y]) {
  const a = -f.angle * Math.PI / 180;
  const dx = x - f.cx, dy = y - f.cy;
  return [dx * Math.cos(a) - dy * Math.sin(a), dx * Math.sin(a) + dy * Math.cos(a)];
}
function fromLocalWith(f, [lx, ly]) {
  const a = f.angle * Math.PI / 180;
  return [f.cx + lx * Math.cos(a) - ly * Math.sin(a),
          f.cy + lx * Math.sin(a) + ly * Math.cos(a)];
}

/** Resize so the ratio holds and the opposite corner stays put.
 *
 * Measured against `g`, the frame at the start of the gesture, not the live
 * frame this function is about to modify - see toImageWith().
 */
function applyResize(ix, screenPt, g) {
  const ratio = ratioOf(state.format, state.orientation);
  const [lx, ly] = toLocalWith(g, toImageWith(g, screenPt));
  const hw = g.w / 2, hh = g.h / 2;
  // Corners only. With the ratio locked, dragging a side cannot mean what it
  // looks like it means - the opposite dimension has to follow - so a side
  // handle reads as a promise the geometry cannot keep.
  const sx = (ix === 0 || ix === 3) ? -1 : 1;
  const sy = (ix === 0 || ix === 1) ? -1 : 1;
  const ax = -sx * hw, ay = -sy * hh;       // the opposite corner, pinned
  const cw = Math.abs(lx - ax), ch = Math.abs(ly - ay);
  let nw = Math.max(cw, ch / ratio), nh = nw * ratio;
  if (Math.min(nw, nh) < MIN_SIDE) return;  // warp() dies on a degenerate crop
  // Recentre so the anchor point does not move.
  const dirX = ax <= 0 ? 1 : -1, dirY = ay <= 0 ? 1 : -1;
  const [ncx, ncy] = fromLocalWith(g, [ax + dirX * nw / 2, ay + dirY * nh / 2]);
  const f = state.frame;
  f.cx = ncx; f.cy = ncy; f.w = nw; f.h = nh;
}
window.applyResize = applyResize;

// --------------------------------------------------------------- gestures

let grab = null, grabStart = null, grabFrame = null, moveArmed = true;
// Pushed on the first actual change of a gesture, not on pointerdown: a tap
// that moves nothing must not light up Undo.
let gesturePushed = false;
function pushOnce() {
  if (!gesturePushed) { pushHistory(); gesturePushed = true; }
}

/** How much of the finger's travel the frame takes, by zoom.
 *
 * At 1x the whole scan is squeezed into a few hundred pixels, so one finger
 * pixel is several scan pixels and 1:1 is unusably twitchy. By 3x a pixel is
 * already fine, so the damping eases out and the frame tracks the finger.
 */
function moveGain() {
  return Math.min(1, 0.3 + 0.7 * (state.view.zoom - 1) / 2);
}
window.moveGain = moveGain;
const touches = new Map();
let pinch = null;
/* A right-button drag in progress: where it started and the pan it started
 * from, so every move is measured from the origin and cannot drift. */
let viewPan = null;

cv.addEventListener('pointerdown', e => {
  // Right button pans the sheet. Checked before hitTest, so it works over the
  // crop core too -- where a left drag would move the crop instead.
  if (e.button === 2) {
    if (state.peek) return;
    viewPan = { start: canvasPt(e),
                panX: state.view.panX, panY: state.view.panY };
    grab = null;
    cv.setPointerCapture(e.pointerId);
    cv.style.cursor = 'grabbing';
    e.preventDefault();
    return;
  }
  touches.set(e.pointerId, canvasPt(e));
  if (touches.size >= 2) {
    // Two fingers pan and zoom the VIEW and never touch the frame, so there is
    // no modifier state and no chance of a pinch quietly resizing the crop.
    // A THIRD pointer must not fall through to hitTest and grab the frame, and
    // must not leave the baseline as it was: the pinch is rebuilt whenever the
    // finger count changes, so a palm touching down and lifting again cannot
    // leave `dist`/`mid` describing a gesture from before all the intervening
    // motion - which snapped the view to a different zoom in one frame.
    grab = null;
    startPinch();
    return;
  }
  if (!state.frame || state.peek) return;
  const hit = hitTest(canvasPt(e));
  if (!hit.kind) return;                    // outside: do nothing at all
  // A move does not start until the finger has actually travelled. Without
  // this a tap or a little jitter shifts a crop that was already settled.
  grab = hit;
  gesturePushed = false;
  grabStart = canvasPt(e);
  grabFrame = { ...state.frame };
  moveArmed = hit.kind !== 'move';
  cv.setPointerCapture(e.pointerId);
});

cv.addEventListener('pointermove', e => {
  if (viewPan) {
    const pt = canvasPt(e);
    state.view.panX = viewPan.panX + (pt[0] - viewPan.start[0]);
    state.view.panY = viewPan.panY + (pt[1] - viewPan.start[1]);
    render();
    return;
  }
  if (touches.has(e.pointerId)) touches.set(e.pointerId, canvasPt(e));
  if (touches.size === 2 && pinch) {
    const [a, b] = [...touches.values()];
    const dist = Math.hypot(a[0] - b[0], a[1] - b[1]);
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    state.view.panX += mid[0] - pinch.mid[0];
    state.view.panY += mid[1] - pinch.mid[1];
    pinch.mid = mid;
    setZoom(pinch.zoom * (dist / pinch.dist), mid);
    return;
  }
  if (!grab) return;
  const pt = canvasPt(e);
  if (!moveArmed) {
    const dpr = window.devicePixelRatio || 1;
    if (Math.hypot(pt[0] - grabStart[0], pt[1] - grabStart[1]) < MOVE_THRESHOLD * dpr)
      return;                               // below the threshold: ignore entirely
    moveArmed = true;
    grabStart = pt;                         // re-baseline so the frame does not jump
    grabFrame = { ...state.frame };
    return;
  }
  pushOnce();
  if (grab.kind === 'move') {
    const g = moveGain();
    const [dx, dy] = screenDeltaToImage(
      grabFrame, [pt[0] - grabStart[0], pt[1] - grabStart[1]]);
    state.frame.cx = grabFrame.cx + dx * g;
    state.frame.cy = grabFrame.cy + dy * g;
  } else {
    applyResize(grab.ix, pt, grabFrame);
  }
  render();
});

for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) {
  cv.addEventListener(ev, e => {
    touches.delete(e.pointerId);
    if (viewPan) { viewPan = null; cv.style.cursor = ''; }
    // Rebuild rather than keep: dropping from three fingers to two leaves a
    // baseline measured against two fingers that are no longer the ones here.
    if (touches.size < 2) pinch = null; else startPinch();
    if (grab) { grab = null; grabStart = null; grabFrame = null; moveArmed = true; render(); }
  });
}

/** (Re)take the pinch baseline from the first two live pointers. */
function startPinch() {
  const [a, b] = [...touches.values()];
  pinch = { dist: Math.hypot(a[0] - b[0], a[1] - b[1]),
            mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
            zoom: state.view.zoom };
}

/** Zoom about a canvas point, keeping that point stationary. */
function setZoom(z, [sx, sy]) {
  const v = state.view;
  const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
  const k = next / v.zoom;
  v.panX = sx - cv.width / 2 - (sx - cv.width / 2 - v.panX) * k;
  v.panY = sy - cv.height / 2 - (sy - cv.height / 2 - v.panY) * k;
  v.zoom = next;
  // At fit the whole sheet is on screen, so an offset centre is never useful --
  // and leaving one there is how a pan strands the sheet half off the canvas
  // with nothing obvious to grab. Zooming back out recentres by itself.
  if (next <= ZOOM_MIN + 1e-6) { v.panX = 0; v.panY = 0; }
  render();
}
window.setZoom = setZoom;

/* --------------------------------------------------------------- desktop zoom
 *
 * The view already zooms and pans -- two fingers do both. None of it was
 * reachable with a mouse: no wheel handler, no keys, no buttons. These add the
 * desktop half without touching the transform maths.
 */

/** Discrete stops for the buttons and keys, so a click lands somewhere
 *  predictable instead of drifting by whatever factor. The wheel stays
 *  continuous. */
const ZOOM_STEPS = [1, 1.5, 2, 3, 4, 6, 8];

function canvasCentre() { return [cv.width / 2, cv.height / 2]; }

/** Move one stop up or down the ladder, about the middle of the view. */
function zoomStep(dir) {
  const z = state.view.zoom;
  const next = dir > 0
    ? ZOOM_STEPS.find(v => v > z + 1e-6)
    : [...ZOOM_STEPS].reverse().find(v => v < z - 1e-6);
  if (next === undefined) return;                 // already at an end
  setZoom(next, canvasCentre());
}
window.zoomStep = zoomStep;

/** Back to fit. Pan has to go too: zooming out alone can leave the sheet
 *  parked off-centre with nothing obvious to grab. */
function zoomReset() {
  state.view.zoom = 1;
  state.view.panX = 0;
  state.view.panY = 0;
  render();
}
window.zoomReset = zoomReset;

/** Keep the readout honest. Called from render(), so every path that changes
 *  the view -- wheel, pinch, buttons, keys, a new page -- updates it. */
function syncZoomUI() {
  const el = q('zoom-readout');
  if (!el) return;
  el.textContent = Math.round(state.view.zoom * 100) + '%';
  const z = state.view.zoom;
  q('zoom-in').disabled = z >= ZOOM_MAX - 1e-6;
  q('zoom-out').disabled = z <= ZOOM_MIN + 1e-6;
}

/* The stage does not scroll, so a plain wheel would otherwise do nothing at
 * all. Ctrl+wheel lands here too: the browser would otherwise zoom the whole
 * page, which is never what is wanted over the sheet. */
cv.addEventListener('wheel', e => {
  e.preventDefault();
  if (state.peek) return;
  const factor = Math.exp(-e.deltaY * 0.0015);
  setZoom(state.view.zoom * factor, canvasPt(e));
}, { passive: false });

/* Right-drag pans the SHEET. Left-drag is spoken for -- it moves and resizes
 * the crop -- so the view needs its own button, and the menu has to go or the
 * drag never starts. */
cv.addEventListener('contextmenu', e => e.preventDefault());

window.addEventListener('keydown', e => {
  const t = e.target;
  if (t && (t.isContentEditable ||
            ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === '+' || e.key === '=') { zoomStep(1); e.preventDefault(); }
  else if (e.key === '-' || e.key === '_') { zoomStep(-1); e.preventDefault(); }
  else if (e.key === '0') { zoomReset(); e.preventDefault(); }
});

function pushHistory() {
  state.history.push({ frame: { ...state.frame }, format: state.format,
                       orientation: state.orientation, rotation: state.rotation });
  if (state.history.length > 50) state.history.shift();
}
window.pushHistory = pushHistory;

// ------------------------------------------------------------------- dial

/** The dial reads 0 at the DETECTED angle, not at 0 in image space, so it shows
 *  the manual correction on top of detection. frame.angle = detectedAngle + dial. */
function dialValue() { return state.frame.angle - state.detectedAngle; }
window.dialValue = dialValue;

// ------------------------------------------------------------------- fit

/* The largest ratio-locked frame that fits inside the detected sheet.
 *
 * A mirror of fit.py -- same algorithm, same results -- because the dial
 * re-fits on every change and cannot afford a round trip, while the server
 * must seed independently and freeze that seed for ground truth. Keep the two
 * in step; tests/test_fit.py pins the behaviour.
 *
 * With ratio and angle fixed, every frame corner is c + s*R(angle)*v_k, so
 * "inside" is 16 linear inequalities in (cx, cy, s). Feasibility is monotone
 * in s, so binary search on s and, for each candidate, clip the plane down to
 * the feasible centres; a non-empty polygon means that size fits.
 */
function inwardEdges(quad) {
  const cx = quad.reduce((a, p) => a + p[0], 0) / quad.length;
  const cy = quad.reduce((a, p) => a + p[1], 0) / quad.length;
  const out = [];
  for (let i = 0; i < 4; i++) {
    const a = quad[i], b = quad[(i + 1) % 4];
    let nx = b[1] - a[1], ny = -(b[0] - a[0]);
    const len = Math.hypot(nx, ny);
    if (len < 1e-12) continue;
    nx /= len; ny /= len;
    let d = nx * a[0] + ny * a[1];
    if (nx * cx + ny * cy > d) { nx = -nx; ny = -ny; d = -d; }
    out.push([nx, ny, d]);
  }
  return out;
}

function clipHalfPlane(poly, nx, ny, d) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i], nxt = poly[(i + 1) % poly.length];
    const cv = nx * cur[0] + ny * cur[1] - d;
    const nv = nx * nxt[0] + ny * nxt[1] - d;
    if (cv <= 0) out.push(cur);
    if ((cv > 0) !== (nv > 0)) {
      const t = cv / (cv - nv);
      out.push([cur[0] + t * (nxt[0] - cur[0]), cur[1] + t * (nxt[1] - cur[1])]);
    }
  }
  return out;
}

/** Biggest frame of this ratio at this angle inside `quad`, or null. */
function largestInside(quad, ratio, angleDeg) {
  const edges = inwardEdges(quad);
  if (edges.length < 3) return null;
  const a = angleDeg * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
  const unit = [[-0.5, -ratio / 2], [0.5, -ratio / 2], [0.5, ratio / 2], [-0.5, ratio / 2]];
  const rot = unit.map(([x, y]) => [x * ca - y * sa, x * sa + y * ca]);
  // Per unit of scale, how far the furthest corner reaches along each normal.
  const reach = edges.map(([nx, ny]) =>
    Math.max(...rot.map(([x, y]) => nx * x + ny * y)));

  const xs = quad.map(p => p[0]), ys = quad.map(p => p[1]);
  const bound = Math.max(...xs.map(Math.abs), ...ys.map(Math.abs)) * 4 + 1;
  let lo = 0, hi = Math.hypot(Math.max(...xs) - Math.min(...xs),
                              Math.max(...ys) - Math.min(...ys)) * 2, best = null;
  for (let it = 0; it < 50; it++) {
    const mid = (lo + hi) / 2;
    let poly = [[-bound, -bound], [bound, -bound], [bound, bound], [-bound, bound]];
    for (let e = 0; e < edges.length && poly.length; e++) {
      const [nx, ny, d] = edges[e];
      poly = clipHalfPlane(poly, nx, ny, d - reach[e] * mid);
    }
    if (poly.length) { lo = mid; best = poly; } else { hi = mid; }
  }
  if (!best || lo < 1e-3) return null;
  const cx = best.reduce((s2, p) => s2 + p[0], 0) / best.length;
  const cy = best.reduce((s2, p) => s2 + p[1], 0) / best.length;
  return { cx, cy, w: lo, h: lo * ratio };
}

/** Re-fit the frame to the sheet at the current angle. */
function autoFit() {
  // `detected` is the frozen detection record {corners, angle, format}, not a
  // bare quad -- the sheet outline lives under .corners.
  const det = state.page && state.page.detected;
  const quad = det && det.corners;
  if (!quad || quad.length !== 4 || state.format === 'free') return false;
  const f = largestInside(quad, ratioOf(state.format, state.orientation),
                          state.frame.angle);
  if (!f) return false;
  state.frame.cx = f.cx; state.frame.cy = f.cy;
  state.frame.w = f.w; state.frame.h = f.h;
  return true;
}

/* Redraw the dial to match state.frame, changing nothing.
 *
 * undo() and resetFrame() used to call setDial() to refresh it, but setDial()
 * re-fits: it ends in autoFit(), which overwrites cx/cy/w/h. So undoing a drag
 * in straighten mode - where the frame IS draggable - restored the old frame
 * and then discarded everything but its angle, leaving a third rectangle that
 * was neither the before nor the after. */
function refreshDial() {
  if (!state.frame) return;
  const d = dialValue();
  q('angle-readout').textContent = `${d >= 0 ? '+' : ''}${d.toFixed(2)}°`;
  if (state.mode === 'straighten') drawDial();
}
window.refreshDial = refreshDial;

function setDial(deg) {
  // Snapped to DIAL_STEP so the dial lands on clean values instead of 2.40000001.
  const d = Math.round(
    Math.max(-DIAL_RANGE, Math.min(DIAL_RANGE, deg)) / DIAL_STEP) * DIAL_STEP;
  state.frame.angle = state.detectedAngle + d;
  // Deskew is a prerequisite for the fit, not an independent control: the
  // biggest frame that fits depends on the angle, so changing the angle
  // invalidates the previous fit. Re-fit rather than leave a frame that now
  // overhangs, or one that has quietly given up coverage it could reclaim.
  autoFit();
  q('angle-readout').textContent = `${d >= 0 ? '+' : ''}${d.toFixed(2)}°`;
  drawDial();
  render();
}
window.setDial = setDial;

function nudge(d) {
  if (!haveFrame()) return;
  pushHistory(); setDial(dialValue() + d);
}
window.nudge = nudge;

function drawDial() {
  const dpr = window.devicePixelRatio || 1;
  if (!dial.clientWidth) return;
  dial.width = Math.round(dial.clientWidth * dpr);
  dial.height = Math.round(dial.clientHeight * dpr);
  const w = dial.width, h = dial.height, mid = w / 2;
  dctx.clearRect(0, 0, w, h);
  const pxPerDeg = w / (DIAL_RANGE * 2);
  const off = -dialValue() * pxPerDeg;
  dctx.strokeStyle = '#8b95a5'; dctx.lineWidth = 1 * dpr;
  for (let d = -DIAL_RANGE * 2; d <= DIAL_RANGE * 2; d += 0.5) {
    const x = mid + off + d * pxPerDeg;
    if (x < 0 || x > w) continue;
    const major = Math.abs(d % 5) < 1e-6;
    dctx.globalAlpha = major ? 0.9 : 0.4;
    dctx.beginPath();
    dctx.moveTo(x, h * (major ? 0.28 : 0.40));
    dctx.lineTo(x, h * (major ? 0.72 : 0.60));
    dctx.stroke();
  }
  dctx.globalAlpha = 1;
  dctx.strokeStyle = '#d29922'; dctx.lineWidth = 3 * dpr;
  dctx.beginPath(); dctx.moveTo(mid, h * 0.18); dctx.lineTo(mid, h * 0.82); dctx.stroke();
}
window.drawDial = drawDial;

// A whole drag gesture is ONE undo step: history is pushed on pointerdown, not
// on every move event.
let dialGrab = null;

/* Drop every in-flight gesture. Gesture state is module-level and a page
 * switch does not go through the pointer handlers, so without this a drag
 * survives it: hold an interior drag, tap a filmstrip thumbnail with a second
 * finger, keep moving, and the NEW page's frame is moved using the OLD page's
 * grabFrame - an A6 gets an A4's centre and the crop leaves the sheet. Worse,
 * gesturePushed is still set, so pushOnce() records nothing and Undo cannot
 * get it back. */
function cancelGestures() {
  grab = grabStart = grabFrame = viewPan = pinch = dialGrab = null;
  moveArmed = true;
  gesturePushed = false;
  touches.clear();
}
window.cancelGestures = cancelGestures;
dial.addEventListener('pointerdown', e => {
  // Pinned to one pointer: a second finger landing on the dial used to
  // overwrite the origin, so the first finger's next move was measured
  // from the second finger's position and the angle jumped.
  dialGrab = { id: e.pointerId, x: e.clientX, start: dialValue(), pushed: false };
  dial.setPointerCapture(e.pointerId);
});
dial.addEventListener('pointermove', e => {
  if (!dialGrab || e.pointerId !== dialGrab.id) return;
  const pxPerDeg = dial.clientWidth / (DIAL_RANGE * 2);
  const next = dialGrab.start + (e.clientX - dialGrab.x) / pxPerDeg;
  if (Math.abs(next - dialValue()) < DIAL_STEP / 2) return;   // no step yet
  if (!dialGrab.pushed) { pushHistory(); dialGrab.pushed = true; }
  setDial(next);
});
for (const ev of ['pointerup', 'pointercancel'])
  dial.addEventListener(ev, e => {
    if (dialGrab && e.pointerId === dialGrab.id) dialGrab = null;
  });

// ---------------------------------------------------------------- controls

function setMode(m) {
  if (!haveFrame()) return;
  state.mode = m;
  q('mode-crop').setAttribute('aria-pressed', String(m === 'crop'));
  q('mode-straighten').setAttribute('aria-pressed', String(m === 'straighten'));
  document.getElementById('panel-straighten').hidden = m !== 'straighten';
  if (m === 'straighten') drawDial();
  render();
}
window.setMode = setMode;

function syncChips() {
  for (const f of Object.keys(RATIO))
    q('fmt-' + f).setAttribute('aria-pressed', String(f === state.format));
}
window.syncChips = syncChips;

/** Re-lock to a new ratio about the same centre and angle, preserving the long
 *  edge so the crop neither leaps outwards nor collapses. */
function relock() {
  const f = state.frame;
  const ratio = ratioOf(state.format, state.orientation);
  const long = Math.max(f.w, f.h);
  if (ratio >= 1) { f.h = long; f.w = long / ratio; }
  else { f.w = long; f.h = long * ratio; }
  syncChips(); render();
}

function setFormat(fmt) {
  if (!haveFrame()) return;
  pushHistory(); state.format = fmt; relock();
}
function swapOrientation() {
  if (!haveFrame()) return;
  pushHistory();
  state.orientation = state.orientation === 'portrait' ? 'landscape' : 'portrait';
  const f = state.frame, t = f.w; f.w = f.h; f.h = t;
  syncChips(); render();
}
// Output rotation, applied by the backend AFTER warp - for a sheet fed upside
// down. Distinct from swapOrientation, which changes the crop's shape.
function rotate90() { if (!haveFrame()) return; pushHistory(); state.rotation = (state.rotation + 90) % 360; render(); }

function undo() {
  if (!haveFrame()) return;
  const h = state.history.pop();
  if (!h) return;
  state.frame = { ...h.frame }; state.format = h.format;
  state.orientation = h.orientation; state.rotation = h.rotation;
  syncChips();
  refreshDial();
  render();
}

function resetFrame() {
  const s = state.page && state.page.seeded;
  if (!s) return;
  // Reset means "back to how this page arrived", so the undo stack goes too -
  // otherwise Undo after Reset walks back into edits that were just discarded.
  state.history = [];
  state.frame = { cx: s.cx, cy: s.cy, w: s.w, h: s.h, angle: s.angle };
  state.format = s.format; state.orientation = s.orientation; state.rotation = 0;
  syncChips();
  refreshDial();
  render();
}

/** Page size and rotation are set once per page at most, so they live behind a
 *  button rather than occupying a permanent row. */
function togglePageSetup() {
  state.pageSetup = !state.pageSetup;
  q('btn-pagesetup').setAttribute('aria-pressed', String(state.pageSetup));
  document.getElementById('panel-crop').hidden = !state.pageSetup;
}
window.togglePageSetup = togglePageSetup;

function applyTitleState() {
  const el = q('title-toggle');
  document.getElementById('nav').classList.toggle('wide', state.titleOpen);
  el.classList.toggle('open', state.titleOpen);
  el.setAttribute('aria-expanded', String(state.titleOpen));
  el.title = state.titleOpen ? 'Hide page name' : 'Show page name';
}
function toggleTitle() { state.titleOpen = !state.titleOpen; applyTitleState(); }
window.toggleTitle = toggleTitle;

function toggleFilmstrip() {
  state.film = !state.film;
  q('film-toggle').setAttribute('aria-pressed', String(state.film));
  renderFilmstrip();
}
window.toggleFilmstrip = toggleFilmstrip;

function toggleGrid() {
  state.grid = !state.grid;
  q('grid-toggle').setAttribute('aria-pressed', String(state.grid));
  render();
}
window.toggleGrid = toggleGrid;

/** Peek: the warped result full-screen, from the same endpoint Accept uses. */
/* State and button must move together. The failure path used to clear
 * state.peek but leave aria-pressed="true", so the button stayed lit while peek
 * was off - and render() bails whenever state.peek is true, so the mirror-image
 * desync froze the canvas. */
function setPeek(v) {
  state.peek = v;
  q('btn-peek').setAttribute('aria-pressed', String(v));
}
window.setPeek = setPeek;

async function togglePeekImpl() {
  if (!haveFrame()) return;
  const gen = state.gen;
  setPeek(!state.peek);
  if (!state.peek) { render(); return; }
  drawGrid(frameRectOnScreen());                    // clears the overlay
  // Ask for the resolution this canvas will actually paint. cv.width is in
  // DEVICE pixels (clientWidth x dpr), so on a phone at dpr 3 it is well over
  // 1200. The server default is 560, which was then scaled UP to fill the
  // screen -- the peek looked markedly softer than the ordinary view, which
  // draws the full-resolution source. Capped so a desktop window cannot ask
  // for a needlessly huge JPEG.
  const want = Math.max(560, Math.min(2400, cv.width));
  let r;
  try {
    r = await fetch('/api/preview/' + encodeURIComponent(state.page.id), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ corners: cornersOf(state.frame),
                             rotation: state.rotation, target: state.format,
                             max_width: want, quality: 92 }) });
  } catch {
    setPeek(false); render();
    throw new Error('network unreachable');
  }
  if (!r.ok) {
    // A 400 here means the crop itself is unrenderable, which is the user's
    // doing and worth naming; anything else is the server's.
    say(r.status === 400 ? 'invalid crop' : `server said ${r.status}`, 'var(--err)');
    setPeek(false); render(); return;
  }
  if (gen !== state.gen || !state.peek) return;   // navigated, or toggled off
  const url = URL.createObjectURL(await r.blob());
  const im = new Image();
  // Without this a decode failure leaks the blob for the life of the document.
  im.onerror = () => URL.revokeObjectURL(url);
  im.onload = () => {
    if (gen !== state.gen || !state.peek) { URL.revokeObjectURL(url); return; }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cv.width, cv.height);
    const s = Math.min(cv.width / im.width, cv.height / im.height);
    const w = im.width * s, h = im.height * s;
    ctx.drawImage(im, (cv.width - w) / 2, (cv.height - h) / 2, w, h);
    URL.revokeObjectURL(url);
  };
  im.src = url;
}
window.undo = undo; window.resetFrame = resetFrame; window.setFormat = setFormat;
window.swapOrientation = swapOrientation; window.rotate90 = rotate90;
const togglePeek = guard(togglePeekImpl, 'peek', false);
window.togglePeek = togglePeek;

// ----------------------------------------------------------------- actions

// A few pixels of overhang is normal and not worth a warning: the seeded A4 for
// a full-width scan lands ~3px proud of the top edge, and warning on that makes
// the flag noise on an ordinary page. Warn on overhang a human would notice.
const OUTSIDE_TOL_PX = 12;

/** How far the frame reaches beyond the scan, in source px (0 if inside). */
function outsideOverhangPx() {
  const W = state.page.width, H = state.page.height;
  return cornersOf(state.frame).reduce((m, [x, y]) => Math.max(
    m, -x, -y, x - (W - 1), y - (H - 1)), 0);
}
function outsideFraction() {
  const p = cornersOf(state.frame), W = state.page.width, H = state.page.height;
  return p.filter(([x, y]) => x < 0 || y < 0 || x > W - 1 || y > H - 1).length / 4;
}
window.outsideOverhangPx = outsideOverhangPx;
function showFlags() {
  q('outside-flag').hidden = outsideOverhangPx() <= OUTSIDE_TOL_PX;
  const h = state.page && state.page.hint;
  q('hint-mismatch').hidden = !(h && h !== state.format);
}
window.showFlags = showFlags;

async function acceptImpl() {
  if (!state.page) return;
  say('accepting…');
  const r = await request('/api/accept/' + encodeURIComponent(state.page.id), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      corners: cornersOf(state.frame),
      // The frame travels alongside the corners so the ground-truth record can
      // decompose the error per axis instead of blending it into one number.
      frame: { ...state.frame, format: state.format, orientation: state.orientation },
      rotation: state.rotation, target: state.format }) });
  const out = await r.json();
  say(`accepted ${out.width}×${out.height}`, 'var(--accent)');
  delete state.edits[state.page.id];
  await load(false);
  advanceAfterDecision();
  await showPage();
}

async function rejectImpl() {
  if (!state.page) return;
  await request('/api/reject/' + encodeURIComponent(state.page.id),
                { method: 'POST' });
  say('rejected');
  delete state.edits[state.page.id];
  await load(false);
  advanceAfterDecision();
  await showPage();
}

async function finalizeImpl() {
  const d = currentDoc();
  if (!d || !d.ready) { say('decide every page first', 'var(--err)'); return; }
  const del = d.deletable;
  const r = await request(`/api/${del ? 'discard' : 'finalize'}/`
                          + encodeURIComponent(d.batch), { method: 'POST' });
  const out = await r.json();
  say(del ? 'document deleted'
          : `sent to paperless: ${out.pages} page(s)`, 'var(--accent)');
  state.pageIndex = 0;
  await load();
}
const accept = guard(acceptImpl, 'accept');
const reject = guard(rejectImpl, 'reject');
const finalize = guard(finalizeImpl, 'send');
window.accept = accept; window.reject = reject; window.finalize = finalize;

// -------------------------------------------------------------------- load

/** Remember what has been changed on this page before leaving it. */
function captureEdit() {
  if (!state.page || !state.frame) return;
  state.edits[state.page.id] = {
    frame: { ...state.frame }, format: state.format,
    orientation: state.orientation, rotation: state.rotation,
  };
}

function currentDoc() { return state.documents[state.docIndex] || null; }
function currentPage() {
  const d = currentDoc();
  return d ? d.pages[state.pageIndex] || null : null;
}
window.currentDoc = currentDoc; window.currentPage = currentPage;

/** Send, or Delete when there is nothing to keep.
 *
 * A wholly declined document has no PDF to make, so the only way to close it is
 * to delete it. Removing it automatically was worse: it made rejecting the only
 * page of a one-page document silently irreversible.
 */
function updateStaged() {
  const d = currentDoc();
  const btn = q('btn-finalize');
  const use = btn.querySelector('use');
  const n = d ? d.counts.accepted : 0;
  const del = !!(d && d.deletable);
  btn.classList.toggle('danger', del);
  use.setAttribute('href', del ? '/icons.svg#trash' : '/icons.svg#send');
  btn.dataset.action = del ? 'delete' : 'send';
  // The count belongs on the page strip, where it says how many pages this
  // document HAS. On Send it said how many were accepted, which is a different
  // number and only meaningful once everything is decided.
  q('page-count').textContent = d ? String(d.counts.total) : '';
  btn.disabled = !d || !d.ready || (!del && n === 0);
  btn.title = del ? 'Delete this document'
    : (d && d.ready && n) ? `Send ${n} page${n === 1 ? '' : 's'} to paperless`
    : 'Decide every page first';
  btn.setAttribute('aria-label', del ? 'Delete document' : 'Send to paperless');
}
window.updateStaged = updateStaged;

function updateNav() {
  const n = state.documents.length;
  q('queue-count').textContent = n ? `${state.docIndex + 1}/${n}` : '0/0';
  q('btn-prev').disabled = state.docIndex <= 0;
  q('btn-next').disabled = state.docIndex >= n - 1;
  const d = currentDoc(), p = currentPage();
  q('page-title').textContent = d
    ? `${d.label}${d.pages.length > 1 ? ` · p${p ? p.page_no : '?'}` : ''}`
    : 'queue empty';
  q('btn-accept').disabled = !p || p.status !== 'pending';
  q('btn-reject').disabled = !p || p.status !== 'pending';
  // Everything that needs a frame goes dead together with it, so an empty
  // queue offers no button that cannot do anything.
  for (const id of ['mode-crop', 'mode-straighten', 'btn-peek', 'btn-pagesetup',
                    'btn-rotate', 'btn-swap'])
    { const b = q(id); if (b) b.disabled = !state.frame; }
  updateStaged();
  applyTitleState();
}

/** Step DOCUMENTS. Bounded, not wrapping: on a phone a wrap looks identical to
 *  not having moved. */
async function stepImpl(delta) {
  // A message about the page you are leaving would read as being about the one
  // you arrive at - 'accept failed' from page A is not about page B. Cleared
  // HERE and not in showPage(), because showPage() is also the last step of a
  // decision, where the status IS that decision's confirmation.
  say('');
  const next = state.docIndex + delta;
  if (next < 0 || next >= state.documents.length) return;
  captureEdit();
  state.docIndex = next;
  state.pageIndex = firstUndecided(state.documents[next]);
  await showPage();
}
const step = guard(stepImpl, 'navigation', false);
window.step = step;

function firstUndecided(doc) {
  if (!doc) return 0;
  const i = doc.pages.findIndex(p => p.status === 'pending');
  return i < 0 ? 0 : i;
}

/** Open a page of this document. A decided page is reopened first - that is
 *  what makes the last look before Send worth having. */
async function selectPageImpl(i) {
  say('');                      // see stepImpl
  const d = currentDoc();
  if (!d || !d.pages[i]) return;
  captureEdit();
  const p = d.pages[i];
  state.pageIndex = i;
  if (p.status === 'accepted' || p.status === 'rejected') {
    let r;
    try {
      r = await fetch('/api/reopen/' + encodeURIComponent(p.id),
                      { method: 'POST' });
    } catch {
      throw new Error('network unreachable');
    }
    // A refusal is not an error: a page of an already-sent document simply
    // stays as it is. Only a dead network is worth shouting about.
    if (r.ok) { await load(); return; }
  }
  await showPage();
}
const selectPage = guard(selectPageImpl, 'open page', false);
window.selectPage = selectPage;

/** After a decision, the next undecided page of this document, scanning forward
 *  and wrapping once - pages can be decided out of order from the filmstrip, so
 *  the next one may be behind you. */
function advanceAfterDecision() {
  const d = currentDoc();
  if (!d) return;
  const n = d.pages.length;
  for (let k = 1; k <= n; k++) {
    const i = (state.pageIndex + k) % n;
    if (d.pages[i].status === 'pending') { state.pageIndex = i; return; }
  }
}
window.advanceAfterDecision = advanceAfterDecision;

function renderFilmstrip() {
  const strip = document.getElementById('filmstrip');
  const d = currentDoc();
  strip.innerHTML = '';
  strip.hidden = !state.film;
  if (!d || !state.film) return;
  d.pages.forEach((p, i) => {
    const b = document.createElement('button');
    b.className = 'film';
    b.dataset.testid = 'film-' + i;
    b.dataset.state = p.status;
    b.setAttribute('aria-current', String(i === state.pageIndex));
    b.setAttribute('aria-label', `Page ${p.page_no}, ${p.status}`);
    b.onclick = () => selectPage(i);
    const im = document.createElement('img');
    im.src = '/api/thumb/' + encodeURIComponent(p.id);
    im.alt = '';
    b.appendChild(im);
    if (p.status === 'accepted' || p.status === 'rejected') {
      const m = document.createElement('span');
      m.className = 'mark';
      m.textContent = p.status === 'accepted' ? '✓' : '✕';
      b.appendChild(m);
    }
    strip.appendChild(b);
  });
}
window.renderFilmstrip = renderFilmstrip;

async function showPage() {
  // Every page switch invalidates whatever the last one had in flight. Two
  // showPage() runs overlap freely - the filmstrip's onclick and the chevrons
  // are plain handlers, nothing serialises them - and the loser used to finish
  // last and win: tap a slow page 3 then page 1, and page 3's image landed in
  // state.img UNDER page 1's frame, dim mask and loupes. Accept then posted
  // page 1's id with a crop aimed at a different sheet.
  const gen = ++state.gen;
  cancelGestures();
  setPeek(false);
  const p = currentPage();
  if (!p) {
    state.page = null; state.img = null; state.frame = null;
    renderFilmstrip(); updateNav(); render();
    return;
  }
  state.page = p;
  const s = p.seeded;
  const kept = state.edits[p.id];
  if (kept) {
    state.frame = { ...kept.frame }; state.format = kept.format;
    state.orientation = kept.orientation; state.rotation = kept.rotation;
  } else {
    state.frame = s
      ? { cx: s.cx, cy: s.cy, w: s.w, h: s.h, angle: s.angle }
      : { cx: p.width / 2, cy: p.height / 2, w: p.width, h: p.height, angle: 0 };
    state.format = (s && s.format) || 'A4';
    state.orientation = (s && s.orientation) || 'portrait';
    state.rotation = 0;
  }
  state.detectedAngle = s ? s.angle : 0;
  state.history = [];
  state.view = { zoom: 1, panX: 0, panY: 0 };
  q('angle-readout').textContent =
      `${dialValue() >= 0 ? '+' : ''}${dialValue().toFixed(2)}°`;
  const im = await new Promise(res => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => res(null);
    // No cache-bust: a spool file is immutable once ingested - ingest() gives a
    // same-named scan with different content a distinct name - so the only
    // thing `?t=` bought was re-downloading tens of megabytes on every revisit.
    img.src = '/api/image/' + encodeURIComponent(p.id);
  });
  if (gen !== state.gen) return;      // a newer page won while this one loaded
  state.img = im;
  if (!im) say('could not load the scan', 'var(--err)');
  syncChips();
  renderFilmstrip();
  updateNav();
  resize();
}
window.showPage = showPage;

/* `show` is false when the caller is about to move to a different page.
 *
 * A decision used to cost two full-resolution downloads: load() ended in
 * showPage(), which re-fetched the scan just decided, rendered it, and then
 * threw it away when advanceAfterDecision() moved on - a visible flash of the
 * decided page, and tens of megabytes over the phone's Wi-Fi. */
async function load(show = true) {
  const r = await request('/api/queue');
  const data = await r.json();
  state.documents = data.documents || [];
  state.docIndex = Math.max(0, Math.min(state.docIndex,
                                        state.documents.length - 1));
  const d = currentDoc();
  if (!d || state.pageIndex >= d.pages.length) state.pageIndex = firstUndecided(d);
  if (show) await showPage();
}
window.load = load;

// The very first load has no caller to catch it: a 500 from /api/queue - which
// does real detection work per request - or a 401 used to leave a featureless
// black canvas with no message and no retry short of a reload.
load().catch(e => say(`could not load the queue: ${e.message}`, 'var(--err)'));
