/// Tap to Pay through Stripe Terminal, for a venue the back office has put on
/// Stripe (Card Payments, Who takes the cards). Every other venue is on Dojo.
///
/// Stripe's SDK provisions any app holding Apple's entitlement, and its test
/// mode has a simulated reader, so the whole flow runs here with no card and no
/// real money while the venue's account is a sandbox one. The server creates
/// each payment on the venue's own account (src/stripe.js): no key on the phone.
library;

import 'dart:async';

import 'package:mek_stripe_terminal/mek_stripe_terminal.dart';
import 'package:permission_handler/permission_handler.dart';

import '../data/api.dart';
import 'payment_service.dart';
import '../ui/pages/stripe_reader_page.dart' show deviceStripeReader;

/// The verdict the server gives on a Stripe payment.
PayResult stripeResult(String? status) => switch (status) {
  'succeeded' => PayResult.paid,
  'canceled' => PayResult.cancelled,
  'requires_payment_method' => PayResult.declined,
  _ => PayResult.uncertain,
};

/// What an SDK error means for the sale.
PaymentOutcome stripeFailure(TerminalException e, {String? paymentId}) {
  final declined =
      e.code == TerminalExceptionCode.declinedByStripeApi || e.code == TerminalExceptionCode.declinedByReader;
  if (declined) {
    return PaymentOutcome(PayResult.declined, paymentId: paymentId, message: 'The card was declined.');
  }
  if (e.code == TerminalExceptionCode.canceled) {
    return PaymentOutcome(PayResult.cancelled, paymentId: paymentId);
  }
  // Anything else may or may not have reached the card, so it is never "failed".
  return PaymentOutcome(PayResult.uncertain, paymentId: paymentId, message: tapProblemWords(e));
}

