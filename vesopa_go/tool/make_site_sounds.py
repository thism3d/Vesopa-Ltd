"""Calm background sounds for go.vesopa.com (2026-11-06), written here with
numpy so nothing needs licensing. The owner found the live Web Audio tone loud
and not calm, so these are three different characters to choose from by ear:

    python vesopa_go/tool/make_site_sounds.py

Writes web/site/media/calm-piano.mp3, calm-ocean.mp3, calm-keys.mp3: 48 s, fading
in and out at the ends so they loop without a jump, all at the same quiet level.
"""
import pathlib
import subprocess
import wave

import numpy as np

OUT = pathlib.Path(__file__).resolve().parents[1] / "web" / "site" / "media"
RATE = 44100
LENGTH = 48.0
TARGET_DB = -27.0  # RMS: well under the old sound
rng = np.random.default_rng(21)


def hz(n):
    return 440.0 * 2 ** ((n - 69) / 12)


def blank():
    return np.zeros((2, int(LENGTH * RATE)))


def add(mix, sig, at, vol, pan=0.0):
    i = int(at * RATE)
    if i >= mix.shape[1]:
        return
    s = sig[:mix.shape[1] - i] * vol
    mix[0, i:i + len(s)] += s * np.sqrt((1 - pan) / 2)
    mix[1, i:i + len(s)] += s * np.sqrt((1 + pan) / 2)


def lowpass(x, cutoff):
    """One gentle pole, there and back, so nothing is left sharp."""
    a = np.exp(-2 * np.pi * cutoff / RATE)
    for sig in (x, x[::-1]):
        out = np.empty_like(sig)
        y = 0.0
        for i, v in enumerate(sig):  # short notes only; the ocean uses fft_lowpass
            y = (1 - a) * v + a * y
            out[i] = y
        x = out
    return x[::-1]


def fft_lowpass(x, cutoff):
    f = np.fft.rfftfreq(len(x), 1 / RATE)
    return np.fft.irfft(np.fft.rfft(x) / (1 + (f / cutoff) ** 4), len(x))


def reverb(mix, seconds, amount):
    """A long dark room, by FFT convolution with decaying filtered noise."""
    n = int(seconds * RATE)
    out = np.zeros_like(mix)
    for c in range(2):
        ir = fft_lowpass(rng.standard_normal(n), 2400) * np.exp(-np.arange(n) / (RATE * seconds / 5.5))
        ir /= np.sqrt(np.sum(ir ** 2))
        size = mix.shape[1] + n
        wet = np.fft.irfft(np.fft.rfft(mix[c], size) * np.fft.rfft(ir, size), size)[:mix.shape[1]]
        out[c] = mix[c] + wet * amount
    return out


def felt(f, dur):
    """A felt piano note: soft hammer, a few slightly stretched partials."""
    t = np.arange(int(dur * RATE)) / RATE
    sig = np.zeros_like(t)
    for k, (amp, decay) in enumerate(((1, 1.5), (.32, 2.6), (.1, 4), (.04, 6)), 1):
        sig += amp * np.sin(2 * np.pi * f * k * (1 + .0004 * k * k) * t) * np.exp(-t * decay)
    return sig * np.minimum(1, t / .014) * np.minimum(1, (dur - t) / .2)


def ep(f, dur):
    """A warm electric piano: gentle FM, with a slow tremolo."""
    t = np.arange(int(dur * RATE)) / RATE
    index = 1.1 * np.exp(-t * 2.2)
    sig = np.sin(2 * np.pi * f * t + index * np.sin(2 * np.pi * f * t))
    sig *= np.exp(-t * .75) * np.minimum(1, t / .03) * np.minimum(1, (dur - t) / .4)
    return sig * (1 + .12 * np.sin(2 * np.pi * 3.1 * t))


CHORDS = [[40, 59, 64, 68], [37, 56, 61, 64], [33, 57, 61, 64], [35, 54, 59, 63]]  # E, C#m, A, B


def piano():
    mix = blank()
    bar = 4.0
    scale = [64, 66, 68, 71, 73, 76, 78, 80]
    t, c, last = 1.0, 0, 3
    while t < LENGTH - 5:
        ch = CHORDS[c % 4]
        add(mix, felt(hz(ch[0] + 12), 6), t, .22, -.1)
        for j, n in enumerate(ch[1:]):
            add(mix, felt(hz(n), 5), t + .9 + j * .55, .16, -.25 + j * .25)
        # one quiet melody note a bar, stepping, sometimes resting
        if rng.random() > .3:
            last = int(np.clip(last + rng.integers(-2, 3), 0, len(scale) - 1))
            add(mix, felt(hz(scale[last]), 5), t + 2.2 + rng.random() * .5, .13, .2)
        t += bar
        c += 1
    return reverb(mix, 3.8, .45)


def ocean():
    n = int(LENGTH * RATE)
    mix = np.zeros((2, n))
    for c in range(2):
        rumble = fft_lowpass(rng.standard_normal(n), 420)
        hiss = fft_lowpass(rng.standard_normal(n), 2600)
        env = np.full(n, .2)
        hi = np.zeros(n)
        t = 1.0 + c * .6
        while t < LENGTH - 2:  # each wave: a slow rise, a break, a long drawing back
            period = 8 + rng.random() * 4
            x = np.arange(n) / RATE - t
            rise = np.clip(x / 3.2, 0, 1) ** 2
            fall = np.exp(-np.clip(x - 3.2, 0, None) / 2.6)
            shape = rise * fall * (.7 + rng.random() * .4)
            env += shape
            hi += shape ** 2
            t += period
        mix[c] = rumble / np.std(rumble) * env + hiss / np.std(hiss) * hi * .32
    return mix


def keys():
    mix = blank()
    t, c = 1.0, 0
    while t < LENGTH - 6:
        ch = CHORDS[c % 4]
        add(mix, ep(hz(ch[0] + 12), 8), t, .26)
        for j, n in enumerate(ch[1:]):
            add(mix, ep(hz(n), 8), t + j * .045, .17, -.3 + j * .3)
        t += 6.0
        c += 1
    return reverb(mix, 3.0, .35)


def save(mix, name):
    fade = np.ones(mix.shape[1])
    k = int(1.5 * RATE)
    fade[:k] = np.linspace(0, 1, k) ** 2
    fade[-k:] = np.linspace(1, 0, k) ** 2
    mix = mix * fade
    gain = 10 ** (TARGET_DB / 20) / np.sqrt(np.mean(mix ** 2))
    mix = mix * gain
    peak = float(np.max(np.abs(mix)))
    if peak > .7:
        mix = mix * .7 / peak
    wav = OUT / f"{name}.wav"
    with wave.open(str(wav), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes((mix.T * 32767).astype(np.int16).tobytes())
    mp3 = OUT / f"{name}.mp3"
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(wav), "-b:a", "128k", str(mp3)], check=True)
    wav.unlink()
    print(name, f"rms {20 * np.log10(np.sqrt(np.mean(mix ** 2))):.1f} dB, peak {20 * np.log10(np.max(np.abs(mix))):.1f} dB, {mp3.stat().st_size // 1024} KB")


if __name__ == "__main__":
    save(piano(), "calm-piano")
    save(ocean(), "calm-ocean")
    save(keys(), "calm-keys")
