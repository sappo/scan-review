import sys, cv2, numpy as np
from detect import detect
from warp import warp
DPI = 200; MM = 25.4/DPI
for p in sys.argv[1:]:
    img = cv2.imread(p)
    d = detect(img)
    r = warp(img, d.corners)
    out = f"work/{p.split('/')[-1].replace('.png','')}-cropped.png"
    cv2.imwrite(out, r.image)
    g = cv2.cvtColor(r.image, cv2.COLOR_BGR2GRAY).astype(float)
    src = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(float)
    # Did we remove the synthetic padding? It is exactly 255 with zero variance.
    pad_before = ((src.std(axis=1) < 0.01) & (src.mean(axis=1) > 254.5)).sum()
    pad_after = ((g.std(axis=1) < 0.01) & (g.mean(axis=1) > 254.5)).sum()
    print(f"{p}")
    print(f"  cropped -> {r.width_px}x{r.height_px}px = {r.width_px*MM:.0f}x{r.height_px*MM:.0f}mm  clamped={r.clamped}")
    print(f"  content : mean={g.mean():.1f} std={g.std():.1f} nonwhite={(g<200).mean()*100:.2f}%")
    print(f"  padding rows: {pad_before} before -> {pad_after} after")
    print(f"  wrote {out}")
