import 'dart:async';

import 'package:url_launcher/url_launcher.dart';

import 'payment_provider.dart';

/// How the desktop till is currently able to take a card.
enum DesktopCardMode {
  /// A physical Dojo reader on the counter. Requires a terminal id AND the
  /// `software-house-id` Dojo issues to integration partners.
  terminal,

  /// No reader configured: the card is keyed into Dojo's hosted checkout page,
  /// opened in a window. Works with nothing but the API key.
  hostedCheckout,
}

/// What the payment is doing right now, so the till can say something better
/// than an unexplained spinner.
enum DojoStage { creating, sendingToTerminal, awaitingCard, checking }

/// Card payments for Windows, macOS and Linux.
///
/// There is no Dojo SDK for desktop — the published .NET library is a
/// server-side HTTP client, so wrapping it would reproduce exactly this REST
/// flow with no card UI of its own. Instead this provider uses the two routes
/// that genuinely present a card on a desktop till:
///
///  1. **Terminal** — push the intent to a physical Dojo reader next to the
///     till ([DesktopCardMode.terminal]). This is the production answer for a
///     touch-screen EPOS, and needs a software-house-id.
///  2. **Hosted checkout** — open Dojo's own payment page for the intent in a
///     browser window and let the customer key the card
///     ([DesktopCardMode.hostedCheckout]). Works today with just the API key.
///
/// Either way the intent is then polled until it settles. Polling is reported
/// through [onStageChanged] and can be abandoned via [cancel], because the previous
/// behaviour — a silent two-minute wait with no way out — left the clerk stuck
/// staring at "Waiting for the card…".
class DesktopDojoProvider implements PaymentProvider {
  DesktopDojoProvider({
    required this.intents,
    this.onStageChanged,
    this.openCheckout,
    this.pollTimeout = const Duration(minutes: 3),
  });

  /// Creates and reads intents over REST. Shared with the other providers so
  /// intent handling lives in one place.
  final DojoProvider intents;

  /// Progress callback, for the till's payment dialog. Settable because the
  /// provider is built once by Riverpod but the dialog that listens to it is
  /// created fresh for each payment.
  void Function(DojoStage stage)? onStageChanged;

  /// Opens the hosted checkout page.
  ///
  /// Settable rather than final because the till supplies it per payment: the
  /// provider is built once by Riverpod, but the thing that shows the page is
  /// the payment screen, which wants to render the checkout *inside* the app
  /// (see `CardCheckoutPage`). Left unset it falls back to the system browser,
  /// which is also what tests rely on to avoid launching one.
  Future<bool> Function(String url)? openCheckout;

  final Duration pollTimeout;

  /// Set when the clerk abandons the payment. Checked between polls so the wait
  /// ends promptly rather than running to the timeout.
  bool _cancelled = false;

  /// The intent being waited on, so [cancel] can cancel it at Dojo.
  String? _current;

  /// Wakes the poll loop early, so a cancel is answered at once.
  Completer<void>? _wake;

  /// Cancel the payment from the till.
  ///
  /// "In web manual payment the till cannot cancel the payment." It only
  /// stopped polling, and left the intent open, so the customer could still
  /// pay on the page after the till had given up. Now the intent is cancelled
  /// at Dojo too (only possible while nobody has paid: Dojo refuses once it is
  /// authorised), and the loop checks one last time, so a card keyed a moment
  /// before the clerk pressed Cancel still comes back as paid.
  bool _onTerminal = false;

  void cancel() {
    // On a card machine the session is cancelled, as Dojo's "Cancel from
    // POS" asks, and its real result still comes back: deleting the intent
    // under a card that is already in would lose a payment.
    if (_onTerminal) {
      intents.requestCancel();
      return;
    }
    _cancelled = true;
    final id = _current;
    if (id != null) unawaited(intents.cancelIntent(id));
    final w = _wake;
    if (w != null && !w.isCompleted) w.complete();
  }

  /// Which route this till will use, given what is configured.
  DesktopCardMode get mode => intents.canUseTerminal
      ? DesktopCardMode.terminal
      : DesktopCardMode.hostedCheckout;

  @override
  String get method => 'card';

