# scanpipe — scan → deskew/crop → review → paperless (mocked)

Running now as a user service on this machine, reachable from the LAN.

    open http://192.168.1.10:8765     (log in: user `scan`, password in secrets.env)

Credentials live in `secrets.env` (mode 0600) and are loaded by the systemd unit,
so they never appear in `ps` or in the unit file.

    systemctl --user status scanpipe      # state
    systemctl --user restart scanpipe     # after code changes
    journalctl --user -u scanpipe -f      # logs

## How it flows

    Pi (adf-scan, FULL size)
      └─ push_scans.py  ──POST /api/ingest, sha256-acked──> spool/
           └─ auto-detect the sheet, then seed a ratio-locked frame
                └─ REVIEW on the phone   ← crop, straighten, Accept / Reject
                     └─ "Send"
                          └─ out/document-*.pdf  and  mock-paperless/consume/*.pdf
                               └─ mock-paperless/deliveries.json  (proof of delivery)

`mock-paperless/` is a STAND-IN for paperless-ngx. Swapping it for the real thing
means pointing `CONSUME` in app.py at paperless' consume directory (or POSTing to
its REST API); nothing else changes.

## Scan oversize — this matters

Scan with `SIZE=FULL`, not `SIZE=A4`. Cropping to exactly A4 leaves no margin, so
there is nothing to detect and any feed skew clips real content. FULL gives the
detector the surrounding backing to find the sheet against.

    ssh rpi@192.168.1.20 'SIZE=FULL RES=200 adf-scan batch'
    ./.venv/bin/python fetch_scans.py

## How the sheet is found

A FULL-size scan has three regions, not two:

    grey ADF backing beside the sheet   mean ~125, std ~1     (optically scanned)
    the paper                           mean ~240, std 30-60
    padding past the page end           exactly 255, std 0    (synthesised)

Brightness alone cannot tell paper from padding (both bright); variance alone
cannot tell paper from backing (both optically scanned). `detect.py` combines
them, then takes the largest contour's minimum-area rectangle as the quad.

## Two angles, and which one wins

`detect.py` measures the **sheet** - the angle of the paper, from `minAreaRect`
over the paper mask. `deskew.py` measures the **content** - the angle of the
printed text, from the baselines of whatever is on the page. These are different
quantities and they do disagree: `letter-01`'s text sits about **1 degree off
its own sheet edges**, which was confirmed independently with `cv2.HoughLinesP`
(+0.90 to +1.05) before it was believed.

The content angle wins, because a level page is what the reader wants.

The text angle is measured as a RESIDUAL on the already-cropped page and added
to the sheet angle. Run on a FULL scan it would not work at all: the grey ADF
backing binarises as one enormous dark region whose boundary is a near-perfect
horizontal line, and that single edge outvotes every line of text. For the same
reason the measurement ignores a 1% margin on all four sides - the sheet border
sitting on the crop boundary forms a broad ridge across many angles in the
accumulator and scatters the result.

When the content angle cannot be measured confidently - a blank page, a
photograph, a sparse handwritten note - the sheet angle stands. The real A6 in
`spool/` is exactly that case: 11 agreeing lines out of 28 candidates, so it
keeps its -7.679 degree sheet angle.

**Only the angle comes from the text.** Centre and size stay with the sheet, so
a page printed askew rotates the crop but cannot walk it off the paper; if it
reaches past the scan the existing overhang warning shows it.

The algorithm is NAPS2's (`NAPS2.Sdk/Images/Deskewer.cs`), reimplemented from a
description of how it works rather than translated - NAPS2 is GPL-2.0-or-later
and this project is not, so none of its code is carried over. Bottom edges only
(a dark pixel directly above a light one), a Hough accumulator over -20 to +20
degrees in 201 steps, keep the top 100 lines, drop any scoring under half the
10th best, cluster the survivors within 2.01 degrees, and report the cluster
mean - or no confidence at all when the winning cluster holds under half the
candidates.

## Multi-page documents

**One ADF run is one document.** `adf-scan` writes a run as `BASE-01.png`,
`BASE-02.png`, ... so the basename is the batch id; the Pi sends it with each
scan as a `batch` form field, and the backend keeps one staged document per
batch. Two letters scanned in the same sitting therefore cannot merge into one
PDF, which they previously did unless you remembered to Send in between.

The Send button carries a badge with the number of pages staged for the current
batch. Accepting the last page of a batch moves the queue on to the next one,
whose tray is empty - Send still offers the batch you just finished, because
that is exactly when you want it.

`finalize` lays out **each page at its own size**, from its pixel dimensions at
200 dpi. It used to force an A4 layout on every page, so a 148x105mm landscape
A6 came out as a 210x297mm portrait A4 - throwing away the true size that the
ratio-locked frame exists to produce. Pages are sorted by page number rather
than accept order, since stepping back through the queue makes accept order
unreliable.

The Pi's panel used to pass a constant basename (`a4`, `a6`), so every A4 scan
was `a4-01.png`: consecutive batches were indistinguishable and the second
collided with the first. `scanui.py` now passes `a4-<timestamp>`.

## Known limits

- A4 has almost no horizontal margin: the scanner's usable width is ~211mm versus
  A4's 210mm. Deskewing a full-width A4 therefore has nowhere to rotate into and
  will clip edges. A6 and smaller have plenty of margin.
- The frame may extend past the scan and is deliberately NOT clamped. See
  "Review UI" below - clamping cost 3 degrees of residual skew on a real A6.
- The review UI trusts whoever can reach it, behind HTTP basic auth on the LAN.
- Reordering pages within a document is not possible; they come out in scan
  order. Removing an accepted page from a staged document is not possible
  either - reject it before accepting.

## Tests

    ./.venv/bin/python -m pytest tests/     # 35 geometry / deskew / evaluation units
    npx playwright test                     # 92 e2e (46 mobile, 46 desktop)

The Python suite covers `frame.py` and `evaluate.py` without a browser or a
running server: the ratio table, the seed fit against the real 1663x2328 A4 and
the skewed A6, the frame/corners round-trip, and the error decomposition.

The Playwright suite runs against the live service in two viewports, `Pixel 7`
and 1280x1000. It supplies its own scans: `make_fixtures.py` generates
synthetic FULL-size scans with the three regions detect.py keys off, and the
global setup regenerates them if `spool/` is empty. The suite used to run
against real documents, which are not in the repository and were consumed as
the tests ran - so it only worked on one machine, and only until the queue
emptied. The fixtures cover a plain A4, an A4 whose print is 1.2 degrees off
its sheet, an A4 fed at -2.6 degrees, and a blank A6 where the content angle
cannot be measured at all. It asserts on outcomes - accepted pixel dimensions, painted
pixels, files on disk, `qpdf --show-npages` - not on whether something rendered.

Two properties would pass against a broken implementation, so both were
mutation-tested: breaking the ratio lock (`nh = nw * ratio * 1.05`) fails at the
ratio assertion, and breaking the resize anchor fails at the anchor assertion
and NOT at the ratio one, confirming the two assert different things.

`workers` is pinned to 1 and the queue is reset before every test. The tests
share one single-process server and one `state.json`, so parallel workers race
each other - the same constraint that forbids `uvicorn --workers N`.

## Layout

    detect.py         find the sheet (corners, skew, coverage)
    deskew.py         measure the angle of the printed CONTENT
    frame.py          the ratio-locked crop: seed fit, frame <-> corners, error
    warp.py           deskew/crop at a true ISO size
    app.py            queue, accept/reject, PDF assembly, mock delivery
    ui.html           review UI markup and styles
    ui.js             frame geometry, gestures, canvas rendering
    evaluate.py       how far the detector is off, per axis
    fetch_scans.py    pull scans from the Pi, checksum-verified
    make_fixtures.py  synthetic scans for the test suite
    build-icons.js    vendored Lucide sprite -> icons.svg

## Post-implementation review (self-audit)

Checked, with results:

- **Path traversal via `page_id`** — SAFE. `/api/image/{page_id}` looks the id up
  in state and only serves paths this app itself ingested. Verified: `../../etc/passwd`,
  URL-encoded variants and absolute paths all return 404 with nothing leaked.
- **Corner ordering** — was a latent bug, now fixed. The usual sum/diff heuristic
  silently yields a self-intersecting (bow-tie) quad past ~90 degrees of rotation,
  which would warp to a mangled page. Unreachable today (minAreaRect normalises to
  +/-45, and dragging preserves indices) but replaced with angle-around-centroid
  ordering, verified correct at 0-315 degrees.
- **Output filename collision** — was real, now fixed. `doc.png` and `doc.jpg`
  both mapped to `doc-page.png`. Keyed on the full filename now.
- **Concurrency** — `state.json` is read-modify-written under an in-process lock,
  so the server MUST stay single-process. Running `uvicorn --workers N` could
  interleave two accepts and lose one. The systemd unit omits `--workers`; both
  the unit and app.py say why.

Two of these are now moot: corner ordering and the crossed-quad risk both
disappeared with the ratio-locked frame, which cannot express a bow-tie. The
concurrency note still stands and is why `workers` is pinned to 1 in the
Playwright config as well as in the systemd unit.

Superseded: an earlier version of this file said the UI has no auth and binds
127.0.0.1 only. It binds 0.0.0.0 behind HTTP basic auth, LAN-scoped by an
nftables rule - see "Network access".

## Network access

The service binds 0.0.0.0:8765 and requires HTTP basic auth.

This host is internet-facing - YunoHost, with mail/web on 0.0.0.0 and a
dynamic-DNS name - and the nftables firewall is `policy drop` with only
22, 25, 80, 443, 587, 993 open. Port 8765 is therefore opened by a LAN-ONLY
rule, so the UI stays unreachable from the internet even if the router forwards
the port or UPnP opens it:

    sudo install -m644 nftables-scanpipe.conf /etc/nftables.d/scanpipe.conf
    sudo systemctl reload nftables

To close it again, delete that file and reload nftables.

Deliberately NOT used: `yunohost firewall allow TCP 8765`. That opens the port to
every source address, leaving only the router between these documents and the
internet. The LAN-scoped rule is the safer equivalent.

## Review UI

Mobile first - most review happens on a phone. One full-bleed canvas, controls
docked at the bottom within thumb reach; above 900px the bottom panel becomes a
right-hand rail and the canvas takes the rest.

**The crop is a ratio-locked rectangle**, not four free corners. Pages arrive
from a sheet-fed ADF, not a handheld camera, so there is no perspective
distortion to correct - a page is a rectangle of known ISO ratio, rotated by the
feed skew. Free corner dragging only offered ways to produce a crop no real
sheet could have. Internally the crop is `{cx, cy, w, h, angle}` with `h/w`
pinned by the format, so a sheared or bow-tie quad is not expressible. Corners
are derived when the server is called, which is why `warp.py` and the
accept/preview API needed no changes.

**The frame stays upright; the scan tilts under it.** The canvas rotates the
image by `-angle` and draws the frame axis-aligned. Level is then judged against
the screen edges and the raster rather than against a tilted box, which is what
makes the straighten dial legible - and it collapses hit-testing to
point-in-rectangle.

Two modes:

- **Crop** - white corner brackets and edge midpoint ticks, everything outside
  the frame dimmed.
- **Straighten** - a tick dial with the +/-0.1 degree steps built into the same
  row. It reads **0 at the detected angle**, so it shows the manual correction
  on top of detection, and snaps to 0.1 degrees. A whole drag is one undo step.

The crop frame is drawn in BOTH modes and is draggable in both. It used to be
hidden while straightening, which meant dragging something invisible - that read
as the gesture being broken rather than merely unlit.

**Page size and rotation** live behind their own button rather than a permanent
row: they are set at most once per page, and the scan should have the screen.

Gestures:

- One finger on a **corner** resizes, holding the ratio and anchoring the
  opposite corner. Corners only: with the ratio locked, dragging a side cannot
  mean what it looks like it means - the other dimension has to follow - so a
  side handle reads as a promise the geometry cannot keep. The grab zone is
  `min(24px, a quarter of the frame's smaller screen dimension)`, so a small
  frame still keeps a movable core.
- One finger in the **interior** moves the whole frame, after ~10px of travel so
  a tap or a little jitter cannot shift a settled crop. Movement is damped by
  zoom: about 30% of the finger's travel at 1x, easing to 1:1 by 3x, because at
  1x one finger pixel is several scan pixels.

  All drag maths is measured against the frame as it was when the gesture
  *began*, never the live frame. `toImageWith()`'s origin is the frame centre,
  so a handler that moves the centre and then measures the next delta against
  the moved origin re-counts its own movement: a 100px drag moved the frame 8.5x
  too far, and worse the more pointer events arrived.
- One finger **outside the frame does nothing**, so steadying the phone at the
  edge of the screen cannot nudge a crop that was already settled.
- **Two fingers** pan and zoom the view (1x to 8x) and never touch the frame.

**Gridlines** - a blue grid plus a stronger red centre cross, clipped to the
frame and therefore aligned to the output. On its own canvas layer, toggleable.

The title bar shows the **queue position** - `1/6`, counting up as pages are
accepted, not just what is left. On a phone it collapses to that badge between
the two button clusters and expands onto its own row when tapped; a filename has
nowhere near enough width to be legible inline on a 412px screen.

The top bar holds only undo, the queue navigator, and the two decisions -
reject and accept. That is what keeps it on one row: with peek still up there
it fitted at exactly 412px and wrapped at 390, 375 and 360, pushing accept and
reject onto a second line on most phones.

Everything else lives in **one** permanently visible bottom bar - modes (crop,
straighten), a separator, then actions (page setup, gridlines, peek, reset,
send). Its buttons are 38px wide rather than 44: seven of them plus a separator
do not fit a 360px screen otherwise, and two stacked bars took too much of the
page. The full 44px height is kept, so only the horizontal target shrinks, and
the two decisions that matter stay 44px in the top bar.

**Controls float** over a full-bleed canvas as translucent pills rather than
sitting in a docked panel, so the scan gets the whole screen. Buttons are
icon-only, from a vendored Lucide sprite (`build-icons.js` -> `icons.svg`); no
CDN, so the UI works without internet and a page showing scanned documents makes
no third-party requests. The A4/A5/A6 chips stay textual - there is no icon for
"A4".

**Navigation** - the badge in the top bar reads the position in the queue,
`1/4`, with a chevron either side to step through it. Bounded rather than
wrapping: on a phone a wrap looks identical to not having moved. Edits are kept
per page, so stepping away and back does not discard them - navigation you
cannot trust is worse than none.

**Peek** flips to the warped result full-screen, rendered by the same endpoint
Accept uses.

**Format** picks A4/A5/A6 and the output is rendered at that exact ISO size.
Ratios come from `PAPER_MM`, not from sqrt(2): the ISO sizes are whole
millimetres, so A4 (1.414286), A5 (1.418919) and A6 (1.409524) genuinely differ.
**Swap orientation** transposes the frame; **Rotate 90** is a different control,
cycling the output rotation applied after warp for a sheet fed upside down. The
whole view turns with it, so the rotation is visible rather than showing up only
in the finished PDF.

**The frame may lie outside the scan, and is never clamped.** A sheet fed flush
to the leading edge genuinely has a corner beyond the captured area; clamping it
deformed the quad and left 3 degrees of residual skew on a real A6. That region
is hatched on the canvas and filled white in the output. The warning only fires
past 12px of overhang: the seeded A4 for a full-width scan lands about 3px proud
of the top edge, and flagging that made the warning noise on an ordinary page.

## Ground truth: measuring the detector

Every accept writes `groundtruth/<page>.json`, schema 2:

    detected   the detector's raw quad, frozen at ingest
    seeded     the ratio-locked frame the operator was actually SHOWN
    accepted   the frame they approved
    error      centre / scale / angle / format / orientation, decomposed

Three geometries, not two. `seeded` is stored rather than recomputed so a later
change to the seed fit cannot silently make old records uncomparable. The error
compares **seeded to accepted**, because that is the frame that was on screen.

The decomposition is the point. A ratio-locked frame has five degrees of freedom
and each indicts a different part of the detector:

    centre        the paper mask's centroid - backing/padding thresholds
    scale         mask erosion or dilation - the morphology kernel sizes
    angle         minAreaRect skew
    format        classify() and its tolerance

The old single `corner_shift_px` blended all of these into one number that said
a scan was wrong but not how, so it is gone.

The seed fit runs on the SERVER, at ingest, and is frozen. If the browser
computed it, a stale client could report a starting frame it never displayed and
the dataset would overstate how often the detector was right.

Accepts you did not change are recorded too - agreement is evidence, and a
corpus of only corrections would be biased. `unchanged` means centre within 1px,
scale within 0.2%, angle within 0.05 degrees, same format and orientation.

    ./.venv/bin/python evaluate.py            # summary + worst cases
    ./.venv/bin/python evaluate.py --verbose

It refuses any record whose schema it does not recognise rather than misreading
a pre-frame record as if the fields matched.

## The panel choice is ADVICE, not geometry

The Pi always scans FULL (215.9x355.6mm). The A4/A6 button on the panel no longer
sets the scan size - it travels with the scan as a `hint`, and the backend compares
it against its own detection. The review UI shows both and flags disagreement.

Cropping at scan time would leave the detector no margin to find the sheet against
and would clip content on skew, so the scan is always oversized and the crop is
decided later, where it can be reviewed and corrected.

## Transfer: the Pi pushes

Chosen over notify-then-pull: one round trip, and the Pi authenticates to the
backend (which already requires auth) rather than the backend needing credentials
into the Pi.

    Pi: adf-scan  ->  push_scans.py  ->  POST /api/ingest (multipart + hint)

- Each scan is RETAINED on the Pi until the backend acks with a matching sha256.
- `scanpipe-push.timer` retries every 5 minutes, so a backend that was down
  catches up by itself.
- Re-pushing an identical file is a no-op. A same-named scan with DIFFERENT
  content is stored under a distinct name rather than overwriting - two sessions
  naturally produce the same basename and silently replacing one would destroy
  ground-truth data.
- Credentials live in `~/scanpipe.env` on the Pi, mode 0600.

## Collecting ground truth

1. Put documents in the feeder, pick A4 or A6 on the panel, press KEY1.
2. They arrive in the queue by themselves.
3. Review each: correct the crop if the detector got it wrong, accept if it was
   right. Both outcomes are data.
4. `./.venv/bin/python evaluate.py` to see where the detector actually stands.
