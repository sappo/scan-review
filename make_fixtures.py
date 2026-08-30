#!/usr/bin/env python
"""Generate synthetic FULL-size scans for the test suite.

The suite used to run against real scans sitting in spool/. Those are personal
documents, they are not in the repository, and they were consumed by the tests -
so the suite only ever worked on one machine, and only until the queue emptied.

These stand in for what the ADF actually produces, which is what detect.py keys
off (see README, "How the sheet is found"):

    grey ADF backing beside the sheet   mean ~125, std ~1     (optically scanned)
    the paper                           mean ~240, some noise
    padding past the page end           exactly 255, std 0    (synthesised)

    ./.venv/bin/python make_fixtures.py [outdir]
"""
import json
import sys
from pathlib import Path

import cv2
import numpy as np

SCAN_W, SCAN_H = 1664, 2799      # what the ADS-2100e produces at 200 dpi, FULL
DPI = 200
BACKING, PAPER = 125, 240
rng = np.random.default_rng(7)


def _noise(shape, level):
    return rng.normal(0.0, level, shape)


def sheet(mm, lines, text_angle=0.0, margin=0.12):
    """An upright sheet of paper with dark bars standing in for lines of text."""
    w = int(round(mm[0] / 25.4 * DPI))
    h = int(round(mm[1] / 25.4 * DPI))
    page = np.clip(PAPER + _noise((h, w), 3.0), 0, 255).astype(np.uint8)
    if lines:
        bars = np.zeros((h, w), np.uint8)
        x0, x1 = int(w * margin), int(w * (1 - margin))
        step = (h * (1 - 2 * margin)) / lines
        for i in range(lines):
            y = int(h * margin + i * step)
            cv2.rectangle(bars, (x0, y), (x1, y + max(4, int(step * 0.22))), 255, -1)
        if text_angle:
            m = cv2.getRotationMatrix2D((w / 2, h / 2), -text_angle, 1.0)
            bars = cv2.warpAffine(bars, m, (w, h), flags=cv2.INTER_NEAREST)
        page[bars > 0] = 30
    return page


def scan(page, angle=0.0, centre=None, feed_gap=140):
    """Place a sheet on the ADF backing at an angle, and pad past the page end."""
    canvas = np.full((SCAN_H, SCAN_W), 255, np.uint8)     # synthesised padding
    ph, pw = page.shape
    cx, cy = centre or (SCAN_W / 2, feed_gap + ph / 2)
    # Backing covers everything the sensor actually saw: down to the page end.
    seen = int(min(SCAN_H, cy + ph / 2 + feed_gap))
    canvas[:seen] = np.clip(BACKING + _noise((seen, SCAN_W), 1.0), 0, 255)

    m = cv2.getRotationMatrix2D((pw / 2, ph / 2), -angle, 1.0)
    m[0, 2] += cx - pw / 2
    m[1, 2] += cy - ph / 2
    placed = cv2.warpAffine(page, m, (SCAN_W, SCAN_H), flags=cv2.INTER_CUBIC,
                            borderValue=0)
    mask = cv2.warpAffine(np.full_like(page, 255), m, (SCAN_W, SCAN_H),
                          flags=cv2.INTER_NEAREST, borderValue=0)
    canvas[mask > 127] = placed[mask > 127]
    return cv2.cvtColor(canvas, cv2.COLOR_GRAY2BGR)


# Two batches, because one ADF run is one document. adf-scan names a run's
# pages BASE-01, BASE-02, ... and that basename is the batch id.
LETTER = "fx-letter-20260830-120000"
NOTE = "fx-note-20260830-121500"

FIXTURES = {
    # A three-page letter: the ordinary case, one printed 1.2 degrees off its
    # sheet (which is what text-primary deskew exists for), one fed at an angle.
    f"{LETTER}-01.png": (lambda: scan(sheet((210, 297), 30)), None),
    f"{LETTER}-02.png": (lambda: scan(sheet((210, 297), 30, text_angle=1.2)), None),
    f"{LETTER}-03.png": (lambda: scan(sheet((210, 297), 30), angle=-2.6), "A4"),
    # A separate one-page note. Blank, so the content angle is not measurable
    # and the sheet angle has to stand; the panel hint disagrees with detection.
    f"{NOTE}-01.png": (lambda: scan(sheet((148, 105), 0), angle=-7.7,
                                    centre=(SCAN_W / 2, 700)), "A4"),
}


def main(outdir="spool"):
    out = Path(outdir)
    out.mkdir(parents=True, exist_ok=True)
    for name, (build, hint) in FIXTURES.items():
        cv2.imwrite(str(out / name), build())
        sidecar = out / (name + ".json")
        if hint:
            sidecar.write_text(json.dumps({"hint": hint}))
        elif sidecar.exists():
            sidecar.unlink()
        print(f"  {name}")
    print(f"{len(FIXTURES)} fixtures in {out}/")
    return 0


if __name__ == "__main__":
    sys.exit(main(*sys.argv[1:]))
