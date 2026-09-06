"""Scan review pipeline: spool -> auto deskew/crop -> human review -> PDF -> paperless.

The paperless target is MOCKED here: approved PDFs are written into a consume
directory and each delivery is appended to a JSON log so tests can assert on it.
"""
import hashlib
import hmac
import json
import os
import secrets
import shutil
import re
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import anyio
import cv2
import img2pdf
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import HTMLResponse, Response
from pydantic import BaseModel

from detect import detect
import documents as documents_mod
import fit
import frame as frame_mod
from deskew import text_skew
from warp import PAPER_MM, classify, rotate_quad, target_size_px, warp

ROOT = Path(__file__).parent
# Code and data are separate roots, and only the data root moves.
#
# Everything below used to hang off the source directory. A packaged install
# replaces the code directory wholesale on upgrade and backs up only the data
# directory, so that arrangement would have destroyed the queue, the
# ground-truth corpus and every delivered PDF the first time the app was
# upgraded. ui.html, ui.js and icons.svg stay with ROOT because they ARE code
# and must be replaced on upgrade.
#
# Unset, DATA is the source tree, so a checkout, the test suite and the
# systemd unit as it stands all behave exactly as before.
DATA = Path(os.environ.get("SCANPIPE_DATA") or ROOT)
SPOOL = DATA / "spool"
WORK = DATA / "work"
ARCHIVE = DATA / "spool-archive"
THUMB_LONG_SIDE = 160     # shown at 52px; 160 stays sharp on a dense screen
OUT = DATA / "out"
CONSUME = DATA / "mock-paperless" / "consume"
TRUTH = DATA / "groundtruth"
DELIVERY_LOG = DATA / "mock-paperless" / "deliveries.json"
STATE = WORK / "state.json"
THUMBS = WORK / "thumbs"
# Fallback only. The scan dpi travels per page from the Pi, because the
# scanner's resolution can change and pages already in the queue were taken at
# whatever it was then. A single global would silently remeasure every older
# page: at 200 vs 300 an A4 sheet classifies 1.5x too large and stops being A4.
DPI = 200
MAX_UPLOAD_BYTES = 128 * 1024 * 1024

for d in (SPOOL, WORK, ARCHIVE, OUT, CONSUME, TRUTH, THUMBS):
    d.mkdir(parents=True, exist_ok=True)

# No /docs, /redoc or /openapi.json. They are behind auth, but they exist
# only to explore an API by hand, and this one has a single known client.
app = FastAPI(title="scanpipe", docs_url=None, redoc_url=None,
              openapi_url=None)

# --------------------------------------------------------------------------
# access control
# --------------------------------------------------------------------------
# The service is reachable from the LAN, and this host also answers on 0.0.0.0
# for mail/web with a dynamic-DNS name, so an unauthenticated UI serving scanned
# bank and medical documents would be a poor idea. Basic auth is enough here and
# browsers handle it natively; nginx puts TLS in front of it, because basic auth
# replays the password on every request including each thumbnail fetch.
AUTH_USER = os.environ.get("SCANPIPE_USER", "")
AUTH_PASS = os.environ.get("SCANPIPE_PASS", "")
# Fail CLOSED. A missing EnvironmentFile already stops the unit, but a file that
# merely went blank - an edit leaving SCANPIPE_PASS= empty, a typo'd key - used
# to start cleanly and serve every scanned bank and medical document to anyone
# who could reach the port, logging nothing to say so. Refusing to start is loud;
# serving unauthenticated is silent, and silence is the wrong failure here.
ALLOW_ANONYMOUS = os.environ.get("SCANPIPE_ALLOW_ANONYMOUS") == "1"
if not (AUTH_USER and AUTH_PASS) and not ALLOW_ANONYMOUS:
    raise RuntimeError(
        "SCANPIPE_USER and SCANPIPE_PASS must both be set; refusing to start. "
        "Set SCANPIPE_ALLOW_ANONYMOUS=1 for a deliberately open local instance.")


