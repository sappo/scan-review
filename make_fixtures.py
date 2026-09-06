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


# Flat regions, no per-pixel noise. Noise everywhere made a fixture a 5.5MB PNG
# - random pixels do not compress - and every UI test downloads and decodes one.
# It buys nothing: detect.py separates padding from backing by row MEAN
# (>254.5) as well as row std, and the backing's 125 already fails that test.
def _noise(shape, level):
    return np.zeros(shape)


def sheet(mm, lines, text_angle=0.0, margin=0.12, dpi=DPI):
    """An upright sheet of paper with dark bars standing in for lines of text."""
    w = int(round(mm[0] / 25.4 * dpi))
    h = int(round(mm[1] / 25.4 * dpi))
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


def scan(page, angle=0.0, centre=None, feed_gap=140, dpi=DPI):
    """Place a sheet on the ADF backing at an angle, and pad past the page end."""
    # The scanner's bed is a fixed physical size, so the raster grows with
    # resolution. A fixture that ignored this would be an A4 sheet on an A6
    # bed and classify() would not recognise it.
    k = dpi / DPI
    scan_w, scan_h = int(round(SCAN_W * k)), int(round(SCAN_H * k))
    feed_gap = int(round(feed_gap * k))
    canvas = np.full((scan_h, scan_w), 255, np.uint8)     # synthesised padding
    ph, pw = page.shape
    cx, cy = centre or (scan_w / 2, feed_gap + ph / 2)
    # Backing covers everything the sensor actually saw: down to the page end.
    seen = int(min(scan_h, cy + ph / 2 + feed_gap))
    canvas[:seen] = np.clip(BACKING + _noise((seen, scan_w), 1.0), 0, 255)

    m = cv2.getRotationMatrix2D((pw / 2, ph / 2), -angle, 1.0)
    m[0, 2] += cx - pw / 2
    m[1, 2] += cy - ph / 2
    placed = cv2.warpAffine(page, m, (scan_w, scan_h), flags=cv2.INTER_CUBIC,
                            borderValue=0)
    mask = cv2.warpAffine(np.full_like(page, 255), m, (scan_w, scan_h),
                          flags=cv2.INTER_NEAREST, borderValue=0)
    canvas[mask > 127] = placed[mask > 127]
    return cv2.cvtColor(canvas, cv2.COLOR_GRAY2BGR)


# Three batches, because one ADF run is one document. adf-scan names a run's
# pages BASE-01, BASE-02, ... and that basename is the batch id.
#
# Three and not two: the document navigation tests need somewhere to step to in
# both directions. They used to pass on two fixtures only because the operator's
# own scans were sitting in the same queue - the exact dependency on real data
# this generator exists to remove, and it went unnoticed until the queue was
# emptied.
LETTER = "fx-letter-20260830-120000"
NOTE = "fx-note-20260830-121500"
RECEIPT = "fx-receipt-20260830-130000"

FIXTURES = {
    # A three-page letter: the ordinary case, one printed 1.2 degrees off its
    # sheet (which is what text-primary deskew exists for), one fed at an angle.
    f"{LETTER}-01.png": (lambda: scan(sheet((210, 297), 30)), None, 200),
    f"{LETTER}-02.png": (lambda: scan(sheet((210, 297), 30, text_angle=1.2)), None, 200),
    f"{LETTER}-03.png": (lambda: scan(sheet((210, 297), 30), angle=-2.6), "A4", 200),
    # A separate one-page note. Blank, so the content angle is not measurable
    # and the sheet angle has to stand; the panel hint disagrees with detection.
    f"{NOTE}-01.png": (lambda: scan(sheet((148, 105), 0), angle=-7.7,
                                    centre=(SCAN_W / 2, 700)), "A4", 200),
    # A one-page A5 at 300 dpi. Every other fixture is 200, which is the
    # scanner's usual setting AND the value warp() used to assume - so the test
    # that checks a page reaches the PDF at its true physical size passed
    # against code that ignored dpi entirely. This is the case that catches it.
    f"{RECEIPT}-01.png": (lambda: scan(sheet((148, 210), 18, dpi=300), dpi=300),
                          None, 300),
}


def main(outdir="spool"):
    out = Path(outdir)
    out.mkdir(parents=True, exist_ok=True)
    for name, (build, hint, dpi) in FIXTURES.items():
        cv2.imwrite(str(out / name), build())
        sidecar = out / (name + ".json")
        # dpi always travels, because it is what turns pixels into millimetres.
        meta = {"dpi": str(dpi)}
        if hint:
            meta["hint"] = hint
        sidecar.write_text(json.dumps(meta))
        print(f"  {name}")
    print(f"{len(FIXTURES)} fixtures in {out}/")
    return 0


if __name__ == "__main__":
    sys.exit(main(*sys.argv[1:]))
