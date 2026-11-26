/// Taking a card payment: the services Go can take one through.
///
///   DojoCardMachine   the venue's Dojo card machine (cloud terminal)
///   StripeTapToPay    Stripe Tap to Pay on this phone, and Stripe's readers
///                     (stripe_tap.dart)
///   TeyaCardMachine   the venue's Teya machines (teya_machine.dart)
///   DemoPayments      the demo venue
///
/// Go never touches card data: the card is read by Stripe's certified SDK or
/// by the card machine, and the bill is settled on the server's answer.
library;

import 'dart:async';

import 'package:flutter/foundation.dart' show defaultTargetPlatform, kIsWeb, TargetPlatform;
import 'package:uuid/uuid.dart';

import '../config/constants.dart' show iosTapToPayGranted;
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

/// Whether Tap to Pay may be offered on this device at all: everywhere but an
/// iPhone or iPad built without Apple's Tap to Pay entitlement
/// ([iosTapToPayGranted]). Where it is false, Go shows no Tap to Pay button,
/// card or set-up screen (App Review 2.1: nothing that cannot work).
bool get tapToPayOnThisPlatform => kIsWeb || defaultTargetPlatform != TargetPlatform.iOS || iosTapToPayGranted;

/// Where a step of the payment has got to, for the screen.
enum PayStep { preparing, activating, linking, waitingForCard, onMachine, pin, signature, cancelling, confirming, done }

/// What the clerk can do to a payment while it runs: cancel it, and check a
/// customer's signature when the card machine asks (Dojo's accreditation:
/// TS-05 accepting completes the sale, TS-08 declining is never money taken;
/// a cancel before the card is in stops it, ERR-422 after it is left alone).
class PayControl {
  PayControl({this.checkSignature});

  /// Asks the clerk to compare the signature with the card: true accepts.
  Future<bool> Function()? checkSignature;

  /// Told when the machine would not cancel (the card is already in).
  void Function()? onCancelRefused;

  bool _cancel = false;
  bool get cancelRequested => _cancel;
  void cancel() => _cancel = true;
}

/// Follow a sale or refund on the venue's card machine to its verdict: each
/// prompt as a step, a signature answered by the clerk, a cancel sent when
/// the clerk asks. Shared by sales and refunds on the machine.
Future<PaymentOutcome> followMachine({
  required String id,
  required Future<Map<String, dynamic>> Function() poll,
  required Future<Map<String, dynamic>> Function() cancel,
  required Future<void> Function(bool accepted) answer,
  void Function(PayStep step)? onStep,
  PayControl? control,
  int seconds = 180,
}) async {
  var until = DateTime.now().add(Duration(seconds: seconds));
  var cancelSent = false;
  var answered = false;
  bool? signature;
  PayStep? last;
  void step(PayStep s) {
    if (s == last) return;
    last = s;
    onStep?.call(s);
  }

  while (DateTime.now().isBefore(until)) {
    if (control != null && control.cancelRequested && !cancelSent) {
      cancelSent = true;
      step(PayStep.cancelling);
      try {
        final r = await cancel();
        if (r['state'] == 'cancelled') return PaymentOutcome(PayResult.cancelled, paymentId: id);
        if (r['cancel_refused'] == true) control.onCancelRefused?.call();
      } on TapApiError {
        // asked again below: the verdict is the machine's
      }
    }
    try {
      final p = await poll();
      switch ('${p['state'] ?? ''}') {
        case 'paid':
          return PaymentOutcome(PayResult.paid, paymentId: id);
        case 'failed':
          return PaymentOutcome(PayResult.declined,
              paymentId: id, message: signature == false ? 'The signature was declined, so nothing was taken.' : 'Declined');
        case 'cancelled':
          return PaymentOutcome(PayResult.cancelled, paymentId: id);
        case 'expired':
          return PaymentOutcome(PayResult.uncertain,
              paymentId: id, message: 'The card machine stopped answering. Check its screen before taking the payment again.');
        case 'signature':
          if (!answered) {
            answered = true;
            step(PayStep.signature);
            final ok = await (control?.checkSignature?.call() ?? Future.value(true));
            signature = ok;
            try {
              await answer(ok);
            } on TapApiError {
              answered = false; // the machine did not hear it: ask again
            }
            // The machine has the answer; give it time to finish.
            until = DateTime.now().add(const Duration(seconds: 90));
            step(PayStep.confirming);
          }
        default:
          answered = false;
          final prompt = '${p['prompt'] ?? ''}'.toLowerCase();
          if (!cancelSent) {
            step(prompt.contains('pin')
                ? PayStep.pin
                : (prompt.contains('author') || prompt.contains('process') || prompt.contains('remove'))
                    ? PayStep.confirming
                    : PayStep.onMachine);
          }
      }
    } on TapApiError {
      // keep asking: the phone may be between wifi and mobile data
    }
    await Future<void>.delayed(const Duration(milliseconds: 1200));
  }
  return PaymentOutcome(PayResult.uncertain,
      paymentId: id, message: 'No answer from the card machine yet. Check it before taking the payment again.');
}

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
    PayControl? control,
  });
}

