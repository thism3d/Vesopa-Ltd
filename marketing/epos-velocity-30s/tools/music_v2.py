"""Synthesised 30 s soundtrack for the Vesopa EPOS velocity edit. 120 BPM, A minor.
Cue times match the scene list in build/render.html."""
import sys, wave, numpy as np

SR = 44100; DUR = 30.0; N = int(SR * DUR); BEAT = 0.5
rng = np.random.default_rng(4)
L = np.zeros(N); R = np.zeros(N)

def put(sig, t, gain=1.0, pan=0.0):
    i = int(t * SR); j = min(N, i + len(sig))
    if i >= N or j <= i: return
    s = sig[:j - i] * gain
    L[i:j] += s * np.sqrt(0.5 * (1 - pan)) * 1.414
    R[i:j] += s * np.sqrt(0.5 * (1 + pan)) * 1.414

def tt(d): return np.arange(int(d * SR)) / SR
def onepole(x, a):  # unused
    y = np.empty_like(x); acc = 0.0
    for i, v in enumerate(x): acc += a * (v - acc); y[i] = acc
    return y
def lp(x, cutoff):  # vectorised-ish low-pass via FFT brick + smooth rolloff
    X = np.fft.rfft(x); f = np.fft.rfftfreq(len(x), 1 / SR)
    X *= 1 / np.sqrt(1 + (f / cutoff) ** 4); return np.fft.irfft(X, len(x))
def hp(x, cutoff):
    X = np.fft.rfft(x); f = np.fft.rfftfreq(len(x), 1 / SR)
    X *= 1 / np.sqrt(1 + (cutoff / np.maximum(f, 1)) ** 4); return np.fft.irfft(X, len(x))

def kick(d=0.45):
    t = tt(d); f = 45 + 95 * np.exp(-t * 28)
    ph = 2 * np.pi * np.cumsum(f) / SR
    s = np.sin(ph) * np.exp(-t * 7.5); s[:200] += rng.uniform(-1, 1, 200) * np.linspace(.6, 0, 200)
    return np.tanh(s * 1.6)
def clap(d=0.3):
    t = tt(d); n = hp(rng.uniform(-1, 1, len(t)), 900)
    env = np.exp(-t * 16) + 0.6 * np.exp(-np.maximum(t - .012, 0) * 22) * (t > .012) + 0.5 * np.exp(-np.maximum(t - .024, 0) * 20) * (t > .024)
    return n * env * .7 + np.sin(2 * np.pi * 190 * t) * np.exp(-t * 30) * .3
def hat(d=0.06, open_=False):
    t = tt(d if not open_ else .25); n = hp(rng.uniform(-1, 1, len(t)), 7000)
    return n * np.exp(-t * (60 if not open_ else 14)) * .5
def boom(d=2.2):
    t = tt(d); f = 32 + 60 * np.exp(-t * 6)
    s = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 1.8)
    n = lp(rng.uniform(-1, 1, len(t)), 2500) * np.exp(-t * 3) * .5
    return np.tanh((s + n) * 1.4)
def crash(d=2.0):
    t = tt(d); return hp(rng.uniform(-1, 1, len(t)), 4000) * np.exp(-t * 2.2) * .45
def whoosh(d=0.35, up=True):
    t = tt(d); n = rng.uniform(-1, 1, len(t)); env = np.sin(np.pi * t / d) ** 2
    lo = lp(n, 900); hi = hp(n, 3000); mix = np.linspace(0, 1, len(t)) if up else np.linspace(1, 0, len(t))
    return (lo * (1 - mix) + hi * mix * .6 + lp(hp(n, 600), 4000) * .6) * env * 1.4
def riser(d=2.0):
    t = tt(d); n = rng.uniform(-1, 1, len(t)); env = (t / d) ** 2
    s = np.sin(2 * np.pi * np.cumsum(200 + 1400 * (t / d) ** 2) / SR) * .25
    return (hp(n, 1500) * .6 + s) * env
def click():
    t = tt(.04); return np.sin(2 * np.pi * 2200 * t) * np.exp(-t * 160) * .8 + hp(rng.uniform(-1, 1, len(t)), 5000) * np.exp(-t * 300) * .4
def beep():
    t = tt(.22); s = np.sin(2 * np.pi * 1760 * t) * ((t < .09) | (t > .12)) * (t < .21)
    return s * .45
def ding():
    t = tt(.9); return (np.sin(2 * np.pi * 1318.5 * t) + .5 * np.sin(2 * np.pi * 1975.5 * t)) * np.exp(-t * 5) * .3
def thump():
    t = tt(.25); f = 70 + 80 * np.exp(-t * 40)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 14) * .8
