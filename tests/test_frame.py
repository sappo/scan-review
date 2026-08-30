import math

import numpy as np
import pytest

import frame as F

# The real A6 detection from scan `clash.png`, kept as the reference fixture.
A6_CORNERS = [[264.094482421875, 52.032203674316406],
              [1416.6912841796875, -103.3741226196289],
              [1527.88134765625, 721.2855834960938],
              [375.2845458984375, 876.6919555664062]]
A6_ANGLE = -7.678964138031006


def test_ratios_come_from_paper_mm_not_sqrt2():
    # The ISO sizes are whole millimetres, so the three ratios genuinely differ.
    assert F.ratio("A4", F.PORTRAIT) == pytest.approx(297 / 210, abs=1e-9)
    assert F.ratio("A5", F.PORTRAIT) == pytest.approx(210 / 148, abs=1e-9)
    assert F.ratio("A6", F.PORTRAIT) == pytest.approx(148 / 105, abs=1e-9)
    # ...and they are NOT all sqrt(2).
    assert F.ratio("A5", F.PORTRAIT) != pytest.approx(math.sqrt(2), abs=1e-6)


def test_landscape_ratio_is_the_reciprocal():
    assert F.ratio("A6", F.LANDSCAPE) == pytest.approx(105 / 148, abs=1e-9)


def test_corners_are_ordered_tl_tr_br_bl_in_frame_space():
    f = {"cx": 100.0, "cy": 200.0, "w": 40.0, "h": 20.0, "angle": 0.0}
    c = F.corners_of(f)
    assert c.shape == (4, 2)
    np.testing.assert_allclose(c, [[80, 190], [120, 190], [120, 210], [80, 210]],
                               atol=1e-6)


def test_frame_corners_roundtrip_at_many_angles():
    src = {"cx": 512.0, "cy": 733.0, "w": 400.0, "h": 565.7, "angle": 0.0}
    for deg in (-44.0, -7.679, -0.5, 0.0, 0.5, 7.679, 44.0):
        f = dict(src, angle=deg)
        back = F.frame_from_corners(F.corners_of(f))
        for k in ("cx", "cy", "w", "h", "angle"):
            assert back[k] == pytest.approx(f[k], abs=1e-3), f"{k} at {deg} deg"


def test_quad_angle_matches_the_detector_on_the_real_a6():
    # detect.py and app.quad_angle document opposite sign conventions but produce
    # the same number. This pins the number, not the prose.
    assert F.quad_angle_deg(A6_CORNERS) == pytest.approx(A6_ANGLE, abs=1e-6)