/// A Tap to Pay problem that is not the bank's answer, in words the clerk can
/// act on (2026-11-09: an iPhone's Apple Pay on the Kitchen's Android phone
/// timed out, then broke off, and Go only said Stripe's own sentence).
String tapProblemWords(TerminalException e) {
  const hold =
      'Hold the card, phone or watch flat on the back of this device, near the top, and keep it still until the tick.';
  const wallet = 'On an iPhone or Apple Watch, double-click the side button and look at it (or enter the passcode) first.';
  return switch (e.code) {
    TerminalExceptionCode.cardReadTimedOut => 'No card or phone was read in time. Nothing was taken. $hold $wallet',
    TerminalExceptionCode.cardRemoved ||
    TerminalExceptionCode.cardInsertNotRead ||
    TerminalExceptionCode.cardSwipeNotRead ||
    TerminalExceptionCode.unexpectedReaderError ||
    TerminalExceptionCode.missingEmvData => 'The card or phone moved away before it was read. Nothing was taken. Try again. $hold',
    TerminalExceptionCode.unexpectedSdkError when e.message.contains('reader failure') =>
      'The card or phone moved away before it was read. Nothing was taken. Try again. $hold $wallet',
    TerminalExceptionCode.tapToPayPinUnavailable =>
      'This card needs its PIN and this phone cannot take PINs. Nothing was taken. Use the card machine, or pay with a phone or watch wallet.',
    TerminalExceptionCode.nfcDisabled => 'NFC is off on this phone. Turn on NFC in Settings, then try again. Nothing was taken.',
    TerminalExceptionCode.commandNotAllowedDuringCall => 'Tap to Pay cannot run during a phone call. End the call and try again. Nothing was taken.',
    TerminalExceptionCode.notConnectedToInternet ||
    TerminalExceptionCode.internetConnectTimeOut ||
    TerminalExceptionCode.requestTimedOut ||
    TerminalExceptionCode.stripeApiConnectionError ||
    TerminalExceptionCode.internalNetworkError =>
      'This phone lost its connection to Stripe. Check Wi-Fi or mobile data and check the payment before taking it again.',
    TerminalExceptionCode.stripeApiError || TerminalExceptionCode.stripeApiResponseDecodingError =>
      'Stripe had a problem with this payment (${e.message}). Check the payment before taking it again.',
    TerminalExceptionCode.connectionTokenProviderError || TerminalExceptionCode.sessionExpired =>
      'Tap to Pay needs to sign in to Stripe again. Nothing was taken. Try again in a moment.',
    TerminalExceptionCode.notConnectedToReader || TerminalExceptionCode.readerBusy =>
      'Tap to Pay was not ready on this phone. Nothing was taken. Try again.',
    TerminalExceptionCode.tapToPayUnsupportedDevice ||
    TerminalExceptionCode.tapToPayUnsupportedOperatingSystemVersion =>
      'This phone cannot take Tap to Pay (it needs NFC and an up-to-date system). Use the card machine.',
    TerminalExceptionCode.tapToPayDeviceTampered ||
    TerminalExceptionCode.tapToPayInsecureEnvironment ||
    TerminalExceptionCode.tapToPayDebugNotSupported =>
      'Tap to Pay will not run on this phone while developer options, screen sharing or a rooted system are on. Turn them off, or use the card machine.',
    TerminalExceptionCode.tapToPayReaderTOSAcceptanceCanceled ||
    TerminalExceptionCode.tapToPayReaderTOSNotYetAccepted ||
    TerminalExceptionCode.tapToPayReaderTOSAcceptanceFailed ||
    TerminalExceptionCode.tapToPayReaderTOSAcceptanceRequiresiCloudSignIn =>
      "Apple's Tap to Pay terms have to be accepted on this iPhone first (signed in to iCloud). Open More, Set up Tap to Pay on this iPhone.",
    TerminalExceptionCode.tapToPayReaderMerchantBlocked ||
    TerminalExceptionCode.tapToPayReaderInvalidMerchant ||
    TerminalExceptionCode.tapToPayReaderAccountDeactivated ||
    TerminalExceptionCode.tapToPayReaderDeviceBanned ||
    TerminalExceptionCode.featureNotEnabledOnAccount =>
      "The venue's Stripe account cannot take Tap to Pay on this device right now. Use the card machine and contact Vesopa.",
    TerminalExceptionCode.passcodeNotEnabled => 'Tap to Pay needs a screen lock (passcode) on this phone. Set one in Settings, then try again.',
    TerminalExceptionCode.invalidAmount => 'Card payments with Stripe must be at least £0.30. Nothing was taken.',
    _ => '${e.message.trim().isEmpty ? 'Tap to Pay stopped.' : e.message.trim()} Nothing was taken. Try again, or pay another way.',
  };
}

class StripeTapToPay implements PaymentService {
  StripeTapToPay(this.api);

  final TapApi api;

  /// The reader delegate has nothing to do: Apple's sheet and the SDK's own
  /// Android screen tell the customer what to do.
  static final _delegate = _Delegate();

  Future<void> _init() async {
    if (Terminal.isInitialized) return;
    await Terminal.init(fetchToken: () async => (await api.stripeConnectionToken())['secret'] as String);
  }

  @override
  Future<String?> whyUnavailable() async {
    try {
      final config = await api.stripeConfig();
      if (config['enabled'] != true || config['ready'] != true) {
        return 'This venue\'s Stripe account is not ready to take cards yet.';
      }
      await _init();
      final simulated = config['environment'] != 'live';
      final ok = await Terminal.instance.supportsReadersOfType(
        deviceType: DeviceType.tapToPay,
        discoveryConfiguration: TapToPayDiscoveryConfiguration(isSimulated: simulated),
      );
      return ok ? null : 'Tap to Pay is not available on this phone.';
    } on TapApiError catch (e) {
      return e.message;
    } on TerminalException catch (e) {
      return e.message;
    }
  }

