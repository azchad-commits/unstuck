"""Generate Dayfall PWA icons: navy square, amber countdown ring, and the Dayfall mark —
a grain of "today" falling onto the pile of days already done."""
from PIL import Image, ImageDraw, ImageFont
import os, math

NAVY = (15, 42, 68); AMBER = (232, 163, 61); WHITE = (255, 255, 255); PAPER = (233, 238, 243)
OUT = os.path.join(os.path.dirname(__file__), "..", "icons")
os.makedirs(OUT, exist_ok=True)

def draw(size, maskable=False):
    S = 4  # supersample
    W = size * S
    img = Image.new("RGBA", (W, W), NAVY + (255,))
    d = ImageDraw.Draw(img)
    # Maskable icons must keep content inside the inner 80% "safe zone".
    pad = W * (0.20 if maskable else 0.12)
    box = [pad, pad, W - pad, W - pad]
    ring = W * 0.075
    # Track (dim) + progress arc (amber): 270° of a countdown, starting at 12 o'clock.
    d.arc(box, 0, 360, fill=(52, 76, 100), width=int(ring))
    d.arc(box, -90, 180, fill=AMBER, width=int(ring))
    # Rounded arc end caps
    r = ring / 2
    cx, cy = W / 2, W / 2
    rad = (W - 2 * pad) / 2 - r
    for ang in (-90, 180):
        a = math.radians(ang)
        px, py = cx + rad * math.cos(a), cy + rad * math.sin(a)
        d.ellipse([px - r, py - r, px + r, py + r], fill=AMBER)
    # Center: the Dayfall mark — a white grain (today) falling onto the amber pile (days done),
    # with a dimming trail above it. Maskable icons shrink the motif into the safe zone.
    def blend(c1, c2, t):
        return tuple(round(a * (1 - t) + b * t) for a, b in zip(c1, c2))
    k = 0.72 if maskable else 1.0
    mound_w, mound_h = W * 0.32 * k, W * 0.115 * k
    mound_top = cy + W * 0.115 * k
    d.ellipse([cx - mound_w / 2, mound_top, cx + mound_w / 2, mound_top + mound_h], fill=AMBER)
    for dy, r, t in ((-0.235, 0.028, 0.30), (-0.115, 0.040, 0.55)):
        rr = W * r * k
        d.ellipse([cx - rr, cy + W * dy * k - rr, cx + rr, cy + W * dy * k + rr], fill=blend(NAVY, AMBER, t))
    rr = W * 0.056 * k
    gy = cy + W * 0.02 * k
    d.ellipse([cx - rr, gy - rr, cx + rr, gy + rr], fill=WHITE)
    return img.resize((size, size), Image.LANCZOS)

for s in (192, 512):
    draw(s).save(os.path.join(OUT, f"icon-{s}.png"))
    draw(s, maskable=True).save(os.path.join(OUT, f"maskable-{s}.png"))
draw(180).save(os.path.join(OUT, "apple-touch-icon.png"))
draw(32).save(os.path.join(OUT, "favicon-32.png"))
print("icons written to", os.path.abspath(OUT))
