"""An original, warm, uplifting bed for the preview: D A Bm G at 100 bpm."""
import sys, wave
import numpy as np

SR = 48000
DUR = float(sys.argv[2]) if len(sys.argv) > 2 else 29.5
END_AT = float(sys.argv[3]) if len(sys.argv) > 3 else 23.4
DRUMS_IN = float(sys.argv[4]) if len(sys.argv) > 4 else 2 * 2.4
BPM = 100
BEAT = 60 / BPM
BAR = 4 * BEAT
N = int(SR * DUR)
t = np.arange(N) / SR
rng = np.random.default_rng(7)


def hz(midi):
    return 440.0 * 2 ** ((midi - 69) / 12)


def lowpass(x, cutoff):
    # one-pole, run twice for a gentler 12 dB slope
    a = np.exp(-2 * np.pi * cutoff / SR)
    for _ in range(2):
        y = np.empty_like(x)
        acc = 0.0
        b = 1 - a
        for i in range(len(x)):
            acc = b * x[i] + a * acc
            y[i] = acc
        x = y
    return x


def env_adsr(n, a, r):
    e = np.ones(n)
    na, nr = min(n // 2, int(a * SR)), min(n // 2, int(r * SR))
    e[:na] = np.linspace(0, 1, na)
    e[-nr:] *= np.linspace(1, 0, nr)
    return e


# D, A, Bm, G  (two bars each)
CHORDS = [
    (50, [62, 66, 69, 74]),   # D
    (45, [61, 64, 69, 73]),   # A
    (47, [62, 66, 71, 74]),   # Bm
    (43, [62, 67, 71, 74]),   # G
]
CH_LEN = 2 * BAR

mix_l = np.zeros(N)
mix_r = np.zeros(N)

# Pad: detuned saws, filtered, slow swell.
pad = np.zeros(N)
k = 0
start = 0.0
while start < DUR:
    root, notes = CHORDS[k % 4]
    s, e = int(start * SR), min(N, int((start + CH_LEN + 0.4) * SR))
    tt = np.arange(e - s) / SR
    seg = np.zeros(e - s)
    for m in notes:
        for det in (-0.08, 0.0, 0.08):
            f = hz(m + det)
            ph = (tt * f + rng.random()) % 1.0
            seg += (2 * ph - 1) * 0.05
    seg *= env_adsr(len(seg), 0.9, 0.6)
    pad[s:e] += seg
    start += CH_LEN
    k += 1
pad = lowpass(pad, 1400)

# Sub bass on the root, from bar 2.
bass = np.zeros(N)
k, start = 0, 0.0
while start < DUR:
    root, _ = CHORDS[k % 4]
    for b in range(8):
        bt = start + b * BEAT
        if bt < BAR or bt >= DUR:
            continue
        s = int(bt * SR)
        n = min(N - s, int(BEAT * 0.95 * SR))
        tt = np.arange(n) / SR
        tone = np.sin(2 * np.pi * hz(root - 12 + 12) * tt) * 0.5 + np.sin(2 * np.pi * hz(root) * tt) * 0.2
        bass[s:s + n] += tone * np.exp(-tt * 2.2) * 0.32
    start += CH_LEN
    k += 1

# Pluck arpeggio in eighths, entering at bar 1.5.
arp = np.zeros(N)
k, start = 0, 0.0
pattern = [0, 1, 2, 3, 2, 1, 2, 3]
while start < DUR:
    _, notes = CHORDS[k % 4]
    for i in range(16):
        nt = start + i * BEAT / 2
        if nt < BAR * 1.5 or nt >= DUR - 0.3:
            continue
        m = notes[pattern[i % 8]] + 12
        s = int(nt * SR)
        n = min(N - s, int(0.7 * SR))
        tt = np.arange(n) / SR
        f = hz(m)
        tone = np.sin(2 * np.pi * f * tt) + 0.3 * np.sin(4 * np.pi * f * tt) + 0.1 * np.sin(6 * np.pi * f * tt)
        arp[s:s + n] += tone * np.exp(-tt * 7) * 0.09
    start += CH_LEN
    k += 1

# Soft kick on 1 and 3, a light shaker on the offbeats, from bar 3.
drums = np.zeros(N)
for b in range(int(DUR / BEAT) + 1):
    bt = b * BEAT
    if bt < DRUMS_IN or bt >= END_AT - 0.05:
        continue
    s = int(bt * SR)
    if b % 2 == 0:
        n = min(N - s, int(0.35 * SR))
        tt = np.arange(n) / SR
        f = 45 + 90 * np.exp(-tt * 30)
        drums[s:s + n] += np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt * 9) * 0.5
    so = int((bt + BEAT / 2) * SR)
    n = min(N - so, int(0.06 * SR))
    if n > 0:
        noise = rng.standard_normal(n)
        noise = noise - lowpass(noise, 5000)
        drums[so:so + n] += noise * np.exp(-np.arange(n) / SR * 60) * 0.05

# A swell into the ending and a final held D chord.
end_at = END_AT
swell = np.zeros(N)
s, e = int((end_at - 1.6) * SR), int(end_at * SR)
noise = rng.standard_normal(e - s)
noise = noise - lowpass(noise, 1800)
swell[s:e] = noise * np.linspace(0, 1, e - s) ** 2 * 0.12

final = np.zeros(N)
s = int(end_at * SR)
tt = np.arange(N - s) / SR
for m in (50, 62, 66, 69, 74, 78):
    final[s:] += np.sin(2 * np.pi * hz(m) * tt) * 0.06 * np.exp(-tt * 0.35)
final[s:] += np.sin(2 * np.pi * hz(38) * tt) * 0.25 * np.exp(-tt * 1.2)

# Stereo: pad wide, arp slightly right, swell spread.
delay = int(0.012 * SR)
pad_r = np.concatenate([np.zeros(delay), pad[:-delay]])
mix_l = pad * 0.9 + bass + arp * 0.8 + drums + swell + final
mix_r = pad_r * 0.9 + bass + arp * 1.1 + drums + np.roll(swell, 300) + final

# Fade in, fade out, normalise.
fade = np.ones(N)
fi, fo = int(0.8 * SR), int(1.6 * SR)
fade[:fi] = np.linspace(0, 1, fi)
fade[-fo:] = np.linspace(1, 0, fo)
stereo = np.stack([mix_l * fade, mix_r * fade], axis=1)
stereo /= np.max(np.abs(stereo)) / 0.89

out = sys.argv[1]
with wave.open(out, "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((stereo * 32767).astype("<i2").tobytes())
print("wrote", out)
