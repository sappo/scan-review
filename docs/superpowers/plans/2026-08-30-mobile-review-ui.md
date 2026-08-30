# Mobile-first Scan Review UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace scanpipe's free-quad desktop review UI with a mobile-first, ratio-locked crop-and-straighten UI, and rework ground-truth records so detector error is decomposed per axis.

**Architecture:** The UI's crop state becomes `frame = {cx, cy, w, h, angle}` with `h/w` pinned to an ISO ratio; four corners are derived from it whenever the server is called, so `warp.py` and the preview/accept API are untouched. The canvas rotates the *image* by `−angle` so the frame always renders axis-aligned, collapsing hit-testing to point-in-rectangle. The seed fit that turns a detection into a frame runs on the backend at ingest and is frozen, so ground-truth records cannot be influenced by the client.

**Tech Stack:** Python 3 / FastAPI / uvicorn / OpenCV / numpy (backend, `.venv`), vanilla JS + Canvas 2D (frontend, no build step), Playwright (e2e), pytest (geometry units).

**Spec:** `docs/superpowers/specs/2026-08-30-mobile-review-ui-design.md`

## Global Constraints

- Ratios come from `warp.PAPER_MM`, never a shared √2 constant. A4 `0.707071`, A5 `0.704762`, A6 `0.709459` (portrait w/h).
- Output sizes at 200dpi are exact: A4 `1654×2339`, A5 `1165×1654`, A6 portrait `827×1165`, A6 landscape `1165×827`.
- Corners are always ordered **TL, TR, BR, BL in frame space** — `warp()` maps them onto `[[0,0],[W-1,0],[W-1,H-1],[0,H-1]]`.
- The frame is **never clamped** into the image. Clamping previously cost −3.00° of residual skew on a real A6.
- The server must stay single-process. Never add `uvicorn --workers`.
- `state.json` is read-modify-written under `_lock`; `save_state()` must remain atomic (temp file + `os.replace`).
- All work uses `./.venv/bin/python`, never `python3` — brew python has numpy but no PIL, `/usr/bin/python3` has PIL but no numpy.
- Restart after backend changes: `systemctl --user restart scanpipe`.
- Never commit `secrets.env`.

---

### Task 1: Version control with secrets excluded

`scanpipe/` is not a git repository, so the plan's per-task commits have nowhere to go. It also contains `secrets.env` (mode 0600, real credentials) and several directories of personal scans, none of which may ever be committed.

**Files:**
- Create: `.gitignore`

- [ ] **Step 1: Write `.gitignore`**

```gitignore
# credentials - NEVER commit
secrets.env

# scanned documents contain personal data
spool/
spool-archive/
originals/
out/
work/
scans/
groundtruth/
mock-paperless/
state.json

# build / tooling
.venv/
node_modules/
__pycache__/
test-results/
.omc/
*.pyc
```

- [ ] **Step 2: Initialise the repo**

```bash
cd ~/projects/scanpipe && git init -b main
```

- [ ] **Step 3: Verify the exclusions actually hold**

Run:
```bash
cd ~/projects/scanpipe
git add -A
git status --short | grep -E 'secrets\.env|spool/|originals/|\.venv/' && echo "LEAK" || echo "clean"
git check-ignore -v secrets.env
```
Expected: prints `clean`, and `check-ignore` confirms `.gitignore:2:secrets.env`. If `LEAK` prints, stop and fix `.gitignore` before committing anything.

- [ ] **Step 4: Commit**

```bash
cd ~/projects/scanpipe
git commit -m "chore: initialise repo, exclude secrets and scan data"
```

---

### Task 2: `frame.py` — ratios, and frame ↔ corners

**Files:**
- Create: `frame.py`
- Create: `tests/test_frame.py`
- Modify: `.venv` (add pytest)

**Interfaces:**
- Consumes: `warp.PAPER_MM`
- Produces:
  - `ratio(fmt: str, orientation: str) -> float` — h/w
  - `corners_of(f: dict) -> np.ndarray` — `(4,2)` float32, TL TR BR BL in frame space
  - `frame_from_corners(corners) -> dict` — `{cx, cy, w, h, angle}`
  - `quad_angle_deg(corners) -> float` — angle of the top edge, degrees
  - `PORTRAIT = "portrait"`, `LANDSCAPE = "landscape"`

- [ ] **Step 1: Install pytest and make the project root importable**

```bash
cd ~/projects/scanpipe && ./.venv/bin/pip install pytest
touch conftest.py
```

The empty root `conftest.py` is required, not cosmetic: pytest prepends a test
file's own directory to `sys.path`, not the project root, so without it
`import frame` inside `tests/` fails with `ModuleNotFoundError`. A root
`conftest.py` makes pytest add the project root instead.

- [ ] **Step 2: Write the failing tests**

Create `tests/test_frame.py`:

```python
import math
import numpy as np
import pytest

import frame as F

# The real A6 detection from scan `clash.png`, kept as the reference fixture.
A6_CORNERS = [[264.094482421875, 52.032203674316406],
              [1416.6912841796875, -103.3741226196289],
              [1527.88134765625, 721.2855834960938],
              [375.2845458984375, 876.6919555664062]]
A6_ANGLE = -7.678964138031006


def test_ratios_come_from_paper_mm_not_sqrt2():
    # The ISO sizes are whole millimetres, so the three ratios genuinely differ.
    assert F.ratio("A4", F.PORTRAIT) == pytest.approx(297 / 210, abs=1e-9)
    assert F.ratio("A5", F.PORTRAIT) == pytest.approx(210 / 148, abs=1e-9)
    assert F.ratio("A6", F.PORTRAIT) == pytest.approx(148 / 105, abs=1e-9)
    # ...and they are NOT all sqrt(2).
    assert F.ratio("A5", F.PORTRAIT) != pytest.approx(math.sqrt(2), abs=1e-6)


def test_landscape_ratio_is_the_reciprocal():
    assert F.ratio("A6", F.LANDSCAPE) == pytest.approx(105 / 148, abs=1e-9)


def test_corners_are_ordered_tl_tr_br_bl_in_frame_space():
    f = {"cx": 100.0, "cy": 200.0, "w": 40.0, "h": 20.0, "angle": 0.0}
    c = F.corners_of(f)
    assert c.shape == (4, 2)
    np.testing.assert_allclose(c, [[80, 190], [120, 190], [120, 210], [80, 210]], atol=1e-6)


def test_frame_corners_roundtrip_at_many_angles():
    src = {"cx": 512.0, "cy": 733.0, "w": 400.0, "h": 565.7, "angle": 0.0}
    for deg in (-44.0, -7.679, -0.5, 0.0, 0.5, 7.679, 44.0):
        f = dict(src, angle=deg)
        back = F.frame_from_corners(F.corners_of(f))
        for k in ("cx", "cy", "w", "h", "angle"):
            assert back[k] == pytest.approx(f[k], abs=1e-4), f"{k} at {deg} deg"


def test_quad_angle_matches_the_detector_on_the_real_a6():
    # detect.py and app.quad_angle document opposite sign conventions but produce
    # the same number. This pins the number, not the prose.
    assert F.quad_angle_deg(A6_CORNERS) == pytest.approx(A6_ANGLE, abs=1e-6)
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd ~/projects/scanpipe && ./.venv/bin/python -m pytest tests/test_frame.py -v`
Expected: FAIL, `ModuleNotFoundError: No module named 'frame'`.

- [ ] **Step 4: Write `frame.py`**

```python
"""The review crop as a ratio-locked rectangle, and its conversions.

The UI's crop is five numbers - centre, size, angle - with `h/w` pinned to an
ISO paper ratio. Four corners are DERIVED from that whenever the server is
called, so `warp.py` and the preview/accept API never learn about frames.

Ratio-locking is therefore a property of the representation: no gesture can
violate it, because no gesture can express a violation.
"""
import numpy as np

from warp import PAPER_MM

PORTRAIT = "portrait"
LANDSCAPE = "landscape"


def ratio(fmt, orientation=PORTRAIT):
    """h/w for an ISO format.

    Read from PAPER_MM rather than assuming sqrt(2): the ISO sizes are rounded
    to whole millimetres, so A4 (0.707071), A5 (0.704762) and A6 (0.709459)
    genuinely differ. A shared constant would put the frame slightly out of step
    with the size `warp.target_size_px` actually renders.
    """
    pw, ph = PAPER_MM[fmt]
    return (ph / pw) if orientation == PORTRAIT else (pw / ph)


def orientation_of(f):
    return LANDSCAPE if f["w"] > f["h"] else PORTRAIT


def corners_of(f):
    """The frame's four corners, ordered TL TR BR BL *in frame space*.

    Frame space, not image space: after rotation the frame's top-left is
    generally not the topmost-leftmost point. This ordering is what makes
    `warp()` produce an upright page, since it maps corners[0] onto (0,0).
    """
    hw, hh = f["w"] / 2.0, f["h"] / 2.0
    local = np.array([[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]], dtype=np.float64)
    a = np.deg2rad(f["angle"])
    r = np.array([[np.cos(a), -np.sin(a)], [np.sin(a), np.cos(a)]], dtype=np.float64)
    return (local @ r.T + np.array([f["cx"], f["cy"]])).astype(np.float32)


def quad_angle_deg(corners):
    """Rotation of a quad's top edge, in degrees.

    Matches `app.quad_angle` exactly. Note that detect.py's docstring calls this
    convention counter-clockwise and app.py's calls it clockwise; they describe
    the same number. The tests pin the number.
    """
    c = np.asarray(corners, dtype=np.float64)
    return float(np.degrees(np.arctan2(c[1][1] - c[0][1], c[1][0] - c[0][0])))


def frame_from_corners(corners):
    """Fit a frame to a quad, using the mean of each opposing edge pair."""
    c = np.asarray(corners, dtype=np.float64).reshape(4, 2)
    cx, cy = c.mean(axis=0)
    w = (np.linalg.norm(c[1] - c[0]) + np.linalg.norm(c[2] - c[3])) / 2.0
    h = (np.linalg.norm(c[3] - c[0]) + np.linalg.norm(c[2] - c[1])) / 2.0
    return {"cx": float(cx), "cy": float(cy), "w": float(w), "h": float(h),
            "angle": quad_angle_deg(c)}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd ~/projects/scanpipe && ./.venv/bin/python -m pytest tests/test_frame.py -v`
Expected: 5 passed.

- [ ] **Step 6: Commit**