@app.middleware("http")
async def limit_body(request: Request, call_next):
    """Refuse an oversize body BEFORE anything reads it.

    The check inside ingest() runs too late to protect the disk. FastAPI fully
    parses the multipart body before the endpoint is entered, and Starlette's
    `max_part_size` guard applies only to non-file parts - file parts stream
    into a SpooledTemporaryFile under /tmp with no ceiling at all. So by the
    time ingest() can raise 413 the bytes are already on the root filesystem,
    which on this host also carries the mail spool and PostgreSQL.

    require_auth is declared after this one and so runs OUTSIDE it (Starlette
    makes the last-added middleware outermost). That is the right way round:
    an unauthenticated flood gets its 401 without the body being read at all,
    and an authenticated one is stopped here - still before routing, and so
    still before FastAPI parses the multipart.
    """
    if request.method in ("POST", "PUT", "PATCH"):
        declared = request.headers.get("content-length")
        if declared is None:
            # Chunked uploads give no length to check, and the only client is
            # the Pi's push script, which always sends one.
            return Response(status_code=411, content="content-length required")
        try:
            too_big = int(declared) > MAX_UPLOAD_BYTES
        except ValueError:
            return Response(status_code=400, content="bad content-length")
        if too_big:
            return Response(status_code=413,
                            content=f"body exceeds {MAX_UPLOAD_BYTES} bytes")
    return await call_next(request)


@app.middleware("http")
async def deny_cross_site(request: Request, call_next):
    """Refuse a state change that a foreign page caused the browser to make.

    Basic-auth credentials live in the browser's per-origin auth cache and are
    replayed on cross-site form submissions - SameSite governs cookies and does
    nothing for an Authorization header. /api/reject, /api/discard and
    /api/finalize take no request body, so a plain

        <form method=POST action="https://host:8765/api/finalize/a4-...">

    on any page the operator visits fires them, and finalize is irreversible by
    design. Batch ids follow the guessable <size>-<YYYYmmdd>-<HHMMSS> shape.

    A MISSING header allows the request: Sec-Fetch-Site is sent by browsers,
    and the non-browser client that matters here - the Pi's push script - does
    not send it. That is the right default, because the attack requires a
    browser to be the one replaying the credentials in the first place.
    """
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        site = request.headers.get("sec-fetch-site")
        if site is not None and site != "same-origin":
            return Response(status_code=403,
                            content=f"cross-site {request.method} refused")
    return await call_next(request)


@app.middleware("http")
async def require_auth(request: Request, call_next):
    if not (AUTH_USER and AUTH_PASS):
        return await call_next(request)
    header = request.headers.get("authorization", "")
    ok = False
    if header.startswith("Basic "):
        import base64
        try:
            user, _, password = base64.b64decode(header[6:]).decode().partition(":")
            # compare_digest on both fields to avoid leaking length/prefix by timing
            ok = (hmac.compare_digest(user, AUTH_USER)
                  and hmac.compare_digest(password, AUTH_PASS))
        except Exception:
            ok = False
    if not ok:
        return Response(status_code=401, content="authentication required",
                        headers={"WWW-Authenticate": 'Basic realm="scanpipe"'})
    return await call_next(request)

# State lives in one JSON file that is read-modify-written under this lock. A
# threading.Lock only serialises threads WITHIN one process, so the server must
# run single-process: with `uvicorn --workers N` two processes could interleave
# read/write and lose an accept. The systemd unit deliberately omits --workers.
_lock = threading.Lock()


# adf-scan writes one run as BASE-01.png, BASE-02.png, ... so the basename IS
# the batch. Derived here only as a fallback: the Pi sends it explicitly,
# because the collision rename below can change a filename after the fact.
# Greedy, and a page number is 2-3 digits: adf-scan writes %02d and a run of
# 100+ sheets needs a third. Non-greedy with an open-ended \d{2,} split at the
# FIRST dash and swallowed anything, so `report-20260902.png` parsed as batch
# `report`, page 20260902 - and two such files grouped into one document and
# one PDF. A name that does not end in a plausible page number now falls
# through to the single-page default instead of being forced into the shape.
PAGE_SUFFIX = re.compile(r"^(?P<batch>.+)-(?P<page>\d{2,3})$")


def batch_of(name):
    """(batch id, page number) for a scan filename."""
    m = PAGE_SUFFIX.match(Path(name).stem)
    if m:
        return m.group("batch"), int(m.group("page"))
    return Path(name).stem, 1


def quad_angle(corners):
    """Rotation of a quad's top edge, in degrees (positive = clockwise)."""
    (x0, y0), (x1, y1) = corners[0], corners[1]
    return float(np.degrees(np.arctan2(y1 - y0, x1 - x0)))


