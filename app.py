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
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import cv2
import img2pdf
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import HTMLResponse, Response
from pydantic import BaseModel

from detect import detect
from warp import PAPER_MM, classify, rotate_quad, target_size_px, warp

ROOT = Path(__file__).parent
SPOOL = ROOT / "spool"
WORK = ROOT / "work"
OUT = ROOT / "out"
CONSUME = ROOT / "mock-paperless" / "consume"
TRUTH = ROOT / "groundtruth"
DELIVERY_LOG = ROOT / "mock-paperless" / "deliveries.json"
STATE = WORK / "state.json"
DPI = 200
MAX_UPLOAD_BYTES = 128 * 1024 * 1024

for d in (SPOOL, WORK, OUT, CONSUME, TRUTH):
    d.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="scanpipe")

# --------------------------------------------------------------------------
# access control
# --------------------------------------------------------------------------
# The service is reachable from the LAN, and this host also answers on 0.0.0.0
# for mail/web with a dynamic-DNS name, so an unauthenticated UI serving scanned
# bank and medical documents would be a poor idea. Basic auth is enough here and
# browsers handle it natively. Set SCANPIPE_USER/SCANPIPE_PASS to enable it;
# leave them unset for a purely local, unauthenticated setup.
AUTH_USER = os.environ.get("SCANPIPE_USER", "")
AUTH_PASS = os.environ.get("SCANPIPE_PASS", "")


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


def quad_angle(corners):
    """Rotation of a quad's top edge, in degrees (positive = clockwise)."""
    (x0, y0), (x1, y1) = corners[0], corners[1]
    return float(np.degrees(np.arctan2(y1 - y0, x1 - x0)))


# --------------------------------------------------------------------------
# state
# --------------------------------------------------------------------------
def load_state():
    if STATE.exists():
        return json.loads(STATE.read_text())
    return {"pages": {}, "document": [], "ingested": []}


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
    for path in sorted(SPOOL.glob("*.png")) + sorted(SPOOL.glob("*.jpg")):
        key = path.name
        if key in state["ingested"]:
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
        suggested = classify(corners) or "free"
        hint = None
        sidecar = path.with_suffix(path.suffix + ".json")
        if sidecar.exists():
            try:
                hint = json.loads(sidecar.read_text()).get("hint")
            except Exception:
                hint = None
        state["pages"][key] = {
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
        }
        state["ingested"].append(key)
        added.append(key)
    return added


def refresh():
    with _lock:
        s = load_state()
        added = ingest_spool(s)
        if added:
            save_state(s)
        return s, added


# --------------------------------------------------------------------------
# api
# --------------------------------------------------------------------------
class AcceptBody(BaseModel):
    corners: list[list[float]]
    rotation: int = 0
    target: str = "free"      # "A4" | "A6" | ... | "free"


class PreviewBody(BaseModel):
    corners: list[list[float]]
    rotation: int = 0
    target: str = "free"
    max_width: int = 560


@app.get("/api/queue")
def queue():
    s, _ = refresh()
    pending = [p for p in s["pages"].values() if p["status"] == "pending"]
    pending.sort(key=lambda p: p["id"])
    return {"pending": pending, "document": s["document"]}


@app.get("/api/image/{page_id}")
def image(page_id: str):
    s = load_state()
    page = s["pages"].get(page_id)
    if not page:
        raise HTTPException(404, "unknown page")
    data = Path(page["source"]).read_bytes()
    return Response(content=data, media_type="image/png")


