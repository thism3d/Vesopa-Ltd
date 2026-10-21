import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../data/customer_display.dart';
import '../data/till_permissions.dart';
import '../main.dart';
import '../payments/card_log.dart';
import '../payments/dojo_config.dart';
import '../payments/dojo_desktop.dart';
import '../payments/dojo_native.dart';
import '../payments/payment_provider.dart';
import '../payments/barclaycard_provider.dart';
import '../payments/teya_provider.dart';
import 'card_payment_dialog.dart';
import 'permission_gate.dart';
import 'teya_refund.dart';
import 'theme.dart';

String _money(int minor) =>
    NumberFormat.currency(locale: 'en_GB', symbol: '£').format(minor / 100);

/// The Dojo client this till takes cards with, or null when it has none.
///
/// Refunds and status checks need the REST client whichever way the till
/// presents cards (reader, drop-in or hosted checkout).
DojoProvider? tillDojo(WidgetRef ref) {
  DojoProvider? of(PaymentProvider? p) => switch (p) {
    DojoProvider d => d,
    DesktopDojoProvider d => d.intents,
    NativeDojoProvider d => d.intents,
    _ => null,
  };
  return of(ref.read(dojoProvider)) ?? of(ref.read(manualCardProvider));
}

/// How money goes back on a Dojo card payment.
enum DojoRefundRoute {
  /// `POST /payment-intents/{id}/refunds`: straight back to the card that
  /// paid, no card needed, full or part.
  toCard('Back to the card that paid', 'No card needed. Full or part.'),

  /// A MatchedRefund terminal session: on the card machine, linked to the
  /// sale, for whatever is left of it. The customer presents the card.
  machineMatched(
    'On the card machine, linked to the sale',
    'Customer presents the card. Refunds what is left of the sale.',
  ),

  /// An UnlinkedRefund terminal session: any amount, no link to a sale.
  machineUnlinked(
    'On the card machine, any amount',
    'Customer presents the card. Not linked to a sale: a manager approves.',
  );

  const DojoRefundRoute(this.label, this.detail);
  final String label;
  final String detail;
}

/// What has gone back on [intentId] according to this till's own card log:
/// approved refunds of every route, the card machine's included.
///
/// Dojo's own `refundedAmount` does not always say: a refund on the card
/// machine that was not matched to the sale never touches the intent, and the
/// sandbox leaves terminal payments' intents alone even after a matched one.
/// Trusting Dojo alone is what let the same card payment be refunded again
/// and again.
Future<int> cardLogRefunded(String intentId) async {
  var total = 0;
  for (final e in await CardLog.instance.recent()) {
    if (e.intentId == intentId && e.kind.contains('refund') && e.approved) {
      total += e.amountMinor;
    }
  }
  return total;
}

