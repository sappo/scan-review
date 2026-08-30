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
  pending: [], index: 0,
  // Edits are kept per page id, so stepping away and back does not silently
  // throw away work. Navigation you cannot trust is worse than none.
  edits: {},
  frame: null,                // {cx, cy, w, h, angle} in source px
  detectedAngle: 0, seedW: 0,
  format: 'A4', orientation: 'portrait', rotation: 0,
  view: { zoom: 1, panX: 0, panY: 0 },
  mode: 'crop', grid: true, peek: false, pageSetup: false, history: [],
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
  render();
}
window.addEventListener('resize', resize);

// ------------------------------------------------------------------ render

function render() {
  if (!ctx) return;
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

// ------------------------------------------------------------- hit testing

/** Half-extent of a corner's grab zone, in canvas px.
 *
 * Capped at a quarter of the frame's smaller screen dimension: a fixed 24px
 * zone would swallow the interior of a small or zoomed-out frame and leave
 * nothing to grab for moving it.
 */
function bandWidth() {
  const r = frameRectOnScreen();
  const dpr = window.devicePixelRatio || 1;
  return Math.min(BAND_MAX * dpr, Math.min(r.w, r.h) / 4);
}
window.bandWidth = bandWidth;

/** What is under this canvas point: a corner, an edge, the movable core, or nothing. */
function hitTest([sx, sy]) {
  const r = frameRectOnScreen(), b = bandWidth();
  const dpr = window.devicePixelRatio || 1;
  const corner = Math.max(22 * dpr, b);     // 44px touch target, half-extent
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
function applyResize(kind, ix, screenPt, g) {
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

cv.addEventListener('pointerdown', e => {
  touches.set(e.pointerId, canvasPt(e));
  if (touches.size === 2) {
    // Two fingers pan and zoom the VIEW and never touch the frame, so there is
    // no modifier state and no chance of a pinch quietly resizing the crop.
    grab = null;
    const [a, b] = [...touches.values()];
    pinch = { dist: Math.hypot(a[0] - b[0], a[1] - b[1]),
              mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
              zoom: state.view.zoom };
    return;
  }
  if (!state.frame || state.peek) return;
  const hit = hitTest(canvasPt(e));
  if (!hit.kind) return;                    // outside: do nothing at all
  pushHistory();
  // A move does not start until the finger has actually travelled. Without
  // this a tap or a little jitter shifts a crop that was already settled.
  grab = hit;
  grabStart = canvasPt(e);
  grabFrame = { ...state.frame };
  moveArmed = hit.kind !== 'move';
  cv.setPointerCapture(e.pointerId);
});

cv.addEventListener('pointermove', e => {
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
  if (grab.kind === 'move') {
    const g = moveGain();
    const [dx, dy] = screenDeltaToImage(
      grabFrame, [pt[0] - grabStart[0], pt[1] - grabStart[1]]);
    state.frame.cx = grabFrame.cx + dx * g;
    state.frame.cy = grabFrame.cy + dy * g;
  } else {
    applyResize(grab.kind, grab.ix, pt, grabFrame);
  }
  render();
});

for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) {
  cv.addEventListener(ev, e => {
    touches.delete(e.pointerId);
    if (touches.size < 2) pinch = null;
    if (grab) { grab = null; grabStart = null; grabFrame = null; moveArmed = true; render(); }
  });
}

/** Zoom about a canvas point, keeping that point stationary. */
function setZoom(z, [sx, sy]) {
  const v = state.view;
  const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
  const k = next / v.zoom;
  v.panX = sx - cv.width / 2 - (sx - cv.width / 2 - v.panX) * k;
  v.panY = sy - cv.height / 2 - (sy - cv.height / 2 - v.panY) * k;
  v.zoom = next;
  render();
}
window.setZoom = setZoom;

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

function setDial(deg) {
  // Snapped to DIAL_STEP so the dial lands on clean values instead of 2.40000001.
  const d = Math.round(
    Math.max(-DIAL_RANGE, Math.min(DIAL_RANGE, deg)) / DIAL_STEP) * DIAL_STEP;
  state.frame.angle = state.detectedAngle + d;
  q('angle-readout').textContent = `${d >= 0 ? '+' : ''}${d.toFixed(2)}°`;
  drawDial();
  render();
}
window.setDial = setDial;

function nudge(d) { pushHistory(); setDial(dialValue() + d); }
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
dial.addEventListener('pointerdown', e => {
  pushHistory();
  dialGrab = { x: e.clientX, start: dialValue() };
  dial.setPointerCapture(e.pointerId);
});
dial.addEventListener('pointermove', e => {
  if (!dialGrab) return;
  const pxPerDeg = dial.clientWidth / (DIAL_RANGE * 2);
  setDial(dialGrab.start + (e.clientX - dialGrab.x) / pxPerDeg);
});
for (const ev of ['pointerup', 'pointercancel'])
  dial.addEventListener(ev, () => { dialGrab = null; });

// ---------------------------------------------------------------- controls

function setMode(m) {
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

function setFormat(fmt) { pushHistory(); state.format = fmt; relock(); }
function swapOrientation() {
  pushHistory();
  state.orientation = state.orientation === 'portrait' ? 'landscape' : 'portrait';
  const f = state.frame, t = f.w; f.w = f.h; f.h = t;
  syncChips(); render();
}
// Output rotation, applied by the backend AFTER warp - for a sheet fed upside
// down. Distinct from swapOrientation, which changes the crop's shape.
function rotate90() { pushHistory(); state.rotation = (state.rotation + 90) % 360; render(); }

function undo() {
  const h = state.history.pop();
  if (!h) return;
  state.frame = { ...h.frame }; state.format = h.format;
  state.orientation = h.orientation; state.rotation = h.rotation;
  syncChips();
  if (state.mode === 'straighten') setDial(dialValue()); else render();
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
  if (state.mode === 'straighten') setDial(0); else render();
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

function toggleGrid() {
  state.grid = !state.grid;
  q('grid-toggle').setAttribute('aria-pressed', String(state.grid));
  render();
}
window.toggleGrid = toggleGrid;

/** Peek: the warped result full-screen, from the same endpoint Accept uses. */
async function togglePeek() {
  state.peek = !state.peek;
  q('btn-peek').setAttribute('aria-pressed', String(state.peek));
  if (!state.peek) { render(); return; }
  drawGrid(frameRectOnScreen());                    // clears the overlay
  const r = await fetch('/api/preview/' + encodeURIComponent(state.page.id), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ corners: cornersOf(state.frame),
                           rotation: state.rotation, target: state.format }) });
  if (!r.ok) { say('invalid crop', 'var(--err)'); state.peek = false; render(); return; }
  const url = URL.createObjectURL(await r.blob());
  const im = new Image();
  im.onload = () => {
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

async function accept() {
  if (!state.page) return;
  say('accepting…');
  const r = await fetch('/api/accept/' + encodeURIComponent(state.page.id), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      corners: cornersOf(state.frame),
      // The frame travels alongside the corners so the ground-truth record can
      // decompose the error per axis instead of blending it into one number.
      frame: { ...state.frame, format: state.format, orientation: state.orientation },
      rotation: state.rotation, target: state.format }) });
  if (!r.ok) { say('accept failed', 'var(--err)'); return; }
  const out = await r.json();
  say(`accepted ${out.width}×${out.height}`, 'var(--accent)');
  delete state.edits[state.page.id];
  await load();
}

