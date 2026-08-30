"""Measure page skew from text baselines.

The approach is NAPS2's (`NAPS2.Sdk/Images/Deskewer.cs`, GPL-2.0-or-later,
https://github.com/cyanfish/naps2), reimplemented here from its description
rather than translated, so nothing of that project's code is carried over.

Why it exists alongside `detect.py`. detect.py reports the angle of the SHEET,
from minAreaRect over the paper mask. This reports the angle of the CONTENT,
from the baselines of whatever is printed. They answer different questions and
can disagree - a page printed askew on a straight-fed sheet has two different
"correct" angles - so the text angle is measured as a RESIDUAL on an
already-cropped, already-deskewed page and added to the sheet angle.

Feeding it a FULL scan would not work: the grey ADF backing binarises as one
enormous dark region whose boundary is a near-perfect horizontal line, and that
single edge outvotes every line of text.
"""
from dataclasses import dataclass

import cv2
import numpy as np

# NAPS2's constants, kept at its values and names so the two can be compared.
ANGLE_MIN, ANGLE_MAX = -20.0, 20.0   # near-horizontal lines only
ANGLE_STEPS = 201                    # => 0.2 degree resolution
BEST_MAX_COUNT = 100                 # how many top-scoring lines to consider
BEST_THRESHOLD_INDEX = 9             # measured against the 10th best
BEST_THRESHOLD_FACTOR = 0.5          # ...and must score at least half of it
CLUSTER_TARGET_SPREAD = 2.01         # degrees a cluster may span
IGNORE_EDGE_FRACTION = 0.01          # skip the top/bottom 1%: scanner artefacts

# Below this many candidate lines there is not enough evidence to trust a mean.
MIN_CANDIDATES = 8


@dataclass
class TextSkew:
    angle_deg: float      # 0.0 when not confident
    confident: bool
    candidates: int       # lines that passed the score threshold
    cluster: int          # how many of them agreed on an angle


def bottom_edges(gray):
    """Points where a dark pixel sits directly above a light one.

    Bottom edges specifically, as NAPS2 does: the underside of a line of text is
    a far more reliable horizontal than its top, which is broken up by
    ascenders, and using one side only keeps each glyph from voting twice.
    """
    # Otsu rather than a fixed threshold: exposure varies between scans.
    _, bw = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    dark = bw > 0                                   # True where ink is
    h, w = dark.shape
    # NAPS2 trims only top and bottom, because its input is already cropped to
    # the page. Ours is a warped crop whose sheet border sits on the boundary,
    # and one border line that long forms a broad ridge across many angles in
    # the accumulator - enough to scatter the top-scoring cells and defeat the
    # cluster test. Trimming all four sides removes it.
    oy, ox = int(h * IGNORE_EDGE_FRACTION), int(w * IGNORE_EDGE_FRACTION)
    edge = dark[:-1] & ~dark[1:]                    # dark above, light below
    edge[:1 + oy, :] = False
    edge[h - 2 - oy:, :] = False
    edge[:, :1 + ox] = False
    edge[:, w - 1 - ox:] = False
    ys, xs = np.nonzero(edge)
    return xs.astype(np.float64), ys.astype(np.float64)


def _cluster(angles):
    """The largest group of angles spanning no more than CLUSTER_TARGET_SPREAD."""
    a = np.sort(np.asarray(angles, dtype=np.float64))
    # For each start, how far can we reach while staying inside the spread.
    end = np.searchsorted(a, a + CLUSTER_TARGET_SPREAD, side="right")
    start = int(np.argmax(end - np.arange(a.size)))
    return a[start:end[start]]


def text_skew(image, max_side=1400):
    """Skew of the printed content, in degrees, same sign as frame.quad_angle_deg.

    Returns 0.0 with confident=False when the evidence does not agree with
    itself - a blank page, a photograph, or anything without horizontal
    structure. Reporting "no idea" is the useful answer there; guessing is not.
    """
    gray = image if image.ndim == 2 else cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    # Downscale for speed. Angle is preserved by a uniform scale, and the
    # accumulator's 0.2 degree resolution is far coarser than the loss here.
    scale = min(1.0, max_side / max(gray.shape))
    if scale < 1.0:
        gray = cv2.resize(gray, None, fx=scale, fy=scale,
                          interpolation=cv2.INTER_AREA)

    xs, ys = bottom_edges(gray)
    if xs.size < MIN_CANDIDATES:
        return TextSkew(0.0, False, 0, 0)

    h, w = gray.shape
    thetas = np.deg2rad(np.linspace(ANGLE_MIN, ANGLE_MAX, ANGLE_STEPS))
    # A point (x, y) lies on the line y*cos(t) - x*sin(t) = d. Differentiating
    # along that line gives dy/dx = tan(t), so t is the angle of the line in the
    # same sense as atan2(dy, dx) - i.e. frame.quad_angle_deg's convention.
    d = np.rint(np.outer(np.cos(thetas), ys) - np.outer(np.sin(thetas), xs))
    d = (d + w).astype(np.int64)                    # shift to a non-negative index
    n_d = int(h + w + 2)
    np.clip(d, 0, n_d - 1, out=d)

    # One accumulator row per angle; the count of points sharing a (d, angle).
    score = np.zeros((ANGLE_STEPS, n_d), dtype=np.int32)
    for i in range(ANGLE_STEPS):
        score[i] = np.bincount(d[i], minlength=n_d)[:n_d]

    flat = score.ravel()
    top = np.argpartition(flat, -BEST_MAX_COUNT)[-BEST_MAX_COUNT:]
    top = top[np.argsort(flat[top])[::-1]]
    cutoff = flat[top[BEST_THRESHOLD_INDEX]] * BEST_THRESHOLD_FACTOR
    kept = top[flat[top] >= cutoff]
    if kept.size < MIN_CANDIDATES:
        return TextSkew(0.0, False, int(kept.size), 0)

    angles = np.rad2deg(thetas[kept // n_d])
    group = _cluster(angles)
    # NAPS2's confidence test: the winning cluster has to hold more than half of
    # the candidate lines, otherwise the "lines" disagree and mean nothing.
    if group.size * 2 < kept.size:
        return TextSkew(0.0, False, int(kept.size), int(group.size))
    return TextSkew(float(group.mean()), True, int(kept.size), int(group.size))