```bash
cd ~/projects/scanpipe
git add frame.py tests/test_frame.py conftest.py
git commit -m "feat: frame geometry - ratio table and frame/corners conversion"
```

---

### Task 3: `frame.py` — the seed fit

Turns a detector quad into the ratio-locked frame the operator is first shown.

**Files:**
- Modify: `frame.py`
- Modify: `tests/test_frame.py`

**Interfaces:**
- Consumes: `ratio`, `quad_angle_deg`, `PORTRAIT`, `LANDSCAPE` (Task 2)
- Produces: `seed_frame(corners, fmt: str) -> dict` returning
  `{cx, cy, w, h, angle, format, orientation}`

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_frame.py`:

```python
# The real A4 detection from `letter-01.png`: full scan width, ratio 0.7144.
A4_CORNERS = [[0.0, 0.0], [1663.0, 0.0], [1663.0, 2328.0], [0.0, 2328.0]]


def test_seed_locks_the_ratio_exactly():
    f = F.seed_frame(A4_CORNERS, "A4")
    assert f["h"] / f["w"] == pytest.approx(F.ratio("A4", F.PORTRAIT), abs=1e-9)


def test_seed_splits_the_error_between_both_axes():
    # Detected 1663x2328 (ratio 0.7144) cannot be A4 (0.707071) exactly. The
    # least-squares scale lands between: narrower AND taller, not one or other.
    f = F.seed_frame(A4_CORNERS, "A4")
    assert f["w"] == pytest.approx(1651.7, abs=0.5)
    assert f["h"] == pytest.approx(2335.9, abs=0.5)
    assert f["w"] < 1663.0 and f["h"] > 2328.0


def test_seed_centres_on_the_detected_centroid():
    f = F.seed_frame(A4_CORNERS, "A4")
    assert f["cx"] == pytest.approx(831.5, abs=1e-6)
    assert f["cy"] == pytest.approx(1164.0, abs=1e-6)


def test_seed_infers_landscape_from_the_real_a6():
    f = F.seed_frame(A6_CORNERS, "A6")
    assert f["orientation"] == F.LANDSCAPE
    assert f["cx"] == pytest.approx(896.0, abs=0.1)
    assert f["cy"] == pytest.approx(386.7, abs=0.1)
    assert f["w"] == pytest.approx(1166.3, abs=0.1)
    assert f["h"] == pytest.approx(827.5, abs=0.1)
    assert f["angle"] == pytest.approx(A6_ANGLE, abs=1e-6)
    assert f["format"] == "A6"


def test_seed_of_an_unknown_format_is_rejected():
    with pytest.raises(KeyError):
        F.seed_frame(A4_CORNERS, "free")
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd ~/projects/scanpipe && ./.venv/bin/python -m pytest tests/test_frame.py -v -k seed`
Expected: FAIL, `AttributeError: module 'frame' has no attribute 'seed_frame'`.

- [ ] **Step 3: Implement `seed_frame`**

Append to `frame.py`:

```python
def _edge_lengths(c):
    return (max(np.linalg.norm(c[1] - c[0]), np.linalg.norm(c[2] - c[3])),
            max(np.linalg.norm(c[3] - c[0]), np.linalg.norm(c[2] - c[1])))


def seed_frame(corners, fmt):
    """The ratio-locked frame a detector quad implies - what the operator sees first.

    The detector's quad is close to ISO but not exact: the real A4 arrives at
    1663x2328, a ratio of 0.7144 against A4's 0.707071. Fitting by least-squares
    scale splits that error between both axes rather than letting the frame
    systematically over- or under-cover the sheet.

    Given the unit-ratio rectangle (rw, rh) and detected edge lengths (dw, dh),
    minimising (s*rw - dw)^2 + (s*rh - dh)^2 gives
        s = (rw*dw + rh*dh) / (rw^2 + rh^2)
    """
    c = np.asarray(corners, dtype=np.float64).reshape(4, 2)
    cx, cy = c.mean(axis=0)
    dw, dh = _edge_lengths(c)
    orientation = LANDSCAPE if dw > dh else PORTRAIT
    rw, rh = 1.0, ratio(fmt, orientation)
    s = (rw * dw + rh * dh) / (rw * rw + rh * rh)
    return {"cx": float(cx), "cy": float(cy),
            "w": float(s * rw), "h": float(s * rh),
            "angle": quad_angle_deg(c),
            "format": fmt, "orientation": orientation}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd ~/projects/scanpipe && ./.venv/bin/python -m pytest tests/test_frame.py -v`
Expected: 10 passed.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/scanpipe
git add frame.py tests/test_frame.py
git commit -m "feat: least-squares seed fit from detection to ratio-locked frame"
```

---

### Task 4: `frame.py` — error decomposition

**Files:**
- Modify: `frame.py`
- Modify: `tests/test_frame.py`

**Interfaces:**
- Produces: `frame_error(seeded: dict, accepted: dict, dpi: int = 200) -> dict` with keys
  `centre_px` (list of 2), `centre_dist_px`, `centre_dist_mm`, `scale`, `angle_deg`,
  `format_agreed`, `orientation_agreed`, `unchanged`
- Produces: `UNCHANGED_TOL = {"centre_px": 1.0, "scale": 0.002, "angle_deg": 0.05}`

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_frame.py`:

```python
SEED = {"cx": 896.0, "cy": 386.7, "w": 1166.3, "h": 827.5, "angle": -7.679,
        "format": "A6", "orientation": F.LANDSCAPE}


def _acc(**over):
    return dict(SEED, **over)


def test_error_is_zero_and_unchanged_for_an_untouched_accept():
    e = F.frame_error(SEED, _acc())
    assert e["centre_dist_px"] == pytest.approx(0.0, abs=1e-9)
    assert e["scale"] == pytest.approx(1.0, abs=1e-9)
    assert e["angle_deg"] == pytest.approx(0.0, abs=1e-9)
    assert e["unchanged"] is True


def test_error_reports_centre_shift_in_px_and_mm():
    e = F.frame_error(SEED, _acc(cx=901.5, cy=388.3))
    assert e["centre_px"] == pytest.approx([5.5, 1.6], abs=1e-6)
    assert e["centre_dist_px"] == pytest.approx(5.728, abs=1e-3)
    assert e["centre_dist_mm"] == pytest.approx(0.727, abs=1e-3)
    assert e["unchanged"] is False


def test_scale_uses_the_long_edge_so_it_survives_a_format_change():
    # A6 landscape (long edge = w) accepted as A4 portrait (long edge = h).
    e = F.frame_error(SEED, _acc(w=825.0, h=1166.3, format="A4",
                                 orientation=F.PORTRAIT))
    assert e["scale"] == pytest.approx(1166.3 / 1166.3, abs=1e-9)
    assert e["format_agreed"] is False
    assert e["orientation_agreed"] is False


def test_angle_error_is_the_dial_value():
    e = F.frame_error(SEED, _acc(angle=-7.380))
    assert e["angle_deg"] == pytest.approx(0.299, abs=1e-6)


def test_unchanged_tolerates_sub_pixel_noise_but_not_a_real_correction():
    assert F.frame_error(SEED, _acc(cx=896.9))["unchanged"] is True
    assert F.frame_error(SEED, _acc(cx=897.5))["unchanged"] is False
    assert F.frame_error(SEED, _acc(angle=-7.66))["unchanged"] is True
    assert F.frame_error(SEED, _acc(angle=-7.60))["unchanged"] is False
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd ~/projects/scanpipe && ./.venv/bin/python -m pytest tests/test_frame.py -v -k "error or unchanged or scale"`
Expected: FAIL, `AttributeError: module 'frame' has no attribute 'frame_error'`.

- [ ] **Step 3: Implement `frame_error`**

Append to `frame.py`:

```python
# What counts as "the operator accepted what was proposed". Deliberately loose
# enough to absorb float noise and a stray sub-pixel touch, tight enough that a
# real correction is never scored as agreement.
UNCHANGED_TOL = {"centre_px": 1.0, "scale": 0.002, "angle_deg": 0.05}


def frame_error(seeded, accepted, dpi=200):
    """How far the operator moved the frame they were shown.

    Compares SEEDED to ACCEPTED, not detected to accepted: the seeded frame is
    what was actually on screen, so it is what agreement or correction is
    relative to.

    Each component indicts a different part of the detector - centre the mask
    thresholds, scale the morphology kernels, angle minAreaRect, format
    classify()'s tolerance - which the old single `corner_shift_px` could not.
    """
    dx = accepted["cx"] - seeded["cx"]
    dy = accepted["cy"] - seeded["cy"]
    dist = float(np.hypot(dx, dy))
    # Long edge, so the comparison survives a portrait/landscape format change.
    s_long = max(seeded["w"], seeded["h"])
    a_long = max(accepted["w"], accepted["h"])
    scale = float(a_long / s_long)
    d_angle = float(accepted["angle"] - seeded["angle"])
    fmt_ok = seeded.get("format") == accepted.get("format")
    ori_ok = seeded.get("orientation") == accepted.get("orientation")
    unchanged = bool(
        dist <= UNCHANGED_TOL["centre_px"]
        and abs(scale - 1.0) <= UNCHANGED_TOL["scale"]
        and abs(d_angle) <= UNCHANGED_TOL["angle_deg"]
        and fmt_ok and ori_ok
        and int(accepted.get("rotation", 0)) == 0)
    return {"centre_px": [float(dx), float(dy)],
            "centre_dist_px": dist,
            "centre_dist_mm": dist * 25.4 / dpi,
            "scale": scale,
            "angle_deg": d_angle,
            "format_agreed": fmt_ok,
            "orientation_agreed": ori_ok,
            "unchanged": unchanged}
```

- [ ] **Step 4: Run the whole geometry suite**

Run: `cd ~/projects/scanpipe && ./.venv/bin/python -m pytest tests/test_frame.py -v`
Expected: 15 passed.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/scanpipe
git add frame.py tests/test_frame.py
git commit -m "feat: decompose crop error into centre, scale, angle, format"
```

---

### Task 5: Seed the frame at ingest and expose it

**Files:**
- Modify: `app.py` — imports, `ingest_spool()` (~line 106-150), `queue()` (~line 181)
- Modify: `tests/pipeline.spec.js`

**Interfaces:**
- Consumes: `frame.seed_frame` (Task 3)
- Produces: each page in `/api/queue`'s `pending[]` gains
  `seeded: {cx, cy, w, h, angle, format, orientation}`

