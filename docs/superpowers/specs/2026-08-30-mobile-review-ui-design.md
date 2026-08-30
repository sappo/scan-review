# Mobile-first scan review UI — design

Date: 2026-08-30
Status: approved, ready for implementation planning

## Why

Review will mostly happen on a phone. The current UI is a three-pane desktop grid
(source canvas, live preview, control rail) whose primary gesture is dragging one
of four free corners. On a phone that is the wrong shape and the wrong gesture.

It also offers more freedom than the input needs. Pages arrive from a sheet-fed
ADF, not a handheld camera, so there is no perspective distortion to correct — a
page is a rectangle of known ISO ratio, rotated by the feed skew. Free corner
dragging lets the operator produce a crop that cannot correspond to any real
sheet, which is a way to damage a scan, not a way to fix one.

## What changes

The crop becomes a **ratio-locked rectangle** that can be moved, resized and
rotated, but never sheared. Layout and gestures follow the Samsung gallery
editor. The existing blue-grid-and-red-cross raster is kept in preference to
Samsung's rule-of-thirds grid.

The desktop UI is replaced rather than kept alongside: one responsive UI, one
interaction model, one test suite.

## Non-goals

- Perspective / keystone correction. Ruled out by the input source.
- Auto-zoom on straighten. See "Crop past the scan edge" below.
- Free-form (`free`) crop in the UI. The backend keeps supporting it.
- Any change to `detect.py` or to the warp/accept/finalize behaviour.

Ground-truth records **are** in scope: their shape changes with the geometry
model (§6), and all existing records are discarded.

---

## 1. Geometry

### 1.1 State

The UI's authoritative state stops being four free points and becomes one
rectangle, in source-image pixel coordinates:

```
frame = { cx, cy, w, h, angle }
```

with the invariant

```
h / w  ==  ratio(format, orientation)
```

Ratios come from `warp.PAPER_MM`, **not** from √2. The ISO sizes are rounded to
whole millimetres, so the three ratios genuinely differ and a shared √2 constant
would put the frame slightly out of step with the accepted output:

| format | mm        | portrait w/h | landscape w/h |
|--------|-----------|--------------|---------------|
| A4     | 210 × 297 | 0.707071     | 1.414286      |
| A5     | 148 × 210 | 0.704762     | 1.418919      |
| A6     | 105 × 148 | 0.709459     | 1.409524      |

Ratio-locking is therefore an invariant of the representation. No gesture can
violate it, because no gesture can express a violation.

### 1.2 Corners are derived

Every call to the server derives the four corners from the frame, ordered
**TL, TR, BR, BL in frame space** — the frame's own top-left first, which after
rotation is generally not the topmost-leftmost point in image space:

```
corners(frame) = [ C + R(angle)·(∓w/2, ∓h/2) ... ]     R = rotation matrix
```

This ordering is what `warp()` requires: it maps the corners onto
`[[0,0], [W-1,0], [W-1,H-1], [0,H-1]]`, so frame-space ordering is precisely what
makes the output come out upright. The existing code relies on the same
convention.

Consequences, all of which mean **no change to the preview/accept API contract**
(the backend edits in this design are the seed fit and the record shape, §6, plus
a static route, §7):

- `/api/preview` and `/api/accept` receive the same `corners` payload as today.
- `warp.target_size_px()` picks portrait vs landscape by comparing the quad's
  edge lengths, so frame orientation propagates on its own.
- `app.quad_angle()` measures the top edge, which for a derived quad is exactly
  `frame.angle`. Ground-truth skew error stays valid and becomes more precise.
- `detected` is still frozen at ingest by the backend; nothing here touches it.

`frame.angle` must use the same sign convention as `quad_angle` and
`detect.angle_deg` (positive = counter-clockwise). This is verified by seeding a
frame from a real detection and reading the angle back — see §8.

### 1.3 Seeding the frame from detection

The detector's quad is close to ISO but not exact: the real A4 comes in at
1663 × 2328, a ratio of 0.7144 against A4's 0.707071. The frame is fitted by
least-squares scale — given the unit-ratio rectangle `(rw, rh)` and the detected
edge lengths `(dw, dh)`:

```
s = (rw·dw + rh·dh) / (rw² + rh²)
(w, h) = s · (rw, rh)
```

For that A4 this yields 1652 × 2336: about 11px narrower and 8px taller than
detected. The error is split between the two axes rather than the frame
systematically over- or under-covering the sheet.

`cx, cy` come from the detected quad's centroid, `angle` from the detected angle,
and the format from the detector's `classify()` result. Orientation is inferred
from which detected edge is longer — the real A6 is landscape (1165 × 827).

