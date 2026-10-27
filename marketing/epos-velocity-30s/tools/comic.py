import sys, os, numpy as np
from PIL import Image, ImageFilter, ImageEnhance
from multiprocessing import Pool

def comic(path, out):
    im = Image.open(path).convert('RGB')
    h = 1080; w = round(im.width * h / im.height)
    im = im.resize((w, h), Image.LANCZOS)
    im = ImageEnhance.Contrast(im).enhance(1.25)
    im = ImageEnhance.Color(im).enhance(1.9)
    cel = im.filter(ImageFilter.MedianFilter(5))
    a = np.asarray(cel).astype(np.float32) / 255
    # posterize with soft mix
    lv = 5
    post = np.round(a * (lv - 1)) / (lv - 1)
    col = post * 0.7 + a * 0.3
    # ink edges
    g = np.asarray(im.convert('L').filter(ImageFilter.GaussianBlur(1.6))).astype(np.float32)
    gx = np.zeros_like(g); gy = np.zeros_like(g)
    gx[:, 1:-1] = g[:, 2:] - g[:, :-2]; gy[1:-1] = g[2:] - g[:-2]
    mag = np.hypot(gx, gy)
    ink = (mag > 22).astype(np.uint8) * 255
    ink = np.asarray(Image.fromarray(ink).filter(ImageFilter.MaxFilter(3))).astype(np.float32) / 255
    # halftone in shadows (45deg grid)
    lum = (a * [0.299, 0.587, 0.114]).sum(2)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    sp = 10.0
    u = (xx + yy) / 1.41421 / sp; v = (xx - yy) / 1.41421 / sp
    d = np.hypot(u - np.round(u), v - np.round(v)) * sp
    dark = np.clip((0.62 - lum) / 0.62, 0, 1)
    dot = (d < sp * 0.62 * np.sqrt(dark)).astype(np.float32)
    col = col * (1 - 0.55 * dot[..., None])
    # light dots of warm tone in highlights for pop-art paper feel
    light = np.clip((lum - 0.7) / 0.3, 0, 1)
    dot2 = (d < sp * 0.28 * light).astype(np.float32)
    col = col * (1 - 0.12 * dot2[..., None])
    col = col * (1 - ink[..., None] * 0.92)
    Image.fromarray((np.clip(col, 0, 1) * 255).astype(np.uint8)).save(out, quality=90)

def job(args): comic(*args)

if __name__ == '__main__':
    root = sys.argv[1]; clips = sys.argv[2:]
    jobs = []
    for c in clips:
        od = os.path.join(root, c + '_comic'); os.makedirs(od, exist_ok=True)
        for f in sorted(os.listdir(os.path.join(root, c))):
            jobs.append((os.path.join(root, c, f), os.path.join(od, f)))
    with Pool(4) as p: p.map(job, jobs, chunksize=8)
    print(len(jobs))