  /// The environment and location the connected reader was set up for: a
  /// venue moved from the sandbox to live (2026-11-08) must not keep the old one.
  static String? _connectedFor;

  /// A payment still with the SDK from a try that ended badly: called off
  /// before the next one starts, or the next one waits behind it for ever.
  static CancelableFuture<PaymentIntent>? _inFlight;

  /// Where the reader delegate reports Apple's first-time set-up (terms, then
  /// getting this iPhone ready), so the screen says so instead of sitting still.
  static void Function(PayStep step)? _onSetup;

  /// What happened, for the server's log: every step of a Tap to Pay try, so a
  /// payment that goes wrong on a phone can be followed afterwards. Never card data.
  void _log(String step, {String? id, String? code, String? message}) {
    unawaited(api.reportTap({'provider': 'stripe', 'step': step, 'payment': ?id, 'code': ?code, 'message': ?message}));
  }

  /// Ready Tap to Pay before a sale (Apple's guide: prepare early). The first
  /// time on an iPhone this shows Apple's terms for the venue's manager.
  Future<String?> prepare({void Function(PayStep step)? onStep}) async {
    _onSetup = onStep;
    try {
      await _connect();
      return null;
    } on TerminalException catch (e) {
      _log('prepare', code: e.code.name, message: e.message);
      return e.message;
    } on TapApiError catch (e) {
      return e.message;
    } on TimeoutException {
      return 'Tap to Pay did not get ready in time. Try again.';
    } catch (e) {
      _log('prepare', code: 'exception', message: '$e');
      return 'Tap to Pay could not start: $e';
    } finally {
      _onSetup = null;
    }
  }

