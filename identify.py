"""Identify each captured sheet by measuring its paper area.

Past the sheet the scanner backend pads exactly 255 with zero variance, while
real scanned paper carries sensor noise. So the paper is found by VARIANCE, not
brightness - white paper on a white background has no brightness edge at all.
"""
import sys
import numpy as np
from PIL import Image

DPI = 200
MM = 25.4 / DPI


def paper_bbox(gray, noise_threshold=0.5, window=8):
    """Rows/cols whose local variance shows real sensor noise (i.e. actual paper)."""
    row_std = np.array([gray[max(0, i - window):i + window].std() for i in range(gray.shape[0])])
    col_std = np.array([gray[:, max(0, j - window):j + window].std() for j in range(gray.shape[1])])
    rows = np.where(row_std > noise_threshold)[0]
    cols = np.where(col_std > noise_threshold)[0]
    if len(rows) == 0 or len(cols) == 0:
        return None
    return rows.min(), rows.max(), cols.min(), cols.max()


for path in sys.argv[1:]:
    img = Image.open(path).convert("RGB")
    a = np.asarray(img, dtype=np.float32)
    gray = a.mean(axis=2)
    h, w = gray.shape
    bbox = paper_bbox(gray)
    print(f"{path}")
    print(f"  scan   : {w}x{h}px = {w*MM:.0f}x{h*MM:.0f}mm")
    if bbox:
        r0, r1, c0, c1 = bbox
        pw, ph = (c1 - c0 + 1) * MM, (r1 - r0 + 1) * MM
        print(f"  paper  : rows {r0}..{r1} cols {c0}..{c1} => {pw:.0f}x{ph:.0f}mm")
        for name, (sw, sh) in {"A4": (210, 297), "A5": (148, 210), "A6": (105, 148)}.items():
            if abs(pw - sw) < 12 and abs(ph - sh) < 12:
                print(f"  match  : {name}")
    print(f"  content: nonwhite={(gray < 200).mean()*100:.2f}% mean={gray.mean():.1f} std={gray.std():.1f}")
