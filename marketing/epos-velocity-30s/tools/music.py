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

# A minor: Am - F - C - G, one chord per bar (2 s)
CH = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]
BASS = [45, 41, 48, 43]
hz = lambda m: 440 * 2 ** ((m - 69) / 12)

pad = np.zeros(N); bass = np.zeros(N)
for bar in range(15):
    t0 = bar * 2.0; ch = CH[bar % 4]
    seg = sum(saw(hz(m), 2.0) for m in ch) / 3
    env = np.minimum(1, tt(2.0) / .05) * np.minimum(1, (2.0 - tt(2.0)) / .1)
    i = int(t0 * SR); pad[i:i + len(seg)] += seg * env
    for k in range(8):  # driving eighth-note bass
        bt = t0 + k * .25; b = saw(hz(BASS[bar % 4]), .23, (0, .05))
        e = np.exp(-tt(.23) * 6) * np.minimum(1, tt(.23) / .004)
        j = int(bt * SR); bass[j:j + len(b)] += b * e
# pad: muffled in the intro, opens at the drop, softens for the outro
pad_dark = lp(pad, 700); pad_open = lp(pad, 2600)
tline = np.arange(N) / SR
openness = np.clip((tline - 3.0) / 1.0, 0, 1) * (1 - np.clip((tline - 27.0) / .5, 0, 1) * .5)
pad_mix = pad_dark * (1 - openness) + pad_open * openness
bass = lp(bass, 600) * ((tline >= 4) & (tline < 27))

# sidechain duck from the kick grid
duck = np.ones(N)
kicks = [t for t in np.arange(4, 27, BEAT)] + [0, 1.5, 2.0, 3.0]
for kt in kicks:
    i = int(kt * SR); d = int(.3 * SR); env = 1 - .7 * np.exp(-np.arange(d) / SR * 12)
    duck[i:i + d] = np.minimum(duck[i:i + d], env[:max(0, min(d, N - i))])
put(pad_mix * duck, 0, .32, -.05)
put(pad_mix * duck, .012, .32 * .7, .3)  # tiny delay for width
put(bass * duck, 0, .55)

# drums
for kt in kicks: put(kick(), kt, .95)
for bt in np.arange(4, 27, BEAT):
    b = round((bt - 4) / BEAT)
    if b % 2 == 1: put(clap(), bt, .55, .05)
    put(hat(), bt + .25, .35, .35)
    if b % 4 == 3: put(hat(open_=True), bt + .25, .25, -.3)
    put(hat(), bt, .18, .4)
for bt in np.arange(2.0, 3.5, .25): put(clap(.12), bt, .2 + (bt - 2) * .25)  # snare roll into the drop
put(riser(2.0), 2.0, .45)

# hits and transitions (match render.html)
for t in [4.0, 25.0, 27.0]: put(boom(), t, .9); put(crash(), t, .55)
for t in [2.0, 6.0, 9.0, 13.0, 14.0, 15.5, 18.0, 22.5, 24.0, 27.0]: put(whoosh(.32), t - .2, .55, rng.uniform(-.5, .5))
for t in [3.5, 11.0, 20.5]: put(whoosh(.4, False), t - .25, .5)
for t in [6.75, 7.25, 8.25, 9.0, 9.5, 10.0, 10.5, 15.0, 19.75]: put(click(), t, .7, .2)
for t in [6.75, 7.25, 19.75]: put(ding(), t + .02, .55, -.2)
put(beep(), 11.5, .9); put(ding(), 12.25, .7)
for t in [.25, .75, 2.0, 2.5, 3.0, 11.5, 13.25, 16.75, 17.25, 20.0, 25.0, 25.25, 25.5, 25.75, 26.25]: put(thump(), t, .45)

mix = np.stack([L, R], 1)
fade = np.clip((DUR - np.arange(N) / SR) / 1.2, 0, 1)[:, None]
mix *= fade
mix /= np.max(np.abs(mix)) + 1e-9
mix = np.tanh(mix * 1.5) / np.tanh(1.5) * .93
with wave.open(sys.argv[1], 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((mix * 32767).astype('<i2').tobytes())
print('ok')
