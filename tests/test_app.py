"""Accept/finalize behaviour that the pure-geometry suite cannot reach.

These drive app.py's endpoint functions directly - there is no httpx in the
venv, so no TestClient - with ROOT-derived paths redirected into tmp_path.
Two properties are pinned here because both were broken and both are invisible
to a suite whose fixtures are all 200 dpi and all fully accepted.
"""
import json
import pathlib

import cv2
import numpy as np
import pytest

import app as A
import documents as D
from warp import PAPER_MM


@pytest.fixture
def env(tmp_path, monkeypatch):
    """Redirect app.py's module-level paths at a scratch tree."""
    for name in ("SPOOL", "WORK", "OUT", "CONSUME", "TRUTH", "ARCHIVE", "THUMBS"):
        p = tmp_path / name.lower()
        p.mkdir(parents=True, exist_ok=True)
        monkeypatch.setattr(A, name, p)
    monkeypatch.setattr(A, "STATE", tmp_path / "work" / "state.json")
    monkeypatch.setattr(A, "DELIVERY_LOG", tmp_path / "deliveries.json")
    return tmp_path


def _scan(env, name, w, h):
    """A blank white scan on disk, big enough to crop from."""
    path = env / "spool" / name
    cv2.imwrite(str(path), np.full((h, w, 3), 255, np.uint8))
    return path


def _page(env, pid, dpi, batch, page_no, status="pending", w=2000, h=2800):
    src = _scan(env, pid, w, h)
    # An A4-shaped quad, inset so nothing hangs off the scan.
    quad = [[100, 100], [w - 100, 100], [w - 100, h - 100], [100, h - 100]]
    return {"id": pid, "source": str(src), "batch": batch, "page_no": page_no,
            "dpi": dpi, "status": status, "format": "A4", "hint": None,
            "width": w, "height": h, "corners": quad, "angle": 0.0,
            "coverage": 1.0, "rotation": 0,
            "detected": {"corners": quad, "angle": 0.0, "format": "A4"},
            "seeded": {"cx": w / 2, "cy": h / 2, "w": w - 200, "h": h - 200,
                       "angle": 0.0, "format": "A4", "orientation": "portrait"},
            "text_skew": None}


def _write_state(env, *pages):
    state = {"pages": {p["id"]: p for p in pages},
             "ingested": [p["id"] for p in pages]}
    A.save_state(state)
    return state


def _accept(page, target="A4"):
    return A.accept(page["id"], A.AcceptBody(corners=page["corners"],
                                             rotation=0, target=target))


@pytest.mark.parametrize("dpi", [150, 200, 300])
def test_accepted_page_is_rendered_at_the_scan_dpi(env, dpi):
    """The output raster must match the page's own dpi.

    finalize() lays each page out at the dpi carried on the page, so a page
    rendered at a different one comes out at the wrong PHYSICAL size: an A4
    scanned at 300dpi but warped at 200 became a 140x198mm PDF page.
    """
    p = _page(env, "a4-20260905-101500-01.png", dpi, "a4-20260905-101500", 1)
    _write_state(env, p)
    r = _accept(p)
    pw, ph = PAPER_MM["A4"]
    assert r["width"] == round(pw / 25.4 * dpi)
    assert r["height"] == round(ph / 25.4 * dpi)
    # ...which is the same as saying it measures A4 when read back at its dpi.
    assert r["width"] / dpi * 25.4 == pytest.approx(pw, abs=0.5)
    assert r["height"] / dpi * 25.4 == pytest.approx(ph, abs=0.5)


def test_ground_truth_records_the_pages_real_dpi(env):
    """`scan.dpi` drives centre_dist_mm, the headline evaluate.py metric."""
    p = _page(env, "a4-20260905-101500-01.png", 300, "a4-20260905-101500", 1)
    _write_state(env, p)
    _accept(p)
    rec = json.loads((A.TRUTH / f"{p['id']}.json").read_text())
    assert rec["scan"]["dpi"] == 300
    # The error decomposition must convert pixels to mm at that same dpi.
    moved = rec["error"]["centre_dist_px"]
    assert rec["error"]["centre_dist_mm"] == pytest.approx(moved * 25.4 / 300)