/// Refund all or part of a Dojo card payment. Returns what went back, or 0.
///
/// Used from Functions › Card machine (a payment in the till's card log) and
/// from Refund off a receipt (the card share of the sale). Always:
///   1. asks Dojo what the payment is now (paid? already refunded?), and
///      takes off whatever the card log (this till's, and the venue's via
///      [alreadyRefundedMinor]) says has already gone back,
///   2. lets the clerk choose full or part and the route,
///   3. runs it, shows Dojo's answer, and writes it to the card log. When
///      straight-to-card fails it offers the card machine there and then.
///
/// [paidMinor] is what this payment took on the sale; [capMinor] is the most
/// this refund may be (the card share of the lines being refunded).
Future<int> refundDojoPayment(
  BuildContext context,
  WidgetRef ref, {
  required String intentId,
  int? capMinor,
  int? paidMinor,
  int alreadyRefundedMinor = 0,
  String? orderId,
  String? reason,
}) async {
  // Taken on Teya: refunded through Teya.
  if (isTeyaReference(intentId) || isBarclaycardReference(intentId)) {
    return refundTeyaPayment(
      context,
      ref,
      reference: intentId,
      capMinor: capMinor,
      paidMinor: paidMinor,
      alreadyRefundedMinor: alreadyRefundedMinor,
      orderId: orderId,
    );
  }
  final dojo = tillDojo(ref);
  if (dojo == null) {
    _say(context, 'Card payments are not set up on this till.');
    return 0;
  }
  if (!await allowed(context, ref, TillPermission.refund)) return 0;
  if (!context.mounted) return 0;

  // 1. What Dojo says now, and what we know has gone back.
  DojoPaymentStatus status;
  try {
    status = await _busy(
      context,
      'Checking the payment with Dojo…',
      dojo.paymentStatus(intentId),
    );
  } catch (e) {
    if (context.mounted) {
      _say(
        context,
        e is DojoException ? e.clerkMessage : 'Could not reach Dojo: $e',
      );
    }
    return 0;
  }
  if (!context.mounted) return 0;

  final local = await cardLogRefunded(intentId);
  final ours = local > alreadyRefundedMinor ? local : alreadyRefundedMinor;
  // The most anyone could ever get back on this payment.
  final paid = paidMinor ?? status.amountMinor;
  final gone = ours > status.refundedMinor ? ours : status.refundedMinor;
  var refundable = status.refundableMinor;
  final ledgerLeft = paid - gone;
  if (ledgerLeft < refundable) refundable = ledgerLeft;
  if (capMinor != null && capMinor < refundable) refundable = capMinor;
  if (!context.mounted) return 0;
  if (!status.paid || refundable <= 0) {
    _say(
      context,
      !status.paid
          ? 'Dojo says this payment was not taken (${status.status}), so there '
                'is nothing to refund.'
          : gone >= paid
          ? 'This card payment has already been refunded in full '
                '(${_money(gone)} of ${_money(paid)} went back). It cannot be '
                'refunded again.'
          : 'Nothing left to refund on this payment (${status.summary}).',
    );
    return 0;
  }

  // A matched refund on the machine gives back whatever *Dojo* thinks is left,
  // with no amount of ours on it. Only safe while nothing has gone back by any
  // other route, or it would refund the same money a second time.
  final matchedSafe = ours == 0 && refundable == status.refundableMinor;

  // 2. Full or part, and how.
  final choice = await showDialog<({int amount, DojoRefundRoute route})>(
    context: context,
    builder: (_) => _RefundDialog(
      status: status,
      refundableMinor: refundable,
      alreadyRefundedMinor: gone,
      hasMachine: dojo.canUseTerminal,
      allowMatched: matchedSafe,
    ),
  );
  if (choice == null || !context.mounted) return 0;

  var route = choice.route;
  final amount = choice.amount;
  final staff = ref.read(servedByProvider);

  while (true) {
    if (!context.mounted) return 0;
    if (route == DojoRefundRoute.machineUnlinked &&
        !await allowed(context, ref, TillPermission.isManager)) {
      return 0;
    }
    if (!context.mounted) return 0;

    // 3. Do it.
    PaymentResult outcome;
    if (route == DojoRefundRoute.toCard) {
      try {
        final id = await _busy(
          context,
          'Sending the refund to Dojo…',
          dojo.refundToCard(
            intentId,
            amountMinor: amount,
            // One key per refund of this payment and amount, so a retry after
            // a dropped connection cannot refund twice. Keyed on everything
            // that has gone back, ours included: Dojo's figure alone stayed
            // the same after a machine refund, so the next real refund reused
            // the old key and Dojo quietly answered with the old refund.
            idempotencyKey: 'vesopa-$intentId-$amount-$gone',
            reason: reason,
          ),
        );
        outcome = PaymentResult(
          approved: true,
          amountMinor: amount,
          reference: intentId,
          outcome: CardOutcome.approved,
          acquirerStatus: 'Refunded',
          message: 'Refunded ${_money(amount)} to the card. Refund $id.',
        );
      } on DojoException catch (e) {
        outcome = PaymentResult(
          approved: false,
          amountMinor: amount,
          reference: intentId,
          outcome: CardOutcome.failed,
          acquirerStatus: e.statusCode == null ? null : 'HTTP ${e.statusCode}',
          message: e.clerkMessage,
        );
      } catch (e) {
        outcome = PaymentResult(
          approved: false,
          amountMinor: amount,
          reference: intentId,
          outcome: CardOutcome.failed,
          message: 'Could not reach Dojo: $e',
        );
      }
    } else {
      if (!context.mounted) return 0;
      outcome = await runRefundOnMachine(
        context,
        dojo,
        amountMinor: amount,
        intentId: route == DojoRefundRoute.machineMatched ? intentId : null,
      );
    }

    await CardLog.instance.add(
      CardLogEntry.fromResult(
        outcome,
        kind: switch (route) {
          DojoRefundRoute.toCard => 'refund',
          DojoRefundRoute.machineMatched => 'matched_refund',
          DojoRefundRoute.machineUnlinked => 'unlinked_refund',
        },
        // An unlinked refund is not tied to the sale on Dojo's side, but it is
        // on ours: it was raised against this payment, and counting it there
        // is what stops the same payment being refunded again.
        intentId: intentId,
        orderId: orderId,
        terminalId: dojo.terminalId,
        softwareHouseId: dojo.softwareHouseId,
        resellerId: dojo.resellerId,
        staff: staff,
        outcome: outcome.acquirerStatus == recordedManually
            ? 'recorded_manually'
            : null,
      ),
    );
    if (outcome.approved) await CardLog.instance.noteRefund(intentId, amount);
    if (!context.mounted) return outcome.approved ? amount : 0;

    // Straight to the card failed: the customer is usually still at the
    // counter, so offer the machine there and then rather than a dead end.
    if (!outcome.approved &&
        route == DojoRefundRoute.toCard &&
        dojo.canUseTerminal) {
      final next = await _offerMachine(
        context,
        outcome,
        amount: amount,
        matched: matchedSafe && amount == refundable,
      );
      if (next == null || !context.mounted) return 0;
      route = next;
      continue;
    }

    // The card machine's screen already showed its result; straight to the
    // card gets the same screen here.
    if (route == DojoRefundRoute.toCard) {
      await showRefundResult(context, outcome);
    }
    return outcome.approved ? amount : 0;
  }
}

