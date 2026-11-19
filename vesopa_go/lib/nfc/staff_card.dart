/// Reading a staff card or fob with the phone's own NFC.
///
/// This is the NFC that needs nobody's permission: an ISO 14443 tag's id
/// (MIFARE, NTAG, DESFire -- the cards and fobs venues already hand out).
/// It is NOT how cards are paid with: bank cards are read only by Vesopa Tap
/// to Pay (payments/), which is certified to do it.
///
/// A members' card on a phone or watch (a club's own app, vesopa_loyalty
/// CardHceService.kt: Android phones and Wear OS watches) has no fixed id to
/// read: it answers a SELECT of the Vesopa card id with the code its QR
/// shows. So, on Android, a tag that speaks ISO-DEP is asked first, and its
/// code is what comes back; anything that does not answer is read by its id
/// as before (owner, 2026-11-18: "hold near reader" for members).
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:nfc_manager/nfc_manager.dart';
import 'package:nfc_manager/nfc_manager_android.dart';
import 'package:nfc_manager/nfc_manager_ios.dart';

class StaffCardReader {
  /// Whether the phone has NFC and it is switched on.
  static Future<bool> available() async {
    try {
      return await NfcManager.instance.checkAvailability() == NfcAvailability.enabled;
    } catch (_) {
      return false;
    }
  }

  /// Waits for one card and returns its id as upper-case hex, or null if the
  /// clerk cancelled or [timeout] passed. On iPhone the system's own "Ready
  /// to scan" sheet is shown.
  static Future<String?> readOnce({Duration timeout = const Duration(seconds: 30)}) async {
    await cancel();
    final done = Completer<String?>();
    _waiting = done;
    try {
      await NfcManager.instance.startSession(
        pollingOptions: {NfcPollingOption.iso14443},
        alertMessageIos: 'Hold your staff card near the top of the iPhone',
        onDiscovered: (tag) async {
          final member = await _memberCode(tag);
          final id = member == null ? _idOf(tag) : null;
          final value = member ?? (id == null ? null : hex(id));
          if (!done.isCompleted) done.complete(value);
          await NfcManager.instance.stopSession(alertMessageIos: value == null ? null : 'Card read');
        },
      );
    } catch (_) {
      return null;
    }
    return done.future.timeout(timeout, onTimeout: () {
      NfcManager.instance.stopSession();
      return null;
    });
  }

  static Completer<String?>? _waiting;

  /// Stop listening: the reading screen was closed, or another read begins.
  static Future<void> cancel() async {
    final waiting = _waiting;
    _waiting = null;
    if (waiting == null || waiting.isCompleted) return;
    waiting.complete(null);
    try {
      await NfcManager.instance.stopSession();
    } catch (_) {}
  }

  /// The Vesopa members' card id: F0 + "VESOPA" + 01 (a proprietary id).
  static final Uint8List memberAid = Uint8List.fromList([0xF0, 0x56, 0x45, 0x53, 0x4F, 0x50, 0x41, 0x01]);

  /// ISO 7816-4 SELECT by name of [memberAid].
  static Uint8List get selectMember =>
      Uint8List.fromList([0x00, 0xA4, 0x04, 0x00, memberAid.length, ...memberAid, 0x00]);

  /// The code in a card's answer (UTF-8, then 90 00), or null.
  static String? memberCodeFrom(Uint8List answer) {
    if (answer.length < 3 || answer[answer.length - 2] != 0x90 || answer[answer.length - 1] != 0x00) return null;
    try {
      final code = utf8.decode(answer.sublist(0, answer.length - 2)).trim();
      return code.isEmpty ? null : code;
    } catch (_) {
      return null;
    }
  }

  static Future<String?> _memberCode(NfcTag tag) async {
    if (!Platform.isAndroid) return null;
    try {
      final iso = IsoDepAndroid.from(tag);
      if (iso == null) return null;
      return memberCodeFrom(await iso.transceive(selectMember));
    } catch (_) {
      // A plain card or fob: no ISO-DEP, or it does not know the id.
      return null;
    }
  }

  static Uint8List? _idOf(NfcTag tag) {
    if (Platform.isAndroid) return NfcTagAndroid.from(tag)?.id;
    if (Platform.isIOS) return MiFareIos.from(tag)?.identifier ?? Iso7816Ios.from(tag)?.identifier;
    return null;
  }

  static String hex(Uint8List bytes) => bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join().toUpperCase();
}
