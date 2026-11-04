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
import 'package:flutter/widgets.dart';
import 'package:uuid/uuid.dart';

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

/// Dojo Tap to Pay on iPhone, and Dojo's payment app on a Dojo Pocket.
class DojoTapToPay implements PaymentService {
  DojoTapToPay(this.api, {MethodChannel? channel}) : _channel = channel ?? const MethodChannel('com.vesopa.go/dojo');

  final TapApi api;
  final MethodChannel _channel;

  String? _secret;

  /// Whether the person signed on may accept Apple's Tap to Pay terms for the
  /// venue (Apple 3.8: an administrator only). Set by the shell from the
  /// clerk's role; unset means yes, for the set-up screens that ask first.
  bool Function()? canAcceptTerms;

  /// The venue's Dojo location, set on the SDK before activation.
  String? _location;

  /// Apple 3.8.1, in words.
  static const notAdmin = "Tap to Pay on iPhone isn't set up for this venue yet. Ask a manager to set it up in Settings, or to sign on and take this payment.";

  /// The SDK's environment for [_secret], as the server said.
  String _env = 'staging';
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
            // Dojo's SDK runs on any NFC phone on Android 10+; whether Dojo
            // will take payments on it is the SDK's answer (2026-11-04).
            : 'Tap to Pay needs a phone with NFC on Android 10 or later.';
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

  /// One native Tap to Pay set-up call, given up after [limit] (2026-11-04:
  /// an iPhone sat on "Starting" for ever when Dojo's activation never
  /// answered). A stall becomes an error with words, and is logged.
  Future<T?> _step<T>(String name, Duration limit, Future<T?> Function() call) async {
    final watch = Stopwatch()..start();
    try {
      final r = await call().timeout(limit);
      // Each step in the server's log with its time, so a slow or failing
      // iPhone can be read there (2026-11-04).
      unawaited(api.reportTap({'platform': _platform, 'step': name, 'code': 'ok', 'message': '${watch.elapsedMilliseconds} ms${r == null ? '' : ' -> $r'}', 'environment': _env}));
      return r;
    } on PlatformException catch (e) {
      final info = e.details is Map ? '${(e.details as Map)['info'] ?? ''}' : '';
      unawaited(api.reportTap({'platform': _platform, 'step': name, 'code': e.code, 'message': '${e.message ?? ''} after ${watch.elapsedMilliseconds} ms', 'detail': info, 'environment': _env}));
      rethrow;
    } on TimeoutException {
      _active = false;
      final e = PlatformException(
        code: 'timeout',
        message: name == 'link'
            ? "Apple's Tap to Pay terms did not come back. Try again, and accept the terms when they appear."
            : 'Dojo has not finished setting up Tap to Pay on this iPhone ($name). It carries on in the background: '
                "try again in a minute. If it keeps happening, Dojo may not have enabled Tap to Pay on iPhone for the "
                "venue's account. Use the card machine or QR Pay meanwhile.",
        details: {'code': 'timeout', 'name': name},
      );
      unawaited(api.reportTapSetupError(step: name, env: _env, code: 'timeout', message: e.message ?? ''));
      throw e;
    }
  }

  Future<String> _freshSecret() async {
    // Renewed half an hour early: a payment must not start on a secret that
    // runs out while the customer is reaching for their card.
    if (_secret == null || DateTime.now().isAfter(_secretUntil.subtract(const Duration(minutes: 30)))) {
      final s = await api.tapSecret(_platform).timeout(const Duration(seconds: 20),
          onTimeout: () => throw const TapApiError(504, 'The back office did not answer. Check the connection and try again.'));
      _secret = s.secret;
      _env = s.env;
      _location = s.location;
      _secretUntil = DateTime.now().add(const Duration(hours: 6));
      _active = false;
    }
    return _secret!;
  }

