import 'dart:async';

import 'payment_provider.dart';
import 'teya_provider.dart';
import 'teya_sdk.dart';

/// Card payments through Teya's own Windows SDK app (teya_sdk.dart), the way
/// Teya require on Windows. The merchant signs in to Teya on the till, in
/// Teya's own screens, the first time; after that a payment goes from the
/// till to the SDK app to the card machine.
class TeyaSdkProvider implements TeyaCard {
  TeyaSdkProvider({
    required this.info,
    required this.appVersion,
    this.eposInstanceId,
    this.assignedTerminalId,
    this.terminalName,
    TeyaSdk? sdk,
  }) : _sdk = sdk ?? TeyaSdk.instance;

  final TeyaSdkInfo info;
  final String appVersion;
  final String? eposInstanceId;

  /// The card machine the back office chose for this till, linked in the SDK
  /// before the first payment.
  final String? assignedTerminalId;
  @override
  final String? terminalName;
  final TeyaSdk _sdk;

  @override
  String get brand => 'Teya';

  @override
  void Function(String url)? onPayLink;

  @override
  String get method => 'card';

  @override
  bool get sandbox => !info.production;

  @override
  String get terminalId =>
      '${_sdk.terminal?['id'] ?? assignedTerminalId ?? ''}';

  @override
  void Function(String? progress, String message)? onProgress;

  @override
  void Function(bool accepted, String message)? onCancelAnswered;

  bool _cancelRequested = false;
  bool _abandoned = false;
  String? _running;

  @override
  void requestCancel() {
    _cancelRequested = true;
    final id = _running;
    if (id == null) return;
    unawaited(() async {
      try {
        final r = await _sdk.call('cancelPayment', {'transactionId': id});
        final result = '${r['result'] ?? ''}';
        onCancelAnswered?.call(result == 'CANCELLING_PAYMENT', switch (result) {
          'CANCELLING_PAYMENT' => 'Cancelling on the card machine…',
          'PAYMENT_ALREADY_FINISHED' =>
            'Too late to cancel: the payment has finished.',
          'NETWORK_ERROR' =>
            'Could not reach Teya to cancel. Check the internet.',
          _ =>
            'The card machine could not cancel now; the payment may still finish.',
        });
      } catch (e) {
        onCancelAnswered?.call(false, '$e');
      }
    }());
  }

  @override
  void stopWaiting() {
    _cancelRequested = true;
    _abandoned = true;
    final id = _running;
    if (id != null)
      unawaited(
        _sdk
            .call('unsubscribeAll', {'transactionId': id})
            .catchError((_) => <String, dynamic>{}),
      );
  }

  /// Start Teya and make sure the till is signed in and linked to a machine.
  /// Shows Teya's sign-in screens when it is not.
  Future<void> ready({void Function(String)? onStatus}) async {
    await _sdk.start(
      info,
      version: appVersion,
      eposInstanceId: eposInstanceId,
      onStatus: onStatus,
    );
    if (_sdk.terminal == null) {
      onStatus?.call('Sign in to Teya on the window that opens…');
      final r = await _sdk.setup();
      switch (r['response']) {
        case 'SUCCESS':
          break;
        case 'CANCELED':
          throw TeyaSdkException(
            'Teya sign-in was cancelled. Card payments need it once on this till.',
          );
        default:
          throw TeyaSdkException(
            'Teya could not set up this till (${r['debugErrorMessage'] ?? r['response'] ?? 'no answer'}).',
          );
      }
    }
    final want = assignedTerminalId ?? '';
    if (want.isNotEmpty && '${_sdk.terminal?['id'] ?? ''}' != want) {
      final r = await _sdk.call('linkTerminal', {'terminalId': want});
      if (r['terminal'] is Map<String, dynamic>) {
        _sdk.terminal = r['terminal'] as Map<String, dynamic>;
      } else {
        throw TeyaSdkException(
          'The card machine chosen in the back office is not in this till\'s Teya store '
          '(${r['failureReason'] ?? 'unknown'}). Check Card Payments, Teya.',
        );
      }
    }
  }

