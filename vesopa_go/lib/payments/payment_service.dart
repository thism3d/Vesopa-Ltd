/// Taking a card on the phone itself.
///
/// Bank cards are read only by Dojo's Tap to Pay SDK, which is certified for
/// it; this app never touches card data. The SDK lives in native code
/// (ios/Runner/DojoTapToPay.swift) and is reached over the `com.vesopa.go/dojo`
/// channel. On Android the card is read by Dojo's own app on a Dojo Pocket
/// (MainActivity.kt, Dojo's sale intents; see [DojoTapToPay._onPocket]). The
/// iPhone's order is Dojo's own (docs.dojo.tech/tap-to-pay-on-iphone):
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
import '../ui/pages/card_machine_page.dart' show deviceMachine;

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

/// Dojo Tap to Pay on iPhone, and Dojo's payment app on a Dojo Pocket.
class DojoTapToPay implements PaymentService {
  DojoTapToPay(this.api, {MethodChannel? channel}) : _channel = channel ?? const MethodChannel('com.vesopa.go/dojo');

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
            : 'Card payments on an Android device need a Dojo Pocket. Use the card machine on this one.';
      }
      // The Pocket has the venue's Dojo account in it already.
      if (!Platform.isIOS) return null;
      await api.tapConfig();
      return null;
    } on TapApiError catch (e) {
      return e.message;
    } on PlatformException catch (e) {
      return e.message ?? 'Tap to Pay is not available on this phone.';
    } on MissingPluginException {
      return 'This build of Vesopa Go has no Tap to Pay in it.';
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
    if (Platform.isAndroid) return _onPocket(amountMinor + tipMinor, onStep);
    var created = false;
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

      final made = await api.createPayment(
        id: paymentId, amountMinor: amountMinor, tipMinor: tipMinor, billRef: billRef, clerk: clerk);
      created = true;
      onStep?.call(PayStep.waitingForCard);
      final sdk = await _channel.invokeMapMethod<String, Object?>('startPayment', {
        'paymentIntentId': made['intent_id'],
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
      // Dojo said no on the phone: a quick word with the server (it has the
      // last say), then the decline at once rather than half a minute later.
      final status = '${sdk?['status'] ?? ''}'.toLowerCase();
      if (status.contains('decline')) {
        unawaited(api.reportTapError(paymentId, where: 'startPayment', code: 'decline', message: 'Dojo declined the card on the phone'));
        final check = await _confirm(paymentId, quick: true);
        if (check.paid) return check;
        return PaymentOutcome(PayResult.declined, paymentId: paymentId, message: 'Declined by the card issuer');
      }

      onStep?.call(PayStep.confirming);
      final outcome = await _confirm(paymentId);
      onStep?.call(PayStep.done);
      return outcome;
    } on TapApiError catch (e) {
      return PaymentOutcome(PayResult.unavailable, paymentId: paymentId, message: e.message);
    } on PlatformException catch (e) {
      // Whatever went wrong, the next payment starts Tap to Pay afresh: a new
      // secret and a new activation, never a half-dead session from before.
      _active = false;
      _secret = null;
      if (e.code == 'cancelled') {
        if (created) unawaited(api.cancelPayment(paymentId).then((_) {}, onError: (Object _) {}));
        return PaymentOutcome(PayResult.cancelled, paymentId: paymentId);
      }
      if (!created) {
        // It never reached a payment: nothing to check, nothing was taken.
        return PaymentOutcome(PayResult.unavailable, message: 'Tap to Pay could not start: ${e.message ?? e.code}. Try again.');
      }
      unawaited(api.reportTapError(paymentId, where: 'startPayment', code: e.code, message: e.message));
      // The card may still have gone through: ask the server before saying no.
      final outcome = await _confirm(paymentId, quick: true);
      return outcome.result == PayResult.paid ? outcome : PaymentOutcome(PayResult.declined, paymentId: paymentId, message: e.message);
    }
  }

  /// Gets Tap to Pay ready before the first payment (Apple asks apps to
  /// prepare the reader early, so the customer is not kept waiting): a fresh
  /// secret and the activation, in the background. Errors are ignored here;
  /// the payment itself will try again and say what is wrong.
  Future<void> prepare() async {
    if (!Platform.isIOS || _active) return;
    try {
      final secret = await _freshSecret();
      await _channel.invokeMethod('activate', {'secret': secret, 'env': dojoEnvironment});
      _active = true;
    } catch (_) {}
  }

  /// The venue's Dojo card machine: the server starts it, the customer uses
  /// the machine, and the phone asks how it is going -- the kiosk's way.
  Future<PaymentOutcome> _onMachine(String paymentId, int amountMinor, int tipMinor, String? billRef, String? clerk,
      void Function(PayStep step)? onStep) async {
    try {
      onStep?.call(PayStep.preparing);
      await api.createPayment(
          id: paymentId, amountMinor: amountMinor, tipMinor: tipMinor, billRef: billRef, clerk: clerk, via: 'machine', terminalId: await deviceMachine());
      onStep?.call(PayStep.onMachine);
      final outcome = await _confirm(paymentId, seconds: 120);
      onStep?.call(PayStep.done);
      return outcome;
    } on TapApiError catch (e) {
      return PaymentOutcome(PayResult.unavailable, paymentId: paymentId, message: e.message);
    }
  }

  /// A Dojo Pocket: Dojo's own app reads the card and answers with the
  /// transaction (MainActivity.kt). Its id, prefixed `pocket:`, is the
  /// payment's reference on the bill, and what a refund goes back through.
  Future<PaymentOutcome> _onPocket(int totalMinor, void Function(PayStep step)? onStep) async {
    try {
      if (!_active) {
        onStep?.call(PayStep.activating);
        final init = await _channel.invokeMapMethod<String, Object?>('pocketInit');
        if (init?['init_result'] == false) {
          return PaymentOutcome(PayResult.unavailable, message: '${init?['init_result_detail'] ?? 'The Dojo app is not ready.'}');
        }
        _active = true;
      }
      onStep?.call(PayStep.waitingForCard);
      final r = await _channel.invokeMapMethod<String, Object?>('pocketSale', {'amount': totalMinor});
      onStep?.call(PayStep.done);
      return pocketOutcome(r);
    } on PlatformException catch (e) {
      if (e.code == 'cancelled') return const PaymentOutcome(PayResult.cancelled);
      // The answer was lost: ask the Pocket what its last payment did.
      try {
        final last = pocketOutcome(await _channel.invokeMapMethod<String, Object?>('pocketLastTx'));
        if (last.paid) return last;
      } on PlatformException {
        // fall through
      }
      return PaymentOutcome(PayResult.uncertain, message: '${e.message ?? 'No answer from the Dojo app.'} Check the Dojo app before taking it again.');
    }
  }

  /// A refund of a Pocket payment, on the Pocket: the customer taps the card again.
  Future<bool> refundOnPocket(int amountMinor) async {
    final r = await _channel.invokeMapMethod<String, Object?>('pocketRefund', {'amount': amountMinor});
    return pocketOutcome(r).paid;
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

/// What Dojo's app answered (MainActivity.kt names each extra by its short
/// name: transaction_result, transaction_id, auth_code, ...).
PaymentOutcome pocketOutcome(Map<String, Object?>? r) {
  final id = r?['transaction_id']?.toString();
  final ref = 'pocket:${id == null || id.isEmpty ? const Uuid().v4() : id}';
  return switch ('${r?['transaction_result'] ?? r?['refund_status'] ?? ''}'.toUpperCase()) {
    'AUTHORISED' || 'AUTHORIZED' || 'SUCCESS' || 'SUCCESSFUL' => PaymentOutcome(PayResult.paid, paymentId: ref),
    'DECLINED' => PaymentOutcome(PayResult.declined, paymentId: ref, message: 'Declined'),
    'CANCELLED' || 'CANCELED' => PaymentOutcome(PayResult.cancelled, paymentId: ref),
    _ => PaymentOutcome(PayResult.uncertain, paymentId: ref, message: 'The Dojo app did not say. Check it before taking the payment again.'),
  };
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