  /// Words for a Tap to Pay set-up failure, by the step it failed at. Dojo's
  /// own errors mostly carry only a number.
  String _setupMessage(String step, PlatformException e, Map d) {
    final code = d['code'] != null ? ' (Dojo ${d['name'] != '' ? d['name'] : 'code'} ${d['code']})' : '';
    if (e.code == 'unsupported') return e.message ?? 'Tap to Pay is not available on this phone.';
    switch (step) {
      case 'activate':
        return 'Dojo would not switch on Tap to Pay for this iPhone$code. '
            'Either Apple has not yet given this version of Vesopa Go its Tap to Pay permission, '
            'or Dojo has not turned Tap to Pay on iPhone on for the venue\'s ${_env == 'production' ? 'live' : 'test'} key. '
            'Use the card machine or QR Pay for now.';
      case 'link':
        return 'This iPhone could not be linked to Tap to Pay$code. Accept Apple\'s Tap to Pay terms with the venue\'s Apple ID, then try again.';
      default:
        return 'Tap to Pay could not start: ${e.message ?? e.code}$code. Try again.';
    }
  }

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
    final paymentId = const Uuid().v4();
    if (via == 'machine') return _onMachine(paymentId, amountMinor, tipMinor, billRef, clerk, onStep, control);
    if (Platform.isAndroid) return _onPocket(amountMinor + tipMinor, onStep, reference: billRef);
    var created = false;
    var step = 'secret';
    try {
      onStep?.call(PayStep.preparing);
      final secret = await _freshSecret();
      step = 'activate';
      if (!_active) await _ready(secret, onStep: onStep);
      step = 'link';
      // Apple 3.7: the terms can be accepted from checkout, but only by an
      // administrator (3.8); anyone else is told who can (3.8.1).
      if (!(await _step('link', const Duration(seconds: 25), () => _channel.invokeMethod<bool>('isAccountLinked', {'secret': secret})) ?? false)) {
        if (!(canAcceptTerms?.call() ?? true)) return const PaymentOutcome(PayResult.unavailable, message: notAdmin);
        onStep?.call(PayStep.linking);
        await _step('link', const Duration(minutes: 5), () => _channel.invokeMethod('linkAccount', {'secret': secret}));
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
      if (e.code == 'not_admin' || e.code == 'timeout' || e.code == 'not_enabled') {
        return PaymentOutcome(PayResult.unavailable, message: e.message);
      }
      if (!created) {
        // It never reached a payment: nothing to check, nothing was taken.
        // The server hears which step failed, so it shows in the venue's logs.
        final d = e.details is Map ? e.details as Map : const {};
        unawaited(api.reportTapSetupError(step: step, env: _env, code: '${d['code'] ?? e.code}', message: e.message ?? ''));
        return PaymentOutcome(PayResult.unavailable, message: _setupMessage(step, e, d));
      }
      unawaited(api.reportTapError(paymentId, where: 'startPayment', code: e.code, message: e.message));
      // The card may still have gone through: ask the server before saying no.
      final outcome = await _confirm(paymentId, quick: true);
      return outcome.result == PayResult.paid ? outcome : PaymentOutcome(PayResult.declined, paymentId: paymentId, message: e.message);
    }
  }

  /// Tap to Pay on iPhone made ready, one at a time however many screens ask
  /// (2026-11-04): Dojo's status; activation when it is not operational;
  /// Apple's terms when the venue has not accepted them (a manager only);
  /// then the wait until Dojo says operational. [link] false leaves the terms
  /// to whoever asks next (the background warm-up).
  Future<void>? _readying;
  Future<void> _ready(String secret, {bool link = true, void Function(PayStep step)? onStep}) {
    final going = _readying;
    if (going != null) return going;
    final run = _readyOnce(secret, link: link, onStep: onStep).whenComplete(() => _readying = null);
    _readying = run;
    return run;
  }