  @override
  Future<PaymentResult> take(
    int amountMinor, {
    String? orderId,
    bool manual = false,
    int cashbackMinor = 0,
  }) async {
    _cancelRequested = false;
    _abandoned = false;
    onProgress?.call(null, 'Starting Teya…');
    try {
      await ready(onStatus: (s) => onProgress?.call(null, s));
    } catch (e) {
      return PaymentResult(
        approved: false,
        amountMinor: amountMinor,
        message: '$e',
        outcome: CardOutcome.failed,
        acquirerStatus: 'NOT_SENT',
      );
    }
    if (_cancelRequested) {
      return PaymentResult(
        approved: false,
        amountMinor: amountMinor,
        message: 'Cancelled before it reached the card machine.',
        outcome: CardOutcome.cancelled,
      );
    }
    final tx =
        'vesopa-${orderId ?? 'sale'}-${DateTime.now().millisecondsSinceEpoch.toRadixString(36)}'
            .replaceAll(RegExp(r'[^A-Za-z0-9_.:-]'), '');
    _running = tx;
    final done = Completer<Map<String, dynamic>>();
    void seen(Map<String, dynamic> s) {
      if (s['type'] != 'makePaymentAndSubscribe->onPaymentStateChanged' ||
          '${s['transactionId']}' != tx)
        return;
      final progress = (s['inProgressState'] ?? s['state']) as String?;
      onProgress?.call(progress, _message(s));
      if (s['isFinal'] == true && !done.isCompleted) done.complete(s);
    }

    final sub = _sdk.notifications.listen(seen);
    try {
      unawaited(
        _sdk
            .call('makePaymentAndSubscribe', {
              'transactionId': tx,
              'amount': amountMinor,
              'tip': 0,
              'currency': 'GBP',
              // The till's own payment screen shows the progress.
              'useTeyaDefaultUi': false,
            }, const Duration(minutes: 10))
            .then(seen)
            .catchError((Object e) {
              if (!done.isCompleted) done.completeError(e);
            }),
      );
      // Stop waiting finishes the wait as "not confirmed".
      final abandon = Completer<Map<String, dynamic>>();
      final poll = Timer.periodic(const Duration(milliseconds: 500), (t) {
        if (_abandoned && !abandon.isCompleted)
          abandon.complete(const {'abandoned': true});
      });
      final Map<String, dynamic> last;
      try {
        last = await Future.any([
          done.future,
          abandon.future,
        ]).timeout(const Duration(minutes: 10));
      } finally {
        poll.cancel();
      }
      if (last['abandoned'] == true)
        return _uncertain(
          amountMinor,
          tx,
          'Stopped waiting for the card machine.',
        );
      return _result(last, amountMinor, tx);
    } on TimeoutException {
      return _uncertain(amountMinor, tx, 'No answer from the card machine.');
    } catch (e) {
      return _uncertain(amountMinor, tx, '$e');
    } finally {
      await sub.cancel();
      _running = null;
    }
  }

  PaymentResult _uncertain(
    int amountMinor,
    String tx,
    String why,
  ) => PaymentResult(
    approved: false,
    amountMinor: amountMinor,
    reference: '$teyaRefPrefix$tx',
    sessionId: tx,
    message:
        '$why Check the card machine\'s screen before trying again: the payment may still have gone through.',
    uncertainty: PaymentUncertainty.checkTerminal,
    outcome: CardOutcome.unknown,
  );

