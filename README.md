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
      └─ fetch_scans.py  ──pull, sha256-verified──> spool/
           └─ auto-detect the sheet (corners + skew)
                └─ REVIEW at http://127.0.0.1:8765   ← drag corners, Accept / Reject / Rotate
                     └─ "Send to paperless"
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

## Known limits

- A4 has almost no horizontal margin: the scanner's usable width is ~211mm versus
  A4's 210mm. Deskewing a full-width A4 therefore has nowhere to rotate into and
  will clip edges. A6 and smaller have plenty of margin. `warp.py` reports
  `clamped=True` when the crop touches the scan boundary and the UI flags it.
- The review UI trusts whoever can reach localhost. Scans contain personal data,
  so keep it bound to 127.0.0.1.
- One document at a time: accepted pages accumulate until "Send to paperless".

## Tests

    npx playwright test        # 6 end-to-end tests against the running service

They assert on outcomes — queue counts, files on disk, output pixel dimensions,
`qpdf --show-npages`, the delivery log — not on whether the page rendered. The
drag test was mutation-checked: disabling the drag handler makes it fail.

## Layout

    detect.py         find the sheet (corners, skew, coverage)
    warp.py           deskew/crop; flags crops that touch the scan edge
    app.py            queue, accept/reject, PDF assembly, mock delivery
    ui.html           review UI (canvas, draggable corners)
    fetch_scans.py    pull scans from the Pi, checksum-verified, no duplicates
    originals/        untouched copies of your two sheets
    spool-archive/    other scans pulled from the Pi, kept out of the queue

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

Not addressed, deliberately:

- A user can drag corners into a crossed quad and get a mangled crop. The UI draws
  the quad live, so this is visible before accepting rather than silent.
- No auth on the review UI. It binds 127.0.0.1 only; scans hold personal data, so
  do not expose it beyond localhost without adding auth.

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

Two panes: the **source** with the detected quad, and a **live preview** of exactly what Accept will produce - the deskewed, cropped page.
The preview is rendered by the same code path as Accept, so what you see is what
you get.

- **Corners** - drag any handle. Handles for corners that fall OUTSIDE the scan
  stay reachable in the margin around the image.
- **Sides** - drag an edge to crop that side in or out. The edge moves along its
  own normal, so it stays parallel and the opposite side does not move. The side
  under the pointer is highlighted. Corners take priority where they overlap.
- **Page size** - pick A4/A5/A6 and the output is rendered at that exact ISO size,
  so the aspect ratio is the true paper ratio no matter how the quad is dragged.
  `free` uses the quad's own measured size.
- **Deskew** - a slider from -15 to +15 degrees rotates the whole quad about its
  centre, with +/-0.1 degree buttons for fine work. The slider is absolute and
  applies only the delta, so `corners` stays authoritative and dragging a handle
  afterwards still behaves. A whole slider gesture is one undo step.
- **Gridlines** over the preview (toggleable, on by default): a light grid plus a
  stronger red centre cross, so "is this level?" is judged against a reference
  rather than by eye. They redraw whenever the preview updates.
- **Undo** reverts any change (drag, nudge, rotate, format). **Reset to detected**
  returns to the automatic result.

Corners may lie OUTSIDE the scan when a sheet was fed flush to the leading edge.
The canvas keeps a margin around the image so those handles stay grabbable, and
the transform does not clamp them - clamping deformed the quad and left about 3
degrees of residual skew on a real A6. The missing sliver is filled white and the
UI says so.

## Ground truth: measuring the detector

The deskew/crop detector is refined against measured error, not guesswork.

Every accept writes `groundtruth/<page>.json` pairing what the detector PROPOSED
with what you ACCEPTED:

    detected  { corners, angle, format }   frozen at ingest
    accepted  { corners, angle, format, rotation }
    hint                                    what you chose on the Pi panel
    corner_shift_px                         how far you moved things

Accepts you did not change are recorded too - agreement is evidence that the
detector was right, and a dataset of only corrections would be biased.

    ./.venv/bin/python evaluate.py            # summary + worst cases
    ./.venv/bin/python evaluate.py --verbose

It reports format agreement, how often detection matched your panel hint, skew
error statistics, and a per-scan table so a bad case can be found and inspected.

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
