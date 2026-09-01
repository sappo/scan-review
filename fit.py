"""Largest ratio-locked frame that fits inside the detected sheet.

The seeded frame comes from a least-squares fit to the detector's quad, which
minimises average error and therefore happily hangs over an edge. What the
operator actually wants is different: cover as much of the sheet as possible
WITHOUT crossing it. That is a constrained maximisation, not a fit.

With the ratio pinned and the angle already chosen (deskew runs first), the
frame has three unknowns: centre and scale. Every frame corner is

    corner_k = c + s * R(angle) @ v_k

for the four unit-rectangle corners v_k, so requiring each corner to lie on the
inner side of each sheet edge gives 4x4 = 16 inequalities, all linear in
(cx, cy, s). Maximising s is therefore a small linear program.

Rather than pull in an LP solver, exploit that feasibility is monotone in s --
growing the frame only ever tightens the constraints -- and binary search on s,
testing each candidate by clipping the plane down to the feasible set of
centres. Both steps are a few lines and, importantly, are simple enough to
mirror exactly in the browser: the deskew dial re-fits on every change and
cannot afford a round trip, so this algorithm exists twice. tests/test_fit.py
pins the behaviour both sides must agree on.
"""
import numpy as np

from frame import LANDSCAPE, PORTRAIT, ratio

# Scale search bounds, as a multiple of the sheet's own diagonal. The upper
# bound only has to exceed any feasible frame; the lower bound keeps a
# degenerate result from ever reaching warp(), which dies on a zero-area crop.
_ITERATIONS = 50
_MIN_SCALE = 1e-3


def _inward_edges(quad):
    """(normal, offset) per sheet edge, oriented so `n . x <= d` means inside."""
    q = np.asarray(quad, dtype=np.float64).reshape(4, 2)
    centre = q.mean(axis=0)
    edges = []
    for i in range(4):
        a, b = q[i], q[(i + 1) % 4]
        n = np.array([b[1] - a[1], -(b[0] - a[0])], dtype=np.float64)
        norm = float(np.hypot(*n))
        if norm < 1e-12:            # degenerate quad: skip this edge
            continue
        n /= norm
        d = float(n @ a)
        if n @ centre > d:          # point the normal outward from the centre
            n, d = -n, -d
        edges.append((n, d))
    return edges


def _clip(poly, n, d):
    """Sutherland-Hodgman: the part of `poly` satisfying n . x <= d."""
    out = []
    for i in range(len(poly)):
        cur, nxt = poly[i], poly[(i + 1) % len(poly)]
        cv, nv = n @ cur - d, n @ nxt - d
        if cv <= 0:
            out.append(cur)
        if (cv > 0) != (nv > 0):    # the edge crosses the boundary
            t = cv / (cv - nv)
            out.append(cur + t * (nxt - cur))
    return out


def _centres_for(edges, offsets, bound):
    """Feasible centres for a given scale, as a polygon (possibly empty).

    `offsets[e][k]` is how far corner k reaches along edge e's normal, so the
    centre constraint is `n_e . c <= d_e - max_k offset`.
    """
    poly = [np.array(p, dtype=np.float64) for p in
            ((-bound, -bound), (bound, -bound), (bound, bound), (-bound, bound))]
    for (n, d), reach in zip(edges, offsets):
        poly = _clip(poly, n, d - reach)
        if not poly:
            return []
    return poly


def largest_inside(quad, fmt, angle_deg, orientation=None):
    """The biggest frame of this ratio, at this angle, inside `quad`.

    Returns None when nothing fits - a quad thinner than the minimum crop, or a
    caller-supplied angle that cannot work - so the caller can keep whatever it
    already had rather than show a degenerate frame.
    """
    q = np.asarray(quad, dtype=np.float64).reshape(4, 2)
    edges = _inward_edges(q)
    if len(edges) < 3:
        return None

    if orientation is None:
        from frame import _edge_lengths
        dw, dh = _edge_lengths(q)
        orientation = LANDSCAPE if dw > dh else PORTRAIT
    r = ratio(fmt, orientation)

    a = np.deg2rad(angle_deg)
    rot = np.array([[np.cos(a), -np.sin(a)],
                    [np.sin(a),  np.cos(a)]], dtype=np.float64)
    # Unit frame: width 1, height `r`, centred on the origin.
    unit = np.array([[-0.5, -r / 2], [0.5, -r / 2], [0.5, r / 2], [-0.5, r / 2]],
                    dtype=np.float64)
    rotated = unit @ rot.T

    # Per unit of scale, how far the furthest corner reaches along each edge
    # normal. That corner is the one that binds, so it sets the constraint.
    reach = [float(max(n @ v for v in rotated)) for n, _ in edges]

    bound = float(np.abs(q).max()) * 4.0 + 1.0
    lo, hi = 0.0, float(np.hypot(*(q.max(axis=0) - q.min(axis=0)))) * 2.0
    best = None
    for _ in range(_ITERATIONS):
        mid = (lo + hi) / 2.0
        poly = _centres_for(edges, [rc * mid for rc in reach], bound)
        if poly:
            lo, best = mid, poly
        else:
            hi = mid

    if best is None or lo < _MIN_SCALE:
        return None
    centre = np.mean(np.asarray(best, dtype=np.float64), axis=0)
    return {"cx": float(centre[0]), "cy": float(centre[1]),
            "w": float(lo), "h": float(lo * r),
            "angle": float(angle_deg),
            "format": fmt, "orientation": orientation}
