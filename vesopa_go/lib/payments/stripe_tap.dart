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
  final declined = e.code == TerminalExceptionCode.declinedByStripeApi ||
      e.code == TerminalExceptionCode.declinedByReader;
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

  Future<void> _connect() async {
    await _init();
    final terminal = Terminal.instance;
    if (await terminal.getConnectedReader() != null) return;

    // Stripe will not start a reader on a phone that has refused location.
    final location = await Permission.locationWhenInUse.request();
    if (!location.isGranted) {
      throw const TapApiError(0, 'Tap to Pay needs the location permission. Allow it in Settings.');
    }
    final config = await api.stripeConfig();
    final locationId = config['location'] as String?;
    if (locationId == null) throw const TapApiError(0, 'This venue has no Stripe location yet.');

    final readers = await terminal
        .discoverReaders(TapToPayDiscoveryConfiguration(isSimulated: config['environment'] != 'live'))
        .firstWhere((list) => list.isNotEmpty)
        .timeout(const Duration(seconds: 30));
    await terminal.connectReader(
      readers.first,
      configuration: TapToPayConnectionConfiguration(locationId: locationId, readerDelegate: _delegate),
    );
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
    CancelableFuture<PaymentIntent>? collecting;
    Timer? watch;
    try {
      onStep?.call(PayStep.preparing);
      await _connect();
      final created = await api.stripePayment(amountMinor + tipMinor, reference: billRef);
      id = created['id'] as String;
      final intent = await Terminal.instance.retrievePaymentIntent(created['client_secret'] as String);

      onStep?.call(PayStep.waitingForCard);
      collecting = Terminal.instance.processPaymentIntent(intent, skipTipping: true);
      final running = collecting;
      watch = Timer.periodic(const Duration(milliseconds: 300), (t) {
        if (control?.cancelRequested ?? false) {
          t.cancel();
          unawaited(running.cancel());
        }
      });
      await collecting;
      // The server's word decides the sale, never the phone's.
      final state = await api.stripePaymentState(id);
      return PaymentOutcome(stripeResult(state['status'] as String?), paymentId: id);
    } on TerminalException catch (e) {
      return stripeFailure(e, paymentId: id);
    } on TimeoutException {
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
}

/// The venue's Stripe card reader, driven from the server (an iPad: Apple has
/// no Tap to Pay there). The same card-machine screen as a Dojo machine.
extension on StripeTapToPay {
  Future<PaymentOutcome> _onReader(int totalMinor,
      {String? billRef, void Function(PayStep step)? onStep, PayControl? control, String? testCard}) async {
    onStep?.call(PayStep.preparing);
    final Map<String, dynamic> listed;
    try {
      listed = await api.stripeReaders();
    } on TapApiError catch (e) {
      return PaymentOutcome(PayResult.unavailable, message: e.message);
    }
    final readers = [for (final r in (listed['readers'] as List? ?? const [])) Map<String, dynamic>.from(r as Map)];
    final chosen = await deviceStripeReader();
    final reader = readers.where((r) => r['id'] == chosen).firstOrNull
        ?? readers.where((r) => r['status'] == 'online').firstOrNull
        ?? readers.firstOrNull;
    if (reader == null) {
      return const PaymentOutcome(PayResult.unavailable,
          message: 'This venue has no Stripe card reader yet. Add one under Cards, Card reader.');
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
      unawaited(Future<void>.delayed(const Duration(seconds: 2),
          () => api.stripeReaderPresent(readerId, card: testCard ?? 'approved').catchError((Object _) => <String, dynamic>{})));
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
