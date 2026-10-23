"""生成 PWA 图标（192 / 512 / maskable / favicon）"""
import os
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'icons')
os.makedirs(OUT, exist_ok=True)

BG = (245, 242, 234)
ACCENT = (178, 69, 44)
INK = (36, 33, 28)

FONT_CANDIDATES = [
    r'C:\Windows\Fonts\msyhbd.ttc',
    r'C:\Windows\Fonts\msyh.ttc',
    r'C:\Windows\Fonts\simhei.ttf',
    r'C:\Windows\Fonts\Dengl.ttf',
]


def load_font(size):
    for p in FONT_CANDIDATES:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return ImageFont.load_default()


def draw_icon(size, maskable=False):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad = int(size * 0.18) if maskable else 0
    box = (pad, pad, size - pad, size - pad)
    radius = int((size - 2 * pad) * 0.24)
    d.rounded_rectangle(box, radius=radius, fill=BG)
    # 内圈强调色方块
    inset = int((size - 2 * pad) * 0.13)
    inner = (box[0] + inset, box[1] + inset, box[2] - inset, box[3] - inset)
    ir = int((inner[2] - inner[0]) * 0.26)
    d.rounded_rectangle(inner, radius=ir, fill=ACCENT)

    text = '词'
    f = load_font(int((inner[2] - inner[0]) * 0.62))
    bbox = d.textbbox((0, 0), text, font=f)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    cx = (inner[0] + inner[2]) / 2 - tw / 2 - bbox[0]
    cy = (inner[1] + inner[3]) / 2 - th / 2 - bbox[1]
    d.text((cx, cy), text, font=f, fill=(255, 250, 244, 255))
    return img


for size in (192, 512):
    draw_icon(size).save(os.path.join(OUT, f'icon-{size}.png'))
draw_icon(512, maskable=True).save(os.path.join(OUT, 'icon-maskable-512.png'))
draw_icon(180).save(os.path.join(OUT, 'apple-touch-icon.png'))
print('icons written to', os.path.abspath(OUT))

# 安卓启动图标（aapt2 按 mipmap-<density> 目录取用）
ANDROID_RES = os.path.join(os.path.dirname(__file__), '..', 'android', 'res')
DENSITIES = [('mdpi', 48), ('hdpi', 72), ('xhdpi', 96), ('xxhdpi', 144), ('xxxhdpi', 192)]
for density, size in DENSITIES:
    d = os.path.join(ANDROID_RES, f'mipmap-{density}')
    os.makedirs(d, exist_ok=True)
    draw_icon(size).save(os.path.join(d, 'ic_launcher.png'))
print('android mipmaps written to', os.path.abspath(ANDROID_RES))