  Future<void> _readyOnce(String secret, {required bool link, void Function(PayStep step)? onStep}) async {
    final env = {'secret': secret, 'env': _env, 'location': ?_location};
    var status = await _step<String>('status', const Duration(seconds: 25), () => _channel.invokeMethod<String>('status', env)) ?? '';
    if (status == 'operational') {
      _active = true;
      return;
    }
    if (status == 'failed') await _channel.invokeMethod('reset');
    onStep?.call(PayStep.activating);
    status = await _step<String>('activate', const Duration(seconds: 60), () => _channel.invokeMethod<String>('activate', env)) ?? '';
    if (status == 'operational') {
      _active = true;
      return;
    }
    // Dojo's order (their sample app; confirmed by the iPhone's log
    // 2026-11-04: before operational, isAccountLinked says "Order-id is
    // missing" and linkAccount "Terminal is not in operational state"):
    // wait until Dojo has provisioned the iPhone, then Apple's terms.
    onStep?.call(PayStep.activating);
    // "unknown" after activation: Dojo has no Tap to Pay terminal order for
    // the venue's account (the iPhone's log, 2026-11-04: "Order-id is
    // missing"), so waiting longer changes nothing. A minute, then words.
    if (status == 'unknown') {
      try {
        final d = await _channel.invokeMapMethod<String, Object?>('diagnose', env);
        unawaited(api.reportTap({'platform': _platform, 'step': 'diagnose', 'code': 'info', 'message': '$d', 'environment': _env}));
      } catch (_) {}
      try {
        await _step<String>('ready', const Duration(seconds: 60), () => _channel.invokeMethod<String>('waitOperational', env));
      } on PlatformException catch (e) {
        if (e.code != 'timeout') rethrow;
        throw PlatformException(
          code: 'not_enabled',
          message: "Dojo has not enabled Tap to Pay on iPhone for this venue's account yet, so this iPhone cannot be set up. "
              'Ask Dojo to switch on Tap to Pay on iPhone for the venue. Use the card machine or QR Pay meanwhile.',
        );
      }
    } else {
      await _step<String>('ready', const Duration(minutes: 4), () => _channel.invokeMethod<String>('waitOperational', env));
    }
    _active = true;
    if (!link) return;
    final linked = await _step('link', const Duration(seconds: 25), () => _channel.invokeMethod<bool>('isAccountLinked', {'secret': secret})) ?? false;
    if (!linked) {
      if (!(canAcceptTerms?.call() ?? true)) {
        throw PlatformException(code: 'not_admin', message: notAdmin);
      }
      onStep?.call(PayStep.linking);
      await _step('link', const Duration(minutes: 5), () => _channel.invokeMethod('linkAccount', {'secret': secret}));
    }
  }

  /// Gets Tap to Pay ready before the first payment (Apple asks apps to
  /// prepare the reader early, so the customer is not kept waiting): a fresh
  /// secret and the activation, in the background. Errors are ignored here;
  /// the payment itself will try again and say what is wrong.
  Future<void> prepare({bool again = false}) async {
    if (again) _active = false;
    if (!Platform.isIOS || _active) return;
    try {
      final secret = await _freshSecret();
      await _ready(secret, link: false);
    } catch (_) {}
  }

  /// Tap to Pay on iPhone set up before the first customer (Apple: the
  /// merchant accepts the terms before checkout): the secret, the activation,
  /// and Apple's terms sheet when the venue's account is not linked yet.
  /// Null when ready, else what is wrong.
  Future<String?> setUp() async {
    if (!Platform.isIOS) return 'Tap to Pay on iPhone is for iPhone.';
    final why = await whyUnavailable();
    if (why != null) return why;
    try {
      final secret = await _freshSecret();
      await _ready(secret);
      if (!(await _step('link', const Duration(seconds: 25), () => _channel.invokeMethod<bool>('isAccountLinked', {'secret': secret})) ?? false)) {
        if (!(canAcceptTerms?.call() ?? true)) return notAdmin;
        await _step('link', const Duration(minutes: 5), () => _channel.invokeMethod('linkAccount', {'secret': secret}));
      }
      return null;
    } on TapApiError catch (e) {
      return e.message;
    } on PlatformException catch (e) {
      _active = false;
      return e.message ?? e.code;
    }
  }

