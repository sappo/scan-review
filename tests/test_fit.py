"""The auto-fit must never leave the sheet, and must not leave room on the table.

These two properties are the whole point: the seeded least-squares frame was
allowed to overhang, and a merely "inside" frame could be trivially satisfied by
something tiny. Each test therefore checks containment AND maximality.
"""
import math

import numpy as np
import pytest

import fit
import frame as frame_mod


def rotate(points, deg, about):
    a = math.radians(deg)
    r = np.array([[math.cos(a), -math.sin(a)], [math.sin(a), math.cos(a)]])
    p = np.asarray(points, dtype=float) - about
    return (p @ r.T) + about


def inside(quad, corners, tol=1e-2):
    """Every corner on the inner side of every sheet edge.

    Tolerance is a hundredth of a pixel, not zero: corners_of() returns
    float32, whose precision at ~2400px is around 2e-4, so an exact fit reads
    as ~7e-5 outside. The fit itself is exact -- recomputed in float64 the
    same frame sits at -0.0 -- and a hundredth of a pixel is far below
    anything the crop can express.
    """
    for n, d in fit._inward_edges(quad):
        for c in corners:
            if n @ np.asarray(c, dtype=float) > d + tol:
                return False
    return True


SHEET = [[100, 100], [1763, 100], [1763, 2428], [100, 2428]]


def test_fitted_frame_stays_inside_the_sheet():
    f = fit.largest_inside(SHEET, "A4", 0.0)
    assert inside(SHEET, frame_mod.corners_of(f))


def test_fitted_frame_cannot_grow():
    """Maximal: 1% wider already crosses an edge."""
    f = fit.largest_inside(SHEET, "A4", 0.0)
    bigger = dict(f, w=f["w"] * 1.01, h=f["h"] * 1.01)
    assert not inside(SHEET, frame_mod.corners_of(bigger))


def test_keeps_the_locked_ratio():
    f = fit.largest_inside(SHEET, "A4", 0.0)
    assert f["h"] / f["w"] == pytest.approx(frame_mod.ratio("A4", "portrait"), abs=1e-9)


@pytest.mark.parametrize("angle", [-7.5, -2.0, 0.0, 1.3, 6.0])
def test_stays_inside_at_any_angle(angle):
    """The dial re-fits on every change, so every angle must be safe."""
    f = fit.largest_inside(SHEET, "A4", angle)
    assert f["angle"] == pytest.approx(angle)
    assert inside(SHEET, frame_mod.corners_of(f))


def test_a_skewed_sheet_is_handled():
    """A sheet that fed crooked: the quad is rotated, not axis-aligned."""
    skewed = rotate(SHEET, 4.0, np.array([931.5, 1264.0]))
    f = fit.largest_inside(skewed, "A4", 4.0)
    assert inside(skewed, frame_mod.corners_of(f))
    # Matching the sheet's own angle should recover nearly all of it.
    sheet_area = 1663 * 2328
    assert (f["w"] * f["h"]) / sheet_area > 0.97


def test_wrong_angle_costs_area_but_still_fits():
    """Deskew is a prerequisite: a bad angle shrinks the frame, never breaks it."""
    skewed = rotate(SHEET, 4.0, np.array([931.5, 1264.0]))
    good = fit.largest_inside(skewed, "A4", 4.0)
    bad = fit.largest_inside(skewed, "A4", -4.0)
    assert inside(skewed, frame_mod.corners_of(bad))
    assert bad["w"] < good["w"]


def test_beats_the_least_squares_seed_on_containment():
    """The seed is allowed to overhang; that is what this replaces."""
    skewed = rotate(SHEET, 3.0, np.array([931.5, 1264.0]))
    seeded = frame_mod.seed_frame(skewed, "A4")
    fitted = fit.largest_inside(skewed, "A4", seeded["angle"])
    assert inside(skewed, frame_mod.corners_of(fitted))


def test_degenerate_quad_returns_none():
    """Nothing fits in a line, and the caller must keep what it had."""
    assert fit.largest_inside([[0, 0], [10, 0], [10, 0], [0, 0]], "A4", 0.0) is None
