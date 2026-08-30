"""Locate the sheet of paper in a scan and report its corners and skew.

Three regions appear in a FULL-size scan from this ADF:
  grey backing beside the sheet : mean ~125, very low variance (optically scanned)
  the paper itself             : mean ~240, variance from print and sensor noise
  padding past the sheet end    : exactly 255 with ZERO variance (synthesised)

Brightness alone cannot separate paper from padding (both are bright), and
variance alone cannot separate paper from backing (both are optically scanned).
Combining them does: paper is bright AND not synthetic padding.
"""
from dataclasses import dataclass

import cv2
import numpy as np

BACKING_PAPER_SPLIT = 180   # midpoint between grey backing (~125) and paper (~240)
PADDING_ROW_STD = 0.01      # synthesised padding rows have exactly zero variance


@dataclass
class Detection:
    corners: np.ndarray      # 4x2 float32, ordered TL, TR, BR, BL
    angle_deg: float         # skew; positive = counter-clockwise
    width_px: float
    height_px: float
    coverage: float          # fraction of the mask filled by the chosen contour


def _order_corners(pts):
    """Order 4 points as top-left, top-right, bottom-right, bottom-left.

    Ordering by angle around the centroid rather than by coordinate sums: the
    common sum/diff heuristic silently produces a self-intersecting quad once
    rotation passes ~90 degrees, which would warp to a mangled image. Detection
    never exceeds 45 degrees today, but nothing in the type system says so.
    """
    pts = np.asarray(pts, dtype=np.float32).reshape(4, 2)
    centre = pts.mean(axis=0)
    # Clockwise from the centre keeps the traversal non-self-intersecting.
    order = np.argsort(np.arctan2(pts[:, 1] - centre[1], pts[:, 0] - centre[0]))
    ring = pts[order]
    # Rotate the ring so it starts at the corner nearest the top-left origin.
    start = int(np.argmin(ring.sum(axis=1)))
    return np.roll(ring, -start, axis=0).astype(np.float32)


def paper_mask(gray):
    """Boolean mask of pixels belonging to the sheet."""
    # Rows the backend synthesised after the page ended: uniformly 255.
    row_std = gray.std(axis=1)
    row_mean = gray.mean(axis=1)
    padding_rows = (row_std < PADDING_ROW_STD) & (row_mean > 254.5)

    mask = (gray > BACKING_PAPER_SPLIT).astype(np.uint8) * 255
    mask[padding_rows] = 0

    # Text and dark print punch holes in the mask; close them so the sheet is
    # one solid region, then open to drop speckle in the backing.
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (25, 25))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, k)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN,
                            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9)))
    return mask


def detect(image_bgr):
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)
    mask = paper_mask(gray)

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    contour = max(contours, key=cv2.contourArea)

    rect = cv2.minAreaRect(contour)          # ((cx,cy),(w,h),angle)
    (w, h), angle = rect[1], rect[2]
    # OpenCV reports angle in (-90, 0]; normalise to "how far from upright".
    if angle < -45:
        angle += 90
    corners = _order_corners(cv2.boxPoints(rect))

    area = w * h
    coverage = (cv2.contourArea(contour) / area) if area else 0.0
    return Detection(corners=corners, angle_deg=float(angle),
                     width_px=float(max(w, h) if False else w),
                     height_px=float(h), coverage=float(coverage))