- [ ] **Step 1: Give Playwright a `baseURL`**

The existing config has none, so the relative paths these tests use would fail.
Add it to the `use` block in `playwright.config.js` (the full config rewrite
comes in Task 8):

```javascript
    baseURL: 'http://127.0.0.1:8765',
```

- [ ] **Step 2: Replace the test file with just this test**

The remaining desktop-era tests target controls that no longer exist after Task 8
(`skew-slider`, the preview pane, corner-index dragging). Delete them now rather
than carrying known-failing tests through six tasks. Overwrite
`tests/pipeline.spec.js` with:

```javascript
const { test, expect } = require('@playwright/test');

test('queue seeds a ratio-locked frame for every pending page', async ({ request }) => {
  const r = await request.get('/api/queue');
  expect(r.ok()).toBeTruthy();
  const { pending } = await r.json();
  expect(pending.length).toBeGreaterThan(0);
  const RATIO = { A4: 297 / 210, A5: 210 / 148, A6: 148 / 105 };
  for (const p of pending) {
    expect(p.seeded, `page ${p.id} has no seeded frame`).toBeTruthy();
    const { w, h, format, orientation } = p.seeded;
    const want = orientation === 'landscape' ? 1 / RATIO[format] : RATIO[format];
    expect(h / w).toBeCloseTo(want, 9);
  }
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd ~/projects/scanpipe && npx playwright test -g "seeds a ratio-locked frame"`
Expected: FAIL, `page ... has no seeded frame`.

- [ ] **Step 4: Seed at ingest**

In `app.py`, add to the imports near `from warp import ...`:

```python
import frame as frame_mod
```

In `ingest_spool()`, immediately after `suggested = classify(corners) or "free"`, add:

```python
        # The seed fit runs HERE, on the server, and is frozen with `detected`.
        # If the browser computed it, a stale client could report a starting
        # frame it never displayed and the ground-truth dataset would overstate
        # how often the detector was right.
        seeded = (frame_mod.seed_frame(corners, suggested)
                  if suggested in PAPER_MM else None)
```

and add `"seeded": seeded,` to the `state["pages"][key] = {...}` dict, directly beneath the `"detected": {...}` entry.

- [ ] **Step 5: Backfill pages ingested before this change**

Pages already in `state.json` have no `seeded`. Add this function above `refresh()`:

```python
def backfill_seeds(state):
    """Give pages ingested before the frame model a seeded frame.

    Recomputed from the FROZEN `detected` corners, so a backfilled seed is
    identical to one written at ingest - no data is invented.
    """
    changed = False
    for page in state["pages"].values():
        if page.get("seeded") is not None:
            continue
        det = page.get("detected") or {}
        fmt = det.get("format")
        if not det.get("corners") or fmt not in PAPER_MM:
            continue
        page["seeded"] = frame_mod.seed_frame(det["corners"], fmt)
        changed = True
    return changed
```

and call it inside `refresh()`, changing the body to:

```python
def refresh():
    with _lock:
        s = load_state()
        added = ingest_spool(s)
        filled = backfill_seeds(s)
        if added or filled:
            save_state(s)
        return s, added
```

- [ ] **Step 6: Restart and run the test**

Run:
```bash
cd ~/projects/scanpipe && systemctl --user restart scanpipe && sleep 2
npx playwright test -g "seeds a ratio-locked frame"
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd ~/projects/scanpipe
git add app.py tests/pipeline.spec.js playwright.config.js
git commit -m "feat: compute and freeze the seeded frame at ingest"
```

---

### Task 6: Schema-2 ground-truth records

**Files:**
- Modify: `app.py` — `AcceptBody`, `accept()` (~line 197-250)
- Modify: `tests/pipeline.spec.js`
- Delete: `groundtruth/*.json`

**Interfaces:**
- Consumes: `frame.frame_error` (Task 4), `page["seeded"]` (Task 5)
- Produces: `AcceptBody` gains `frame: dict | None`; records written at
  `groundtruth/<page_id>.json` in the §6.2 shape with `"schema": 2`

- [ ] **Step 1: Write the failing test**

Append to `tests/pipeline.spec.js`:

```javascript
const fs = require('fs');
const path = require('path');
const TRUTH = path.join(__dirname, '..', 'groundtruth');

test('accepting an untouched frame records schema 2 with unchanged=true',
  async ({ request }) => {
    const { pending } = await (await request.get('/api/queue')).json();
    const p = pending.find(x => x.seeded);
    const r = await request.post(`/api/accept/${encodeURIComponent(p.id)}`, {
      data: { corners: p.corners, frame: p.seeded, rotation: 0,
              target: p.seeded.format } });
    expect(r.ok()).toBeTruthy();

    const rec = JSON.parse(fs.readFileSync(path.join(TRUTH, p.id + '.json'), 'utf8'));
    expect(rec.schema).toBe(2);
    expect(rec.seeded).toBeTruthy();
    expect(rec.detected).toBeTruthy();
    expect(rec.error.unchanged).toBe(true);
    expect(rec.error.centre_dist_px).toBeCloseTo(0, 6);
    expect(rec).not.toHaveProperty('corner_shift_px');
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/projects/scanpipe && npx playwright test -g "records schema 2"`
Expected: FAIL (no `schema` property / file missing).

- [ ] **Step 3: Change `accept()`**

In `app.py`:

Add `frame: dict | None = None` to `AcceptBody`.

Replace the ground-truth block in `accept()` — everything from the
`# Ground truth for refining the detector:` comment through the
`(TRUTH / f"{page_id}.json").write_text(...)` line — with:

```python
        # Ground truth for refining the detector: what it PROPOSED versus what a
        # human ACCEPTED. Written on every accept, including unchanged ones -
        # agreement is as informative as correction, and a dataset of only
        # corrections would be biased.
        detected = page.get("detected", {})
        seeded = page.get("seeded")
        accepted_frame = body.frame or (
            dict(frame_mod.frame_from_corners(body.corners),
                 format=body.target,
                 orientation=frame_mod.orientation_of(
                     frame_mod.frame_from_corners(body.corners))))
        accepted_frame = dict(accepted_frame, rotation=body.rotation)
        record = {
            "page": page_id,
            "at": datetime.now(timezone.utc).isoformat(),
            "schema": 2,
            "source": page["source"],
            "scan": {"width": page["width"], "height": page["height"], "dpi": 200},
            "hint": page.get("hint"),
            "detected": {"corners": detected.get("corners"),
                         "angle": detected.get("angle"),
                         "format": detected.get("format")},
            "seeded": seeded,
            "accepted": dict(accepted_frame, corners=body.corners),
            "error": (frame_mod.frame_error(seeded, accepted_frame)
                      if seeded else None),
        }
        if record["error"] is not None:
            hint = page.get("hint")
            record["error"]["hint_agrees"] = (
                None if hint is None else hint == accepted_frame.get("format"))
        (TRUTH / f"{page_id}.json").write_text(json.dumps(record, indent=2))
```

- [ ] **Step 4: Discard the old records**

```bash
cd ~/projects/scanpipe && rm -f groundtruth/*.json && ls groundtruth/
```
Expected: empty. These were only the `t-agree` / `t-mismatch` test fixtures; no real review data existed.

- [ ] **Step 5: Restart and run**

Run:
```bash
cd ~/projects/scanpipe && systemctl --user restart scanpipe && sleep 2
npx playwright test -g "records schema 2"
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd ~/projects/scanpipe
git add app.py tests/pipeline.spec.js
git commit -m "feat: schema 2 ground truth with decomposed error; discard old records"
```

---

### Task 7: Rewrite `evaluate.py`

**Files:**
- Modify: `evaluate.py` (full rewrite)
- Create: `tests/test_evaluate.py`

**Interfaces:**
- Consumes: schema-2 records (Task 6)
- Produces: `load_records(dirpath) -> list[dict]`, `summarise(records) -> dict`,
  `main(argv) -> int`

- [ ] **Step 1: Write the failing tests**

Create `tests/test_evaluate.py`:

```python
import json
import pytest

import evaluate as E


def _rec(page, unchanged, dist_mm, scale, angle, fmt_ok=True, hint=True):
    return {"page": page, "schema": 2, "hint": "A6",
            "seeded": {"format": "A6"}, "accepted": {"format": "A6"},
            "error": {"unchanged": unchanged, "centre_dist_mm": dist_mm,
                      "centre_dist_px": dist_mm * 200 / 25.4, "scale": scale,
                      "angle_deg": angle, "format_agreed": fmt_ok,
                      "orientation_agreed": True, "hint_agrees": hint}}


def test_summarise_counts_agreement():
    s = E.summarise([_rec("a", True, 0.0, 1.0, 0.0),
                     _rec("b", False, 2.0, 1.01, 0.5)])
    assert s["n"] == 2
    assert s["unchanged"] == 1
    assert s["format_agreed"] == 2
    assert s["hint_agreed"] == 2


def test_summarise_reports_per_axis_error():
    s = E.summarise([_rec("a", False, 1.0, 1.00, 0.2),
                     _rec("b", False, 3.0, 1.02, -0.4)])
    assert s["centre_mm"]["mean"] == pytest.approx(2.0)
    assert s["centre_mm"]["max"] == pytest.approx(3.0)
    assert s["scale_pct"]["max"] == pytest.approx(2.0, abs=1e-6)
    assert s["angle_deg"]["mean"] == pytest.approx(0.3)


def test_records_of_an_unknown_schema_are_refused_not_misread(tmp_path):
    (tmp_path / "old.json").write_text(json.dumps({"page": "old", "detected": {}}))
    with pytest.raises(ValueError, match="schema"):
        E.load_records(tmp_path)


def test_empty_corpus_summarises_without_dividing_by_zero():
    s = E.summarise([])
    assert s["n"] == 0
    assert s["centre_mm"]["mean"] is None
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd ~/projects/scanpipe && ./.venv/bin/python -m pytest tests/test_evaluate.py -v`
Expected: FAIL, `AttributeError: module 'evaluate' has no attribute 'summarise'`.

- [ ] **Step 3: Rewrite `evaluate.py`**

