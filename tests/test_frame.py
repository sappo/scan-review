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


# The real A4 detection from `letter-01.png`: full scan width, ratio 0.7144.
A4_CORNERS = [[0.0, 0.0], [1663.0, 0.0], [1663.0, 2328.0], [0.0, 2328.0]]


def test_seed_locks_the_ratio_exactly():
    f = F.seed_frame(A4_CORNERS, "A4")
    assert f["h"] / f["w"] == pytest.approx(F.ratio("A4", F.PORTRAIT), abs=1e-9)


def test_seed_splits_the_error_between_both_axes():
    # Detected 1663x2328 (ratio 0.7144) cannot be A4 (0.707071) exactly. The
    # least-squares scale lands between: narrower AND taller, not one or other.
    f = F.seed_frame(A4_CORNERS, "A4")
    assert f["w"] == pytest.approx(1651.7, abs=0.5)
    assert f["h"] == pytest.approx(2335.9, abs=0.5)
    assert f["w"] < 1663.0 and f["h"] > 2328.0


def test_seed_centres_on_the_detected_centroid():
    f = F.seed_frame(A4_CORNERS, "A4")
    assert f["cx"] == pytest.approx(831.5, abs=1e-6)
    assert f["cy"] == pytest.approx(1164.0, abs=1e-6)


def test_seed_infers_landscape_from_the_real_a6():
    f = F.seed_frame(A6_CORNERS, "A6")
    assert f["orientation"] == F.LANDSCAPE
    assert f["cx"] == pytest.approx(896.0, abs=0.1)
    assert f["cy"] == pytest.approx(386.7, abs=0.1)
    assert f["w"] == pytest.approx(1166.3, abs=0.1)
    assert f["h"] == pytest.approx(827.5, abs=0.1)
    assert f["angle"] == pytest.approx(A6_ANGLE, abs=1e-6)
    assert f["format"] == "A6"


def test_seed_of_an_unknown_format_is_rejected():
    with pytest.raises(KeyError):
        F.seed_frame(A4_CORNERS, "free")


SEED = {"cx": 896.0, "cy": 386.7, "w": 1166.3, "h": 827.5, "angle": -7.679,
        "format": "A6", "orientation": F.LANDSCAPE}


def _acc(**over):
    return dict(SEED, **over)


def test_error_is_zero_and_unchanged_for_an_untouched_accept():
    e = F.frame_error(SEED, _acc())
    assert e["centre_dist_px"] == pytest.approx(0.0, abs=1e-9)
    assert e["scale"] == pytest.approx(1.0, abs=1e-9)
    assert e["angle_deg"] == pytest.approx(0.0, abs=1e-9)
    assert e["unchanged"] is True


def test_error_reports_centre_shift_in_px_and_mm():
    e = F.frame_error(SEED, _acc(cx=901.5, cy=388.3))
    assert e["centre_px"] == pytest.approx([5.5, 1.6], abs=1e-6)
    assert e["centre_dist_px"] == pytest.approx(5.728, abs=1e-3)
    assert e["centre_dist_mm"] == pytest.approx(0.727, abs=1e-3)
    assert e["unchanged"] is False


def test_scale_uses_the_long_edge_so_it_survives_a_format_change():
    # A6 landscape (long edge = w) accepted as A4 portrait (long edge = h).
    e = F.frame_error(SEED, _acc(w=825.0, h=1166.3, format="A4",
                                 orientation=F.PORTRAIT))
    assert e["scale"] == pytest.approx(1.0, abs=1e-9)
    assert e["format_agreed"] is False
    assert e["orientation_agreed"] is False


def test_angle_error_is_the_dial_value():
    e = F.frame_error(SEED, _acc(angle=-7.380))
    assert e["angle_deg"] == pytest.approx(0.299, abs=1e-6)


def test_unchanged_tolerates_sub_pixel_noise_but_not_a_real_correction():
    assert F.frame_error(SEED, _acc(cx=896.9))["unchanged"] is True
    assert F.frame_error(SEED, _acc(cx=897.5))["unchanged"] is False
    assert F.frame_error(SEED, _acc(angle=-7.66))["unchanged"] is True
    assert F.frame_error(SEED, _acc(angle=-7.60))["unchanged"] is False