  /// Whether Apple's terms have been accepted for the venue's account.
  Future<bool?> isLinked() async {
    if (!Platform.isIOS) return null;
    try {
      final secret = await _freshSecret();
      await _step<String>('status', const Duration(seconds: 25), () => _channel.invokeMethod<String>('status', {'secret': secret, 'env': _env}));
      return await _step('link', const Duration(seconds: 25), () => _channel.invokeMethod<bool>('isAccountLinked', {'secret': secret}));
    } catch (_) {
      return null;
    }
  }

  /// Apple 5.12: asks for notifications well before checkout (from the Tap
  /// to Pay introduction), so a payment that is not approved while the app
  /// is closed can still be told.
  Future<bool> askNotifications() async {
    if (!Platform.isIOS) return false;
    try {
      return await _channel.invokeMethod<bool>('askNotify') ?? false;
    } catch (_) {
      return false;
    }
  }

  /// Tells the clerk a payment was not approved when the app is not on screen.
  Future<void> notifyIfAway(PaymentOutcome o, String amount) async {
    if (!Platform.isIOS || o.result == PayResult.paid) return;
    if (WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed) return;
    final (title, body) = switch (o.result) {
      PayResult.declined => ('Payment declined', '$amount was declined. No money was taken. Open Vesopa Go to try again or pay another way.'),
      PayResult.cancelled => ('Payment cancelled', '$amount was cancelled. Nothing was taken.'),
      PayResult.uncertain => ('Payment not confirmed', '$amount is not confirmed yet. Open Vesopa Go to check it before taking it again.'),
      _ => ('Payment not taken', '$amount did not go through. Open Vesopa Go to try again.'),
    };
    try {
      await _channel.invokeMethod('notify', {'title': title, 'body': body});
    } catch (_) {}
  }