**The fit runs on the backend, at ingest, and is frozen** alongside `detected` —
it is not computed in the browser. Two reasons. First, it preserves the property
the previous session verified carefully: what the detector proposed is written
once at ingest and no client can influence it. If the UI computed and submitted
its own seed, a stale or buggy client could report a starting frame it never
actually displayed, and the dataset would quietly lie about how often the
detector was right. Second, it keeps one implementation of the fit rather than a
Python one and a JavaScript one that can drift apart.

The queue payload therefore carries `seeded` next to `detected`, and the UI
simply uses it. New module `frame.py`, holding the seed fit and the
frame ↔ corners conversions, so the geometry is unit-testable without a browser.

### 1.4 Crop past the scan edge

The frame may extend beyond the scan and **is not clamped**. This is deliberate
and load-bearing: a sheet fed flush to the leading edge genuinely has a corner at
y = −103, and an earlier version of this pipeline that clamped corners into the
image measured **−3.00° of residual skew** on a real A6 as a result. `warp()`
already samples outside the source with a white border.

Therefore no auto-zoom on straighten, unlike the Samsung editor. Instead the
region outside the scan is drawn hatched on the canvas, and the existing
"crop extends past the scan" warning is shown. Accept still succeeds.

---

## 2. Rendering: the frame stays upright, the scan tilts

The canvas rotates the **image** by `−frame.angle` about the frame centre and
draws the frame as an axis-aligned rectangle. The scan appears tilted; the frame
never does.

This is the decision the rest of the UI hangs off:

- Level is judged against the screen edges and the raster, which is what makes a
  straighten dial legible at all.
- Hit-testing collapses to point-in-axis-aligned-rectangle. The current
  arbitrary-quad maths (`segInfo`, `edgeAt`, ~40 lines) is deleted.
- Corner brackets and edge ticks always render upright.
- The raster is aligned to the frame, so it is aligned to the output.

It is a view transform only. `frame.angle` remains the single stored value.

---

## 3. Modes

Two modes, selected by tabs at the bottom, mirroring the reference screenshots.

**Crop.** White L-brackets at the four corners, short tick handles at the edge
midpoints, everything outside the frame dimmed. Bottom panel: format chips
`A4 A5 A6`, orientation swap, rotate 90°.

**Straighten.** Brackets and dimming hidden, whole scan visible. Bottom panel:
the dial, a numeric readout, and ±0.1° buttons for fine work.

The blue grid and red centre cross are drawn inside the frame in **both** modes,
toggleable, on by default.

---

## 4. Gestures

**One finger in a grab band hugging the frame border → resize.** The band extends
~24px either side of the border in screen space. A 44 × 44px zone at each corner
takes priority where a corner and an edge band overlap, so corners always win.
Resize holds the ratio and anchors the opposite corner (for corner drags) or the
opposite edge (for edge drags).

**One finger in the frame's interior core → move the whole frame.** No resize.

**One finger outside the frame → inert.** Steadying the phone at the edge of the
screen cannot nudge a crop that was already settled.

**Two fingers anywhere → pan and zoom the view.** Never touches the frame. Zoom
is what makes fine edge work possible on a 6" screen.

Guard: on a small or zoomed-out frame a fixed 24px band would swallow the whole
interior and leave nothing to grab for moving. The band is therefore

```
band = min(24px, 25% of the frame's smaller screen dimension)
```

so a movable core always exists, however small the frame is drawn.

**The dial** is its own horizontal-drag surface spanning the full width at the
bottom, unaffected by the above. A ±15° range over ~380px gives ~0.08°/px, finer
than the current slider and reachable with a thumb.

The dial reads **0 at the detected angle**, not at 0° in image space, and its
value is the manual correction on top of detection:

```
frame.angle = detected.angle + dial
```

So the seeded A6 sits at `frame.angle = −7.679°` with the dial centred, and the
readout distinguishes "detected skew −7.68°" from "manual +0.30°" exactly as the
current UI does. Reset to detected returns the dial to 0.

### Limits

- **Minimum frame size** 64px on the shorter side, in source pixels. `warp()`
  raises on anything under 8px; 64 keeps the UI well clear of a degenerate crop
  and of a frame smaller than its own grab band.
- **Maximum frame size** none. The frame is allowed past the scan edge (§1.4),
  so there is no meaningful upper bound to enforce.
- **View zoom** clamped to 1× (whole scan fits the canvas) through 8×.

---

## 5. Layout

**Phone.** Top bar: undo · page title · **Accept** · overflow (Reject, Reset to
detected, Send to paperless, page details). Full-bleed canvas. Bottom:
contextual panel per mode, then the mode tabs. A warning strip carries the
hint-mismatch and crop-past-edge flags.