```python
#!/usr/bin/env python
"""Where the crop detector actually stands, measured against accepted reviews.

Each accept writes a record pairing the frame the detector PROPOSED (`seeded`)
with the frame the operator ACCEPTED. A ratio-locked frame has five degrees of
freedom and each maps to a different part of the detector, so the error is
reported per axis rather than as one blended number:

    centre       the paper mask's centroid - backing/padding thresholds
    scale        mask erosion or dilation - the morphology kernel sizes
    angle        minAreaRect skew
    format       classify() and its tolerance

Accepts the operator did NOT change are counted too. A corpus of only
corrections would be biased.
"""
import argparse
import json
import statistics
import sys
from pathlib import Path

SCHEMA = 2
TRUTH = Path(__file__).resolve().parent / "groundtruth"


def load_records(dirpath=TRUTH):
    out = []
    for p in sorted(Path(dirpath).glob("*.json")):
        rec = json.loads(p.read_text())
        if rec.get("schema") != SCHEMA:
            raise ValueError(
                f"{p.name}: schema {rec.get('schema')!r}, expected {SCHEMA}. "
                "Records from before the ratio-locked frame are not comparable; "
                "delete them rather than reading them as if they matched.")
        out.append(rec)
    return out


def _stats(values):
    if not values:
        return {"mean": None, "median": None, "max": None}
    return {"mean": statistics.fmean(values),
            "median": statistics.median(values),
            "max": max(values)}


def summarise(records):
    errs = [r["error"] for r in records if r.get("error")]
    return {
        "n": len(records),
        "measured": len(errs),
        "unchanged": sum(1 for e in errs if e["unchanged"]),
        "format_agreed": sum(1 for e in errs if e["format_agreed"]),
        "orientation_agreed": sum(1 for e in errs if e["orientation_agreed"]),
        "hint_given": sum(1 for e in errs if e.get("hint_agrees") is not None),
        "hint_agreed": sum(1 for e in errs if e.get("hint_agrees") is True),
        "centre_mm": _stats([e["centre_dist_mm"] for e in errs]),
        "scale_pct": _stats([abs(e["scale"] - 1.0) * 100 for e in errs]),
        "angle_deg": _stats([abs(e["angle_deg"]) for e in errs]),
    }


def _fmt(s, unit, places=2):
    if s["mean"] is None:
        return "n/a"
    return (f"mean {s['mean']:.{places}f}{unit}  "
            f"median {s['median']:.{places}f}{unit}  "
            f"max {s['max']:.{places}f}{unit}")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--verbose", action="store_true", help="per-record table")
    ap.add_argument("--dir", default=str(TRUTH))
    args = ap.parse_args(argv)

    records = load_records(args.dir)
    s = summarise(records)
    if not s["n"]:
        print("no ground-truth records yet - review some scans first")
        return 0

    print(f"ground-truth records: {s['n']}")
    print(f"  accepted unchanged : {s['unchanged']}   (detector was right)")
    print(f"  corrected by hand  : {s['measured'] - s['unchanged']}")
    print(f"  format agreement   : {s['format_agreed']}/{s['measured']}")
    print(f"  orientation agree  : {s['orientation_agreed']}/{s['measured']}")
    print(f"  matches panel hint : {s['hint_agreed']}/{s['hint_given']}")
    print()
    print(f"centre error : {_fmt(s['centre_mm'], 'mm')}")
    print(f"scale error  : {_fmt(s['scale_pct'], '%')}")
    print(f"angle error  : {_fmt(s['angle_deg'], 'deg')}")

    worst = sorted((r for r in records if r.get("error")),
                   key=lambda r: r["error"]["centre_dist_mm"], reverse=True)
    print()
    print("worst cases by centre error:")
    print(f"  {'page':28} {'hint':5} {'fmt':5} {'centre':>8} {'scale':>7} {'angle':>7}")
    for r in (worst if args.verbose else worst[:8]):
        e = r["error"]
        print(f"  {r['page'][:28]:28} {str(r.get('hint')):5} "
              f"{str(r['accepted'].get('format')):5} "
              f"{e['centre_dist_mm']:7.2f}mm {(e['scale']-1)*100:6.2f}% "
              f"{e['angle_deg']:6.2f}d")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run the tests**

Run: `cd ~/projects/scanpipe && ./.venv/bin/python -m pytest tests/test_evaluate.py -v && ./.venv/bin/python evaluate.py`
Expected: 4 passed; `evaluate.py` prints `no ground-truth records yet` (Task 6 emptied the directory) or a one-record summary.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/scanpipe
git add evaluate.py tests/test_evaluate.py
git commit -m "feat: evaluate per-axis detector error, refuse unknown schemas"
```

---

### Task 8: UI shell — markup, styles, and the tilted-image transform

The load-bearing rendering decision: the canvas rotates the **image** by `−angle`, so the frame draws as an axis-aligned rectangle and the scan appears tilted.

**Files:**
- Create: `ui.js`
- Modify: `ui.html` (full rewrite)
- Modify: `app.py` — add a route serving `ui.js`
- Modify: `playwright.config.js`

**Interfaces:**
- Consumes: `/api/queue` with `seeded` (Task 5)
- Produces (globals in `ui.js`, used by Tasks 9-14):
  - `state = { page, img, frame, rotation, view: {zoom, panX, panY}, mode }`
  - `RATIO` — `{A4, A5, A6}` portrait h/w, mirroring `frame.ratio`
  - `cornersOf(f) -> [[x,y] x4]`
  - `toScreen([x,y]) -> [sx,sy]`, `toImage([sx,sy]) -> [x,y]`
  - `frameRectOnScreen() -> {x, y, w, h}` — the frame as an axis-aligned screen rect
  - `render()` — full canvas redraw
  - `data-testid` hooks: `canvas`, `queue-count`, `page-title`, `mode-crop`,
    `mode-straighten`, `fmt-A4`/`fmt-A5`/`fmt-A6`, `btn-accept`, `btn-reject`,
    `btn-undo`, `btn-reset`, `btn-rotate`, `btn-swap`, `btn-peek`, `dial`,
    `grid-toggle`, `angle-readout`, `outside-flag`, `hint-mismatch`, `status`

- [ ] **Step 1: Add the mobile project to Playwright config**

Replace `playwright.config.js` with:

```javascript
const { devices } = require('@playwright/test');

const httpCredentials = (() => {
  const fs = require('fs');
  const env = Object.fromEntries(
    fs.readFileSync(__dirname + '/secrets.env', 'utf8')
      .split('\n').filter(Boolean).map(l => l.split('=')));
  return { username: env.SCANPIPE_USER, password: env.SCANPIPE_PASS };
})();

module.exports = {
  testDir: './tests',
  timeout: 30000,
  use: { headless: true, baseURL: 'http://127.0.0.1:8765', httpCredentials },
  projects: [
    { name: 'mobile', use: { ...devices['Pixel 7'], httpCredentials } },
    { name: 'desktop', use: { viewport: { width: 1280, height: 1000 }, httpCredentials } },
  ],
  reporter: [['list']],
};
```

- [ ] **Step 2: Write the failing test**

Append to `tests/pipeline.spec.js`:

```javascript
test('the frame renders axis-aligned while the scan tilts under it', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('canvas')).toBeVisible();
  await page.waitForFunction(() => window.state && window.state.img);
  // Load a skewed page (the real A6 is -7.68 deg) and read the frame back.
  const rect = await page.evaluate(() => {
    window.state.frame = { cx: 800, cy: 700, w: 400, h: 565.7, angle: -7.679 };
    window.render();
    return window.frameRectOnScreen();
  });
  // Axis-aligned means the rect is described by 4 numbers, not 4 points, and
  // its aspect ratio still matches the frame's despite the rotation.
  expect(rect.h / rect.w).toBeCloseTo(565.7 / 400, 4);
  expect(rect.w).toBeGreaterThan(0);
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd ~/projects/scanpipe && npx playwright test --project=mobile -g "axis-aligned"`
Expected: FAIL — `frameRectOnScreen is not a function`.

- [ ] **Step 4: Serve `ui.js` from `app.py`**

Add near the existing `@app.get("/")` route:

```python
@app.get("/ui.js")
def ui_js():
    return Response(content=(ROOT / "ui.js").read_text(),
                    media_type="application/javascript")
```

- [ ] **Step 5: Write `ui.html`**

Full replacement. Dark theme, full-bleed canvas, top bar, bottom contextual panel and mode tabs; above 900px the bottom panel becomes a right rail.