/// Dojo would not refund straight to the card. Try the card machine?
Future<DojoRefundRoute?> _offerMachine(
  BuildContext context,
  PaymentResult failed, {
  required int amount,
  required bool matched,
}) => showDialog<DojoRefundRoute>(
  context: context,
  builder: (context) => AlertDialog(
    icon: const Icon(Icons.error_outline, size: 34, color: Pos.red),
    title: const Text('Dojo did not refund to the card'),
    content: Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(failed.message ?? 'The refund was not accepted.'),
        const SizedBox(height: 12),
        Text(
          'Nothing went back. If the customer has the card with them, refund '
          '${_money(amount)} on the card machine instead.',
        ),
      ],
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('Cancel'),
      ),
      FilledButton.icon(
        icon: const Icon(Icons.point_of_sale),
        onPressed: () => Navigator.pop(
          context,
          matched
              ? DojoRefundRoute.machineMatched
              : DojoRefundRoute.machineUnlinked,
        ),
        label: const Text('Refund on the card machine'),
      ),
    ],
  ),
);

/// The [PaymentResult.acquirerStatus] of a machine refund a manager recorded
/// by hand after the machine showed it approved but Dojo never confirmed it.
const recordedManually = 'Recorded manually';

/// How long the venue keeps a card result on screen (Settings › Card
/// payments), the same for a refund as for a sale.
int _resultSeconds(BuildContext context) {
  try {
    final config = ProviderScope.containerOf(
      context,
      listen: false,
    ).read(dojoConfigProvider).value;
    return (config ?? const DojoConfig()).resultSeconds;
  } catch (_) {
    return const DojoConfig().resultSeconds;
  }
}

