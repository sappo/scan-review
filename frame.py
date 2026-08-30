"""The review crop as a ratio-locked rectangle, and its conversions.

The UI's crop is five numbers - centre, size, angle - with `h/w` pinned to an
ISO paper ratio. Four corners are DERIVED from that whenever the server is
called, so `warp.py` and the preview/accept API never learn about frames.

Ratio-locking is therefore a property of the representation: no gesture can
violate it, because no gesture can express a violation. That is the point of
the change - pages come from a sheet-fed ADF, not a handheld camera, so there
is no perspective to correct and a free quad only offers ways to damage a scan.
"""
import numpy as np

from warp import PAPER_MM

PORTRAIT = "portrait"
LANDSCAPE = "landscape"


def ratio(fmt, orientation=PORTRAIT):
    """h/w for an ISO format.

    Read from PAPER_MM rather than assuming sqrt(2): the ISO sizes are rounded
    to whole millimetres, so A4 (1.414286), A5 (1.418919) and A6 (1.409524)
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
    the same number. The tests pin the number, not the prose.
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