```html
<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,user-scalable=no">
<title>Scan Review</title>
<style>
  :root { --bg:#0d0f13; --panel:#171b22; --line:#2c3442; --text:#e6eaf0;
          --dim:#8b95a5; --accent:#4a9eff; --err:#f85149; --warn:#d29922; }
  * { box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
  html,body { height:100%; margin:0; overscroll-behavior:none; }
  body { background:var(--bg); color:var(--text); display:flex; flex-direction:column;
         font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  #top { display:flex; align-items:center; gap:10px; padding:8px 12px;
         padding-top:calc(8px + env(safe-area-inset-top)); }
  #top .grow { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis;
               white-space:nowrap; color:var(--dim); font-size:13px; }
  #stage { flex:1; position:relative; min-height:0; }
  #cv { position:absolute; inset:0; width:100%; height:100%; touch-action:none;
        display:block; }
  /* The raster lives on its own layer so a test can count its painted pixels
     unambiguously - over the scan, "no grid" and "greyish scan pixel" are not
     distinguishable. */
  #grid { position:absolute; inset:0; width:100%; height:100%; display:block;
          pointer-events:none; }
  #bottom { background:var(--panel); border-top:1px solid var(--line);
            padding:10px 12px calc(6px + env(safe-area-inset-bottom)); }
  .pill { display:flex; gap:8px; justify-content:center; flex-wrap:wrap; }
  button { min-height:44px; min-width:44px; padding:0 14px; border-radius:10px;
           border:1px solid var(--line); background:#232a34; color:var(--text);
           font-size:15px; }
  button[aria-pressed=true] { background:var(--accent); border-color:var(--accent);
                              color:#06121f; font-weight:600; }
  button.primary { background:var(--accent); border-color:var(--accent);
                   color:#06121f; font-weight:600; }
  button.danger { background:#2a1d1f; border-color:#5c2a2e; color:#ffb4ad; }
  #tabs { display:flex; gap:8px; margin-top:10px; }
  #tabs button { flex:1; }
  #dial { width:100%; height:56px; touch-action:none; display:block; }
  .readout { text-align:center; font-variant-numeric:tabular-nums; color:var(--dim); }
  .flag { color:var(--warn); font-size:13px; text-align:center; margin:4px 0 0; }
  .flag[hidden] { display:none; }
  #status { text-align:center; font-size:13px; min-height:18px; color:var(--dim); }
  @media (min-width:900px) {
    body { flex-direction:row; flex-wrap:wrap; }
    #top { width:100%; }
    #stage { flex:1; }
    #bottom { width:320px; border-top:0; border-left:1px solid var(--line); }
  }
</style>

<div id="top">
  <button data-testid="btn-undo" onclick="undo()" title="Undo">↶</button>
  <span class="grow"><span data-testid="page-title">…</span>
    · <span data-testid="queue-count"></span></span>
  <button data-testid="btn-peek" onclick="togglePeek()" title="Preview result">⛶</button>
  <button class="primary" data-testid="btn-accept" onclick="accept()">Accept</button>
</div>

<div id="stage">
  <canvas id="cv" data-testid="canvas"></canvas>
  <canvas id="grid" data-testid="grid"></canvas>
</div>

<div id="bottom">
  <div id="panel-crop">
    <div class="pill">
      <button data-testid="fmt-A4" onclick="setFormat('A4')">A4</button>
      <button data-testid="fmt-A5" onclick="setFormat('A5')">A5</button>
      <button data-testid="fmt-A6" onclick="setFormat('A6')">A6</button>
      <button data-testid="btn-swap" onclick="swapOrientation()" title="Swap orientation">⇄</button>
      <button data-testid="btn-rotate" onclick="rotate90()" title="Rotate output 90°">⟳</button>
    </div>
  </div>
  <div id="panel-straighten" hidden>
    <canvas id="dial" data-testid="dial"></canvas>
    <div class="readout"><span data-testid="angle-readout">0.00°</span></div>
    <div class="pill">
      <button data-testid="skew-minus-01" onclick="nudge(-0.1)">−0.1°</button>
      <button data-testid="skew-plus-01" onclick="nudge(0.1)">+0.1°</button>
    </div>
  </div>

  <p class="flag" data-testid="hint-mismatch" hidden>Panel hint disagrees with detection.</p>
  <p class="flag" data-testid="outside-flag" hidden>Crop extends past the scan; the
    missing sliver is filled white rather than skewing the page.</p>

  <div id="tabs">
    <button data-testid="mode-crop" aria-pressed="true" onclick="setMode('crop')">Crop</button>
    <button data-testid="mode-straighten" aria-pressed="false" onclick="setMode('straighten')">Straighten</button>
  </div>
  <div class="pill" style="margin-top:8px">
    <button data-testid="btn-reset" onclick="resetFrame()">Reset</button>
    <button data-testid="grid-toggle" aria-pressed="true" onclick="toggleGrid()">Grid</button>
    <button class="danger" data-testid="btn-reject" onclick="reject()">Reject</button>
    <button data-testid="btn-finalize" onclick="finalize()">Send</button>
  </div>
  <div id="status" data-testid="status"></div>
</div>

<script src="/ui.js"></script>
```

- [ ] **Step 6: Write `ui.js` — state, transforms, and render**

```javascript
'use strict';
// Portrait h/w, mirroring frame.ratio() on the server. Read from the ISO
// millimetre sizes, NOT sqrt(2): A4 0.707071, A5 0.704762, A6 0.709459 differ.
const PAPER_MM = { A4: [210, 297], A5: [148, 210], A6: [105, 148] };
const RATIO = {};
for (const [k, [w, h]] of Object.entries(PAPER_MM)) RATIO[k] = h / w;

const MIN_SIDE = 64;          // source px; warp() dies under 8, and a frame
                              // smaller than its own grab band is unusable
const BAND_MAX = 24;          // screen px either side of the border
const ZOOM_MIN = 1, ZOOM_MAX = 8;

const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');

const state = {
  page: null, img: null,
  frame: null,                // {cx, cy, w, h, angle} in source px
  format: 'A4', orientation: 'portrait', rotation: 0,
  view: { zoom: 1, panX: 0, panY: 0 },
  mode: 'crop', grid: true, peek: false, history: [],
};
window.state = state;

const q = id => document.querySelector(`[data-testid="${id}"]`);
const say = (m, c) => { const e = q('status'); e.textContent = m || '';
                        e.style.color = c || 'var(--dim)'; };

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

/** Pixels-per-source-pixel that fits the whole scan, before user zoom. */
function baseScale() {
  if (!state.img) return 1;
  const pad = 40;
  return Math.min((cv.width - pad) / state.img.naturalWidth,
                  (cv.height - pad) / state.img.naturalHeight);
}

/** Source pixel -> canvas pixel.
 *
 * The view is rotated by -frame.angle about the frame centre, so the FRAME
 * comes out axis-aligned and the SCAN appears tilted. That is what makes the
 * straighten dial legible against the screen edges, and it collapses all
 * hit-testing to point-in-axis-aligned-rectangle.
 */
function toScreen([x, y]) {
  const f = state.frame, v = state.view, s = baseScale() * v.zoom;
  const a = -f.angle * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
  const dx = x - f.cx, dy = y - f.cy;
  return [cv.width / 2 + v.panX + (dx * ca - dy * sa) * s,
          cv.height / 2 + v.panY + (dx * sa + dy * ca) * s];
}
function toImage([sx, sy]) {
  const f = state.frame, v = state.view, s = baseScale() * v.zoom;
  const px = (sx - cv.width / 2 - v.panX) / s;
  const py = (sy - cv.height / 2 - v.panY) / s;
  const a = f.angle * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
  return [f.cx + px * ca - py * sa, f.cy + px * sa + py * ca];
}
window.toScreen = toScreen; window.toImage = toImage;

/** The frame as an axis-aligned screen rectangle - it is never tilted here. */
function frameRectOnScreen() {
  const f = state.frame, v = state.view, s = baseScale() * v.zoom;
  const w = f.w * s, h = f.h * s;
  return { x: cv.width / 2 + v.panX - w / 2, y: cv.height / 2 + v.panY - h / 2,
           w, h };
}
window.frameRectOnScreen = frameRectOnScreen;

const gridCv = document.getElementById('grid');
const gctx = gridCv.getContext('2d');

function resize() {
  const dpr = window.devicePixelRatio || 1;
  for (const c of [cv, gridCv]) {
    c.width = Math.round(c.clientWidth * dpr);
    c.height = Math.round(c.clientHeight * dpr);
  }
  render();
}
window.addEventListener('resize', resize);

function render() {
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#0d0f13';
  ctx.fillRect(0, 0, cv.width, cv.height);
  if (!state.img || !state.frame) return;

  const f = state.frame, v = state.view, s = baseScale() * v.zoom;
  ctx.save();
  ctx.translate(cv.width / 2 + v.panX, cv.height / 2 + v.panY);
  ctx.rotate(-f.angle * Math.PI / 180);
  ctx.scale(s, s);
  ctx.translate(-f.cx, -f.cy);
  ctx.drawImage(state.img, 0, 0);
  ctx.restore();

  const r = frameRectOnScreen();
  if (state.mode === 'crop') dimOutside(r);
  drawGrid(r);                       // always called; it clears when grid is off
  if (state.mode === 'crop') drawBrackets(r);
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
  // Edge midpoint ticks: the visible affordance for the grab band.
  ctx.lineWidth = 4;
  const T = Math.min(26, r.w / 5, r.h / 5);
  ctx.beginPath();
  ctx.moveTo(r.x + r.w / 2 - T / 2, r.y); ctx.lineTo(r.x + r.w / 2 + T / 2, r.y);
  ctx.moveTo(r.x + r.w / 2 - T / 2, r.y + r.h); ctx.lineTo(r.x + r.w / 2 + T / 2, r.y + r.h);
  ctx.moveTo(r.x, r.y + r.h / 2 - T / 2); ctx.lineTo(r.x, r.y + r.h / 2 + T / 2);
  ctx.moveTo(r.x + r.w, r.y + r.h / 2 - T / 2); ctx.lineTo(r.x + r.w, r.y + r.h / 2 + T / 2);
  ctx.stroke();
  ctx.restore();
}

function drawGrid(r) { /* Task 12 */ }
function undo() { /* Task 13 */ }
function resetFrame() { /* Task 13 */ }
function setFormat(f) { /* Task 13 */ }
function swapOrientation() { /* Task 13 */ }
function rotate90() { /* Task 13 */ }
function toggleGrid() { /* Task 12 */ }
function togglePeek() { /* Task 13 */ }
function nudge(d) { /* Task 11 */ }
function setMode(m) {
  state.mode = m;
  q('mode-crop').setAttribute('aria-pressed', String(m === 'crop'));
  q('mode-straighten').setAttribute('aria-pressed', String(m === 'straighten'));
  document.getElementById('panel-crop').hidden = m !== 'crop';
  document.getElementById('panel-straighten').hidden = m !== 'straighten';
  render();
}
window.setMode = setMode;
function accept() { /* Task 14 */ }
function reject() { /* Task 14 */ }
function finalize() { /* Task 14 */ }

async function load() {
  const r = await fetch('/api/queue');
  const data = await r.json();
  q('queue-count').textContent = `${data.pending.length} pending`;
  if (!data.pending.length) { q('page-title').textContent = 'queue empty'; return; }
  const p = data.pending[0];
  state.page = p;
  state.frame = p.seeded
    ? { cx: p.seeded.cx, cy: p.seeded.cy, w: p.seeded.w, h: p.seeded.h,
        angle: p.seeded.angle }
    : { cx: p.width / 2, cy: p.height / 2, w: p.width, h: p.height, angle: 0 };
  state.format = (p.seeded && p.seeded.format) || 'A4';
  state.orientation = (p.seeded && p.seeded.orientation) || 'portrait';
  state.rotation = 0;
  q('page-title').textContent = p.id;
  await new Promise(res => {
    const im = new Image();
    im.onload = () => { state.img = im; res(); };
    im.src = '/api/image/' + encodeURIComponent(p.id) + '?t=' + Date.now();
  });
  resize();
}
window.load = load;
load();
```

- [ ] **Step 7: Restart, run the test**