  Future<void> _connect() async {
    await _init();
    final terminal = Terminal.instance;
    final config = await api.stripeConfig();
    final locationId = config['location'] as String?;
    if (locationId == null) throw const TapApiError(0, 'This venue has no Stripe location yet.');
    final live = config['environment'] == 'live';
    final want = '${live ? 'live' : 'sandbox'}|$locationId';
    final connected = await terminal.getConnectedReader();
    if (connected != null) {
      // Connected already, by an earlier try that ran past its time limit: keep it.
      if (_connectedFor == null || _connectedFor == want) {
        _connectedFor = want;
        return;
      }
      await terminal.disconnectReader().catchError((Object _) {});
      try {
        await terminal.clearCachedCredentials();
      } catch (_) {}
    } else if (_connectedFor != null && _connectedFor != want) {
      try {
        await terminal.clearCachedCredentials();
      } catch (_) {}
    }

    // Stripe will not start a reader on a phone that has refused location.
    final location = await Permission.locationWhenInUse.request();
    if (!location.isGranted) {
      throw const TapApiError(0, 'Tap to Pay needs the location permission. Allow it in Settings.');
    }

    _log('connect');
    final readers = await terminal
        .discoverReaders(TapToPayDiscoveryConfiguration(isSimulated: !live))
        .firstWhere((list) => list.isNotEmpty)
        .timeout(const Duration(seconds: 30));
    _onSetup?.call(PayStep.activating);
    // The first time, Apple asks the manager to accept its terms and then gets
    // this iPhone ready, which can take a minute or two.
    await terminal
        .connectReader(
          readers.first,
          configuration: TapToPayConnectionConfiguration(locationId: locationId, readerDelegate: _delegate),
        )
        .timeout(const Duration(seconds: 180));
    _connectedFor = want;
    _log('connected');
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
    // The Stripe checklist: which test card the sandbox's reader is handed,
    // 'none' for nothing (the clerk cancels). Real sales leave it null.
    String? testCard,
  }) async {
    if (via == 'machine') {
      return _onReader(amountMinor + tipMinor, billRef: billRef, onStep: onStep, control: control, testCard: testCard);
    }
    String? id;
    Timer? watch;
    final stop = Completer<void>();
    bool cancelled() => control?.cancelRequested ?? false;
    try {
      // Cancel works from the first moment: a watch notices the clerk's Cancel.
      watch = Timer.periodic(const Duration(milliseconds: 250), (t) {
        if (cancelled() && !stop.isCompleted) {
          t.cancel();
          stop.complete();
        }
      });
      Future<T> orStop<T>(Future<T> f) => Future.any([f, stop.future.then<T>((_) => throw const _Stopped())]);

      // The last try's payment, if the SDK still holds it.
      final old = _inFlight;
      _inFlight = null;
      if (old != null) {
        try {
          await old.cancel().timeout(const Duration(seconds: 3));
        } catch (_) {}
      }

      onStep?.call(PayStep.preparing);
      _onSetup = onStep;
      await orStop(_connect());
      _onSetup = null;
      // A new attempt every time: a second try on the same bill is a new
      // payment, never the first one handed back by Stripe.
      final attempt = DateTime.now().microsecondsSinceEpoch.toRadixString(36);
      final created = await orStop(api.stripePayment(amountMinor + tipMinor, reference: billRef, attempt: attempt));
      id = '${created['id']}';
      _log('created', id: id);
      final intent = await orStop(
        Terminal.instance.retrievePaymentIntent('${created['client_secret']}').timeout(const Duration(seconds: 20)),
      );
      return await _collect(id, intent, stop, onStep);
    } on _Stopped {
      _log('cancelled', id: id);
      return id == null ? const PaymentOutcome(PayResult.cancelled) : await _callOff(id);
    } on TerminalException catch (e) {
      _log('sdk-error', id: id, code: e.code.name, message: e.message);
      if (id != null) return await _settle(id, sdk: e, cancelledByClerk: cancelled());
      return stripeFailure(e);
    } on TimeoutException {
      _log('timeout', id: id);
      if (id != null) return await _callOff(id, message: 'Tap to Pay did not answer. Nothing was taken. Try again.');
      return const PaymentOutcome(PayResult.unavailable, message: 'Tap to Pay did not start. Try again.');
    } on TapApiError catch (e) {
      _log('api-error', id: id, message: e.message);
      return PaymentOutcome(
        id == null ? PayResult.unavailable : PayResult.uncertain,
        paymentId: id,
        message: e.message,
      );
    } catch (e) {
      // Anything else (2026-11-08: an error type nobody expected left the screen
      // waiting for ever): the payment is called off and the screen moves on.
      _log('exception', id: id, message: '$e');
      if (id != null) return await _callOff(id, message: 'Tap to Pay stopped. Nothing was taken. Try again.');
      return PaymentOutcome(PayResult.unavailable, message: 'Tap to Pay could not start. Try again. ($e)');
    } finally {
      _onSetup = null;
      watch?.cancel();
    }
  }

  /// Collect the card, with the verdict from whichever answers first:
  ///   * the SDK (Apple's sheet: paid, declined, the customer cancelled);
  ///   * Stripe's own record of the payment, read every 2 seconds, so a
  ///     decline or an approval shows even when the SDK never reports it;
  ///   * the clerk's Cancel;
  ///   * Apple's sheet closing (the SDK back to ready) with no answer;
  ///   * two minutes with nothing at all.
  Future<PaymentOutcome> _collect(
    String id,
    PaymentIntent intent,
    Completer<void> stop,
    void Function(PayStep)? onStep,
  ) async {
    onStep?.call(PayStep.waitingForCard);
    final done = Completer<PaymentOutcome>();
    void finish(Future<PaymentOutcome> Function() verdict) {
      if (done.isCompleted) return;
      // Claimed at once so nothing else finishes it meanwhile.
      final c = Completer<PaymentOutcome>();
      done.complete(c.future);
      verdict().then(
        c.complete,
        onError: (Object e) => c.complete(PaymentOutcome(PayResult.uncertain, paymentId: id, message: '$e')),
      );
    }

    final collecting = Terminal.instance.processPaymentIntent(intent, skipTipping: true);
    _inFlight = collecting;
    var sdkDone = false;
    collecting.then(
      (_) {
        sdkDone = true;
        _log('sdk-done', id: id);
        finish(() => _settle(id));
      },
      onError: (Object e) {
        sdkDone = true;
        if (e is TerminalException) {
          _log('sdk-error', id: id, code: e.code.name, message: e.message);
          finish(() => _settle(id, sdk: e, cancelledByClerk: stop.isCompleted));
        } else {
          _log('sdk-exception', id: id, message: '$e');
          finish(() => _settle(id, cancelledByClerk: stop.isCompleted));
        }
      },
    );

    // The clerk's Cancel: the SDK is asked to stop, and given 3 seconds to say
    // how it ended before the payment is called off on Stripe.
    unawaited(
      stop.future.then((_) async {
        try {
          await collecting.cancel().timeout(const Duration(seconds: 3));
        } catch (_) {}
        await Future<void>.delayed(const Duration(seconds: 3));
        finish(() => _callOff(id));
      }),
    );

    // Stripe's record. A bank decline that asks for the PIN is not the end:
    // Apple's sheet asks the customer for it and the SDK tries again.
    var declineSeenAt = 0;
    final poll = Timer.periodic(const Duration(seconds: 2), (_) async {
      if (done.isCompleted) return;
      try {
        final s = await api.stripePaymentState(id);
        final status = '${s['status']}';
        final error = s['error'] is Map ? Map<String, dynamic>.from(s['error'] as Map) : null;
        if (status == 'succeeded') return finish(() async => PaymentOutcome(PayResult.paid, paymentId: id));
        if (status == 'processing') onStep?.call(PayStep.confirming);
        if (error != null && status == 'requires_payment_method') {
          if (_pinCodes.contains(error['decline_code']) || _pinCodes.contains(error['code'])) {
            onStep?.call(PayStep.pin);
            return;
          }
          // The SDK normally reports a decline itself; if it has not in 6
          // seconds, Stripe's record decides.
          declineSeenAt = declineSeenAt == 0 ? DateTime.now().millisecondsSinceEpoch : declineSeenAt;
          if (!sdkDone && DateTime.now().millisecondsSinceEpoch - declineSeenAt > 6000) {
            _log('declined-by-record', id: id, code: '${error['decline_code'] ?? error['code']}');
            unawaited(collecting.cancel().catchError((Object _) {}));
            finish(() async => PaymentOutcome(PayResult.declined, paymentId: id, message: declineWords(error)));
          }
        }
      } catch (_) {}
    });

    // Apple's sheet gone (tapped outside it, or closed) with no answer: the SDK
    // is back to ready. After a short grace, Stripe's record decides.
    StreamSubscription<PaymentStatus>? sheet;
    var sawInput = false;
    sheet = Terminal.instance.onPaymentStatusChange.listen((st) {
      if (st == PaymentStatus.waitingForInput || st == PaymentStatus.processing) sawInput = true;
      if (st == PaymentStatus.ready && sawInput && !done.isCompleted) {
        Future<void>.delayed(const Duration(seconds: 4), () {
          if (done.isCompleted || sdkDone) return;
          _log('sheet-closed', id: id);
          unawaited(collecting.cancel().catchError((Object _) {}));
          finish(
            () => _settle(id, message: 'Tap to Pay was closed before a card was read. Nothing was taken. Try again.'),
          );
        });
      }
    });

    // Nothing at all for two minutes (Apple's sheet gives up after one).
    final limit = Timer(const Duration(seconds: 120), () {
      _log('limit', id: id);
      unawaited(collecting.cancel().catchError((Object _) {}));
      finish(() => _settle(id, message: 'Tap to Pay did not answer. Nothing was taken. Try again.'));
    });

    try {
      return await done.future;
    } finally {
      poll.cancel();
      limit.cancel();
      await sheet.cancel();
      if (identical(_inFlight, collecting) && sdkDone) _inFlight = null;
    }
  }

  static const _pinCodes = {'online_or_offline_pin_required', 'offline_pin_required', 'online_pin_required'};

  /// How it ended, by Stripe's record: paid stays paid; a decline says why;
  /// anything still open is called off so it can never be taken later.
  Future<PaymentOutcome> _settle(
    String id, {
    TerminalException? sdk,
    bool cancelledByClerk = false,
    String? message,
  }) async {
    Map<String, dynamic>? s;
    try {
      s = await api.stripePaymentState(id);
    } catch (_) {}
    final status = s == null ? null : '${s['status']}';
    if (status == 'succeeded') return PaymentOutcome(PayResult.paid, paymentId: id);
    if (status == 'processing' || status == 'requires_capture') {
      return PaymentOutcome(
        PayResult.uncertain,
        paymentId: id,
        message: 'The bank is still deciding. Check the payment before taking it again.',
      );
    }
    final error = s != null && s['error'] is Map ? Map<String, dynamic>.from(s['error'] as Map) : null;
    if (!cancelledByClerk && error != null && !_pinCodes.contains(error['decline_code'])) {
      unawaited(api.stripeCancel(id).catchError((Object _) => <String, dynamic>{}));
      return PaymentOutcome(PayResult.declined, paymentId: id, message: declineWords(error));
    }
    if (!cancelledByClerk && sdk != null) {
      final f = stripeFailure(sdk, paymentId: id);
      if (f.result == PayResult.declined) {
        unawaited(api.stripeCancel(id).catchError((Object _) => <String, dynamic>{}));
        return PaymentOutcome(PayResult.declined, paymentId: id, message: declineWords({'message': sdk.message}));
      }
    }
    return _callOff(
      id,
      message:
          message ??
          (sdk != null && !cancelledByClerk && sdk.code != TerminalExceptionCode.canceled
              ? tapProblemWords(sdk)
              : null),
    );
  }

  /// Call the payment off on Stripe; if it had already gone through, it is paid.
  Future<PaymentOutcome> _callOff(String id, {String? message}) async {
    try {
      final r = await api.stripeCancel(id);
      if (r['status'] == 'canceled') return PaymentOutcome(PayResult.cancelled, paymentId: id, message: message);
    } catch (_) {}
    try {
      final s = await api.stripePaymentState(id);
      return PaymentOutcome(stripeResult(s['status'] as String?), paymentId: id, message: message);
    } catch (e) {
      return PaymentOutcome(
        PayResult.uncertain,
        paymentId: id,
        message: 'Could not reach Stripe to check this payment. Check it before taking it again.',
      );
    }
  }
}