async function reject() {
  if (!state.page) return;
  await fetch('/api/reject/' + encodeURIComponent(state.page.id), { method: 'POST' });
  say('rejected');
  delete state.edits[state.page.id];
  await load();
}

async function finalize() {
  const r = await fetch('/api/finalize', { method: 'POST' });
  if (!r.ok) { say('nothing to send', 'var(--err)'); return; }
  const out = await r.json();
  say(`sent to paperless: ${out.pages} page(s)`, 'var(--accent)');
  await load();
}
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

function updateNav() {
  const n = state.pending.length;
  q('queue-count').textContent = n ? `${state.index + 1}/${n}` : '0/0';
  q('btn-prev').disabled = state.index <= 0;
  q('btn-next').disabled = state.index >= n - 1;
  applyTitleState();
}

/** Move through the queue. Bounded rather than wrapping: on a phone a wrap
 *  looks identical to not having moved. */
async function step(delta) {
  const next = state.index + delta;
  if (next < 0 || next >= state.pending.length) return;
  captureEdit();
  state.index = next;
  await showPage();
}
window.step = step;

async function showPage() {
  state.peek = false;
  const p = state.pending[state.index];
  if (!p) {
    state.page = null; state.img = null; state.frame = null;
    q('page-title').textContent = 'queue empty';
    updateNav(); render();
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
  // The dial always reads 0 at what the detector proposed, not at what a
  // previous edit left behind.
  state.detectedAngle = s ? s.angle : 0;
  state.seedW = s ? s.w : state.frame.w;
  state.history = [];
  state.view = { zoom: 1, panX: 0, panY: 0 };
  q('page-title').textContent = p.id;
  q('angle-readout').textContent =
      `${dialValue() >= 0 ? '+' : ''}${dialValue().toFixed(2)}°`;
  await new Promise(res => {
    const im = new Image();
    im.onload = () => { state.img = im; res(); };
    im.onerror = () => res();
    im.src = '/api/image/' + encodeURIComponent(p.id) + '?t=' + Date.now();
  });
  syncChips();
  updateNav();
  resize();
}
window.showPage = showPage;

async function load() {
  const r = await fetch('/api/queue');
  const data = await r.json();
  state.pending = data.pending;
  // Clamp rather than reset: after accepting page 3 of 6 you want to be on the
  // page that took its place, not back at the start.
  state.index = Math.max(0, Math.min(state.index, state.pending.length - 1));
  await showPage();
}
window.load = load;
load();
