/// Mobile numbers proved by Firebase Authentication (2026-10-13).
///
/// Firebase texts the code, to any country, and answers an ID token that the
/// server checks (vesopa_server/src/firebase_phone.js). The native halves are
/// android/.../PhoneBridge.kt and ios/Runner/PhoneBridge.swift. A browser and
/// Windows keep the texted code the server sends itself.
library;

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import '../data/api.dart';

const _channel = MethodChannel('vesopa_loyalty/phone');

/// Whether this device can prove a number with Firebase: the phone apps.
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

/// Text a code to [e164] (+447700900123).
Future<PhoneCheck> firebasePhoneStart(String e164) async {
  try {
    final answer = await _channel.invokeMapMethod<String, dynamic>('start', {'phone': e164});
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