# --------------------------------------------------------------------------
# state
# --------------------------------------------------------------------------
def load_state():
    if STATE.exists():
        s = json.loads(STATE.read_text())
        s.setdefault("pages", {})
        s.setdefault("ingested", [])
        # `documents` used to map batch -> staged page ids. Staged membership is
        # derivable from page status, and keeping the two in step cost a bug
        # once, so there is only one source of truth now.
        s.pop("documents", None)
        return s
    return {"pages": {}, "ingested": []}


def save_state(s):
    # Atomic: image() and preview() read state without holding the lock, and an
    # in-place truncate-then-write lets a reader see a half-written file and fail
    # with a JSONDecodeError. Replace is atomic on the same filesystem.
    tmp = STATE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(s, indent=2))
    os.replace(tmp, STATE)


def ingest_spool(state):
    """Pick up new scans, detect the sheet, and queue them for review."""
    added = []
    # `ingested` stays a list in the JSON - documents.build() reads arrival
    # order from it - but membership is tested once per spool file per refresh,
    # and /api/queue refreshes on every poll. Linear scan made that quadratic
    # in the number of scans ever seen.
    seen = set(state["ingested"])
    for path in sorted(SPOOL.glob("*.png")) + sorted(SPOOL.glob("*.jpg")):
        key = path.name
        if key in seen:
            continue
        img = cv2.imread(str(path))
        if img is None:
            continue
        det = detect(img)
        if det is None:
            corners = [[0, 0], [img.shape[1] - 1, 0],
                       [img.shape[1] - 1, img.shape[0] - 1], [0, img.shape[0] - 1]]
            angle, coverage = 0.0, 0.0
        else:
            corners = det.corners.tolist()
            angle, coverage = det.angle_deg, det.coverage
        # Read the sidecar first: dpi is what turns pixels into millimetres,
        # so classify() cannot run before it is known.
        hint = None
        dpi = DPI
        sidecar = path.with_suffix(path.suffix + ".json")
        if sidecar.exists():
            try:
                meta0 = json.loads(sidecar.read_text())
                hint = meta0.get("hint")
                dpi = int(meta0.get("dpi") or DPI)
            except Exception:
                hint = None
        suggested = classify(corners, dpi=dpi) or "free"
        # The seed fit runs HERE, on the server, and is frozen with `detected`.
        # If the browser computed it, a stale client could report a starting
        # frame it never displayed and the ground-truth dataset would overstate
        # how often the detector was right.
        seeded, text = seed_with_text(img, corners, suggested, dpi=dpi)
        batch, page_no = batch_of(key)
        side = path.with_suffix(path.suffix + ".json")
        if side.exists():
            try:
                meta = json.loads(side.read_text())
                batch = meta.get("batch") or batch
                page_no = int(meta.get("page") or page_no)
            except Exception:
                pass
        state["pages"][key] = {
            "batch": batch,
            "page_no": page_no,
            "dpi": dpi,
            "format": suggested,
            "hint": hint,
            # The operator's A4/A6 choice is ADVICE only: it never drives the
            # crop, it is compared against detection so disagreement is visible.
            # None means "no hint given", which is not the same as agreement.
            "hint_agrees": (None if hint is None else hint == suggested),
            "id": key,
            "source": str(path),
            "width": img.shape[1],
            "height": img.shape[0],
            "corners": corners,
            "angle": angle,
            "coverage": coverage,
            "rotation": 0,
            "status": "pending",
            # Frozen at ingest so later edits cannot overwrite what was proposed.
            "detected": {"corners": corners, "angle": angle, "format": suggested},
            "seeded": seeded,
            "text_skew": text,
        }
        state["ingested"].append(key)
        seen.add(key)
        added.append(key)
    return added


