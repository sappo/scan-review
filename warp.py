"""Deskew and crop a scan to the detected sheet, at a true paper size."""
from dataclasses import dataclass

import cv2
import numpy as np

# ISO sizes in mm, portrait.
PAPER_MM = {"A4": (210.0, 297.0), "A5": (148.0, 210.0), "A6": (105.0, 148.0)}

# Ceiling on the output raster, in pixels. With target="free" the size comes
# straight from client-supplied corners, so without this a single small request
# can ask for an arbitrarily large allocation: a 60000x60000 quad is 10.8GB of
# BGR in one warpPerspective call, and this host also runs mail and a database.
# 64M px is roughly 1.8x an A4 at 600dpi, so no real scan comes close.
MAX_OUT_PX = 64_000_000


@dataclass
class WarpResult:
    image: np.ndarray
    width_px: int
    height_px: int
    outside: float          # fraction of the quad lying beyond the scan edge
    target: str             # "A4" | "A6" | ... | "free"


def _edge_lengths(c):
    tl, tr, br, bl = c
    return (max(np.linalg.norm(tr - tl), np.linalg.norm(br - bl)),
            max(np.linalg.norm(bl - tl), np.linalg.norm(br - tr)))


def classify(corners, dpi=200, tolerance=0.06):
    """Best-matching ISO paper size for a quad, or None."""
    w, h = _edge_lengths(np.asarray(corners, dtype=np.float32))
    mm = 25.4 / dpi
    dims = sorted([w * mm, h * mm])
    best, best_err = None, tolerance
    for name, (pw, ph) in PAPER_MM.items():
        target = sorted([pw, ph])
        err = max(abs(dims[0] - target[0]) / target[0],
                  abs(dims[1] - target[1]) / target[1])
        if err < best_err:
            best, best_err = name, err
    return best


def target_size_px(name, corners, dpi=200):
    """Exact pixel size for a paper format, matching the quad's orientation."""
    pw, ph = PAPER_MM[name]
    w, h = _edge_lengths(np.asarray(corners, dtype=np.float32))
    if w > h:                       # the quad is landscape
        pw, ph = ph, pw
    return int(round(pw / 25.4 * dpi)), int(round(ph / 25.4 * dpi))


def warp(image_bgr, corners, target=None, dpi=200):
    """Perspective-correct the quad to an upright rectangle.

    When `target` names a paper size the output is rendered at exactly that
    size, so the aspect ratio is the true ISO ratio rather than whatever the
    dragged quad happened to measure.

    Corners are NOT clamped into the image. A sheet fed flush to the leading
    edge can have a corner slightly outside the captured area; clamping it
    would deform the quad and leave residual skew (measured at -3 degrees on a
    real A6). Instead the transform samples outside the source and fills with
    white, so the page geometry stays true and the missing sliver is visibly
    blank. `outside` reports how much was affected.
    """
    c = np.asarray(corners, dtype=np.float32)
    if c.size != 8:
        # pydantic types the body as list[list[float]] but does not pin the
        # count, so a wrong one otherwise surfaces as an opaque reshape error.
        raise ValueError(f"expected four corners, got {c.size // 2}")
    c = c.reshape(4, 2)
    h, w = image_bgr.shape[:2]

    outside_pts = ((c[:, 0] < 0) | (c[:, 1] < 0) |
                   (c[:, 0] > w - 1) | (c[:, 1] > h - 1)).sum()
    outside = float(outside_pts) / 4.0

    if target in PAPER_MM:
        out_w, out_h = target_size_px(target, c, dpi)
        label = target
    else:
        fw, fh = _edge_lengths(c)
        out_w, out_h = int(round(fw)), int(round(fh))
        label = "free"
    if out_w < 8 or out_h < 8:
        raise ValueError(f"degenerate crop {out_w}x{out_h}")
    if out_w * out_h > MAX_OUT_PX:
        raise ValueError(f"crop too large: {out_w}x{out_h}")

    dst = np.array([[0, 0], [out_w - 1, 0], [out_w - 1, out_h - 1], [0, out_h - 1]],
                   dtype=np.float32)
    m = cv2.getPerspectiveTransform(c, dst)
    out = cv2.warpPerspective(image_bgr, m, (out_w, out_h), flags=cv2.INTER_CUBIC,
                              borderMode=cv2.BORDER_CONSTANT, borderValue=(255, 255, 255))
    return WarpResult(image=out, width_px=out_w, height_px=out_h,
                      outside=outside, target=label)


def rotate_quad(corners, degrees):
    """Rotate a quad about its own centre - manual skew tuning."""
    c = np.asarray(corners, dtype=np.float32).reshape(4, 2)
    centre = c.mean(axis=0)
    a = np.deg2rad(degrees)
    r = np.array([[np.cos(a), -np.sin(a)], [np.sin(a), np.cos(a)]], dtype=np.float32)
    return ((c - centre) @ r.T + centre).astype(np.float32)