  @override
  Future<PaymentResult> take(
    int amountMinor, {
    String? orderId,
    bool manual = false,
  }) async {
    _cancelled = false;
    _current = null;
    _onTerminal = false;
    intents.resetControls();
    try {
      onStageChanged?.call(DojoStage.creating);
      final useTerminal = mode == DesktopCardMode.terminal && !manual;
      final intent = await intents.createIntent(
        amountMinor,
        orderId: orderId,
        // Anything not going to a reader is keyed by the customer on the
        // checkout page, and must be flagged as card-not-present.
        cardHolderNotPresent: !useTerminal,
      );
      _current = intent.id;

      // A keyed card goes to the checkout even where a reader is attached: the
      // reader can only take a card that is in the room.
      if (useTerminal) {
        // A reader on the counter: the payment runs as a terminal session, and
        // that session — not the intent — is what says whether money was taken.
        onStageChanged?.call(DojoStage.sendingToTerminal);
        _onTerminal = true;
        final sessionId = await intents.startTerminalSession(intent.id);
        onStageChanged?.call(DojoStage.awaitingCard);
        return await intents.awaitTerminal(sessionId, intent.id, amountMinor);
      } else {
        final url = intent.paymentLink;
        if (url == null || url.isEmpty) {
          return PaymentResult(
            approved: false,
            amountMinor: amountMinor,
            reference: intent.id,
            message:
                'Dojo did not return a checkout link for this payment. Attach '
                'a card reader in Settings, or contact Dojo support.',
          );
        }
        final opened = await (openCheckout ?? _launch)(url);
        if (!opened) {
          return PaymentResult(
            approved: false,
            amountMinor: amountMinor,
            reference: intent.id,
            message: 'Could not open the card payment window.',
          );
        }
      }

      onStageChanged?.call(DojoStage.awaitingCard);
      return await _await(intent.id, amountMinor);
    } on DojoException catch (e) {
      return PaymentResult(
        approved: false,
        amountMinor: amountMinor,
        reference: _current,
        outcome: CardOutcome.failed,
        message: e.clerkMessage,
      );
    } catch (e) {
      // An errored card payment is NOT a payment. Never fall back to assuming
      // it worked — the till would record money it never took.
      return PaymentResult(
        approved: false,
        amountMinor: amountMinor,
        message: '$e',
      );
    }
  }

  static Future<bool> _launch(String url) =>
      launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);

  /// Poll until the intent settles, the clerk cancels, or we time out.
  ///
  /// The stage stays on "awaiting card" while the customer keys it: flicking
  /// to "checking" on every poll moved the till's screen to "Authorising with
  /// the bank" before any card had been typed, and there it stuck.
  Future<PaymentResult> _await(String intentId, int amountMinor) async {
    _current = intentId;
    final deadline = DateTime.now().add(pollTimeout);
    var lastStatus = '';

    try {
      while (true) {
        final stopping = _cancelled || !DateTime.now().isBefore(deadline);
        Map<String, dynamic>? intent;
        try {
          intent = await intents.fetchIntent(intentId);
        } catch (_) {
          // One missed poll is not a result. Keep going until the deadline.
        }
        final status = (intent?['status'] as String? ?? lastStatus)
            .toLowerCase();
        lastStatus = status;

        if (DojoProvider.paidStatuses.contains(status)) {
          return PaymentResult(
            approved: true,
            amountMinor: amountMinor,
            reference: intentId,
            outcome: CardOutcome.approved,
            acquirerStatus: intent?['status'] as String?,
            message: 'Payment approved.',
          );
        }
        if (DojoProvider.failedStatuses.contains(status)) {
          final cancelled = status == 'canceled' || status == 'cancelled';
          return PaymentResult(
            approved: false,
            amountMinor: amountMinor,
            reference: intentId,
            outcome: cancelled ? CardOutcome.cancelled : CardOutcome.declined,
            acquirerStatus: intent?['status'] as String?,
            message: cancelled
                ? 'The payment was cancelled. No money was taken.'
                : 'The card was declined ($status). No money was taken.',
          );
        }

        if (stopping) {
          if (_cancelled) {
            // Cancelled at Dojo (see [cancel]) and still not paid.
            return PaymentResult(
              approved: false,
              amountMinor: amountMinor,
              reference: intentId,
              outcome: CardOutcome.cancelled,
              acquirerStatus: intent?['status'] as String?,
              message:
                  'The payment was cancelled on the till. No money was taken.',
            );
          }
          // Timed out with the intent still open. This is NOT a decline — the
          // money may yet be taken — so it must never be recorded as either
          // paid or refused.
          return PaymentResult(
            approved: false,
            amountMinor: amountMinor,
            reference: intentId,
            outcome: CardOutcome.unknown,
            uncertainty: PaymentUncertainty.checkTerminal,
            message:
                'Timed out waiting for the card. Check the payment status '
                'before trying again: it may still have gone through.',
          );
        }

        final wake = _wake = Completer<void>();
        await Future.any([
          wake.future,
          Future<void>.delayed(const Duration(seconds: 2)),
        ]);
        if (_cancelled) {
          // Give Dojo a moment to apply the cancel before the last look.
          await Future<void>.delayed(const Duration(milliseconds: 800));
        }
      }
    } finally {
      _current = null;
      _wake = null;
    }
  }
}