def seed_with_text(img, corners, fmt, dpi=DPI):
    """Seed a frame from the sheet, then level it to the printed content.

    detect.py measures the SHEET; deskew.py measures the CONTENT. They are
    different quantities and can disagree - letter-01's text sits about 1 degree
    off its own sheet edges, confirmed independently with cv2.HoughLinesP. The
    content angle wins, because a level page is what the reader wants.

    The text angle is a RESIDUAL on the already-cropped page: run on a FULL scan
    the grey ADF backing is one huge dark region whose boundary outvotes every
    line of text. When the measurement is not confident - a blank page, a
    photograph - the sheet angle stands.

    Only the ANGLE comes from the text. Centre and size stay with the sheet, so
    a page printed askew rotates the crop but cannot walk it off the paper; if
    it does reach past the scan the existing overhang warning shows it.
    """
    if fmt not in PAPER_MM:
        return None, None
    seeded = frame_mod.seed_frame(corners, fmt)
    try:
        crop = warp(img, frame_mod.corners_of(seeded), target=fmt,
                    dpi=dpi).image
        skew = text_skew(crop)
    except Exception:
        return seeded, None
    text = {"residual_deg": skew.angle_deg, "confident": skew.confident,
            "candidates": skew.candidates, "cluster": skew.cluster,
            "sheet_angle": seeded["angle"]}
    if skew.confident:
        seeded = dict(seeded, angle=seeded["angle"] + skew.angle_deg)

    # Re-fit once the angle is settled. seed_frame() fits by least squares,
    # which splits the error between both axes and so is free to hang over an
    # edge; largest_inside() maximises coverage subject to staying on the
    # sheet, which is what the operator was doing by hand. It has to run AFTER
    # the text angle is applied, because the biggest frame that fits depends on
    # the angle -- deskew is a prerequisite, not an afterthought.
    fitted = fit.largest_inside(corners, fmt, seeded["angle"],
                                orientation=seeded["orientation"])
    if fitted is not None:
        seeded = fitted
    return seeded, text


def backfill_seeds(state):
    """Fill in fields added after a page was first ingested.

    Seeds are recomputed from the FROZEN `detected` corners, so a backfilled
    seed is identical to one written at ingest - no data is invented. The batch
    comes from the filename, which is where ingest gets it when the scanner host
    does not send one.
    """
    changed = False
    for key, page in state["pages"].items():
        if not page.get("batch"):
            page["batch"], page["page_no"] = batch_of(key)
            changed = True
    for page in state["pages"].values():
        if page.get("seeded") is not None and "text_skew" in page:
            continue
        det = page.get("detected") or {}
        fmt = det.get("format")
        if not det.get("corners") or fmt not in PAPER_MM:
            continue
        img = cv2.imread(page["source"])
        if img is None:
            continue
        page["seeded"], page["text_skew"] = seed_with_text(
            img, det["corners"], fmt, dpi=int(page.get("dpi") or DPI))
        changed = True
    return changed


def refresh():
    with _lock:
        s = load_state()
        added = ingest_spool(s)
        filled = backfill_seeds(s)
        if added or filled:
            save_state(s)
        return s, added


# --------------------------------------------------------------------------
# api
# --------------------------------------------------------------------------
class AcceptBody(BaseModel):
    corners: list[list[float]]
    rotation: int = 0
    target: str = "free"      # "A4" | "A6" | ... | "free"
    # The ratio-locked frame behind those corners, so the ground-truth record
    # can decompose the error per axis instead of blending it into one number.
    frame: dict | None = None


class PreviewBody(BaseModel):
    corners: list[list[float]]
    rotation: int = 0
    target: str = "free"
    max_width: int = 560
    # The peek view fills the screen, so it asks for canvas resolution and a
    # higher quality than the small inline preview needs. 82 is fine for a
    # 560px thumbnail and visibly soft on scanned text at full size.
    quality: int = 82


# Internal bookkeeping the browser has no use for. `source` and `output` are
# absolute paths on this host, so shipping them told anyone with the password
# the account name and the layout of the disk for no benefit at all - neither
# ui.js nor the test suite reads either.
PRIVATE_PAGE_FIELDS = ("source", "output")


@app.get("/api/queue")
def queue():
    s, _ = refresh()
    docs = documents_mod.build(s)
    for d in docs:
        d["pages"] = [{k: v for k, v in p.items()
                       if k not in PRIVATE_PAGE_FIELDS} for p in d["pages"]]
    return {"documents": docs}


@app.get("/api/image/{page_id}")
def image(page_id: str):
    s = load_state()
    page = s["pages"].get(page_id)
    if not page:
        raise HTTPException(404, "unknown page")
    data = Path(page["source"]).read_bytes()
    return Response(content=data, media_type="image/png")


