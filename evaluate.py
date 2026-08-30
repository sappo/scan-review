#!/usr/bin/env python3
"""Report how well the automatic detector matches what humans actually accepted.

Every accept writes a ground-truth record pairing the DETECTED quad with the
ACCEPTED one. Agreement matters as much as correction, so untouched accepts are
recorded too - they are the evidence that the detector was already right.

usage: evaluate.py [--dir groundtruth] [--verbose]
"""
import argparse
import json
import statistics
from pathlib import Path

UNTOUCHED_PX = 2.0      # below this the human effectively accepted the proposal


def angle_error(rec):
    d = rec.get("detected", {}).get("angle")
    a = rec.get("accepted", {}).get("angle")
    if d is None or a is None:
        return None
    # Both describe the top edge; compare as a signed difference wrapped to +/-90.
    err = (a - d + 90) % 180 - 90
    return err


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=str(Path(__file__).parent / "groundtruth"))
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    files = sorted(Path(args.dir).glob("*.json"))
    if not files:
        print(f"No ground-truth records in {args.dir} yet.")
        print("Scan documents, review them, and accept each page; a record is")
        print("written on every accept.")
        return 0

    recs = []
    for f in files:
        try:
            recs.append(json.loads(f.read_text()))
        except json.JSONDecodeError:
            print(f"  skipping unreadable record: {f.name}")

    shifts = [r["corner_shift_px"] for r in recs if r.get("corner_shift_px") is not None]
    errs = [(r, angle_error(r)) for r in recs]
    errs = [(r, e) for r, e in errs if e is not None]
    untouched = [r for r in recs
                 if (r.get("corner_shift_px") or 0) <= UNTOUCHED_PX]
    corrected = [r for r in recs
                 if (r.get("corner_shift_px") or 0) > UNTOUCHED_PX]

    print(f"ground-truth records: {len(recs)}")
    print(f"  accepted unchanged : {len(untouched)}   (detector was right)")
    print(f"  corrected by hand  : {len(corrected)}")

    fmt_known = [r for r in recs if r.get("detected", {}).get("format")]
    if fmt_known:
        agreed = sum(1 for r in fmt_known if r.get("format_agreed"))
        print(f"  format agreement   : {agreed}/{len(fmt_known)} "
              f"({100*agreed/len(fmt_known):.0f}%)")

    hinted = [r for r in recs if r.get("hint")]
    if hinted:
        ok = sum(1 for r in hinted if r["hint"] == r.get("detected", {}).get("format"))
        print(f"  matches panel hint : {ok}/{len(hinted)} "
              f"({100*ok/len(hinted):.0f}%)")

    if errs:
        vals = [abs(e) for _, e in errs]
        print(f"\nskew error (accepted minus detected), degrees:")
        print(f"  mean |err| {statistics.mean(vals):.3f}   median |err| "
              f"{statistics.median(vals):.3f}   max |err| {max(vals):.3f}")
        if len(vals) > 1:
            print(f"  stdev {statistics.pstdev(vals):.3f}")
    if shifts:
        print(f"corner displacement, px: mean {statistics.mean(shifts):.1f}  "
              f"median {statistics.median(shifts):.1f}  max {max(shifts):.1f}")

    worst = sorted(errs, key=lambda t: -abs(t[1]))[:10]
    if worst:
        print(f"\nworst cases by skew error:")
        print(f"  {'page':26s} {'hint':5s} {'det':5s} {'acc':5s} "
              f"{'skew_err':>9s} {'shift_px':>9s}")
        for r, e in worst:
            print(f"  {r['id'][:26]:26s} {str(r.get('hint'))[:5]:5s} "
                  f"{str(r.get('detected',{}).get('format'))[:5]:5s} "
                  f"{str(r.get('accepted',{}).get('format'))[:5]:5s} "
                  f"{e:+9.3f} {(r.get('corner_shift_px') or 0):9.1f}")

    if args.verbose:
        print("\nall records:")
        for r in recs:
            print(f"  {r['id']}: detected {r.get('detected',{}).get('angle')} -> "
                  f"accepted {r.get('accepted',{}).get('angle')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
