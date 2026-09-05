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


def test_a_sent_document_with_a_rejected_page_leaves_the_queue(env):
    """Rejecting the blank back of a duplex sheet must not strand the document.

    finalize() marked only the ACCEPTED pages, so a rejected sibling kept a
    status outside documents.CLOSED and the whole document came back as an
    empty "delete me" card after its PDF had already been delivered.
    """
    keep = _page(env, "duplex-20260905-101500-01.png", 200,
                 "duplex-20260905-101500", 1)
    blank = _page(env, "duplex-20260905-101500-02.png", 200,
                  "duplex-20260905-101500", 2)
    _write_state(env, keep, blank)
    _accept(keep)
    A.reject(blank["id"])
    A.finalize("duplex-20260905-101500")

    state = A.load_state()
    assert state["pages"][keep["id"]]["status"] == "sent"
    assert state["pages"][blank["id"]]["status"] in D.CLOSED
    assert D.build(state) == []


def test_a_page_cannot_be_reopened_once_its_document_is_sent(env):
    """One ADF run is one document; reopening a sibling would make a second PDF."""
    keep = _page(env, "duplex-20260905-101500-01.png", 200,
                 "duplex-20260905-101500", 1)
    blank = _page(env, "duplex-20260905-101500-02.png", 200,
                  "duplex-20260905-101500", 2)
    _write_state(env, keep, blank)
    _accept(keep)
    A.reject(blank["id"])
    A.finalize("duplex-20260905-101500")
    for pid in (keep["id"], blank["id"]):
        with pytest.raises(Exception) as exc:
            A.reopen(pid)
        assert getattr(exc.value, "status_code", None) == 409


def _archive_names(env):
    return sorted(p.name for p in (A.ARCHIVE).glob("*.png"))


def test_discard_never_overwrites_an_earlier_archived_scan(env):
    """Two sessions produce the same basename; the archive must keep both.

    ingest() goes to real trouble over this - a same-named scan with different
    content is stored under a distinct name, because "silently replacing the
    earlier one would destroy ground-truth data". discard() used shutil.move,
    which clobbers, and so undid exactly that guarantee. The scan is gone for
    good: it is not in spool/ and it is not in the archive either.
    """
    first = _page(env, "scan-01.png", 200, "scan", 1, status="rejected")
    _write_state(env, first)
    # Content A is distinguishable from content B.
    cv2.imwrite(first["source"], np.full((40, 40, 3), 11, np.uint8))
    A.discard("scan")
    assert _archive_names(env) == ["scan-01.png"]
    archived_a = cv2.imread(str(A.ARCHIVE / "scan-01.png"))

    # A later session, same basename, different content.
    second = _page(env, "scan-01.png", 200, "scan", 1, status="rejected")
    _write_state(env, second)
    cv2.imwrite(second["source"], np.full((40, 40, 3), 222, np.uint8))
    A.discard("scan")

    names = _archive_names(env)
    assert len(names) == 2, f"the first scan was overwritten: {names}"
    # ...and the original content is still readable somewhere in the archive.
    survivors = [cv2.imread(str(A.ARCHIVE / n)).mean() for n in names]
    assert any(abs(v - archived_a.mean()) < 1 for v in survivors)


def test_discard_keeps_a_scan_and_its_sidecar_together(env):
    p = _page(env, "scan-01.png", 200, "scan", 1, status="rejected")
    _write_state(env, p)
    side = pathlib.Path(p["source"] + ".json")
    side.write_text('{"batch": "scan", "page": "1"}')
    A.discard("scan")
    png = _archive_names(env)[0]
    assert (A.ARCHIVE / (png + ".json")).exists(), "sidecar lost its scan"


# --------------------------------------------------------------------------
# the accepted frame must describe the corners it arrived with
# --------------------------------------------------------------------------
def _frame_of(page):
    f = dict(page["seeded"])
    f["rotation"] = 0
    return f


def test_a_frame_that_matches_its_corners_is_recorded(env):
    p = _page(env, "a4-20260905-101500-01.png", 200, "a4-20260905-101500", 1)
    _write_state(env, p)
    f = _frame_of(p)
    corners = A.frame_mod.corners_of(f).tolist()
    A.accept(p["id"], A.AcceptBody(corners=corners, rotation=0, target="A4",
                                   frame=f))
    rec = json.loads((A.TRUTH / f"{p['id']}.json").read_text())
    assert rec["accepted"]["w"] == pytest.approx(f["w"])


def test_a_frame_that_contradicts_its_corners_is_refused(env):
    """The ground truth is only worth having if both halves agree.

    `seeded` is computed on the server precisely so a stale client cannot
    misreport the frame it was shown. `accepted` arrived from the client
    alongside the corners and was written down unchecked, so the same class of
    client bug could silently corrupt the other side of every comparison.
    """
    p = _page(env, "a4-20260905-101500-01.png", 200, "a4-20260905-101500", 1)
    _write_state(env, p)
    f = _frame_of(p)
    corners = A.frame_mod.corners_of(f).tolist()
    lying = dict(f, w=f["w"] * 0.5, cx=f["cx"] + 300)
    with pytest.raises(Exception) as exc:
        A.accept(p["id"], A.AcceptBody(corners=corners, rotation=0,
                                       target="A4", frame=lying))
    assert getattr(exc.value, "status_code", None) == 400


def test_a_rotated_frame_still_matches_its_own_corners(env):
    """The check has to survive a real skew, not just an axis-aligned frame."""
    p = _page(env, "a4-20260905-101500-01.png", 200, "a4-20260905-101500", 1)
    _write_state(env, p)
    f = dict(_frame_of(p), angle=-7.679)
    corners = A.frame_mod.corners_of(f).tolist()
    A.accept(p["id"], A.AcceptBody(corners=corners, rotation=0, target="A4",
                                   frame=f))
    rec = json.loads((A.TRUTH / f"{p['id']}.json").read_text())
    assert rec["accepted"]["angle"] == pytest.approx(-7.679, abs=1e-6)