def saw(freq, d, detune=(0, .07, -.07)):
    t = tt(d); s = sum(2 * ((t * freq * 2 ** (c / 12)) % 1) - 1 for c in detune); return s / len(detune)

# ---- v2: the reference's grid, 80 BPM, beats at 0.45 + 0.75 n; drop at 9.45 when the world goes comic
BEAT = 0.75; B0 = 0.45
BEATS = [round(B0 + BEAT * n, 3) for n in range(40)]
DROP, HERO, OUTRO = 9.45, 15.45, 28.2
CUTS = [1.2, 1.95, 3.45, 4.2, 4.95, 5.7, 6.45, 9.45, 10.95, 12.45, 13.95, 15.45, 16.95, 18.45, 19.95, 21.45, 22.95, 24.45, 25.95, 27.45, 28.2]
CH = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]
BASS = [45, 41, 48, 43]
hz = lambda m: 440 * 2 ** ((m - 69) / 12)
tline = np.arange(N) / SR
pad = np.zeros(N); bass = np.zeros(N)
BAR = BEAT * 4
for bar in range(-1, 11):
    t0 = B0 + bar * BAR; ch = CH[bar % 4]
    seg = sum(saw(hz(m), BAR) for m in ch) / 3
    env = np.minimum(1, tt(BAR) / .05) * np.minimum(1, (BAR - tt(BAR)) / .1)
    i = int(t0 * SR); a = max(0, -i); seg = (seg * env)[a:]; i = max(0, i)
    pad[i:i + len(seg)] += seg[:max(0, min(len(seg), N - i))]
    for k in range(8):
        bt = t0 + k * BEAT / 2
        if bt < 0: continue
        b = saw(hz(BASS[bar % 4]), .34, (0, .05)); e = np.exp(-tt(.34) * 5) * np.minimum(1, tt(.34) / .004)
        j = int(bt * SR); seg2 = (b * e)[:max(0, min(len(b), N - j))]; bass[j:j + len(seg2)] += seg2
openness = np.clip((tline - (DROP - 1.5)) / 1.5, 0, 1)
pad_mix = lp(pad, 650) * (1 - openness) + lp(pad, 2800) * openness
bass = lp(bass, 600) * (tline >= DROP)
kicks = [b for b in BEATS if b >= DROP] + [b for b in BEATS if b < DROP][::2]
duck = np.ones(N)
for kt in kicks:
    i = int(kt * SR); d = int(.4 * SR); env = 1 - .7 * np.exp(-np.arange(d) / SR * 10)
    duck[i:i + d] = np.minimum(duck[i:i + d], env[:max(0, min(d, N - i))])
put(pad_mix * duck, 0, .34, -.05); put(pad_mix * duck, .012, .24, .3); put(bass * duck, 0, .6)
for kt in kicks: put(kick(.55), kt, .95 if kt >= DROP else .6)
for n, b in enumerate(BEATS):
    if b >= DROP:
        if n % 2 == 1: put(clap(), b, .6, .05)
        for k in (1, 2, 3): put(hat(), b + k * BEAT / 4, .22 if k != 2 else .32, .35)
        if n % 4 == 3: put(hat(open_=True), b + BEAT / 2, .25, -.3)
    elif b >= 4.2: put(hat(), b + BEAT / 2, .2, .3)
for k in range(12): put(clap(.12), DROP - 1.5 + k * BEAT / 8, .15 + k * .03)  # roll into the drop
put(riser(2.2), DROP - 2.2, .5)
for t in [DROP, HERO, OUTRO]: put(boom(), t, .9); put(crash(), t, .5)
for t in CUTS: put(whoosh(.24), t - .14, .5, rng.uniform(-.5, .5))
for b in BEATS:  # a small swish on every velocity burst
    if b not in CUTS: put(whoosh(.16), b - .09, .28, rng.uniform(-.4, .4))
for t in [16.2, 17.7, 19.2]: put(click(), t, .7, .2)
put(ding(), 16.22, .5); put(beep(), 14.7, .9); put(ding(), 17.72, .45)
for t in [10.2, 11.7, 13.2, 20.7, 22.2, 23.7, 25.2, 26.7]: put(thump(), t, .5)

mix = np.stack([L, R], 1)
fade = np.clip((DUR - np.arange(N) / SR) / 1.2, 0, 1)[:, None]
mix *= fade
mix /= np.max(np.abs(mix)) + 1e-9
mix = np.tanh(mix * 1.5) / np.tanh(1.5) * .93
with wave.open(sys.argv[1], 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((mix * 32767).astype('<i2').tobytes())
print('ok')