  static String _message(Map<String, dynamic> s) {
    final state = '${s['state'] ?? ''}';
    final reason = '${s['reason'] ?? ''}';
    if (state == 'SUCCESSFUL') return 'Approved';
    if (state == 'CANCELLING') return 'Cancelling…';
    if (state == 'CANCELED') {
      return reason == 'CANCELED_BY_EPOS'
          ? 'Cancelled from the till.'
          : reason == 'EXPIRED'
          ? 'The payment expired. No money was taken.'
          : 'Cancelled on the card machine.';
    }
    if (state == 'PROCESSING_FAILED') {
      return switch (reason) {
        'PROCESSING_FAILED_DECLINED_ONLINE' ||
        'PROCESSING_FAILED_DECLINED_OFFLINE' => 'Card declined.',
        'PROCESSING_FAILED_TIMEOUT' =>
          'The card machine timed out. No money was taken.',
        _ =>
          'Payment failed (${reason.toLowerCase().replaceAll('_', ' ')}). No money was taken.',
      };
    }
    if (state == 'COMMUNICATION_FAILED') {
      return reason == 'COMMUNICATION_FAILED_AUTH_REQUIRED'
          ? 'Teya needs you to sign in again on this till (Settings, Teya).'
          : 'Lost contact with the card machine.';
    }
    return switch ('${s['inProgressState'] ?? ''}') {
      'SENT_TO_PAYMENT_APP' || 'RECEIVED' => 'Sent to the card machine…',
      'WAITING_FOR_CARD_ENTRY' => 'Present card',
      'INSERT_CARD' => 'Insert card',
      'CARD_PRESENTED' => 'Card read…',
      'PIN_ENTRY' => 'Enter PIN',
      'TIP_SELECTION' => 'Customer is choosing a tip',
      'DCC_SELECTION' => 'Customer is choosing a currency',
      'APP_SELECTION' => 'Customer is choosing a card account',
      'REMOVE_CARD' => 'Remove card',
      _ => 'Waiting for the card machine…',
    };
  }

  PaymentResult _result(Map<String, dynamic> s, int amountMinor, String tx) {
    final state = '${s['state'] ?? ''}';
    final reason = '${s['reason'] ?? ''}';
    final meta = s['metadata'] is Map ? s['metadata'] as Map : const {};
    final card = meta['card'] is Map ? meta['card'] as Map : const {};
    final gw = '${s['gatewayPaymentId'] ?? ''}';
    if (state == 'COMMUNICATION_FAILED') {
      // Contact was lost; the money may have moved.
      return _uncertain(amountMinor, tx, _message(s));
    }
    final outcome = switch (state) {
      'SUCCESSFUL' => CardOutcome.approved,
      'CANCELED' => CardOutcome.cancelled,
      _ =>
        reason.contains('DECLINED') ? CardOutcome.declined : CardOutcome.failed,
    };
    return PaymentResult(
      approved: state == 'SUCCESSFUL',
      amountMinor: amountMinor,
      reference: '$teyaRefPrefix${gw.isNotEmpty ? gw : tx}',
      sessionId: tx,
      message: _message(s),
      outcome: outcome,
      acquirerStatus: reason.isEmpty || reason == 'null'
          ? state
          : '$state $reason',
      gratuityMinor: (s['tip'] as num?)?.toInt() ?? 0,
      authCode: meta['authorisationCode'] as String?,
      cardLast4: card['last4'] as String?,
      cardType: card['brand'] as String?,
    );
  }

  @override
  Future<({bool ok, String message, String? refundId})> refund(
    String reference,
    int amountMinor,
  ) async {
    final gw = reference.startsWith(teyaRefPrefix)
        ? reference.substring(teyaRefPrefix.length)
        : reference;
    if (!gw.startsWith('tr_')) {
      return (
        ok: false,
        message:
            'This payment has no Teya payment id, so it cannot be refunded to the card from here.',
        refundId: null,
      );
    }
    try {
      await ready();
      final r = await _sdk.call('refundPayment', {
        'gatewayPaymentId': gw,
        'amount': amountMinor,
        'currency': 'GBP',
      }, const Duration(minutes: 2));
      final result = '${r['result'] ?? ''}';
      return (
        ok: result == 'SUCCESS',
        message: switch (result) {
          'SUCCESS' => 'Refunded to the card.',
          'AMOUNT_EXCEEDS_ALLOWED' =>
            'That is more than is left to refund on this payment.',
          'INVALID_AMOUNT_OR_PAYMENT_ID' =>
            'Teya does not recognise this payment or amount.',
          'DECLINED' => 'Teya declined the refund.',
          'NETWORK_ERROR' =>
            'Could not reach Teya. Check the internet and try again.',
          'CANCELLED' => 'The refund was cancelled.',
          _ =>
            'The refund failed${r['debugErrorMessage'] == null ? '' : ' (${r['debugErrorMessage']})'}.',
        },
        refundId: r['gatewayRefundId'] as String?,
      );
    } catch (e) {
      return (ok: false, message: '$e', refundId: null);
    }
  }
}
