/// Taking a card on the phone itself.
///
/// Bank cards are read only by Dojo's Tap to Pay SDK, which is certified for
/// it; this app never touches card data. The SDK lives in native code
/// (ios/Runner/DojoTapToPay.swift, and Android when Dojo publish theirs) and
/// is reached over the `com.vesopa.tap/dojo` channel. The order is Dojo's own
/// (docs.dojo.tech/tap-to-pay-on-iphone):
///
///   1. secret     the server gets a six-hour Tap to Pay secret with the
///                 venue's key (POST /api/tap/secret); the key never comes here
///   2. activate   the SDK activates this phone as a terminal with the secret,
///                 waiting until it reports operational
///   3. link       the first time, the venue's Apple account is linked to Tap
///                 to Pay (Apple shows its own terms sheet)
///   4. intent     the server creates the payment intent ONCE per payment id
///   5. pay        the SDK shows Apple's tap screen and reads the card
///   6. confirm    the server asks Dojo for the intent: only Captured is paid
///
/// Step 6 is the one that counts. The SDK saying "approved" is what the clerk
/// sees first; the bill is settled on the server's answer, so a phone that
/// drops off the wifi at the wrong moment cannot mark a bill paid that is not.
library;

import 'dart:async';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:uuid/uuid.dart';

import '../config/constants.dart';
import '../data/api.dart';

enum PayResult { paid, declined, cancelled, uncertain, unavailable }

class PaymentOutcome {
  const PaymentOutcome(this.result, {this.paymentId, this.message});
  final PayResult result;
  final String? paymentId;
  final String? message;
  bool get paid => result == PayResult.paid;
}

/// Where a step of the payment has got to, for the screen.
enum PayStep { preparing, activating, linking, waitingForCard, onMachine, confirming, done }

abstract class PaymentService {
  /// Whether this phone can take a tap at all, and why not if not.
  Future<String?> whyUnavailable();

  Future<PaymentOutcome> take({
    required int amountMinor,
    int tipMinor = 0,
    String? billRef,
    String? clerk,
    String via = 'tap',
    void Function(PayStep step)? onStep,
  });
}

/// Dojo Tap to Pay on iPhone (and Android, when its SDK is out).
class DojoTapToPay implements PaymentService {
  DojoTapToPay(this.api, {MethodChannel? channel}) : _channel = channel ?? const MethodChannel('com.vesopa.tap/dojo');

  final TapApi api;
  final MethodChannel _channel;

  String? _secret;
  DateTime _secretUntil = DateTime.fromMillisecondsSinceEpoch(0);
  bool _active = false;

  String get _platform => Platform.isIOS ? 'ios' : 'android';

  @override
  Future<String?> whyUnavailable() async {
    try {
      final ok = await _channel.invokeMethod<bool>('isSupported') ?? false;
      if (!ok) {
        return Platform.isIOS
            ? 'Tap to Pay needs an iPhone XS or newer on iOS 16.7 or later.'
            : 'Tap to Pay on Android is waiting for Dojo\'s Android SDK. Use the card machine for now.';
      }
      final config = await api.tapConfig();
      if (!Platform.isIOS && config['android'] != true) return 'Tap to Pay on Android is not switched on for this venue yet.';
      return null;
    } on TapApiError catch (e) {
      return e.message;
    } on PlatformException catch (e) {
      return e.message ?? 'Tap to Pay is not available on this phone.';
    } on MissingPluginException {
      return 'This build of Vesopa Tap has no Tap to Pay in it.';
    }
  }

  Future<String> _freshSecret() async {
    // Renewed half an hour early: a payment must not start on a secret that
    // runs out while the customer is reaching for their card.
    if (_secret == null || DateTime.now().isAfter(_secretUntil.subtract(const Duration(minutes: 30)))) {
      _secret = await api.tapSecret(_platform);
      _secretUntil = DateTime.now().add(const Duration(hours: 6));
      _active = false;
    }
    return _secret!;
  }

