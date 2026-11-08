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
  return PaymentOutcome(PayResult.uncertain, paymentId: paymentId, message: e.message);
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

  Future<void> _connect() async {
    await _init();
    final terminal = Terminal.instance;
    final config = await api.stripeConfig();
    final locationId = config['location'] as String?;
    if (locationId == null) throw const TapApiError(0, 'This venue has no Stripe location yet.');
    final live = config['environment'] == 'live';
    final want = '${live ? 'live' : 'sandbox'}|$locationId';
    if (await terminal.getConnectedReader() != null) {
      if (_connectedFor == want) return;
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

    final readers = await terminal
        .discoverReaders(TapToPayDiscoveryConfiguration(isSimulated: !live))
        .firstWhere((list) => list.isNotEmpty)
        .timeout(const Duration(seconds: 30));
    await terminal
        .connectReader(
          readers.first,
          configuration: TapToPayConnectionConfiguration(locationId: locationId, readerDelegate: _delegate),
        )
        .timeout(const Duration(seconds: 60));
    _connectedFor = want;
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
      // The last try's payment, if the SDK still holds it.
      final old = _inFlight;
      _inFlight = null;
      if (old != null) await old.cancel().timeout(const Duration(seconds: 3)).catchError((Object _) {});

      onStep?.call(PayStep.preparing);
      // Cancel works from the first moment: a watch notices the clerk's Cancel.
      watch = Timer.periodic(const Duration(milliseconds: 250), (t) {
        if (cancelled() && !stop.isCompleted) {
          t.cancel();
          stop.complete();
        }
      });
      Future<T> orStop<T>(Future<T> f) => Future.any([f, stop.future.then<T>((_) => throw const _Stopped())]);

      await orStop(_connect());
      // A new attempt every time: a second try on the same bill is a new
      // payment, never the first one handed back by Stripe.
      final attempt = DateTime.now().microsecondsSinceEpoch.toRadixString(36);
      final created = await orStop(api.stripePayment(amountMinor + tipMinor, reference: billRef, attempt: attempt));
      id = created['id'] as String;
      final intent = await orStop(
        Terminal.instance
            .retrievePaymentIntent(created['client_secret'] as String)
            .timeout(const Duration(seconds: 20)),
      );

      onStep?.call(PayStep.waitingForCard);
      final collecting = Terminal.instance.processPaymentIntent(intent, skipTipping: true);
      _inFlight = collecting;
      unawaited(stop.future.then((_) => collecting.cancel().catchError((Object _) {})));
      // The SDK is given a moment to give the card back after a cancel; if it
      // does not, the payment is called off on Stripe and the screen moves on.
      await Future.any([
        collecting.then((_) {}),
        stop.future.then((_) => Future<void>.delayed(const Duration(seconds: 4))),
      ]);
      if (identical(_inFlight, collecting)) _inFlight = null;
      onStep?.call(PayStep.confirming);
      // The server's word decides the sale, never the phone's.
      final state = await api.stripePaymentState(id);
      final result = stripeResult(state['status'] as String?);
      if (cancelled() && result != PayResult.paid) return await _callOff(id);
      return PaymentOutcome(result, paymentId: id);
    } on _Stopped {
      return id == null ? const PaymentOutcome(PayResult.cancelled) : await _callOff(id);
    } on TerminalException catch (e) {
      if (cancelled() && id != null) return await _callOff(id);
      return stripeFailure(e, paymentId: id);
    } on TimeoutException {
      if (id != null) return await _callOff(id, message: 'Tap to Pay did not answer. Nothing was taken. Try again.');
      return PaymentOutcome(PayResult.unavailable, paymentId: id, message: 'Tap to Pay did not start. Try again.');
    } on TapApiError catch (e) {
      return PaymentOutcome(
        id == null ? PayResult.unavailable : PayResult.uncertain,
        paymentId: id,
        message: e.message,
      );
    } finally {
      watch?.cancel();
    }
  }

  /// Call the payment off on Stripe; if it had already gone through, it is paid.
  Future<PaymentOutcome> _callOff(String id, {String? message}) async {
    try {
      final r = await api.stripeCancel(id);
      if (r['status'] == 'canceled') return PaymentOutcome(PayResult.cancelled, paymentId: id, message: message);
    } on TapApiError catch (_) {}
    try {
      final s = await api.stripePaymentState(id);
      return PaymentOutcome(stripeResult(s['status'] as String?), paymentId: id, message: message);
    } on TapApiError catch (e) {
      return PaymentOutcome(PayResult.uncertain, paymentId: id, message: e.message);
    }
  }
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
  void onStartInstallingUpdate(ReaderSoftwareUpdate update, Cancellable cancelUpdate) {}

  @override
  void onReportReaderSoftwareUpdateProgress(double progress) {}

  @override
  void onFinishInstallingUpdate(ReaderSoftwareUpdate? update, TerminalException? exception) {}

  @override
  void onRequestReaderDisplayMessage(ReaderDisplayMessage message) {}

  @override
  void onRequestReaderInput(List<ReaderInputOption> options) {}
}