Run:
```bash
cd ~/projects/scanpipe && systemctl --user restart scanpipe && sleep 2
npx playwright test --project=mobile -g "axis-aligned"
```
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
cd ~/projects/scanpipe
git add ui.html ui.js app.py playwright.config.js tests/pipeline.spec.js
git commit -m "feat: mobile UI shell with frame-upright canvas transform"
```

---

### Task 9: Crop gestures — move, resize, grab band, inert outside

**Files:**
- Modify: `ui.js`
- Modify: `tests/pipeline.spec.js`

**Interfaces:**
- Consumes: `frameRectOnScreen`, `toImage`, `render` (Task 8)
- Produces: `hitTest([sx,sy]) -> {kind, ix}` where `kind` is
  `'corner' | 'edge' | 'move' | null` and `ix` is 0-3
  (corners TL TR BR BL; edges top right bottom left);
  `bandWidth() -> number`; `applyResize(kind, ix, imgPt)`

- [ ] **Step 1: Write the failing tests**

Append to `tests/pipeline.spec.js`:

```javascript
async function frameOf(page) { return page.evaluate(() => ({ ...window.state.frame })); }

test('a drag inside the frame core moves it without resizing', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.state.img);
  const before = await frameOf(page);
  const box = await page.getByTestId('canvas').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy); await page.mouse.down();
  await page.mouse.move(cx + 40, cy + 25, { steps: 8 }); await page.mouse.up();
  const after = await frameOf(page);
  expect(after.w).toBeCloseTo(before.w, 6);
  expect(after.h).toBeCloseTo(before.h, 6);
  expect(after.angle).toBeCloseTo(before.angle, 6);
  expect(Math.hypot(after.cx - before.cx, after.cy - before.cy)).toBeGreaterThan(1);
});

test('resizing from a corner holds the ratio and anchors the opposite corner',
  async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => window.state.img);
    const want = await page.evaluate(() => window.state.frame.h / window.state.frame.w);
    const anchorBefore = await page.evaluate(() => window.cornersOf(window.state.frame)[2]);
    const r = await page.evaluate(() => {
      const q = window.frameRectOnScreen();
      const b = document.getElementById('cv').getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      return { x: b.x + q.x / dpr, y: b.y + q.y / dpr };
    });
    await page.mouse.move(r.x, r.y); await page.mouse.down();
    await page.mouse.move(r.x + 60, r.y + 60, { steps: 10 }); await page.mouse.up();
    const f = await frameOf(page);
    expect(f.h / f.w).toBeCloseTo(want, 9);          // ratio held
    const anchorAfter = await page.evaluate(() => window.cornersOf(window.state.frame)[2]);
    expect(anchorAfter[0]).toBeCloseTo(anchorBefore[0], 3);   // BR pinned
    expect(anchorAfter[1]).toBeCloseTo(anchorBefore[1], 3);
    expect(f.w).toBeLessThan(await page.evaluate(() => window.state.seedW));
  });

test('a drag starting outside the frame changes nothing', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.state.img);
  const before = await frameOf(page);
  const box = await page.getByTestId('canvas').boundingBox();
  await page.mouse.move(box.x + 4, box.y + 4); await page.mouse.down();
  await page.mouse.move(box.x + 90, box.y + 90, { steps: 8 }); await page.mouse.up();
  expect(await frameOf(page)).toEqual(before);
});

test('the grab band never swallows the whole frame', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.state.img);
  const ok = await page.evaluate(() => {
    window.state.view.zoom = 1;
    window.state.frame.w = 40; window.state.frame.h = 56.6;
    window.render();
    const r = window.frameRectOnScreen();
    return window.bandWidth() * 2 < Math.min(r.w, r.h);
  });
  expect(ok).toBe(true);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd ~/projects/scanpipe && npx playwright test --project=mobile -g "frame core|anchors the opposite|outside the frame|grab band"`
Expected: all FAIL.

- [ ] **Step 3: Implement hit-testing and gestures in `ui.js`**

Add after `frameRectOnScreen`, and record `state.seedW` in `load()`
(`state.seedW = state.frame.w;` right after the frame is set):

```javascript
/** Grab band half-width, in canvas px.
 *
 * Capped at a quarter of the frame's smaller screen dimension: a fixed 24px
 * band would swallow the interior of a small or zoomed-out frame and leave
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
  const corner = Math.max(22 * dpr, b);   // 44px touch target, half-extent
  const pts = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]];
  for (let i = 0; i < 4; i++) {
    if (Math.abs(sx - pts[i][0]) <= corner && Math.abs(sy - pts[i][1]) <= corner)
      return { kind: 'corner', ix: i };     // corners win where they overlap an edge
  }
  const inX = sx >= r.x - b && sx <= r.x + r.w + b;
  const inY = sy >= r.y - b && sy <= r.y + r.h + b;
  if (inX && Math.abs(sy - r.y) <= b) return { kind: 'edge', ix: 0 };
  if (inY && Math.abs(sx - (r.x + r.w)) <= b) return { kind: 'edge', ix: 1 };
  if (inX && Math.abs(sy - (r.y + r.h)) <= b) return { kind: 'edge', ix: 2 };
  if (inY && Math.abs(sx - r.x) <= b) return { kind: 'edge', ix: 3 };
  if (sx > r.x && sx < r.x + r.w && sy > r.y && sy < r.y + r.h)
    return { kind: 'move', ix: -1 };
  return { kind: null, ix: -1 };            // outside: inert, so steadying the
                                            // phone cannot nudge a settled crop
}
window.hitTest = hitTest;

/** Frame-local coordinates: the frame is axis-aligned here, so this is just
 *  the inverse rotation about its centre. */
function toLocal([x, y]) {
  const f = state.frame, a = -f.angle * Math.PI / 180;
  const dx = x - f.cx, dy = y - f.cy;
  return [dx * Math.cos(a) - dy * Math.sin(a), dx * Math.sin(a) + dy * Math.cos(a)];
}
function fromLocal([lx, ly]) {
  const f = state.frame, a = f.angle * Math.PI / 180;
  return [f.cx + lx * Math.cos(a) - ly * Math.sin(a),
          f.cy + lx * Math.sin(a) + ly * Math.cos(a)];
}

/** Resize so the ratio holds and the opposite corner/edge stays put. */
function applyResize(kind, ix, imgPt) {
  const f = state.frame;
  const ratio = ratioOf(state.format, state.orientation);
  const [lx, ly] = toLocal(imgPt);
  const hw = f.w / 2, hh = f.h / 2;
  let nw, nh, ax, ay;                      // new size, and the anchor in local coords
  if (kind === 'corner') {
    const sx = (ix === 0 || ix === 3) ? -1 : 1;   // which side the dragged corner is
    const sy = (ix === 0 || ix === 1) ? -1 : 1;
    ax = -sx * hw; ay = -sy * hh;                 // the opposite corner, pinned
    // Drive the ratio from whichever axis the pointer moved more.
    const cw = Math.abs(lx - ax), ch = Math.abs(ly - ay);
    nw = Math.max(cw, ch / ratio); nh = nw * ratio;
  } else {
    if (ix === 0 || ix === 2) {                   // top or bottom edge
      const sy = ix === 0 ? -1 : 1;
      ay = -sy * hh; ax = 0;
      nh = Math.abs(ly - ay); nw = nh / ratio;
    } else {                                      // left or right edge
      const sx = ix === 3 ? -1 : 1;
      ax = -sx * hw; ay = 0;
      nw = Math.abs(lx - ax); nh = nw * ratio;
    }
  }
  if (Math.min(nw, nh) < MIN_SIDE) return;        // warp() dies on a degenerate crop
  // Recentre so the anchor point does not move.
  const dirX = ax <= 0 ? 1 : -1, dirY = ay <= 0 ? 1 : -1;
  const centreLocal = [ax + dirX * nw / 2, ay + dirY * nh / 2];
  const [ncx, ncy] = fromLocal(centreLocal);
  f.cx = ncx; f.cy = ncy; f.w = nw; f.h = nh;
}
window.applyResize = applyResize;

let grab = null, lastImg = null;
cv.addEventListener('pointerdown', e => {
  if (!state.frame || state.peek || e.isPrimary === false) return;
  const p = canvasPt(e);
  const hit = hitTest(p);
  if (!hit.kind) return;                          // outside: do nothing at all
  pushHistory();
  grab = hit; lastImg = toImage(p);
  cv.setPointerCapture(e.pointerId);
});
cv.addEventListener('pointermove', e => {
  if (!grab) return;
  const img = toImage(canvasPt(e));
  if (grab.kind === 'move') {
    state.frame.cx += img[0] - lastImg[0];
    state.frame.cy += img[1] - lastImg[1];
    lastImg = img;
  } else {
    applyResize(grab.kind, grab.ix, img);
  }
  render();
});
function endGrab() { if (grab) { grab = null; lastImg = null; render(); } }
cv.addEventListener('pointerup', endGrab);
cv.addEventListener('pointercancel', endGrab);

function canvasPt(e) {
  const b = cv.getBoundingClientRect();
  return [(e.clientX - b.left) * (cv.width / b.width),
          (e.clientY - b.top) * (cv.height / b.height)];
}
function pushHistory() {
  state.history.push({ frame: { ...state.frame }, format: state.format,
                       orientation: state.orientation, rotation: state.rotation });
  if (state.history.length > 50) state.history.shift();
}
window.pushHistory = pushHistory;
```

- [ ] **Step 4: Run the tests**

Run: `cd ~/projects/scanpipe && npx playwright test --project=mobile -g "frame core|anchors the opposite|outside the frame|grab band"`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/scanpipe
git add ui.js tests/pipeline.spec.js
git commit -m "feat: ratio-locked crop gestures with proximity grab band"
```

---

### Task 10: Two-finger pan and zoom

**Files:**
- Modify: `ui.js`
- Modify: `tests/pipeline.spec.js`

**Interfaces:**
- Produces: `setZoom(z, centreScreenPt)` clamped to `[1, 8]`; two active pointers
  drive pan+zoom and never touch `state.frame`

- [ ] **Step 1: Write the failing test**

```javascript
test('zoom is clamped and never alters the frame', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.state.img);
  const before = await page.evaluate(() => ({ ...window.state.frame }));
  const z = await page.evaluate(() => {
    window.setZoom(99, [100, 100]);
    const hi = window.state.view.zoom;
    window.setZoom(0.01, [100, 100]);
    return { hi, lo: window.state.view.zoom };
  });
  expect(z.hi).toBe(8);
  expect(z.lo).toBe(1);
  expect(await page.evaluate(() => ({ ...window.state.frame }))).toEqual(before);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/projects/scanpipe && npx playwright test --project=mobile -g "zoom is clamped"`
Expected: FAIL, `window.setZoom is not a function`.

- [ ] **Step 3: Implement**

