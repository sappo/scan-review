import os

import cv2
import numpy as np
import pytest

import deskew
import frame as F

SPOOL = os.path.join(os.path.dirname(__file__), "..", "spool")


def page_with_text(angle=0.0, w=1200, h=1600, lines=26):
    """A white page with dark bars standing in for lines of text.

    Synthetic rather than a real scan because spool/ holds personal documents
    and is not in the repository, so a test that needed it would only pass on
    this machine.
    """
    img = np.full((h, w), 255, np.uint8)
    x0, x1 = int(w * 0.12), int(w * 0.88)
    for i in range(lines):
        y = int(h * 0.10 + i * h * 0.030)
        cv2.rectangle(img, (x0, y), (x1, y + 9), 0, -1)
    if angle:
        m = cv2.getRotationMatrix2D((w / 2, h / 2), -angle, 1.0)
        img = cv2.warpAffine(img, m, (w, h), flags=cv2.INTER_CUBIC,
                             borderMode=cv2.BORDER_CONSTANT, borderValue=255)
    return img


@pytest.mark.parametrize("angle", [-12.0, -7.5, -3.0, -0.4, 0.0, 0.4, 3.0, 7.5, 12.0])
def test_recovers_a_known_angle(angle):
    r = deskew.text_skew(page_with_text(angle))
    assert r.confident, f"no confidence at {angle} deg"
    assert r.angle_deg == pytest.approx(angle, abs=0.3)


def test_sign_convention_matches_quad_angle():
    # A quad whose top edge falls to the right has a POSITIVE quad_angle; text
    # rotated the same way must report positive too, or the two measurements
    # cannot be added together.
    quad = [[0, 0], [100, 10], [100, 110], [0, 100]]
    assert F.quad_angle_deg(quad) > 0
    assert deskew.text_skew(page_with_text(5.0)).angle_deg > 0


def test_a_blank_page_reports_no_confidence_rather_than_zero_skew():
    r = deskew.text_skew(np.full((1200, 850), 255, np.uint8))
    assert r.confident is False
    assert r.angle_deg == 0.0


def test_noise_without_horizontal_structure_is_not_confident():
    rng = np.random.default_rng(0)
    noise = rng.integers(0, 256, (900, 700), dtype=np.uint8)
    assert deskew.text_skew(noise).confident is False


def test_bottom_edges_ignores_the_page_border():
    # A frame drawn hard against the image edge must not contribute: it is the
    # sheet boundary, and one line that long outvotes every line of text.
    img = np.full((800, 600), 255, np.uint8)
    cv2.rectangle(img, (0, 0), (599, 799), 0, 3)
    xs, _ = deskew.bottom_edges(img)
    assert xs.size < 40, f"border contributed {xs.size} edge points"


def test_downscaling_does_not_move_the_answer():
    page = page_with_text(4.0, w=2000, h=2600)
    big = deskew.text_skew(page, max_side=2600)
    small = deskew.text_skew(page, max_side=900)
    assert big.angle_deg == pytest.approx(small.angle_deg, abs=0.25)


@pytest.mark.skipif(not os.path.exists(os.path.join(SPOOL, "letter-01.png")),
                    reason="needs a real scan in spool/")
def test_real_scan_content_is_about_one_degree_off_its_sheet():
    from warp import warp
    from detect import detect
    img = cv2.imread(os.path.join(SPOOL, "letter-01.png"))
    det = detect(img)
    crop = warp(img, F.corners_of(F.seed_frame(det.corners.tolist(), "A4")),
                target="A4").image
    r = deskew.text_skew(crop)
    # Cross-checked independently with cv2.HoughLinesP, which gives +0.90..+1.05.
    assert r.confident
    assert r.angle_deg == pytest.approx(1.0, abs=0.25)
