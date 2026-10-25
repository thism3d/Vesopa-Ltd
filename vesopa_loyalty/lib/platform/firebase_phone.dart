/// Mobile numbers proved by Firebase Authentication (2026-10-13).
///
/// Firebase texts the code, to any country, and answers an ID token that the
/// server checks (vesopa_server/src/firebase_phone.js). The native halves are
/// android/.../PhoneBridge.kt and ios/Runner/PhoneBridge.swift. A browser and
/// Windows keep the texted code the server sends itself.
library;

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import '../data/api.dart';

const _channel = MethodChannel('vesopa_loyalty/phone');

final _proved = StreamController<String>.broadcast();
var _listening = false;

/// Proofs that come by themselves after the code was sent: Android reads the
/// text and proves the number without the member typing anything. Each event
/// is a Firebase ID token, for the same call [firebasePhoneConfirm]'s is.
Stream<String> get firebasePhoneProved {
  if (!_listening && firebasePhoneOnDevice) {
    _listening = true;
    _channel.setMethodCallHandler((call) async {
      final token = (call.arguments as Map?)?['token'] as String?;
      if (call.method == 'proved' && token != null && token.isNotEmpty) _proved.add(token);
    });
  }
  return _proved.stream;
}

/// Whether this device proves a number with Firebase: the phone apps.
///
/// The owner chose Firebase for every phone (2026-10-25: the Postcoder account
/// had no credit). Android checks the app with Play Integrity and reads the
/// text by itself; the iPhone checks it with a silent push, which needs the
/// APNs key in the Firebase project, and otherwise with a short check page.
bool get firebasePhoneOnDevice =>
    !kIsWeb && (defaultTargetPlatform == TargetPlatform.android || defaultTargetPlatform == TargetPlatform.iOS);

/// What starting a check gave: a [verification] to type the code against, or
/// a [token] when the phone proved the number by itself (Android can).
class PhoneCheck {
  const PhoneCheck({this.verification, this.token});
  final String? verification;
  final String? token;
}

/// Thrown when this build cannot prove numbers with Firebase, so the caller
/// falls back to the texted code.
class FirebasePhoneUnavailable implements Exception {}

/// Where Firebase's check page opens when the silent push cannot prove the
/// app: the venue's own address (member.pontardawerfc.com, which passes
/// /__/auth/ through to Firebase: vesopa_server loyalty_host.js), never
/// vesopa.firebaseapp.com (owner, 2026-10-25). Empty: Firebase's own.
const _authDomain = String.fromEnvironment('FIREBASE_AUTH_DOMAIN');

/// Text a code to [e164] (+447700900123).
Future<PhoneCheck> firebasePhoneStart(String e164) async {
  try {
    final answer = await _channel.invokeMapMethod<String, dynamic>('start', {'phone': e164, 'authDomain': _authDomain});
    return PhoneCheck(
      verification: answer?['verification'] as String?,
      token: answer?['token'] as String?,
    );
  } on MissingPluginException {
    throw FirebasePhoneUnavailable();
  } on PlatformException catch (e) {
    if (e.code == 'unavailable') throw FirebasePhoneUnavailable();
    throw ApiError(e.message ?? 'That number could not be checked. Please try again.');
  }
}

/// The ID token for the code the member typed.
Future<String> firebasePhoneConfirm(String verification, String code) async {
  try {
    final token = await _channel.invokeMethod<String>('confirm', {'verification': verification, 'code': code});
    if (token == null || token.isEmpty) throw ApiError('That code is not right. Please try again.');
    return token;
  } on PlatformException catch (e) {
    throw ApiError(e.message ?? 'That code is not right. Please try again.');
  }
}