Add to `ui.js`:

```javascript
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

// Two fingers pan and zoom the VIEW. They never touch the frame, so there is
// no modifier state and no chance of a pinch quietly resizing the crop.
const touches = new Map();
let pinch = null;
cv.addEventListener('pointerdown', e => {
  touches.set(e.pointerId, canvasPt(e));
  if (touches.size === 2) {
    grab = null;                       // a second finger cancels a frame drag
    const [a, b] = [...touches.values()];
    pinch = { dist: Math.hypot(a[0] - b[0], a[1] - b[1]),
              mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
              zoom: state.view.zoom };
  }
}, true);
cv.addEventListener('pointermove', e => {
  if (!touches.has(e.pointerId)) return;
  touches.set(e.pointerId, canvasPt(e));
  if (touches.size !== 2 || !pinch) return;
  const [a, b] = [...touches.values()];
  const dist = Math.hypot(a[0] - b[0], a[1] - b[1]);
  const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  state.view.panX += mid[0] - pinch.mid[0];
  state.view.panY += mid[1] - pinch.mid[1];
  pinch.mid = mid;
  setZoom(pinch.zoom * (dist / pinch.dist), mid);
}, true);
for (const ev of ['pointerup', 'pointercancel'])
  cv.addEventListener(ev, e => { touches.delete(e.pointerId);
                                 if (touches.size < 2) pinch = null; }, true);
```

- [ ] **Step 4: Run the test**

Run: `cd ~/projects/scanpipe && npx playwright test --project=mobile -g "zoom is clamped"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/scanpipe
git add ui.js tests/pipeline.spec.js
git commit -m "feat: two-finger pan and zoom, clamped, frame untouched"
```

---

### Task 11: Straighten mode and the dial

**Files:**
- Modify: `ui.js`
- Modify: `tests/pipeline.spec.js`

**Interfaces:**
- Consumes: `state.frame`, `pushHistory`, `render` (Tasks 8-9)
- Produces: `state.detectedAngle` (set in `load()`), `dialValue() -> number`,
  `setDial(deg)` clamped to `[-15, 15]`, `nudge(deg)`, `drawDial()`

- [ ] **Step 1: Write the failing tests**

```javascript
test('the dial reads zero at the detected angle and applies a delta', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.state.img);
  const det = await page.evaluate(() => window.state.detectedAngle);
  expect(await page.evaluate(() => window.dialValue())).toBeCloseTo(0, 6);
  await page.evaluate(() => window.setDial(2.5));
  expect(await page.evaluate(() => window.state.frame.angle)).toBeCloseTo(det + 2.5, 6);
  expect(await page.getByTestId('angle-readout').textContent()).toContain('2.5');
});

test('the dial holds the ratio and is one undo step', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.state.img);
  const want = await page.evaluate(() => window.state.frame.h / window.state.frame.w);
  const before = await page.evaluate(() => ({ ...window.state.frame }));
  await page.getByTestId('mode-straighten').click();
  const box = await page.getByTestId('dial').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 70, box.y + box.height / 2, { steps: 12 });
  await page.mouse.up();
  const f = await page.evaluate(() => ({ ...window.state.frame }));
  expect(f.h / f.w).toBeCloseTo(want, 9);
  expect(f.angle).not.toBeCloseTo(before.angle, 3);
  await page.getByTestId('btn-undo').click();
  expect(await page.evaluate(() => window.state.frame.angle)).toBeCloseTo(before.angle, 6);
});

test('nudge buttons step the dial by a tenth of a degree', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.state.img);
  await page.getByTestId('mode-straighten').click();
  await page.getByTestId('skew-plus-01').click();
  expect(await page.evaluate(() => window.dialValue())).toBeCloseTo(0.1, 6);
  await page.getByTestId('skew-minus-01').click();
  await page.getByTestId('skew-minus-01').click();
  expect(await page.evaluate(() => window.dialValue())).toBeCloseTo(-0.1, 6);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd ~/projects/scanpipe && npx playwright test --project=mobile -g "dial|nudge buttons"`
Expected: all FAIL.

- [ ] **Step 3: Implement**

In `load()`, after the frame is set, add `state.detectedAngle = state.frame.angle;`.
Then replace the `nudge` stub and add:

```javascript
const DIAL_RANGE = 15;    // degrees either side

/** The dial reads 0 at the DETECTED angle, not at 0 in image space, so it shows
 *  the manual correction on top of detection - matching the readout the old UI
 *  had. frame.angle = detectedAngle + dial. */
function dialValue() { return state.frame.angle - state.detectedAngle; }
window.dialValue = dialValue;

function setDial(deg) {
  const d = Math.max(-DIAL_RANGE, Math.min(DIAL_RANGE, deg));
  state.frame.angle = state.detectedAngle + d;
  q('angle-readout').textContent = `${d >= 0 ? '+' : ''}${d.toFixed(2)}°`;
  drawDial();
  render();
}
window.setDial = setDial;

function nudge(d) { pushHistory(); setDial(dialValue() + d); }
window.nudge = nudge;

const dial = document.getElementById('dial');
const dctx = dial.getContext('2d');

function drawDial() {
  const dpr = window.devicePixelRatio || 1;
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
  setDial(dialGrab.start + (dialGrab.x - e.clientX) / pxPerDeg * -1);
});
for (const ev of ['pointerup', 'pointercancel'])
  dial.addEventListener(ev, () => { dialGrab = null; });
```

Also add `drawDial();` to the end of `setMode()` when `m === 'straighten'`.

- [ ] **Step 4: Run the tests**

Run: `cd ~/projects/scanpipe && npx playwright test --project=mobile -g "dial|nudge buttons"`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/scanpipe
git add ui.js tests/pipeline.spec.js
git commit -m "feat: straighten dial, zeroed at the detected angle"
```

---

### Task 12: The blue/red raster inside the frame

**Files:**
- Modify: `ui.js`
- Modify: `tests/pipeline.spec.js`

**Interfaces:**
- Produces: `drawGrid(rect)` painting onto the main canvas; `toggleGrid()`
  flipping `state.grid` and the `grid-toggle` button's `aria-pressed`

- [ ] **Step 1: Write the failing test**

```javascript
/** Count PAINTED pixels on the raster overlay. The overlay starts fully
 *  transparent, so "grid off" really is exactly zero - an assertion that would
 *  be impossible if the grid were drawn over the scan itself. */
async function paintedIn(page, channel) {
  return page.evaluate((ch) => {
    const g = document.getElementById('grid');
    const d = g.getContext('2d').getImageData(0, 0, g.width, g.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;                      // untouched
      if (ch === 'any') n++;
      else if (ch === 'blue' && d[i + 2] > d[i] + 40) n++;
      else if (ch === 'red' && d[i] > d[i + 2] + 60) n++;
    }
    return n;
  }, channel);
}

test('the raster paints blue gridlines and a red centre cross, and toggles off',
  async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => window.state.img);
    expect(await paintedIn(page, 'blue')).toBeGreaterThan(100);
    expect(await paintedIn(page, 'red')).toBeGreaterThan(50);
    await page.getByTestId('grid-toggle').click();
    expect(await paintedIn(page, 'any')).toBe(0);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/projects/scanpipe && npx playwright test --project=mobile -g "raster paints"`
Expected: FAIL — `drawGrid` is a stub, so the blue count is 0.

- [ ] **Step 3: Implement**

Replace the `drawGrid` and `toggleGrid` stubs in `ui.js`:

```javascript
/** The reference raster, clipped to the frame and therefore aligned to the
 *  OUTPUT. Judging "is this level?" against a grid beats judging it by eye,
 *  and because the frame is drawn axis-aligned the grid is too. */
function drawGrid(r) {
  const dpr = window.devicePixelRatio || 1;
  gctx.setTransform(1, 0, 0, 1, 0, 0);
  gctx.clearRect(0, 0, gridCv.width, gridCv.height);
  if (!state.grid) return;                    // cleared: painted pixels are 0
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

function toggleGrid() {
  state.grid = !state.grid;
  q('grid-toggle').setAttribute('aria-pressed', String(state.grid));
  render();
}
window.toggleGrid = toggleGrid;
```

- [ ] **Step 4: Run the test**

Run: `cd ~/projects/scanpipe && npx playwright test --project=mobile -g "raster paints"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/scanpipe
git add ui.js tests/pipeline.spec.js
git commit -m "feat: blue grid and red centre cross clipped to the frame"
```

---

### Task 13: Format, orientation, rotation, undo, reset, peek

**Files:**
- Modify: `ui.js`
- Modify: `tests/pipeline.spec.js`

**Interfaces:**
- Produces: `setFormat(fmt)`, `swapOrientation()`, `rotate90()`, `undo()`,
  `resetFrame()`, `togglePeek()`, `syncChips()`

- [ ] **Step 1: Write the failing tests**

```javascript
test('changing format re-locks the ratio about the same centre', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.state.img);
  const before = await page.evaluate(() => ({ ...window.state.frame }));
  await page.getByTestId('fmt-A6').click();
  const f = await page.evaluate(() => ({ ...window.state.frame }));
  const want = await page.evaluate(() =>
    window.state.orientation === 'landscape' ? 105 / 148 : 148 / 105);
  expect(f.h / f.w).toBeCloseTo(want, 9);
  expect(f.cx).toBeCloseTo(before.cx, 6);
  expect(f.cy).toBeCloseTo(before.cy, 6);
  await expect(page.getByTestId('fmt-A6')).toHaveAttribute('aria-pressed', 'true');
});

test('swapping orientation transposes the frame', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.state.img);
  const before = await page.evaluate(() => ({ ...window.state.frame }));
  await page.getByTestId('btn-swap').click();
  const f = await page.evaluate(() => ({ ...window.state.frame }));
  expect(f.w).toBeCloseTo(before.h, 6);
  expect(f.h).toBeCloseTo(before.w, 6);
});

test('rotate cycles output rotation without moving the frame', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.state.img);
  const before = await page.evaluate(() => ({ ...window.state.frame }));
  await page.getByTestId('btn-rotate').click();
  expect(await page.evaluate(() => window.state.rotation)).toBe(90);
  expect(await page.evaluate(() => ({ ...window.state.frame }))).toEqual(before);
});

