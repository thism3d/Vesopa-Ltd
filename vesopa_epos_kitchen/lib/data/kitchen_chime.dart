/// The new-order chime, played by the app itself (2026-10-26).
///
/// Pontardawe RFC's kitchen screen, a Windows PC, made no noise: the board
/// rang Windows' own "alert" sound, and a shop PC whose sound scheme is set to
/// "No sounds" (the usual way they come) plays nothing for it however loud the
/// speakers are. So the chime is made here, as a short WAV in memory, and
/// played through the sound card with PlaySound -- which does not consult the
/// sound scheme at all. Anywhere else, or if that fails, the system alert as
/// before.
library;

import 'dart:ffi';
import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:ffi/ffi.dart';
import 'package:flutter/services.dart';

typedef _PlaySoundNative = Int32 Function(Pointer<Void> sound, IntPtr module, Uint32 flags);
typedef _PlaySoundDart = int Function(Pointer<Void> sound, int module, int flags);

const _sndAsync = 0x0001;
const _sndNoDefault = 0x0002;
const _sndMemory = 0x0004;

class KitchenChime {
  KitchenChime._();

  static _PlaySoundDart? _play;
  static Pointer<Uint8>? _wav;

  /// Three rising notes, bright enough to cut through a kitchen.
  static Future<void> play() async {
    if (Platform.isWindows && _playWindows()) return;
    for (var i = 0; i < 3; i++) {
      await Future<void>.delayed(Duration(milliseconds: i == 0 ? 0 : 230));
      await SystemSound.play(SystemSoundType.alert);
    }
  }

  static bool _playWindows() {
    try {
      _play ??= DynamicLibrary.open('winmm.dll').lookupFunction<_PlaySoundNative, _PlaySoundDart>('PlaySoundW');
      // Made once and never freed: an asynchronous PlaySound reads the
      // memory while it plays, after this call has returned.
      _wav ??= _toNative(_chimeWav());
      return _play!(_wav!.cast<Void>(), 0, _sndMemory | _sndAsync | _sndNoDefault) != 0;
    } catch (_) {
      return false;
    }
  }

  static Pointer<Uint8> _toNative(Uint8List bytes) {
    final p = calloc<Uint8>(bytes.length);
    p.asTypedList(bytes.length).setAll(0, bytes);
    return p;
  }

  /// A 16-bit mono WAV: C6, E6, G6, each with a quick attack and a soft tail.
  static Uint8List _chimeWav() {
    const rate = 22050;
    const notes = [1046.5, 1318.5, 1568.0];
    const noteSeconds = 0.26;
    const gap = 0.05;
    final perNote = (rate * noteSeconds).round();
    final perGap = (rate * gap).round();
    final samples = Int16List(notes.length * (perNote + perGap) + rate ~/ 5);
    var at = 0;
    for (final f in notes) {
      for (var i = 0; i < perNote; i++) {
        final t = i / rate;
        final attack = math.min(1.0, i / (rate * 0.008));
        final decay = math.exp(-t * 7);
        final wave = math.sin(2 * math.pi * f * t) * 0.8 + math.sin(4 * math.pi * f * t) * 0.2;
        samples[at + i] = (wave * attack * decay * 30000).round().clamp(-32767, 32767);
      }
      at += perNote + perGap;
    }
    final data = samples.buffer.asUint8List();
    final header = ByteData(44)
      ..setUint32(0, 0x52494646, Endian.big) // RIFF
      ..setUint32(4, 36 + data.length, Endian.little)
      ..setUint32(8, 0x57415645, Endian.big) // WAVE
      ..setUint32(12, 0x666d7420, Endian.big) // fmt
      ..setUint32(16, 16, Endian.little)
      ..setUint16(20, 1, Endian.little) // PCM
      ..setUint16(22, 1, Endian.little) // mono
      ..setUint32(24, rate, Endian.little)
      ..setUint32(28, rate * 2, Endian.little)
      ..setUint16(32, 2, Endian.little)
      ..setUint16(34, 16, Endian.little)
      ..setUint32(36, 0x64617461, Endian.big) // data
      ..setUint32(40, data.length, Endian.little);
    return Uint8List.fromList([...header.buffer.asUint8List(), ...data]);
  }
}