/// Run a refund on the card machine and follow it to its end, on the same
/// full-screen view as a sale: what the machine is asking for, a Cancel
/// button, the signature check, and then the result (approved, declined,
/// cancelled, not confirmed) held on screen like a payment's.
///
/// The refund is followed by the same code as a sale ([DojoProvider.
/// followSession]), so it behaves the same way at every step Dojo test:
///
///  * the signature prompt does not stop the till reading the machine, and
///    a signature Dojo accept by themselves after 80 seconds takes the
///    buttons down and shows the real result;
///  * a machine that stops answering, or a session that ends Expired, is
///    "not confirmed", never a bare error: Check refund status, Record as
///    refunded and Try again are offered, and the till keeps checking with
///    Dojo by itself while the result is up;
///  * Try again runs a new session on the same screen.
///
/// [intentId] makes it a matched refund; without it, it is unlinked.
Future<PaymentResult> runRefundOnMachine(
  BuildContext context,
  DojoProvider dojo, {
  required int amountMinor,
  String? intentId,
}) async {
  final matched = intentId != null && intentId.isNotEmpty;
  final kind = matched
      ? TerminalSessionKind.matchedRefund
      : TerminalSessionKind.unlinkedRefund;
  final payment = ValueNotifier<CardPaymentState>(
    CardPaymentState(
      step: CardStep.starting,
      readerPrompt: 'Starting the refund on the card machine…',
      partnerLabel: dojo.partnerLabel,
      terminalLabel: dojo.terminalId,
    ),
  );
  final display = _display(context);
  final seconds = _resultSeconds(context);

  // The customer's screen follows the refund as it follows a sale.
  void mirror(CardPaymentState st) {
    final outcome = st.outcome;
    final title = outcome == null
        ? (st.step == CardStep.signature ? 'Signature' : 'Refund')
        // Neutral words on the customer's screen, as for payments.
        : outcome.customerTitle.replaceAll('Payment', 'Refund');
    unawaited(display?.showCard({
      'phase': outcome == null ? 'progress' : 'result',
      'heading': 'Card refund',
      'title': title,
      'detail': outcome == null
          ? (st.step == CardStep.signature
                ? 'Please wait while your signature is checked'
                : st.step == CardStep.present
                ? 'Tap, insert or swipe your card to get your refund'
                : st.step.customerDetail)
          : switch (outcome) {
              CardOutcome.approved => 'The money is going back to your card.',
              CardOutcome.expired || CardOutcome.unknown =>
                'Please wait while we check your refund.',
              _ => 'Nothing went back to your card.',
            },
      'outcome': outcome?.name,
      'amount_minor': amountMinor,
    }));
  }

  void set(CardPaymentState next) {
    final before = payment.value;
    payment.value = next;
    if (next.step != before.step || next.outcome != before.outcome) {
      mirror(next);
    }
  }

  mirror(payment.value);

  String? sessionId;
  Completer<bool>? signature;
  var ending = Completer<_RefundEnding>();
  void end(_RefundEnding e) {
    if (!ending.isCompleted) ending.complete(e);
  }

  PaymentResult? result;
  String? lastCheck;

  // True once Dojo say the refund went through. [auto]: the till checking by
  // itself while "not confirmed" is up, quietly until there is news.
  Future<bool> checkStatus({bool auto = false}) async {
    final id = sessionId ?? result?.sessionId;
    if (payment.value.checking) return false;
    if (id == null && !matched) {
      if (!auto) {
        payment.value = payment.value.copyWith(
          checkNote: 'The refund never reached Dojo, so there is nothing to '
              'look up. Check the card machine screen.',
        );
      }
      return false;
    }
    payment.value = payment.value.copyWith(
      checking: !auto,
      clearSeconds: !auto,
    );
    try {
      bool done;
      bool over;
      String word;
      if (id != null) {
        final s = await dojo.fetchSession(id);
        done = s.captured || (s.signatureAccepted && !matched);
        over = s.failed || s.signatureRejected;
        word = s.status;
        if (!done && s.signatureAccepted && matched) {
          final st = await dojo.paymentStatus(intentId);
          done = st.refundedMinor > 0;
          word = st.summary;
        }
      } else {
        final st = await dojo.paymentStatus(intentId!);
        done = st.status.toLowerCase() == 'refunded';
        over = false;
        word = st.summary;
      }
      if (auto && word == lastCheck && !done) {
        payment.value = payment.value.copyWith(checking: false);
        return false;
      }
      lastCheck = word;
      payment.value = payment.value.copyWith(
        checking: false,
        checkSaysPaid: done,
        checkNote: done
            ? 'Dojo confirms the refund went through ($word).'
            : over
            ? 'Dojo says the refund did not go through ($word). Nothing went '
                  'back. It is safe to try again.'
            : auto
            ? 'Dojo have no final answer yet ($word). The till keeps '
                  'checking; check the card machine screen too.'
            : 'Dojo have no final answer yet ($word). Check the card machine '
                  'screen.',
      );
      return done;
    } catch (e) {
      payment.value = payment.value.copyWith(
        checking: false,
        checkNote: auto
            ? payment.value.checkNote
            : e is DojoException
            ? 'Could not check: ${e.clerkMessage}'
            : 'Could not reach Dojo. Check the card machine screen.',
      );
      return false;
    }
  }

  final dialog = showDialog<void>(
    context: context,
    barrierDismissible: false,
    useRootNavigator: true,
    builder: (_) => ValueListenableBuilder<CardPaymentState>(
      valueListenable: payment,
      builder: (_, state, _) => CardPaymentView(
        state: state,
        heading: 'Card refund',
        refund: true,
        amountLabel: _money(amountMinor),
        onCancel: () {
          payment.value = payment.value.copyWith(
            cancelling: true,
            cancelNote: 'Asking the card machine to cancel the refund…',
          );
          dojo.requestCancel();
        },
        onStopWaiting: dojo.abandon,
        onSignatureAccepted: state.step == CardStep.signature
            ? () => _answer(payment, signature, true)
            : null,
        onSignatureRejected: state.step == CardStep.signature
            ? () => _answer(payment, signature, false)
            : null,
        onClose: () => end(
          state.checkSaysPaid ? _RefundEnding.recordRefunded : _RefundEnding.close,
        ),
        onCheckStatus: () => checkStatus(),
        onRecordPaid: () => end(_RefundEnding.recordRefunded),
        onRetry: () => end(_RefundEnding.retry),
      ),
    ),
  );

  dojo.onTerminalUpdate = (s) {
    if (payment.value.finished) return;
    final next = forwardStep(payment.value.step, cardStepFor(session: s));
    set(payment.value.copyWith(step: next, readerPrompt: s.prompt));
  };
  dojo.onSignatureRequested = () {
    final c = signature = Completer<bool>();
    set(payment.value.copyWith(step: CardStep.signature));
    return c.future;
  };
  dojo.onSignatureSettled = (note) {
    if (payment.value.finished) return;
    set(payment.value.copyWith(step: CardStep.processing, readerPrompt: note));
  };
  dojo.onCancelAnswered = (_, message) {
    payment.value = payment.value.copyWith(cancelNote: message);
  };

  Timer? countdown;
  Timer? autoCheck;
  _RefundEnding ended;
  while (true) {
    dojo.resetControls();
    sessionId = null;
    try {
      sessionId = await dojo.startRefundSession(
        amountMinor: amountMinor,
        intentId: intentId,
      );
      result = await dojo.followSession(
        sessionId,
        intentId: intentId,
        amountMinor: amountMinor,
        kind: kind,
      );
    } on DojoException catch (e) {
      result = PaymentResult(
        approved: false,
        amountMinor: amountMinor,
        reference: intentId,
        outcome: e.statusCode == 409 ? CardOutcome.busy : CardOutcome.failed,
        acquirerStatus: e.statusCode == null ? null : 'HTTP ${e.statusCode}',
        message: e.clerkMessage,
      );
    } catch (e) {
      // The connection dropped while the refund was being sent: it may have
      // reached the machine. Not confirmed, with the buttons to find out.
      result = PaymentResult(
        approved: false,
        amountMinor: amountMinor,
        reference: intentId,
        sessionId: sessionId,
        outcome: CardOutcome.unknown,
        uncertainty: PaymentUncertainty.checkTerminal,
        message: 'Lost contact with Dojo while sending the refund. Check the '
            'card machine screen and the refund status before trying again.',
      );
    }

    final r = result;
    final outcome = r.kind;
    set(payment.value.copyWith(
      outcome: outcome,
      resultMessage: r.message ?? outcome.title,
      step: outcome == CardOutcome.approved ? CardStep.done : null,
      secondsLeft: outcome.uncertain ? null : seconds,
      clearSeconds: outcome.uncertain,
    ));

    void countDown(_RefundEnding then) {
      countdown?.cancel();
      countdown = Timer.periodic(const Duration(seconds: 1), (t) {
        final left = (payment.value.secondsLeft ?? 0) - 1;
        if (left <= 0) {
          t.cancel();
          end(then);
        } else {
          payment.value = payment.value.copyWith(secondsLeft: left);
        }
      });
    }

    if (!outcome.uncertain) countDown(_RefundEnding.close);
    if (outcome.uncertain) {
      final until = DateTime.now().add(const Duration(minutes: 5));
      Future<void> tick() async {
        if (ending.isCompleted || payment.value.checkSaysPaid) return;
        if (DateTime.now().isAfter(until)) {
          autoCheck?.cancel();
          return;
        }
        if (await checkStatus(auto: true) && !ending.isCompleted) {
          autoCheck?.cancel();
          set(payment.value.copyWith(
            outcome: CardOutcome.approved,
            step: CardStep.done,
            resultMessage: 'Dojo confirmed the refund went through. It is '
                'recorded as refunded.',
            secondsLeft: seconds,
          ));
          countDown(_RefundEnding.recordRefunded);
        }
      }

      unawaited(tick());
      autoCheck = Timer.periodic(const Duration(seconds: 5), (_) => tick());
    }

    ended = await ending.future;
    countdown?.cancel();
    autoCheck?.cancel();
    if (ended != _RefundEnding.retry) break;

    // Try again: a new session on the same screen.
    ending = Completer<_RefundEnding>();
    lastCheck = null;
    signature = null;
    set(CardPaymentState(
      step: CardStep.starting,
      readerPrompt: 'Starting the refund on the card machine again…',
      partnerLabel: dojo.partnerLabel,
      terminalLabel: dojo.terminalId,
    ));
  }

  dojo.onTerminalUpdate = null;
  dojo.onSignatureRequested = null;
  dojo.onSignatureSettled = null;
  dojo.onCancelAnswered = null;
  unawaited(display?.showCard(null));
  final confirmedByDojo = payment.value.checkSaysPaid;
  if (context.mounted) Navigator.of(context, rootNavigator: true).pop();
  await dialog;
  payment.dispose();

  final r = result;
  if (ended == _RefundEnding.recordRefunded && !r.approved) {
    if (confirmedByDojo) {
      return r.copyWith(
        approved: true,
        outcome: CardOutcome.approved,
        message: 'Dojo confirmed the refund went through.',
      );
    }
    // The machine showed it approved but Dojo never said so. On the record,
    // marked as recorded by hand rather than confirmed.
    return r.copyWith(
      approved: true,
      outcome: CardOutcome.approved,
      acquirerStatus: recordedManually,
      message: 'Recorded as refunded after checking the card machine.',
    );
  }
  return r;
}