/// A bank's decline in words for the clerk and the customer, with what to do.
String declineWords(Map<String, dynamic> error) {
  // Stripe's own fraud check (Radar) stopped it before the bank saw it: the
  // same card tried again straight away is stopped again (2026-11-09, a
  // Bangladeshi debit card at the Kitchen after its bank's first refusal).
  if (error['blocked'] == true) {
    return 'Stripe stopped this card as too risky after the earlier tries, before the bank saw it. '
        'No money was taken. Do not try this card again now: ask for another card, or pay another way.';
  }
  final code = '${error['decline_code'] ?? error['code'] ?? ''}';
  final country = '${error['card_country'] ?? ''}'.toUpperCase();
  final abroad = country.isNotEmpty && country != 'GB';
  final said = switch (code) {
    'insufficient_funds' => 'Not enough money on this card.',
    'expired_card' => 'This card has expired.',
    'incorrect_pin' || 'invalid_pin' => 'The PIN was wrong.',
    'pin_try_exceeded' => 'Too many wrong PINs on this card.',
    'lost_card' || 'stolen_card' || 'pickup_card' || 'restricted_card' => 'The bank will not allow this card.',
    'transaction_not_allowed' || 'card_not_supported' => 'This card does not support this kind of payment.',
    'do_not_honor' || 'generic_decline' => 'The bank declined the card.',
    'card_velocity_exceeded' || 'withdrawal_count_limit_exceeded' => 'The card has reached its limit.',
    'fraudulent' || 'merchant_blacklist' => 'The bank declined the card.',
    _ =>
      (error['message'] as String?)?.trim().isNotEmpty == true ? '${error['message']}' : 'The bank declined the card.',
  };
  final foreign = abroad && const {'transaction_not_allowed', 'card_not_supported', 'do_not_honor', 'generic_decline', 'card_declined', 'restricted_card'}.contains(code)
      ? ' This card is from abroad ($country): its bank may need to allow payments in the UK or contactless payments.'
      : '';
  final later = error['advice'] == 'try_again_later' && !abroad ? ' The bank says try again later.' : '';
  return '$said$foreign$later No money was taken. Ask for another card, or pay another way.';
}

