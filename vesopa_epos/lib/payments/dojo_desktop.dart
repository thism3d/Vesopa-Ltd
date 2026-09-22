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

  /// Give up waiting. The intent is NOT cancelled at Dojo — the customer may
  /// still be mid-payment — so this reports "unknown", never "declined".
  void cancel() => _cancelled = true;

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

      // A keyed card goes to the checkout even where a reader is attached: the
      // reader can only take a card that is in the room.
      if (useTerminal) {
        // A reader on the counter: the payment runs as a terminal session, and
        // that session — not the intent — is what says whether money was taken.
        onStageChanged?.call(DojoStage.sendingToTerminal);
        final sessionId = await intents.startTerminalSession(intent.id);
        onStageChanged?.call(DojoStage.awaitingCard);
        return intents.awaitTerminal(sessionId, intent.id, amountMinor);
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
      return _await(intent.id, amountMinor);
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
  Future<PaymentResult> _await(String intentId, int amountMinor) async {
    final deadline = DateTime.now().add(pollTimeout);

    while (DateTime.now().isBefore(deadline)) {
      if (_cancelled) {
        return PaymentResult(
          approved: false,
          amountMinor: amountMinor,
          reference: intentId,
          message:
              'Payment abandoned on the till. If the customer completed it, '
              'check Dojo before charging again.',
        );
      }

      onStageChanged?.call(DojoStage.checking);
      final intent = await intents.fetchIntent(intentId);
      final status = (intent['status'] as String? ?? '').toLowerCase();

      if (DojoProvider.paidStatuses.contains(status)) {
        return PaymentResult(
          approved: true,
          amountMinor: amountMinor,
          reference: intentId,
          message: status,
        );
      }
      if (DojoProvider.failedStatuses.contains(status)) {
        return PaymentResult(
          approved: false,
          amountMinor: amountMinor,
          reference: intentId,
          message: 'Card payment $status',
        );
      }

      onStageChanged?.call(DojoStage.awaitingCard);
      await Future<void>.delayed(const Duration(seconds: 2));
    }

    // Timed out with the intent still open. This is NOT a decline — the money
    // may yet be taken — so it must never be recorded as either paid or
    // refused.
    return PaymentResult(
      approved: false,
      amountMinor: amountMinor,
      reference: intentId,
      message:
          'Timed out waiting for the card. Check the terminal or Dojo before '
          'retrying — the payment may still have gone through.',
    );
  }
}