/// The venue's Dojo card machine (the cloud terminal): the server starts the
/// payment on the machine and Go follows it. Dojo's Tap to Pay SDKs (on
/// iPhone, and on a Dojo Pocket) were removed on 2026-11-18 (owner: "Remove
/// DOJO Tap to Pay SDK completely but keep DOJO terminal and Stripe
/// Terminal, Stripe Tap to Pay and Teya Terminal"): Tap to Pay on this device
/// is Stripe's (stripe_tap.dart).
class DojoCardMachine implements PaymentService {
  DojoCardMachine(this.api);

  final TapApi api;

  /// What a clerk reads when this device itself is asked to read a card.
  static const noTapToPay = 'Tap to Pay on this device is Vesopa Tap to Pay. Switch it on in Settings, '
      'Card payments, or take this payment on the card machine.';

  @override
  Future<String?> whyUnavailable() async => null;

  @override
  Future<PaymentOutcome> take({
    required int amountMinor,
    int tipMinor = 0,
    String? billRef,
    String? clerk,
    String via = 'machine',
    void Function(PayStep step)? onStep,
    PayControl? control,
  }) async {
    final paymentId = const Uuid().v4();
    if (via != 'machine') return PaymentOutcome(PayResult.unavailable, paymentId: paymentId, message: noTapToPay);
    return _onMachine(paymentId, amountMinor, tipMinor, billRef, clerk, onStep, control);
  }

  /// The venue's Dojo card machine: the server starts it, the customer uses
  /// the machine, and the phone asks how it is going -- the kiosk's way.
  Future<PaymentOutcome> _onMachine(String paymentId, int amountMinor, int tipMinor, String? billRef, String? clerk,
      void Function(PayStep step)? onStep, PayControl? control) async {
    try {
      onStep?.call(PayStep.preparing);
      await api.createPayment(
          id: paymentId, amountMinor: amountMinor, tipMinor: tipMinor, billRef: billRef, clerk: clerk, via: 'machine', terminalId: await deviceMachine());
      onStep?.call(PayStep.onMachine);
      final outcome = await followMachine(
        id: paymentId,
        poll: () => api.machinePayment(paymentId),
        cancel: () => api.cancelPayment(paymentId),
        answer: (ok) => api.answerSignature(paymentId, accepted: ok, by: clerk),
        onStep: onStep,
        control: control,
      );
      if (outcome.paid) onStep?.call(PayStep.done);
      return outcome;
    } on TapApiError catch (e) {
      return PaymentOutcome(PayResult.unavailable, paymentId: paymentId, message: e.message);
    }
  }
}



/// The demo venue's pretend card payments. An amount ending in 13p is
/// declined, and one ending in 42p on the card machine asks for a signature,
/// so a decline and a signature check can be shown and rehearsed.
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
    PayControl? control,
  }) async {
    final id = const Uuid().v4();
    onStep?.call(PayStep.preparing);
    await Future<void>.delayed(const Duration(milliseconds: 400));
    onStep?.call(via == 'machine' ? PayStep.onMachine : PayStep.waitingForCard);
    for (var i = 0; i < 16; i++) {
      await Future<void>.delayed(const Duration(milliseconds: 100));
      if (control?.cancelRequested == true) return PaymentOutcome(PayResult.cancelled, paymentId: id);
    }
    if (via == 'machine' && (amountMinor + tipMinor) % 100 == 42) {
      onStep?.call(PayStep.signature);
      final ok = await (control?.checkSignature?.call() ?? Future.value(true));
      if (!ok) return PaymentOutcome(PayResult.declined, paymentId: id, message: 'The signature was declined, so nothing was taken.');
    }
    onStep?.call(PayStep.confirming);
    await Future<void>.delayed(const Duration(milliseconds: 500));
    onStep?.call(PayStep.done);
    return (amountMinor + tipMinor) % 100 == 13
        ? PaymentOutcome(PayResult.declined, paymentId: id, message: 'Declined by the card issuer (demo)')
        : PaymentOutcome(PayResult.paid, paymentId: id);
  }
}
