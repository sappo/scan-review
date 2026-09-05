"""Bounds on the output raster.

`warp()` sizes its output from client-supplied corners when the target is
"free", so the size is attacker-controlled. The existing guard only rejected a
crop that was too SMALL, which left the large end open: a 60000x60000 quad asks
for a 10.8GB BGR allocation in one `cv2.warpPerspective` call, on a host that
also runs mail and a database.
"""
import numpy as np
import pytest

import warp as W


def _square(n):
    return np.array([[0, 0], [n, 0], [n, n], [0, n]], dtype=np.float32)


def test_a_free_crop_larger_than_the_cap_is_refused():
    img = np.full((100, 100, 3), 255, np.uint8)
    with pytest.raises(ValueError, match="crop too large"):
        W.warp(img, _square(60000), target="free")


def test_the_cap_is_on_area_not_on_either_edge():
    # A long thin strip is cheap; a square of the same longest edge is not.
    img = np.full((100, 100, 3), 255, np.uint8)
    strip = np.array([[0, 0], [40000, 0], [40000, 10], [0, 10]], dtype=np.float32)
    W.warp(img, strip, target="free")          # 400k px, fine
    with pytest.raises(ValueError, match="crop too large"):
        W.warp(img, _square(40000), target="free")   # 1.6G px, not fine


def test_an_ordinary_page_is_unaffected():
    img = np.full((2799, 1664, 3), 255, np.uint8)
    # A4 at 600dpi is about 35Mpx - comfortably under the cap.
    out = W.warp(img, _square(1600), target="A4", dpi=600)
    assert out.image.shape[0] > 0


def test_a_quad_that_is_not_four_points_is_refused():
    img = np.full((100, 100, 3), 255, np.uint8)
    for bad in ([[0, 0], [10, 0], [10, 10]], [[0, 0]] * 5, []):
        with pytest.raises(ValueError, match="four corners"):
            W.warp(img, np.array(bad, dtype=np.float32), target="free")