  /// Apple's own guide to taking a payment with Tap to Pay on iPhone.
  Future<String?> showGuide() async {
    try {
      await _channel.invokeMethod('showEducation');
      return null;
    } on PlatformException catch (e) {
      return e.message ?? e.code;
    } on MissingPluginException {
      return 'This build has no Tap to Pay in it.';
    }
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

  /// A Dojo Pocket: Dojo's own app reads the card and answers with the
  /// transaction (MainActivity.kt). Its id, prefixed `pocket:`, is the
  /// payment's reference on the bill, and what a refund goes back through.
  /// Dojo's Pocket SDK started with the venue's account (MainActivity.kt,
  /// DojoPocketSdk.kt). Once per app run; when the back office cannot be
  /// reached the Pocket is driven by its intents instead, as before.
  bool _pocketSdk = false;
  String _sdkEnv = '';

  /// What went wrong, with the phone it went wrong on, to the server's log.
  Future<void> _report(String step, PlatformException e) async {
    Map<String, Object?> device = const {};
    try {
      device = (await _channel.invokeMapMethod<String, Object?>('deviceInfo')) ?? const {};
    } catch (_) {}
    unawaited(api.reportTap({
      'platform': _platform,
      'step': step,
      'code': e.code,
      'message': e.message,
      'sdk_ready': _pocketSdk,
      'environment': _sdkEnv,
      ...device,
    }));
  }

  Future<void> _configurePocket() async {
    if (_pocketSdk) return;
    try {
      final c = await api.pocketConfig();
      _sdkEnv = '${c['environment'] ?? ''}';
      await _channel.invokeMethod('pocketConfigure', {
        'apiKey': '${c['api_key'] ?? ''}',
        'softwareHouseId': '${c['software_house_id'] ?? ''}',
        'resellerId': '${c['reseller_id'] ?? ''}',
      });
      _pocketSdk = true;
    } on TapApiError {
      // Offline or an older back office: the intents still take the card.
    } on PlatformException catch (e) {
      unawaited(_report('configure', e));
      // The payment itself says why, in the SDK's words.
      if (e.code != 'setup') rethrow;
    }
  }

  Future<PaymentOutcome> _onPocket(int totalMinor, void Function(PayStep step)? onStep, {String? reference}) async {
    try {
      await _configurePocket();
      if (!_active) {
        onStep?.call(PayStep.activating);
        final init = await _channel.invokeMapMethod<String, Object?>('pocketInit');
        if (init?['init_result'] == false) {
          return PaymentOutcome(PayResult.unavailable, message: '${init?['init_result_detail'] ?? 'The Dojo app is not ready.'}');
        }
        _active = true;
      }
      onStep?.call(PayStep.waitingForCard);
      final r = await _channel.invokeMapMethod<String, Object?>('pocketSale', {'amount': totalMinor, 'reference': ?reference});
      onStep?.call(PayStep.done);
      return pocketOutcome(r);
    } on PlatformException catch (e) {
      if (e.code == 'cancelled') return const PaymentOutcome(PayResult.cancelled);
      unawaited(_report('sale', e));
      // Refused before the card was asked for (not a Pocket, the app out of
      // date, no connection, ...): nothing was taken, and the words say why.
      if (const {'dojo', 'setup', 'busy', 'unsupported'}.contains(e.code)) {
        return PaymentOutcome(PayResult.unavailable, message: e.message ?? 'The Dojo app could not take the payment.');
      }
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
  /// Through Dojo's SDK, as Dojo documents (DojoTapToPayOnPocket.refund),
  /// set up first like a sale; the intents only when the SDK could not be.
  Future<bool> refundOnPocket(int amountMinor) async {
    try {
      await _configurePocket();
      final r = await _channel.invokeMapMethod<String, Object?>('pocketRefund', {'amount': amountMinor});
      return pocketOutcome(r).paid;
    } on PlatformException catch (e) {
      unawaited(_report('refund', e));
      rethrow;
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

/// What Dojo's app answered (MainActivity.kt names each extra by its short
/// name: transaction_result, transaction_id, auth_code, ...).
PaymentOutcome pocketOutcome(Map<String, Object?>? r) {
  // The Pocket never answered and Dojo could not say either (the SDK's
  // MissingResponse): the card may have been charged.
  if (r?['missing'] == true) {
    return PaymentOutcome(PayResult.uncertain, message: '${r?['message'] ?? 'The Dojo app did not answer. Check the Pocket before taking it again.'}');
  }
  final id = r?['transaction_id']?.toString();
  final ref = 'pocket:${id == null || id.isEmpty ? const Uuid().v4() : id}';
  return switch ('${r?['transaction_result'] ?? r?['refund_status'] ?? ''}'.toUpperCase()) {
    'AUTHORISED' || 'AUTHORIZED' || 'SUCCESS' || 'SUCCESSFUL' => PaymentOutcome(PayResult.paid, paymentId: ref),
    'DECLINED' => PaymentOutcome(PayResult.declined, paymentId: ref, message: 'Declined'),
    // Dojo's FAILED: the payment did not go through (no money moved), not a
    // "check the app" (docs.dojo.tech/tap-to-pay-on-pocket, TRANSACTION_RESULT).
    'FAILED' => PaymentOutcome(PayResult.declined, paymentId: ref, message: 'The card payment failed. Nothing was taken.'),
    'CANCELLED' || 'CANCELED' => PaymentOutcome(PayResult.cancelled, paymentId: ref),
    _ => PaymentOutcome(PayResult.uncertain, paymentId: ref, message: 'The Dojo app did not say. Check it before taking the payment again.'),
  };
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