/// Pass the clerk's signature decision to the waiting refund, once.
void _answer(
  ValueNotifier<CardPaymentState> payment,
  Completer<bool>? signature,
  bool accepted,
) {
  if (signature == null || signature.isCompleted) return;
  signature.complete(accepted);
  payment.value = payment.value.copyWith(
    step: CardStep.processing,
    readerPrompt: accepted ? 'Finishing the refund' : 'Rejecting the signature',
  );
}

/// The customer's screen, when this till drives one.
CustomerDisplayFeed? _display(BuildContext context) {
  try {
    return ProviderScope.containerOf(
      context,
      listen: false,
    ).read(customerDisplayProvider);
  } catch (_) {
    return null;
  }
}

enum _RefundEnding { close, recordRefunded, retry }

/// Dojo's answer for a refund made without the machine (straight to the
/// card), on the same full-screen result as a payment: approved in green,
/// declined or failed in red, held for the venue's chosen seconds.
Future<void> showRefundResult(BuildContext context, PaymentResult r) async {
  final outcome = r.kind;
  final payment = ValueNotifier<CardPaymentState>(
    CardPaymentState(
      step: outcome == CardOutcome.approved ? CardStep.done : CardStep.processing,
      outcome: outcome,
      resultMessage: [
        r.message ?? outcome.title,
        if (r.acquirerStatus != null && r.acquirerStatus != recordedManually)
          'Dojo status: ${r.acquirerStatus}',
      ].join('\n'),
      secondsLeft: outcome.uncertain ? null : _resultSeconds(context),
    ),
  );
  final done = Completer<void>();
  Timer? countdown;
  if (!outcome.uncertain) {
    countdown = Timer.periodic(const Duration(seconds: 1), (t) {
      final left = (payment.value.secondsLeft ?? 0) - 1;
      if (left <= 0) {
        t.cancel();
        if (!done.isCompleted) done.complete();
      } else {
        payment.value = payment.value.copyWith(secondsLeft: left);
      }
    });
  }
  final dialog = showDialog<void>(
    context: context,
    barrierDismissible: false,
    useRootNavigator: true,
    builder: (_) => ValueListenableBuilder<CardPaymentState>(
      valueListenable: payment,
      builder: (_, state, _) => CardPaymentView(
        state: state,
        heading: 'Card refund',
        refund: true,
        amountLabel: _money(r.amountMinor),
        onClose: () {
          if (!done.isCompleted) done.complete();
        },
      ),
    ),
  );
  await done.future;
  countdown?.cancel();
  if (context.mounted) Navigator.of(context, rootNavigator: true).pop();
  await dialog;
  payment.dispose();
}