  @override
  Future<PaymentOutcome> take({
    required int amountMinor,
    int tipMinor = 0,
    String? billRef,
    String? clerk,
    String via = 'tap',
    void Function(PayStep step)? onStep,
  }) async {
    final paymentId = const Uuid().v4();
    if (via == 'machine') return _onMachine(paymentId, amountMinor, tipMinor, billRef, clerk, onStep);
    try {
      onStep?.call(PayStep.preparing);
      final secret = await _freshSecret();
      if (!_active) {
        onStep?.call(PayStep.activating);
        await _channel.invokeMethod('activate', {'secret': secret, 'env': dojoEnvironment});
        _active = true;
      }
      if (!(await _channel.invokeMethod<bool>('isAccountLinked', {'secret': secret}) ?? false)) {
        onStep?.call(PayStep.linking);
        await _channel.invokeMethod('linkAccount', {'secret': secret});
      }

      final created = await api.createPayment(
        id: paymentId, amountMinor: amountMinor, tipMinor: tipMinor, billRef: billRef, clerk: clerk);
      onStep?.call(PayStep.waitingForCard);
      final sdk = await _channel.invokeMapMethod<String, Object?>('startPayment', {
        'paymentIntentId': created['intent_id'],
        'secret': secret,
      });
      if (sdk?['cancelled'] == true) {
        try {
          await api.cancelPayment(paymentId);
        } on TapApiError {
          // the intent expires on its own at Dojo; nothing was taken
        }
        return PaymentOutcome(PayResult.cancelled, paymentId: paymentId);
      }

      onStep?.call(PayStep.confirming);
      final outcome = await _confirm(paymentId);
      onStep?.call(PayStep.done);
      return outcome;
    } on TapApiError catch (e) {
      return PaymentOutcome(PayResult.unavailable, paymentId: paymentId, message: e.message);
    } on PlatformException catch (e) {
      if (e.code == 'cancelled') return PaymentOutcome(PayResult.cancelled, paymentId: paymentId);
      if (e.code == 'unsupported') _active = false;
      // The card may still have gone through: ask the server before saying no.
      final outcome = await _confirm(paymentId, quick: true);
      return outcome.result == PayResult.paid ? outcome : PaymentOutcome(PayResult.declined, paymentId: paymentId, message: e.message);
    }
  }

  /// The venue's Dojo card machine: the server starts it, the customer uses
  /// the machine, and the phone asks how it is going -- the kiosk's way.
  Future<PaymentOutcome> _onMachine(String paymentId, int amountMinor, int tipMinor, String? billRef, String? clerk,
      void Function(PayStep step)? onStep) async {
    try {
      onStep?.call(PayStep.preparing);
      await api.createPayment(id: paymentId, amountMinor: amountMinor, tipMinor: tipMinor, billRef: billRef, clerk: clerk, via: 'machine');
      onStep?.call(PayStep.onMachine);
      final outcome = await _confirm(paymentId, seconds: 120);
      onStep?.call(PayStep.done);
      return outcome;
    } on TapApiError catch (e) {
      return PaymentOutcome(PayResult.unavailable, paymentId: paymentId, message: e.message);
    }
  }

  /// Ask the server until Dojo has a verdict (~30 seconds; longer on a card machine).
  Future<PaymentOutcome> _confirm(String paymentId, {bool quick = false, int seconds = 30}) async {
    final until = DateTime.now().add(Duration(seconds: quick ? 6 : seconds));
    while (DateTime.now().isBefore(until)) {
      try {
        final p = await api.payment(paymentId);
        switch (p['state']) {
          case 'paid':
            return PaymentOutcome(PayResult.paid, paymentId: paymentId);
          case 'failed':
            return PaymentOutcome(PayResult.declined, paymentId: paymentId, message: 'Declined');
          case 'cancelled':
            return PaymentOutcome(PayResult.cancelled, paymentId: paymentId);
        }
      } on TapApiError {
        // keep asking: the phone may be between wifi and mobile data
      }
      await Future<void>.delayed(const Duration(milliseconds: 1500));
    }
    return PaymentOutcome(PayResult.uncertain, paymentId: paymentId,
        message: 'No answer from Dojo yet. Check the payment before taking it again.');
  }
}

/// The demo venue's pretend card payments. An amount ending in 13p is
/// declined, so a decline can be shown and rehearsed.
class DemoPayments implements PaymentService {
  @override
  Future<String?> whyUnavailable() async => null;

  @override
  Future<PaymentOutcome> take({
    required int amountMinor,
    int tipMinor = 0,
    String? billRef,
    String? clerk,
    String via = 'tap',
    void Function(PayStep step)? onStep,
  }) async {
    onStep?.call(PayStep.preparing);
    await Future<void>.delayed(const Duration(milliseconds: 400));
    onStep?.call(via == 'machine' ? PayStep.onMachine : PayStep.waitingForCard);
    await Future<void>.delayed(const Duration(milliseconds: 1600));
    onStep?.call(PayStep.confirming);
    await Future<void>.delayed(const Duration(milliseconds: 500));
    onStep?.call(PayStep.done);
    final id = const Uuid().v4();
    return (amountMinor + tipMinor) % 100 == 13
        ? PaymentOutcome(PayResult.declined, paymentId: id, message: 'Declined by the card issuer (demo)')
        : PaymentOutcome(PayResult.paid, paymentId: id);
  }
}
