/// Stripe's own native screens for signing a venue up to Vesopa Go
/// (owner, 2026-11-17: "Native Stripe mobile SDK"):
///
///   * [StripeOnboarding.verifyIdentity]     Stripe Identity: the owner's
///     photo ID and a live selfie
///   * [StripeOnboarding.accountOnboarding]  Stripe Connect's account
///     onboarding: the business, its people and its bank account
///   * [StripeOnboarding.collectCard]        the card sheet, saving the card
///     for the licence (a SetupIntent; nothing is charged during the trial)
///
/// The server makes every session (vesopa_server/src/go_onboarding.js); the
/// phone never holds a secret key. iOS: StripeIdentity, StripeConnect and
/// StripePaymentSheet. Android: com.stripe:identity, connect and paymentsheet.
library;

import 'package:flutter/services.dart';

/// How one of Stripe's screens ended.
enum StripeFlowEnd { completed, canceled, failed }

class StripeFlowResult {
  const StripeFlowResult(this.end, [this.message]);
  final StripeFlowEnd end;
  final String? message;

  bool get completed => end == StripeFlowEnd.completed;

  static StripeFlowResult parse(Object? raw) {
    final s = (raw as String?) ?? 'failed';
    if (s == 'completed') return const StripeFlowResult(StripeFlowEnd.completed);
    if (s == 'canceled') return const StripeFlowResult(StripeFlowEnd.canceled);
    return StripeFlowResult(StripeFlowEnd.failed, s.startsWith('failed:') ? s.substring(7) : null);
  }
}

class StripeOnboarding {
  StripeOnboarding._();

  static const _channel = MethodChannel('com.vesopa.go/stripe_onboarding');
  static Future<String?> Function()? _fetchClientSecret;
  static bool _listening = false;

  static void _listen() {
    if (_listening) return;
    _listening = true;
    _channel.setMethodCallHandler((call) async {
      // Stripe's Connect screens ask for a fresh account session whenever
      // theirs runs out; the server makes it.
      if (call.method == 'fetchClientSecret') return await _fetchClientSecret?.call();
      return null;
    });
  }

  /// The owner's photo ID and a live selfie. [sessionId] and
  /// [ephemeralKeySecret] come from POST /api/go/onboarding/identity.
  static Future<StripeFlowResult> verifyIdentity({
    required String sessionId,
    required String ephemeralKeySecret,
    required String publishableKey,
  }) async {
    try {
      return StripeFlowResult.parse(await _channel.invokeMethod<String>('verifyIdentity', {
        'sessionId': sessionId,
        'ephemeralKeySecret': ephemeralKeySecret,
        'publishableKey': publishableKey,
      }));
    } on PlatformException catch (e) {
      return StripeFlowResult(StripeFlowEnd.failed, e.message);
    }
  }

  /// Stripe Connect's account onboarding, over Go. [fetchClientSecret] is
  /// called for the first account session and again whenever Stripe needs a
  /// new one. Ends when the owner closes it: read the status from the server.
  static Future<StripeFlowResult> accountOnboarding({
    required String publishableKey,
    required Future<String?> Function() fetchClientSecret,
    String title = 'Verify your business',
  }) async {
    _fetchClientSecret = fetchClientSecret;
    _listen();
    try {
      return StripeFlowResult.parse(await _channel.invokeMethod<String>('accountOnboarding', {
        'publishableKey': publishableKey,
        'title': title,
        'termsUrl': 'https://go.vesopa.com/terms',
        'privacyUrl': 'https://go.vesopa.com/privacy',
      }));
    } on PlatformException catch (e) {
      return StripeFlowResult(StripeFlowEnd.failed, e.message);
    } finally {
      _fetchClientSecret = null;
    }
  }

  /// The card for Vesopa's licence, saved through [setupIntentClientSecret].
  static Future<StripeFlowResult> collectCard({
    required String publishableKey,
    required String setupIntentClientSecret,
    String merchantName = 'Vesopa Software Ltd',
    /// Apple Pay (iOS, in a build carrying the merchant entitlement) and
    /// Google Pay (Android) beside the card and Link (owner, 2026-11-18).
    bool wallets = true,
    String applePayMerchantId = 'merchant.com.vesopa.go',
  }) async {
    try {
      return StripeFlowResult.parse(await _channel.invokeMethod<String>('collectCard', {
        'publishableKey': publishableKey,
        'clientSecret': setupIntentClientSecret,
        'merchantName': merchantName,
        'wallets': wallets,
        'applePayMerchantId': applePayMerchantId,
      }));
    } on PlatformException catch (e) {
      return StripeFlowResult(StripeFlowEnd.failed, e.message);
    }
  }
}