class _Stopped implements Exception {
  const _Stopped();
}

/// The venue's Stripe card reader, driven from the server (an iPad: Apple has
/// no Tap to Pay there). The same card-machine screen as a Dojo machine.
extension on StripeTapToPay {
  Future<PaymentOutcome> _onReader(
    int totalMinor, {
    String? billRef,
    void Function(PayStep step)? onStep,
    PayControl? control,
    String? testCard,
  }) async {
    onStep?.call(PayStep.preparing);
    final Map<String, dynamic> listed;
    try {
      listed = await api.stripeReaders();
    } on TapApiError catch (e) {
      return PaymentOutcome(PayResult.unavailable, message: e.message);
    }
    final readers = [for (final r in (listed['readers'] as List? ?? const [])) Map<String, dynamic>.from(r as Map)];
    final chosen = await deviceStripeReader();
    final reader =
        readers.where((r) => r['id'] == chosen).firstOrNull ??
        readers.where((r) => r['status'] == 'online').firstOrNull ??
        readers.firstOrNull;
    if (reader == null) {
      return const PaymentOutcome(
        PayResult.unavailable,
        message: 'This venue has no Stripe card reader yet. Add one under Cards, Card reader.',
      );
    }
    final readerId = '${reader['id']}';
    final String id;
    try {
      id = '${(await api.stripeReaderPayment(readerId, totalMinor, reference: billRef))['id']}';
    } on TapApiError catch (e) {
      return PaymentOutcome(PayResult.unavailable, message: e.message);
    }
    onStep?.call(PayStep.onMachine);
    // The sandbox's simulated reader has no customer: hand it Stripe's test card.
    if (reader['simulated'] == true && testCard != 'none') {
      unawaited(
        Future<void>.delayed(
          const Duration(seconds: 2),
          () => api
              .stripeReaderPresent(readerId, card: testCard ?? 'approved')
              .catchError((Object _) => <String, dynamic>{}),
        ),
      );
    }
    return followMachine(
      id: id,
      poll: () => api.stripeReaderPaymentState(id, readerId),
      cancel: () => api.stripeReaderCancel(id, readerId),
      answer: (_) async {},
      onStep: onStep,
      control: control,
    );
  }
}

class _Delegate extends TapToPayReaderDelegate {
  @override
  void onStartInstallingUpdate(ReaderSoftwareUpdate update, Cancellable cancelUpdate) =>
      StripeTapToPay._onSetup?.call(PayStep.activating);

  @override
  void onReportReaderSoftwareUpdateProgress(double progress) {}

  @override
  void onFinishInstallingUpdate(ReaderSoftwareUpdate? update, TerminalException? exception) {}

  @override
  void onRequestReaderDisplayMessage(ReaderDisplayMessage message) {}

  @override
  void onRequestReaderInput(List<ReaderInputOption> options) {}
}
