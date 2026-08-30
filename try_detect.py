import sys, cv2, numpy as np
from detect import detect
DPI = 200; MM = 25.4 / DPI
for p in sys.argv[1:]:
    img = cv2.imread(p)
    d = detect(img)
    print(f"{p}: scan {img.shape[1]}x{img.shape[0]}px")
    if d is None:
        print("  NO DETECTION"); continue
    print(f"  quad  : {d.width_px*MM:.0f}x{d.height_px*MM:.0f}mm  skew={d.angle_deg:+.2f}deg  coverage={d.coverage:.2f}")
    print(f"  corners: {[(int(x), int(y)) for x, y in d.corners]}")
    for name, (sw, sh) in {"A4": (210,297), "A5": (148,210), "A6": (105,148)}.items():
        dims = sorted([d.width_px*MM, d.height_px*MM]); std = sorted([sw, sh])
        if abs(dims[0]-std[0]) < 12 and abs(dims[1]-std[1]) < 12:
            print(f"  match : {name}")
