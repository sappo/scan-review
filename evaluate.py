#!/usr/bin/env python
"""Where the crop detector actually stands, measured against accepted reviews.

Each accept writes a record pairing the frame the detector PROPOSED (`seeded`)
with the frame the operator ACCEPTED. A ratio-locked frame has five degrees of
freedom and each maps to a different part of the detector, so the error is
reported per axis rather than as one blended number:

    centre       the paper mask's centroid - backing/padding thresholds
    scale        mask erosion or dilation - the morphology kernel sizes
    angle        minAreaRect skew
    format       classify() and its tolerance

Accepts the operator did NOT change are counted too. A corpus of only
corrections would be biased.
"""
import argparse
import json
import statistics
import sys
from pathlib import Path

SCHEMA = 2
TRUTH = Path(__file__).resolve().parent / "groundtruth"


def load_records(dirpath=TRUTH):
    out = []
    for p in sorted(Path(dirpath).glob("*.json")):
        rec = json.loads(p.read_text())
        if rec.get("schema") != SCHEMA:
            raise ValueError(
                f"{p.name}: schema {rec.get('schema')!r}, expected {SCHEMA}. "
                "Records from before the ratio-locked frame are not comparable; "
                "delete them rather than reading them as if they matched.")
        out.append(rec)
    return out


def _stats(values):
    if not values:
        return {"mean": None, "median": None, "max": None}
    return {"mean": statistics.fmean(values),
            "median": statistics.median(values),
            "max": max(values)}


def summarise(records):
    errs = [r["error"] for r in records if r.get("error")]
    return {
        "n": len(records),
        "measured": len(errs),
        "unchanged": sum(1 for e in errs if e["unchanged"]),
        "format_agreed": sum(1 for e in errs if e["format_agreed"]),
        "orientation_agreed": sum(1 for e in errs if e["orientation_agreed"]),
        "hint_given": sum(1 for e in errs if e.get("hint_agrees") is not None),
        "hint_agreed": sum(1 for e in errs if e.get("hint_agrees") is True),
        "centre_mm": _stats([e["centre_dist_mm"] for e in errs]),
        "scale_pct": _stats([abs(e["scale"] - 1.0) * 100 for e in errs]),
        "angle_deg": _stats([abs(e["angle_deg"]) for e in errs]),
        # How often the content angle could be measured at all, and by how much
        # it moved the frame off the sheet angle when it could.
        "text_measured": sum(1 for r in records
                             if (r.get("text_skew") or {}).get("confident")),
        "text_residual": _stats([abs(r["text_skew"]["residual_deg"])
                                 for r in records
                                 if (r.get("text_skew") or {}).get("confident")]),
    }


def _fmt(s, unit, places=2):
    if s["mean"] is None:
        return "n/a"
    return (f"mean {s['mean']:.{places}f}{unit}  "
            f"median {s['median']:.{places}f}{unit}  "
            f"max {s['max']:.{places}f}{unit}")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--verbose", action="store_true", help="per-record table")
    ap.add_argument("--dir", default=str(TRUTH))
    args = ap.parse_args(argv)

    records = load_records(args.dir)
    s = summarise(records)
    if not s["n"]:
        print("no ground-truth records yet - review some scans first")
        return 0

    print(f"ground-truth records: {s['n']}")
    print(f"  accepted unchanged : {s['unchanged']}   (detector was right)")
    print(f"  corrected by hand  : {s['measured'] - s['unchanged']}")
    print(f"  format agreement   : {s['format_agreed']}/{s['measured']}")
    print(f"  orientation agree  : {s['orientation_agreed']}/{s['measured']}")
    print(f"  matches panel hint : {s['hint_agreed']}/{s['hint_given']}")
    print()
    print(f"centre error : {_fmt(s['centre_mm'], 'mm')}")
    print(f"scale error  : {_fmt(s['scale_pct'], '%')}")
    print(f"angle error  : {_fmt(s['angle_deg'], 'deg')}")
    print()
    print(f"text deskew  : measured on {s['text_measured']}/{s['n']} pages "
          f"(the rest kept the sheet angle)")
    print(f"  correction : {_fmt(s['text_residual'], 'deg')}")

    worst = sorted((r for r in records if r.get("error")),
                   key=lambda r: r["error"]["centre_dist_mm"], reverse=True)
    print()
    print("worst cases by centre error:")
    print(f"  {'page':28} {'hint':5} {'fmt':5} {'centre':>9} {'scale':>8} {'angle':>8}")
    for r in (worst if args.verbose else worst[:8]):
        e = r["error"]
        print(f"  {r['page'][:28]:28} {str(r.get('hint')):5} "
              f"{str(r['accepted'].get('format')):5} "
              f"{e['centre_dist_mm']:7.2f}mm {(e['scale']-1)*100:6.2f}% "
              f"{e['angle_deg']:6.2f}d")
    return 0


if __name__ == "__main__":
    sys.exit(main())