test('reset returns to the seeded frame after several edits', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.state.img);
  const seeded = await page.evaluate(() => ({ ...window.state.page.seeded }));
  await page.getByTestId('fmt-A6').click();
  await page.evaluate(() => window.setDial(3));
  await page.getByTestId('btn-reset').click();
  const f = await page.evaluate(() => ({ ...window.state.frame }));
  expect(f.cx).toBeCloseTo(seeded.cx, 4);
  expect(f.w).toBeCloseTo(seeded.w, 4);
  expect(f.angle).toBeCloseTo(seeded.angle, 6);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd ~/projects/scanpipe && npx playwright test --project=mobile -g "changing format|swapping orientation|rotate cycles|reset returns"`
Expected: all FAIL.

- [ ] **Step 3: Implement — replace the Task 8 stubs**

```javascript
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
  const f = state.frame; const t = f.w; f.w = f.h; f.h = t;
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
  pushHistory();
  state.frame = { cx: s.cx, cy: s.cy, w: s.w, h: s.h, angle: s.angle };
  state.format = s.format; state.orientation = s.orientation; state.rotation = 0;
  syncChips();
  if (state.mode === 'straighten') setDial(0); else render();
}

/** Peek: the warped result full-screen, from the same endpoint Accept uses. */
async function togglePeek() {
  state.peek = !state.peek;
  if (!state.peek) { render(); return; }
  const r = await fetch('/api/preview/' + encodeURIComponent(state.page.id), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ corners: cornersOf(state.frame),
                           rotation: state.rotation, target: state.format }) });
  if (!r.ok) { say('invalid crop', 'var(--err)'); state.peek = false; return; }
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
```

Add `syncChips();` to the end of `load()`.

- [ ] **Step 4: Run the tests**

Run: `cd ~/projects/scanpipe && npx playwright test --project=mobile -g "changing format|swapping orientation|rotate cycles|reset returns"`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/scanpipe
git add ui.js tests/pipeline.spec.js
git commit -m "feat: format, orientation, rotation, undo, reset and peek"
```

---

### Task 14: Accept, reject, finalize, and the warnings

**Files:**
- Modify: `ui.js`
- Modify: `tests/pipeline.spec.js` (this is where the file becomes its final form —
  remove any leftover desktop-era tests)

**Interfaces:**
- Consumes: everything above
- Produces: `accept()` POSTing `{corners, frame, rotation, target}`;
  `reject()`; `finalize()`; `showFlags(outside)`

- [ ] **Step 1: Write the failing tests**

```javascript
test('A4 accepts at exactly the ISO size however the frame was dragged',
  async ({ page, request }) => {
    await page.goto('/');
    await page.waitForFunction(() => window.state.img);
    const id = await page.evaluate(() => window.state.page.id);
    await page.evaluate(() => {
      window.setFormat('A4');
      window.state.frame.w *= 0.72;               // a big, deliberate distortion
      window.state.frame.h = window.state.frame.w * (297 / 210);
      window.render();
    });
    const out = await page.evaluate(async () => {
      const r = await fetch('/api/accept/' + encodeURIComponent(window.state.page.id), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ corners: window.cornersOf(window.state.frame),
                               frame: { ...window.state.frame, format: 'A4',
                                        orientation: 'portrait' },
                               rotation: 0, target: 'A4' }) });
      return r.json();
    });
    // Pinned to the true ISO size regardless of how far the frame was dragged.
    expect(out.width).toBe(1654);
    expect(out.height).toBe(2339);
    const rec = JSON.parse(require('fs').readFileSync(
      require('path').join(__dirname, '..', 'groundtruth', id + '.json'), 'utf8'));
    expect(rec.accepted.format).toBe('A4');
    expect(rec.error.unchanged).toBe(false);      // it was deliberately distorted
    const { pending } = await (await request.get('/api/queue')).json();
    expect(pending.find(p => p.id === id)).toBeUndefined();
  });

test('A6 accepts at exactly 1165x827 landscape', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.state.img);
  const out = await page.evaluate(async () => {
    window.setFormat('A6');
    if (window.state.orientation !== 'landscape') window.swapOrientation();
    const r = await fetch('/api/accept/' + encodeURIComponent(window.state.page.id), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ corners: window.cornersOf(window.state.frame),
                             frame: { ...window.state.frame,
                                      format: 'A6', orientation: 'landscape' },
                             rotation: 0, target: 'A6' }) });
    return r.json();
  });
  expect(out.width).toBe(1165);
  expect(out.height).toBe(827);
});

test('pushing the frame past the scan edge warns but still accepts', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.state.img);
  await page.evaluate(() => { window.state.frame.cy -= window.state.frame.h * 0.4;
                              window.render(); });
  await expect(page.getByTestId('outside-flag')).toBeVisible();
  await page.getByTestId('btn-accept').click();
  await expect(page.getByTestId('status')).toContainText('accepted');
});

test('finalize delivers a PDF to the paperless mock', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.state.img);
  await page.getByTestId('btn-accept').click();
  await expect(page.getByTestId('status')).toContainText('accepted');
  await page.getByTestId('btn-finalize').click();
  await expect(page.getByTestId('status')).toContainText('paperless');
  const { execSync } = require('child_process');
  const fs = require('fs'), path = require('path');
  const consume = path.join(__dirname, '..', 'mock-paperless', 'consume');
  const pdfs = fs.readdirSync(consume).filter(f => f.endsWith('.pdf'));
  expect(pdfs.length).toBeGreaterThan(0);
  const n = execSync(`qpdf --show-npages ${path.join(consume, pdfs[pdfs.length - 1])}`)
    .toString().trim();
  expect(Number(n)).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd ~/projects/scanpipe && npx playwright test --project=mobile -g "ISO size however|1165x827|past the scan edge|finalize delivers"`
Expected: all FAIL (`accept` is a stub).

- [ ] **Step 3: Implement**

Replace the `accept`/`reject`/`finalize` stubs:

```javascript
/** How much of the frame falls outside the scan - drives the warning. */
function outsideFraction() {
  const p = cornersOf(state.frame), W = state.page.width, H = state.page.height;
  return p.filter(([x, y]) => x < 0 || y < 0 || x > W - 1 || y > H - 1).length / 4;
}
function showFlags() {
  q('outside-flag').hidden = outsideFraction() === 0;
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
      frame: { ...state.frame, format: state.format,
               orientation: state.orientation },
      rotation: state.rotation, target: state.format }) });
  if (!r.ok) { say('accept failed', 'var(--err)'); return; }
  const out = await r.json();
  say(`accepted ${out.width}×${out.height}`, 'var(--accent)');
  state.history = [];
  await load();
}

async function reject() {
  if (!state.page) return;
  await fetch('/api/reject/' + encodeURIComponent(state.page.id), { method: 'POST' });
  say('rejected');
  state.history = [];
  await load();
}

async function finalize() {
  const r = await fetch('/api/finalize', { method: 'POST' });
  if (!r.ok) { say('nothing to send', 'var(--err)'); return; }
  const out = await r.json();
  say(`sent to paperless: ${out.pages || ''} page(s)`, 'var(--accent)');
  await load();
}
window.accept = accept; window.reject = reject; window.finalize = finalize;
```

Add `showFlags();` at the end of `render()` (guarded by `if (state.page)`).

Endpoint paths are confirmed against `app.py`: `POST /api/reject/{page_id}` and
`POST /api/finalize`, the latter returning `{ok, pdf, pages}`.

- [ ] **Step 4: Run the tests**

Run: `cd ~/projects/scanpipe && npx playwright test --project=mobile -g "ISO size however|1165x827|past the scan edge|finalize delivers"`
Expected: 4 passed.

- [ ] **Step 5: Run the whole suite on both projects**

Run: `cd ~/projects/scanpipe && ./.venv/bin/python -m pytest tests/ -v && npx playwright test`
Expected: all green. Delete any surviving desktop-era test that references
`skew-slider`, `preview`, or corner-index dragging — those controls no longer exist.

- [ ] **Step 6: Commit**

```bash
cd ~/projects/scanpipe
git add ui.js tests/pipeline.spec.js
git commit -m "feat: accept/reject/finalize with overhang and hint warnings"
```

---

### Task 15: Mutation-test the guarantees, then document

A passing test proves nothing until it has been seen to fail. The ratio lock and
the resize anchor are the two properties that would otherwise pass against a
broken implementation, so both get deliberately broken and confirmed to fail.

**Files:**
- Modify: `ui.js` (temporarily, then restore)
- Modify: `README.md`

- [ ] **Step 1: Break the ratio lock and confirm the test catches it**

In `applyResize`, change `nh = nw * ratio;` to `nh = nw * ratio * 1.05;`. Run:

```bash
cd ~/projects/scanpipe && npx playwright test --project=mobile -g "anchors the opposite corner"
```
Expected: FAIL at the `expect(f.h / f.w).toBeCloseTo(want, 9)` assertion. Record
the failure message. **Restore the line.**

- [ ] **Step 2: Break the anchor and confirm the test catches it**

In `applyResize`, change the recentre line to `const centreLocal = [ax, ay];`. Run
the same command.
Expected: FAIL at the `anchorAfter[0]` assertion, NOT at the ratio assertion —
this confirms the two assertions test different things. **Restore the line.**

- [ ] **Step 3: Confirm everything is green again**

Run: `cd ~/projects/scanpipe && ./.venv/bin/python -m pytest tests/ -v && npx playwright test`
Expected: all green, both projects.

- [ ] **Step 4: Update `README.md`**

Replace the "Review UI", "Tests" and "Ground truth" sections to describe:
the ratio-locked frame and why perspective correction is absent; the two modes;
the gesture map including the grab band and two-finger zoom; that the frame may
sit outside the scan by design and why clamping is wrong; the schema-2 record and
per-axis error; that `evaluate.py` refuses records of an unknown schema; and the
new test commands (`./.venv/bin/python -m pytest tests/` and `npx playwright test`).
Keep the existing "Scan oversize", "How the sheet is found", "Network access" and
"Transfer" sections as they are — none of them changed.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/scanpipe
git add README.md
git commit -m "docs: describe the ratio-locked mobile review UI and schema 2 records"
```

---

## Verification checklist

Before declaring this done, run and paste the output of:

```bash
cd ~/projects/scanpipe
./.venv/bin/python -m pytest tests/ -v
npx playwright test
./.venv/bin/python evaluate.py
git log --oneline
git status --short           # must NOT list secrets.env
```

Then review one real scan end-to-end on the phone at
`http://192.168.1.10:8765` and confirm: the frame is grabbable, the dial is
usable with a thumb, and the accepted PDF looks right.