class _RefundDialog extends StatefulWidget {
  const _RefundDialog({
    required this.status,
    required this.refundableMinor,
    required this.hasMachine,
    this.alreadyRefundedMinor = 0,
    this.allowMatched = true,
  });

  final DojoPaymentStatus status;
  final int refundableMinor;
  final bool hasMachine;

  /// What has gone back already, by any route, so the clerk sees it.
  final int alreadyRefundedMinor;

  /// Whether a matched refund on the machine is safe (see refundDojoPayment).
  final bool allowMatched;

  @override
  State<_RefundDialog> createState() => _RefundDialogState();
}

class _RefundDialogState extends State<_RefundDialog> {
  bool _full = true;
  late final _amount = TextEditingController(
    text: (widget.refundableMinor / 100).toStringAsFixed(2),
  );
  // Straight to the card first: no card needed, full or part, and the one Dojo
  // record of the refund that sits on the sale itself.
  late DojoRefundRoute _route = DojoRefundRoute.toCard;

  int get _minor => _full
      ? widget.refundableMinor
      : ((double.tryParse(_amount.text.trim()) ?? 0) * 100).round();

  bool get _valid => _minor > 0 && _minor <= widget.refundableMinor;

  @override
  void dispose() {
    _amount.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final hint = Theme.of(context).hintColor;
    final routes = [
      DojoRefundRoute.toCard,
      if (widget.hasMachine) ...[
        // Linked to the sale is the whole of what is left, never a part:
        // Dojo cap it at the sale, and a part goes back to the card instead.
        if (_full && widget.allowMatched) DojoRefundRoute.machineMatched,
        DojoRefundRoute.machineUnlinked,
      ],
    ];
    if (!routes.contains(_route)) _route = routes.first;

    return AlertDialog(
      icon: const Icon(Icons.undo, size: 30),
      title: const Text('Refund a card payment'),
      content: SizedBox(
        width: 440,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(widget.status.summary),
              if (widget.alreadyRefundedMinor > 0) ...[
                const SizedBox(height: 6),
                Text(
                  '${_money(widget.alreadyRefundedMinor)} has already gone back '
                  'on this payment.',
                  style: const TextStyle(
                    fontWeight: FontWeight.w600,
                    color: Pos.orange,
                  ),
                ),
              ],
              const SizedBox(height: 4),
              Text(
                'Up to ${_money(widget.refundableMinor)} can go back.',
                style: TextStyle(fontSize: 12, color: hint),
              ),
              const SizedBox(height: 14),
              SegmentedButton<bool>(
                segments: const [
                  ButtonSegment(value: true, label: Text('Full refund')),
                  ButtonSegment(value: false, label: Text('Part refund')),
                ],
                selected: {_full},
                onSelectionChanged: (v) => setState(() => _full = v.first),
              ),
              if (!_full) ...[
                const SizedBox(height: 12),
                TextField(
                  controller: _amount,
                  autofocus: true,
                  keyboardType: const TextInputType.numberWithOptions(
                    decimal: true,
                  ),
                  decoration: InputDecoration(
                    labelText: 'Amount to refund',
                    prefixText: '£ ',
                    errorText: _amount.text.isNotEmpty && !_valid
                        ? 'Between £0.01 and ${_money(widget.refundableMinor)}'
                        : null,
                    border: const OutlineInputBorder(),
                  ),
                  onChanged: (_) => setState(() {}),
                ),
              ],
              const SizedBox(height: 14),
              RadioGroup<DojoRefundRoute>(
                groupValue: _route,
                onChanged: (v) => setState(() => _route = v ?? _route),
                child: Column(
                  children: [
                    for (final r in routes)
                      RadioListTile<DojoRefundRoute>(
                        contentPadding: EdgeInsets.zero,
                        value: r,
                        title: Text(r.label),
                        subtitle: Text(
                          r.detail,
                          style: const TextStyle(fontSize: 12),
                        ),
                      ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: _valid
              ? () => Navigator.pop(context, (amount: _minor, route: _route))
              : null,
          child: Text('Refund ${_valid ? _money(_minor) : ''}'),
        ),
      ],
    );
  }
}

Future<T> _busy<T>(BuildContext context, String text, Future<T> work) async {
  final dialog = showDialog<void>(
    context: context,
    barrierDismissible: false,
    builder: (_) => AlertDialog(
      content: Row(
        children: [
          const SizedBox(
            width: 22,
            height: 22,
            child: CircularProgressIndicator(strokeWidth: 2.5),
          ),
          const SizedBox(width: 14),
          Expanded(child: Text(text)),
        ],
      ),
    ),
  );
  try {
    return await work;
  } finally {
    if (context.mounted) Navigator.of(context, rootNavigator: true).pop();
    await dialog;
  }
}

void _say(BuildContext context, String text) {
  showDialog<void>(
    context: context,
    builder: (context) => AlertDialog(
      content: Text(text),
      actions: [
        FilledButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('OK'),
        ),
      ],
    ),
  );
}
