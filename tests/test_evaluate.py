import json

import pytest

import evaluate as E


def _rec(page, unchanged, dist_mm, scale, angle, fmt_ok=True, hint=True):
    return {"page": page, "schema": 2, "hint": "A6",
            "seeded": {"format": "A6"}, "accepted": {"format": "A6"},
            "error": {"unchanged": unchanged, "centre_dist_mm": dist_mm,
                      "centre_dist_px": dist_mm * 200 / 25.4, "scale": scale,
                      "angle_deg": angle, "format_agreed": fmt_ok,
                      "orientation_agreed": True, "hint_agrees": hint}}


def test_summarise_counts_agreement():
    s = E.summarise([_rec("a", True, 0.0, 1.0, 0.0),
                     _rec("b", False, 2.0, 1.01, 0.5)])
    assert s["n"] == 2
    assert s["unchanged"] == 1
    assert s["format_agreed"] == 2
    assert s["hint_agreed"] == 2


def test_summarise_reports_per_axis_error():
    s = E.summarise([_rec("a", False, 1.0, 1.00, 0.2),
                     _rec("b", False, 3.0, 1.02, -0.4)])
    assert s["centre_mm"]["mean"] == pytest.approx(2.0)
    assert s["centre_mm"]["max"] == pytest.approx(3.0)
    assert s["scale_pct"]["max"] == pytest.approx(2.0, abs=1e-6)
    assert s["angle_deg"]["mean"] == pytest.approx(0.3)


def test_records_of_an_unknown_schema_are_refused_not_misread(tmp_path):
    (tmp_path / "old.json").write_text(json.dumps({"page": "old", "detected": {}}))
    with pytest.raises(ValueError, match="schema"):
        E.load_records(tmp_path)


def test_empty_corpus_summarises_without_dividing_by_zero():
    s = E.summarise([])
    assert s["n"] == 0
    assert s["centre_mm"]["mean"] is None
