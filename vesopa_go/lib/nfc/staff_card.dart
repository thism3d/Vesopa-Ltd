/// Reading a staff card or fob with the phone's own NFC.
///
/// This is the NFC that needs nobody's permission: an ISO 14443 tag's id
/// (MIFARE, NTAG, DESFire -- the cards and fobs venues already hand out).
/// It is NOT how cards are paid with: bank cards are read only by Dojo's Tap
/// to Pay SDK (payments/), which is certified to do it.
library;

import 'dart:async';
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
    final done = Completer<String?>();
    try {
      await NfcManager.instance.startSession(
        pollingOptions: {NfcPollingOption.iso14443},
        alertMessageIos: 'Hold your staff card near the top of the iPhone',
        onDiscovered: (tag) async {
          final id = _idOf(tag);
          if (!done.isCompleted) done.complete(id == null ? null : hex(id));
          await NfcManager.instance.stopSession(alertMessageIos: id == null ? null : 'Card read');
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

  static Uint8List? _idOf(NfcTag tag) {
    if (Platform.isAndroid) return NfcTagAndroid.from(tag)?.id;
    if (Platform.isIOS) return MiFareIos.from(tag)?.identifier ?? Iso7816Ios.from(tag)?.identifier;
    return null;
  }

  static String hex(Uint8List bytes) => bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join().toUpperCase();
}