**Desktop.** Same code and same model. Above ~900px the bottom panel becomes a
right-hand rail and the canvas takes the remaining width.

**Peek.** A button flips the canvas to the warped result full-screen, using the
existing `/api/preview`; tap to return. This replaces the always-visible preview
pane — the frame is already WYSIWYG, since it *is* the output rectangle.

### Rotation vs orientation

Two distinct controls, distinctly labelled:

- **Rotate 90°** cycles `rotation` (0/90/180/270), applied by the backend after
  warp. This is for a sheet fed upside down. Unchanged from today.
- **Swap orientation** transposes the frame's ratio between portrait and
  landscape. This changes the crop, not the output rotation.

### Undo

History snapshots `{ frame, format, rotation }` — orientation needs no separate
entry, since it is recoverable from whether `frame.w > frame.h`. Pushed once per
gesture on pointerdown/keydown rather than on every move event — the same
approach the current deskew slider uses. **Reset to detected** restores the
seeded frame from §1.3.

---

## 6. Ground truth

**All existing records in `groundtruth/` are discarded.** They are the two test
fixtures `t-agree.png.json` and `t-mismatch.png.json`; no real review data has
been collected yet, so nothing of value is lost.

### 6.1 Why the shape changes

Today a record pairs `detected` and `accepted` corners and summarises the
difference as `corner_shift_px`, the mean corner displacement. That number
conflates every way the detector can be wrong. The `t-mismatch` fixture reports
600.2px, which says the detector was wrong but not whether it mislocated the
sheet, mis-sized it, or picked the wrong format.

A ratio-locked frame has only five degrees of freedom, and each maps to a
distinct detector failure:

| error | what it indicts |
|-------|-----------------|
| centre | the paper mask's centroid — backing/padding thresholds |
| scale | mask erosion or dilation — the morphology kernel sizes |
| angle | `minAreaRect` skew |
| format | `classify()` and its 6% tolerance |
| orientation | which detected edge was taken as longer |

Recording them separately turns the dataset from "how often was it wrong" into
"which part of the detector to fix".

### 6.2 Record shape

```json
{
  "page": "scan-001.png",
  "at": "2026-08-30T18:04:11Z",
  "schema": 2,
  "scan":     { "width": 1664, "height": 2799, "dpi": 200 },
  "hint":     "A6",

  "detected": { "corners": [[...]], "angle": -7.679, "format": "A6" },
  "seeded":   { "cx": 896.0, "cy": 386.7, "w": 1166.3, "h": 827.5,
                "angle": -7.679, "format": "A6", "orientation": "landscape" },
  "accepted": { "cx": 901.5, "cy": 388.3, "w": 1173.1, "h": 832.3,
                "angle": -7.380, "format": "A6", "orientation": "landscape",
                "rotation": 0, "corners": [[...]] },

  "error": {
    "centre_px": [5.5, 1.6], "centre_dist_px": 5.7, "centre_dist_mm": 0.73,
    "scale": 1.0058,
    "angle_deg": 0.299,
    "format_agreed": true,
    "orientation_agreed": true,
    "hint_agrees": true,
    "unchanged": false
  }
}
```

Notes on the fields:

- **Three geometries, not two.** `detected` is the detector's raw quad, frozen at
  ingest and unchanged from today. `seeded` is the ratio-locked frame actually
  shown to the operator (§1.3). `accepted` is what they approved. Storing
  `seeded` explicitly rather than recomputing it means a later change to the fit
  rule cannot silently make old records uncomparable.
- **`error` compares `seeded` to `accepted`**, because that is the frame the
  operator was presented with and chose to correct or not.
- **`scale`** is the ratio of the long edges, so it stays meaningful even when
  the operator changed format and the two frames have different aspect ratios.
- **`angle_deg`** is `accepted.angle − seeded.angle`, which is exactly the dial
  value (§4). Since both are ratio-locked frames this is a true like-for-like
  comparison — unlike the old record, where `detected.angle` came from
  `minAreaRect` and `accepted.angle` from `quad_angle` and the two only happened
  to agree.
- **`unchanged`** is true when the operator accepted the seeded frame as-is:
  centre within 1px, scale within 0.2%, angle within 0.05°, same format and
  orientation, rotation 0. Untouched accepts are still recorded — a dataset of
  only corrections would be biased.
- **`corner_shift_px` is dropped.** `centre_dist_px` plus `scale` carry the same
  information in a form that can be acted on.
- **`schema: 2`** so a future change can be detected rather than guessed at.
  `evaluate.py` refuses records it does not know the schema of, instead of
  silently misreading them.

### 6.3 evaluate.py

Rewritten to report, over the corpus:

- agreement rate (`unchanged`), format and orientation agreement, hint match rate
- centre error: mean / median / max, in mm
- scale error: mean / median / max, as a percentage
- angle error: mean / median / max |error|, in degrees
- a worst-case table sorted by whichever axis is worst, so a bad scan can be
  found and opened

`--verbose` keeps the per-record dump.

## 7. Files

`ui.html` is currently 19KB of markup, CSS and JS in one file, and this rework
grows the JS substantially. Split it:

- `ui.html` — markup and styles.
- `ui.js` — gestures, rendering, canvas transforms.

Backend, all additive:

- `frame.py` — **new**. The seed fit (§1.3), frame ↔ corners conversion, and the
  ratio table. Pure functions, unit-tested without a browser.
- `app.py` — compute and freeze `seeded` at ingest; expose it in the queue
  payload; write the §6.2 record on accept; serve `ui.js`.
- `evaluate.py` — rewritten for the new metrics (§6.3).
- `groundtruth/*.json` — deleted.

Unchanged: `detect.py`, `warp.py`, `fetch_scans.py`, `identify.py`, and the
Pi-side push.

---

## 8. Testing

Add a mobile Playwright project (`Pixel 7`, 412 × 915, touch enabled) alongside
the existing desktop viewport. The 11 current tests are retired and replaced by the
12 below, written against the new DOM. Tests assert on outcomes — accepted pixel
dimensions, painted pixels, files on disk — not on whether something rendered.

| # | Test | Asserts |
|---|------|---------|
| 1 | Queue loads and seeds a frame | Frame ratio matches the suggested format to 1e-6 |
| 2 | Angle round-trip | Frame seeded from a real detection reports the detector's angle; verifies the §1.2 sign convention |
| 3 | **Ratio lock** | Drag a corner far off-axis, accept, output PNG is *exactly* 1654 × 2339 for A4 |
| 4 | **Corner anchoring** | Resizing from one corner leaves the opposite corner fixed to the pixel |
| 5 | Edge anchoring | Dragging an edge tick holds the ratio and leaves the opposite edge fixed |
| 6 | Move | Interior drag translates the frame; `w`, `h`, `angle` unchanged |
| 7 | Inert outside | A drag starting outside the frame changes nothing |
| 8 | Dial | Drag changes angle, holds the ratio, and is one undo step |
| 9 | Raster | Non-transparent alpha count > 0 inside the frame, drops to exactly 0 when toggled off |
| 10 | Overhang | Push the frame past the scan edge → warning shown, accept still succeeds |
| 11 | A6 landscape | Accepts at exactly 1165 × 827, fully deskewed |
| 12 | Finalize | PDF delivered to the mock in order; page count via `qpdf --show-npages` |
| 13 | Untouched accept | Accepting the seeded frame as-is writes `unchanged: true`, `schema: 2`, and a `seeded` block |
| 14 | Error decomposition | Move the frame a known distance and accept; `error.centre_px` matches to sub-pixel and `scale` stays 1.000 |

Plus a Python unit suite for `frame.py` (pytest, added to the venv — it is not
installed today), covering the seed fit against the real 1663 × 2328 A4 and the
skewed A6, the frame ↔ corners round-trip at several angles, and the ratio
invariant across all three formats in both orientations. These run without a
browser or a live server, which is where the geometry belongs.

**Mutation-test #3 and #4** specifically. Those two would otherwise pass against
an implementation that silently ignored the ratio lock or the anchor, and a
passing test proves nothing until it has been seen to fail. Disable the relevant
handler, confirm failure at the exact assertion, restore.

---

## 9. What is lost

Accepted deliberately:

- Free corner dragging and free-form edge dragging.
- The `free` format in the UI (still supported by the backend).
- The always-visible preview pane, replaced by peek.
- The existing desktop three-pane layout.
- All existing ground-truth records, and the `corner_shift_px` metric (§6).

## 10. Risks

- **The corpus restarts from zero.** Discarding the old records costs nothing
  today (they are two test fixtures), but it does mean the detector remains
  unmeasured on real scans until a fresh batch has been reviewed. Nothing in this
  design improves the detector; it improves the ability to see where it is wrong.
- **Touch testing is shallower than real use.** Playwright's synthetic touch does
  not reproduce fat fingers or palm contact. The grab-band sizes in §4 are
  reasoned, not measured, and may need adjustment after real use on the phone.
- **The seed fit is a judgement call, and it is now load-bearing.** Least-squares
  scale (§1.3) decides where every review starts, and `error` in §6.2 is measured
  against it. If it proves biased, changing it invalidates comparisons across the
  change — which is why `seeded` is stored per record rather than recomputed.