@app.get("/api/thumb/{page_id}")
def thumb(page_id: str):
    """A small JPEG of the RAW scan, for the filmstrip.

    Not the cropped result: the strip is an index of what is in the document,
    and rendering every page through warp() on demand would be slow and would
    shift under the operator as they drag the frame.
    """
    s = load_state()
    page = s["pages"].get(page_id)
    if not page:
        raise HTTPException(404, "unknown page")
    THUMBS.mkdir(parents=True, exist_ok=True)
    dest = THUMBS / f"{page_id}.jpg"
    if not dest.exists():
        img = cv2.imread(page["source"])
        if img is None:
            raise HTTPException(410, f"source image gone: {page['source']}")
        scale = THUMB_LONG_SIDE / max(img.shape[:2])
        small = cv2.resize(img, None, fx=scale, fy=scale,
                           interpolation=cv2.INTER_AREA)
        cv2.imwrite(str(dest), small, [cv2.IMWRITE_JPEG_QUALITY, 75])
    return Response(content=dest.read_bytes(), media_type="image/jpeg")


@app.post("/api/accept/{page_id}")
def accept(page_id: str, body: AcceptBody):
    with _lock:
        s = load_state()
        page = s["pages"].get(page_id)
        if not page or page["status"] != "pending":
            raise HTTPException(404, "not pending")
        img = cv2.imread(page["source"])
        if img is None:
            # The spool file was deleted or moved out from under a queued page.
            # Without this the failure is an AttributeError deep in warp() and
            # surfaces as an opaque 500.
            raise HTTPException(410, f"source image gone: {page['source']}")
        # At the page's OWN dpi: finalize() lays each page out at that same dpi,
        # so rendering at a fixed 200 gave the wrong physical size on any other
        # scan - an A4 taken at 300dpi became a 140x198mm PDF page.
        page_dpi = int(page.get("dpi") or DPI)
        try:
            result = warp(img, np.array(body.corners, dtype=np.float32),
                          target=body.target, dpi=page_dpi)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        out_img = result.image
        for _ in range((body.rotation // 90) % 4):
            out_img = cv2.rotate(out_img, cv2.ROTATE_90_CLOCKWISE)
        # Keyed on the full filename, not the stem: "doc.png" and "doc.jpg"
        # would otherwise both write "doc-page.png" and clobber each other.
        dest = WORK / f"{page_id}.page.png"
        cv2.imwrite(str(dest), out_img)
        page.update(status="accepted", output=str(dest), rotation=body.rotation,
                    corners=body.corners, format=body.target,
                    out_width=int(out_img.shape[1]), out_height=int(out_img.shape[0]),
                    outside=result.outside)
        # Ground truth for refining the detector: what it PROPOSED versus what a
        # human ACCEPTED. Written on every accept, including unchanged ones -
        # agreement is as informative as correction, and a dataset of only
        # corrections would be biased.
        detected = page.get("detected", {})
        seeded = page.get("seeded")
        if body.frame:
            accepted_frame = dict(body.frame)
            # Both halves of this record arrive from the client, and the whole
            # point of the ground truth is that they describe the same thing:
            # `corners` is what was warped, `frame` is what the operator was
            # manipulating. The seed is computed server-side precisely so a
            # stale client cannot misreport the frame it was shown - but
            # `accepted` was written down unchecked, so the same class of bug
            # could quietly corrupt the other side of every comparison.
            implied = frame_mod.frame_from_corners(body.corners)
            drift = max(abs(implied["cx"] - accepted_frame.get("cx", 0)),
                        abs(implied["cy"] - accepted_frame.get("cy", 0)),
                        abs(implied["w"] - accepted_frame.get("w", 0)),
                        abs(implied["h"] - accepted_frame.get("h", 0)))
            # A pixel absorbs float noise through the corner round-trip; a real
            # disagreement is orders of magnitude larger than that.
            if drift > 1.0:
                raise HTTPException(
                    400, f"frame disagrees with corners by {drift:.1f}px")
        else:
            accepted_frame = frame_mod.frame_from_corners(body.corners)
            accepted_frame["format"] = body.target
            accepted_frame["orientation"] = frame_mod.orientation_of(accepted_frame)
        accepted_frame["rotation"] = body.rotation
        record = {
            "page": page_id,
            "at": datetime.now(timezone.utc).isoformat(),
            "schema": 2,
            "source": page["source"],
            "scan": {"width": page["width"], "height": page["height"],
                     "dpi": page_dpi},
            "hint": page.get("hint"),
            "detected": {"corners": detected.get("corners"),
                         "angle": detected.get("angle"),
                         "format": detected.get("format")},
            "seeded": seeded,
            "text_skew": page.get("text_skew"),
            "accepted": dict(accepted_frame, corners=body.corners),
            # dpi is what turns the pixel error into centre_dist_mm, the metric
            # evaluate.py leads with; at a fixed 200 it was out by a third on a
            # 300dpi scan.
            "error": (frame_mod.frame_error(seeded, accepted_frame, dpi=page_dpi)
                      if seeded else None),
        }
        if record["error"] is not None:
            hint = page.get("hint")
            record["error"]["hint_agrees"] = (
                None if hint is None else hint == accepted_frame.get("format"))
        (TRUTH / f"{page_id}.json").write_text(json.dumps(record, indent=2))

        save_state(s)
        return {"ok": True, "output": str(dest), "target": result.target,
                "width": int(out_img.shape[1]), "height": int(out_img.shape[0])}


@app.post("/api/preview/{page_id}")
def preview(page_id: str, body: PreviewBody):
    """Render what Accept would produce, so the user sees the deskew live."""
    s = load_state()
    page = s["pages"].get(page_id)
    if not page:
        raise HTTPException(404, "unknown page")
    img = cv2.imread(page["source"])
    if img is None:
        # Same guard the other three readers carry: without it a spool file
        # removed under a queued page is an AttributeError inside warp(), which
        # surfaces as an opaque 500 rather than accept()'s 410.
        raise HTTPException(410, f"source image gone: {page['source']}")
    try:
        result = warp(img, np.array(body.corners, dtype=np.float32),
                      target=body.target, dpi=int(page.get("dpi") or DPI))
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    out = result.image
    for _ in range((body.rotation // 90) % 4):
        out = cv2.rotate(out, cv2.ROTATE_90_CLOCKWISE)
    # The true output size: after rotation, before the preview downscale. Both
    # matter - warp's pre-rotation size disagrees at 90/270, and the resized
    # `out` is only a thumbnail.
    out_w, out_h = int(out.shape[1]), int(out.shape[0])
    if out.shape[1] > body.max_width:
        scale = body.max_width / out.shape[1]
        out = cv2.resize(out, (body.max_width, max(1, int(out.shape[0] * scale))),
                         interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", out,
                           [cv2.IMWRITE_JPEG_QUALITY, max(50, min(97, body.quality))])
    if not ok:
        raise HTTPException(500, "preview encode failed")
    return Response(content=buf.tobytes(), media_type="image/jpeg", headers={
        "X-Out-Width": str(out_w), "X-Out-Height": str(out_h),
        "X-Target": result.target, "X-Outside": f"{result.outside:.2f}",
    })


@app.post("/api/ingest")
async def ingest(file: UploadFile = File(...), hint: str = Form(""),
                 batch: str = Form(""), page: str = Form(""), dpi: str = Form("")):
    """Accept a scan pushed by the scanner host.

    Push rather than pull: the Pi authenticates to us (we already require auth),
    so no credentials are needed in the other direction, and the Pi keeps each
    file until this returns ok.
    """
    name = Path(file.filename or "").name
    if not name or not name.lower().endswith((".png", ".jpg", ".jpeg")):
        raise HTTPException(400, "expected a .png/.jpg filename")
    # Read with a cap rather than swallowing an arbitrary body into memory.
    # A 600dpi A4 colour PNG is roughly 50MB, so this is generous for real scans.
    chunks, total = [], 0
    while chunk := await file.read(1 << 20):
        total += len(chunk)
        if total > MAX_UPLOAD_BYTES:
            raise HTTPException(413, f"upload exceeds {MAX_UPLOAD_BYTES} bytes")
        chunks.append(chunk)
    data = b"".join(chunks)
    if not data:
        raise HTTPException(400, "empty upload")
    digest = hashlib.sha256(data).hexdigest()

    # Never overwrite: two scanning sessions naturally produce the same basename
    # (scan-01.png on Monday and on Tuesday), and silently replacing the earlier
    # one would destroy ground-truth data. Identical content is a harmless
    # re-push; different content gets a distinct name.
    dest = SPOOL / name
    if dest.exists():
        if hashlib.sha256(dest.read_bytes()).hexdigest() == digest:
            await anyio.to_thread.run_sync(refresh)
            return {"ok": True, "stored": dest.name, "bytes": len(data),
                    "sha256": digest, "hint": hint or None, "duplicate": True}
        stem, suffix = Path(name).stem, Path(name).suffix
        dest = SPOOL / f"{stem}-{digest[:8]}{suffix}"
    dest.write_bytes(data)
    meta = {k: v for k, v in (("hint", hint), ("batch", batch), ("page", page),
                              ("dpi", dpi)) if v}
    if meta:
        dest.with_suffix(dest.suffix + ".json").write_text(json.dumps(meta))
    # Off the event loop. This is the only `async def` endpoint, so its body
    # runs ON the loop, and refresh() is heavy synchronous work - measured at
    # 166ms per new page for detect + deskew - that also takes the blocking
    # state lock. Run inline it stalls every other request, including the
    # review UI in someone's hand, for the whole of that.
    await anyio.to_thread.run_sync(refresh)
    return {"ok": True, "stored": dest.name, "bytes": len(data), "sha256": digest,
            "hint": hint or None, "duplicate": False}


@app.get("/api/formats")
def formats():
    return {"formats": ["free", *sorted(PAPER_MM)]}


@app.post("/api/reject/{page_id}")
def reject(page_id: str):
    with _lock:
        s = load_state()
        page = s["pages"].get(page_id)
        if not page or page["status"] != "pending":
            raise HTTPException(404, "not pending")
        page["status"] = "rejected"
        save_state(s)
        return {"ok": True}


def _archive_dest(src):
    """A name in ARCHIVE that does not overwrite an earlier scan.

    shutil.move clobbers. Two scanning sessions naturally produce the same
    basename, and ingest() already refuses to let the second destroy the first
    - but discard() used to undo that guarantee on the way out, leaving the
    original in neither spool/ nor the archive. Same rule as ingest: identical
    content is a no-op, different content gets a digest suffix.
    """
    dest = ARCHIVE / src.name
    if not dest.exists():
        return dest
    digest = hashlib.sha256(src.read_bytes()).hexdigest()
    if hashlib.sha256(dest.read_bytes()).hexdigest() == digest:
        return dest                     # same scan already archived
    return ARCHIVE / f"{src.stem}-{digest[:8]}{src.suffix}"


@app.post("/api/discard/{batch}")
def discard(batch: str):
    """Close a document that has nothing worth keeping.

    When every page is declined there is no PDF to make, so Send becomes
    Delete. Without this a wholly rejected document would either sit in the
    queue for ever or - the earlier behaviour - vanish the instant its last
    page was rejected, which made that reject silently irreversible on a
    one-page document.

    The scans are moved to spool-archive/ rather than erased: that directory
    exists for scans kept out of the queue, and a mis-tap should not destroy a
    document.
    """
    with _lock:
        s = load_state()
        members = [p for p in s["pages"].values() if p.get("batch") == batch]
        if not members:
            raise HTTPException(404, f"no such batch {batch!r}")
        if any(p["status"] in ("pending", "accepted") for p in members):
            raise HTTPException(
                409, f"batch {batch!r} still has pages to keep or decide")
        ARCHIVE.mkdir(parents=True, exist_ok=True)
        moved = []
        for p in members:
            src = Path(p["source"])
            if src.exists():
                dest = _archive_dest(src)
                shutil.move(str(src), str(dest))
                moved.append(dest.name)
                side = src.with_suffix(src.suffix + ".json")
                if side.exists():
                    # Follow the scan's final name, or a renamed scan and its
                    # sidecar stop referring to each other.
                    shutil.move(str(side), str(ARCHIVE / (dest.name + ".json")))
            p["status"] = "discarded"
        save_state(s)
        return {"ok": True, "batch": batch, "archived": moved}


@app.post("/api/reopen/{page_id}")
def reopen(page_id: str):
    """Put a decided page back in play.

    Deciding is reversible right up until the document is sent - that is what
    makes the last look before Send worth having, and it is the way back from a
    mis-tap. Sending is not: the PDF has been delivered.
    """
    with _lock:
        s = load_state()
        page = s["pages"].get(page_id)
        if not page:
            raise HTTPException(404, "unknown page")
        # Scoped to the DOCUMENT, not the page. A rejected page whose siblings
        # have been sent is still part of a delivered run, and reopening it
        # would let that one ADF run produce a second PDF - the exact thing
        # finalize() refuses to do by requiring every page to be decided.
        batch = page.get("batch")
        if any(p["status"] == "sent" for p in s["pages"].values()
               if p.get("batch") == batch):
            raise HTTPException(409, "document already sent")
        page["status"] = "pending"
        for key in ("output", "out_width", "out_height", "outside"):
            page.pop(key, None)
        save_state(s)
        return {"ok": True, "status": "pending"}


@app.post("/api/finalize/{batch}")
def finalize(batch: str):
    """Assemble one batch's accepted pages into a PDF and deliver it.

    One ADF run is one document. Previously every accepted page went into a
    single tray and Send emptied it, so two letters scanned in the same sitting
    merged into one PDF unless the operator remembered to Send in between.
    """
    with _lock:
        s = load_state()
        members = [p for p in s["pages"].values() if p.get("batch") == batch]
        if not members:
            raise HTTPException(404, f"no such batch {batch!r}")
        if any(p["status"] == "pending" for p in members):
            # Sending half a document would produce a second PDF for the same
            # ADF run later, and one run is one document.
            raise HTTPException(409, f"batch {batch!r} still has undecided pages")
        # Pages of a run come off the ADF in order; accept order can differ if
        # the operator stepped back through the queue.
        staged = [p for p in members
                  if p["status"] == "accepted" and p.get("output")]
        staged.sort(key=lambda p: (p.get("page_no") or 0, p["id"]))
        if not staged:
            raise HTTPException(404, f"no accepted pages in batch {batch!r}")
        ids = [p["id"] for p in staged]
        images = [p["output"] for p in staged]
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        # The batch id disambiguates two finalizes in the same second, which
        # the timestamp alone cannot. Without it the second PDF overwrote the
        # first while deliveries.json logged both, so one document was silently
        # lost and the surviving file was attributed to the wrong batch.
        safe = re.sub(r"[^A-Za-z0-9._-]", "_", batch)
        pdf_path = OUT / f"document-{stamp}-{safe}.pdf"
        # Each page at ITS OWN size, from its pixel dimensions at the scan dpi.
        # A fixed A4 layout put a 148x105mm A6 onto a 210x297mm portrait page,
        # throwing away the true size the ratio-locked frame exists to produce.
        # Pages in one batch share a dpi in practice, but read it from the
        # pages rather than assuming: a batch assembled from a re-ingested
        # older scan would otherwise be laid out at the wrong physical size.
        dpis = {int(p.get("dpi") or DPI) for p in staged}
        page_dpi = dpis.pop() if len(dpis) == 1 else DPI
        if dpis:
            log_dpi = sorted({int(p.get("dpi") or DPI) for p in staged})
            print(f"batch {batch}: mixed dpi {log_dpi}, laying out at {page_dpi}")
        layout = img2pdf.get_fixed_dpi_layout_fun((page_dpi, page_dpi))
        pdf_path.write_bytes(img2pdf.convert(images, layout_fun=layout))

        delivered = CONSUME / pdf_path.name
        shutil.copy2(pdf_path, delivered)

        log = json.loads(DELIVERY_LOG.read_text()) if DELIVERY_LOG.exists() else []
        log.append({"file": delivered.name, "batch": batch, "pages": len(ids),
                    "page_ids": ids, "bytes": delivered.stat().st_size,
                    "at": datetime.now(timezone.utc).isoformat()})
        DELIVERY_LOG.write_text(json.dumps(log, indent=2))

        for p in staged:
            p["status"] = "sent"
        # The rejected pages close out with the document. Leaving them
        # `rejected` - a status outside documents.CLOSED - kept the whole
        # document in the queue after its PDF had been delivered, where it
        # reappeared as an empty "delete me" card. Rejecting the blank back of
        # a duplex sheet is the common case, so this was the common path.
        for p in members:
            if p["status"] == "rejected":
                p["status"] = "closed"
        save_state(s)
        return {"ok": True, "pdf": delivered.name, "batch": batch,
                "pages": len(ids)}


@app.get("/api/deliveries")
def deliveries():
    return json.loads(DELIVERY_LOG.read_text()) if DELIVERY_LOG.exists() else []


@app.get("/icons.svg")
def icons_svg():
    # Vendored Lucide sprite (see build-icons.js). Served locally so the UI
    # works without internet and makes no third-party requests from a page
    # showing scanned documents.
    return Response(content=(ROOT / "icons.svg").read_text(),
                    media_type="image/svg+xml")


@app.get("/ui.js")
def ui_js():
    return Response(content=(ROOT / "ui.js").read_text(),
                    media_type="application/javascript")


@app.get("/", response_class=HTMLResponse)
def index():
    return (ROOT / "ui.html").read_text()
