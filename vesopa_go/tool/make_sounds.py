"""Vesopa Go's sounds, drawn as sine tones so they are ours and small.

python tool/make_sounds.py  ->  assets/sounds/{add,approved,declined,ready,allergen}.wav
"""
import math, struct, wave
from pathlib import Path

RATE = 44100
OUT = Path(__file__).resolve().parent.parent / 'assets' / 'sounds'


def tone(freq, ms, vol=0.6, shape='sine', attack=4, release=None):
    n = int(RATE * ms / 1000)
    release = release if release is not None else ms * 0.6
    out = []
    for i in range(n):
        t = i / RATE
        if shape == 'square':
            v = 1.0 if math.sin(2 * math.pi * freq * t) >= 0 else -1.0
            v *= 0.35
        else:
            # A touch of the octave makes it ring like a bell, not a beep.
            v = math.sin(2 * math.pi * freq * t) + 0.25 * math.sin(4 * math.pi * freq * t)
        ms_i = i * 1000 / RATE
        env = min(1.0, ms_i / attack) if attack else 1.0
        tail = ms - ms_i
        if tail < release:
            env *= max(0.0, tail / release) ** 2
        out.append(v * env * vol)
    return out


def silence(ms):
    return [0.0] * int(RATE * ms / 1000)


def write(name, samples):
    OUT.mkdir(parents=True, exist_ok=True)
    peak = max(1e-9, max(abs(s) for s in samples))
    scale = 0.9 / peak if peak > 0.9 else 1.0
    with wave.open(str(OUT / f'{name}.wav'), 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(b''.join(struct.pack('<h', int(max(-1, min(1, s * scale)) * 32767)) for s in samples))


write('add', tone(1800, 45, 0.45, attack=1, release=40))
write('approved', tone(880, 120, 0.6) + tone(1320, 320, 0.6))
write('declined', tone(220, 160, 0.7, 'square') + silence(60) + tone(196, 260, 0.7, 'square'))
write('ready', tone(784, 140) + tone(988, 140) + tone(1175, 420))
write('allergen', tone(660, 150, 0.7) + tone(440, 150, 0.7) + tone(660, 150, 0.7) + tone(440, 260, 0.7))
print('sounds written to', OUT)