@app.post("/api/accept/{page_id}")
def accept(page_id: str, body: AcceptBody):
    with _lock:
        s = load_state()
        page = s["pages"].get(page_id)
        if not page or page["status"] != "pending":
            raise HTTPException(404, "not pending")
        img = cv2.imread(page["source"])
        result = warp(img, np.array(body.corners, dtype=np.float32), target=body.target)
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
        # Ground truth for refining the detector: what it proposed versus what a
        # human actually accepted. Written on every accept, including unchanged
        # ones - agreement is as informative as correction.
        detected = page.get("detected", {})
        corner_shift = None
        if detected.get("corners"):
            d = np.asarray(detected["corners"], dtype=float)
            f = np.asarray(body.corners, dtype=float)
            corner_shift = float(np.max(np.linalg.norm(d - f, axis=1)))
        record = {
            "id": page_id,
            "source": page["source"],
            "scan_width": page["width"], "scan_height": page["height"],
            "hint": page.get("hint"),
            "detected": {"corners": detected.get("corners"),
                         "angle": detected.get("angle"),
                         "format": detected.get("format")},
            "accepted": {"corners": body.corners,
                         "angle": quad_angle(body.corners),
                         "format": body.target,
                         "rotation": body.rotation},
            "corner_shift_px": corner_shift,
            "format_agreed": detected.get("format") == body.target,
            "at": datetime.now(timezone.utc).isoformat(),
        }
        (TRUTH / f"{page_id}.json").write_text(json.dumps(record, indent=2))

        s["document"].append(page_id)
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
    try:
        result = warp(img, np.array(body.corners, dtype=np.float32), target=body.target)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    out = result.image
    for _ in range((body.rotation // 90) % 4):
        out = cv2.rotate(out, cv2.ROTATE_90_CLOCKWISE)
    if out.shape[1] > body.max_width:
        scale = body.max_width / out.shape[1]
        out = cv2.resize(out, (body.max_width, max(1, int(out.shape[0] * scale))),
                         interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", out, [cv2.IMWRITE_JPEG_QUALITY, 82])
    if not ok:
        raise HTTPException(500, "preview encode failed")
    return Response(content=buf.tobytes(), media_type="image/jpeg", headers={
        "X-Out-Width": str(result.width_px), "X-Out-Height": str(result.height_px),
        "X-Target": result.target, "X-Outside": f"{result.outside:.2f}",
    })


@app.post("/api/ingest")
async def ingest(file: UploadFile = File(...), hint: str = Form("")):
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
            refresh()
            return {"ok": True, "stored": dest.name, "bytes": len(data),
                    "sha256": digest, "hint": hint or None, "duplicate": True}
        stem, suffix = Path(name).stem, Path(name).suffix
        dest = SPOOL / f"{stem}-{digest[:8]}{suffix}"
    dest.write_bytes(data)
    if hint:
        dest.with_suffix(dest.suffix + ".json").write_text(json.dumps({"hint": hint}))
    refresh()
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


@app.post("/api/finalize")
def finalize():
    """Assemble accepted pages into one PDF and deliver it to the paperless mock."""
    with _lock:
        s = load_state()
        ids = list(s["document"])
        if not ids:
            raise HTTPException(400, "no accepted pages")
        images = [s["pages"][i]["output"] for i in ids]
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        pdf_path = OUT / f"document-{stamp}.pdf"
        layout = img2pdf.get_layout_fun(
            (img2pdf.mm_to_pt(210), img2pdf.mm_to_pt(297)))
        pdf_path.write_bytes(img2pdf.convert(images, layout_fun=layout))

        delivered = CONSUME / pdf_path.name
        shutil.copy2(pdf_path, delivered)

        log = json.loads(DELIVERY_LOG.read_text()) if DELIVERY_LOG.exists() else []
        log.append({"file": delivered.name, "pages": len(ids), "page_ids": ids,
                    "bytes": delivered.stat().st_size,
                    "at": datetime.now(timezone.utc).isoformat()})
        DELIVERY_LOG.write_text(json.dumps(log, indent=2))

        s["document"] = []
        save_state(s)
        return {"ok": True, "pdf": delivered.name, "pages": len(ids)}


@app.get("/api/deliveries")
def deliveries():
    return json.loads(DELIVERY_LOG.read_text()) if DELIVERY_LOG.exists() else []


@app.get("/", response_class=HTMLResponse)
def index():
    return (ROOT / "ui.html").read_text()
