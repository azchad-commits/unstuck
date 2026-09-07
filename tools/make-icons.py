"""Generate Unstuck PWA icons: navy square, amber countdown ring, white check-free dial."""
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
    # Center: a bold "U" as the wordmark-lite
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", int(W * 0.42))
    except Exception:
        font = ImageFont.load_default()
    tw = d.textbbox((0, 0), "U", font=font)
    txt_w, txt_h = tw[2] - tw[0], tw[3] - tw[1]
    d.text((cx - txt_w / 2 - tw[0], cy - txt_h / 2 - tw[1]), "U", font=font, fill=WHITE)
    return img.resize((size, size), Image.LANCZOS)

for s in (192, 512):
    draw(s).save(os.path.join(OUT, f"icon-{s}.png"))
    draw(s, maskable=True).save(os.path.join(OUT, f"maskable-{s}.png"))
draw(180).save(os.path.join(OUT, "apple-touch-icon.png"))
draw(32).save(os.path.join(OUT, "favicon-32.png"))
print("icons written to", os.path.abspath(OUT))
