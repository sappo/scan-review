import sys, cv2, numpy as np
from detect import detect
from warp import _edge_lengths, classify
DPI = 200; MM = 25.4 / DPI
for p in sys.argv[1:]:
    img = cv2.imread(p)
    d = detect(img)
    print(f"{p}: scan {img.shape[1]}x{img.shape[0]}px")
    if d is None:
        print("  NO DETECTION"); continue
    # Measured from the corners rather than carried on Detection: minAreaRect's
    # w/h are its own axes, which swap under rotation, and nothing else read them.
    w, h = _edge_lengths(np.asarray(d.corners, dtype=np.float32))
    print(f"  quad  : {w*MM:.0f}x{h*MM:.0f}mm  skew={d.angle_deg:+.2f}deg  coverage={d.coverage:.2f}")
    print(f"  corners: {[(int(x), int(y)) for x, y in d.corners]}")
    print(f"  match : {classify(d.corners, dpi=DPI) or 'none'}")
