import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../data/commerce.dart';
import '../data/local/database.dart';
import '../data/order_repository.dart';
import '../data/pricing_engine.dart';
import '../data/receipt_repository.dart';
import '../data/staff_session.dart';
import '../data/tender_engine.dart';
import '../data/till_settings.dart';
import '../main.dart';
import '../payments/connect_pac.dart';
import '../payments/dojo_desktop.dart';
import '../payments/payment_provider.dart';
import 'card_checkout_page.dart';
import 'card_payment_dialog.dart';
import 'confirm_tender_dialog.dart';
import 'discount_dialog.dart';
import 'print_receipt_sheet.dart';
import 'redemption_dialogs.dart';
import '../data/cash_tally.dart';
import 'till_actions.dart';
import 'void_dialog.dart';
import 'widgets/cash_notes_panel.dart';
import 'widgets/pay_check_panel.dart';
import 'widgets/pos_message.dart';
import 'widgets/tender_panel.dart';
import 'receipts_page.dart' show receiptListProvider;
import 'theme.dart';

/// Private so it does not collide with the basket panel's exported `money`,
/// which sale_page imports.
String _money(int minor) =>
    NumberFormat.currency(locale: 'en_GB', symbol: '£').format(minor / 100);

/// Tender screen. Everything here writes locally and settles immediately —
/// taking money must never wait on the network.
class PaymentPage extends ConsumerStatefulWidget {
  const PaymentPage({
    super.key,
    required this.orderId,
    required this.onSettled,
    this.initialSplitWays = 0,
  });

  final String orderId;
  final VoidCallback onSettled;

  /// Open with the bill already divided this many ways — how the tables screen
  /// hands over a "split evenly" request. 0 means no split.
  final int initialSplitWays;

  @override
  ConsumerState<PaymentPage> createState() => _PaymentPageState();
}

class _PaymentPageState extends ConsumerState<PaymentPage> {
  /// What the clerk has keyed in, in minor units. Null means "no override", in
  /// which case a tender settles the whole outstanding balance.
  String _entry = '';

  void _key(String k) {
    setState(() {
      if (k == 'CL') {
        _entry = '';
      } else if (k == '.' && _entry.contains('.')) {
        return;
      } else {
        _entry += k;
      }
    });
  }


  /// Get the just-closed sale onto the server and refresh the history, so the
  /// receipt shows up in the Receipts screen the moment it is paid instead of
  /// only after a manual refresh.
  ///
  /// The list is server-backed, so the sale has to reach the server first: we
  /// flush the outbox now rather than waiting for the periodic sync, then
  /// invalidate the list once that push has been attempted. If the till is
  /// offline the flush is a no-op and the sale stays queued — the receipt then
  /// appears when connectivity returns and the next flush lands, which is the
  /// best history can do without the network.
  ///
  /// The service and the container are read up front, before the page pops:
  /// this runs unawaited and the flush is slow, so by the time it finishes this
  /// State can be disposed — going through the root container rather than the
  /// widget's `ref` keeps the invalidation valid regardless.
  Future<void> _publishReceipt() async {
    final container = ProviderScope.containerOf(context, listen: false);
    await container.read(syncServiceProvider).flush();
    container.invalidate(receiptListProvider);
  }

  /// After payment, offer to print the receipt. Built from the just-settled
  /// local order, so it works even if the sale has not yet synced to the
  /// server — the customer gets their receipt regardless of the network.
  Future<void> _offerReceipt() async {
    final repo = ref.read(orderRepositoryProvider);
    final order = await repo.watchOrder(widget.orderId).first;
    final lines = await repo.watchLines(widget.orderId).first;
    final tenders = await repo.paymentsFor(widget.orderId);

    if (!mounted) return;

    final session = ref.read(sessionProvider);
    final detail = ReceiptDetail(
      summary: ReceiptSummary(
        id: order.id,
        totalMinor: order.totalMinor,
        taxMinor: order.taxMinor,
        discountMinor: order.discountMinor,
        tableNumber: order.tableNumber,
        closedAt: order.closedAt ?? DateTime.now(),
        covers: order.covers,
        // Who served it and who it was for — both print, and both are what
        // makes a receipt traceable back to a person rather than a terminal.
        clerkName: ref.read(servedByProvider),
        customerName: _customer?.name ?? order.customerName,
        orderNote: order.notes,
        // What was taken off, so the printed receipt explains its own total.
        voucherCode: _voucherCode,
        voucherMinor: _voucherMinor,
        serviceMinor: _tender.totals.gratuityMinor,
        pointsRedeemed: _pointsRedeemed,
        pointsEarned: _customer?.pointsFor(_tender.totals.netGoodsMinor) ?? 0,
        pointsBalance: _customer?.pointsBalance,
      ),
      lines: [
        for (final l in lines)
          ReceiptLine(
            name: l.name,
            quantity: l.quantity,
            unitPriceMinor: l.unitPriceMinor,
            taxPercentage: l.taxPercentage,
            note: l.notes,
          ),
      ],
      tenders: [
        for (final t in tenders)
          ReceiptTender(
            method: t.method,
            amountMinor: t.amountMinor,
            cashBreakdown: t.cashBreakdown,
          ),
      ],
    );

    await PrintReceiptSheet.show(
      context,
      receipt: detail,
      venueName: session.venueName,
      branding: ref.read(brandingProvider),
      // A takeaway counter has no kitchen ticket to send; a table order does.
      showKitchenOption: order.tableNumber != null,
    );
  }

  /// Hand the clerk's signature decision back to the waiting provider.
  ///
  /// Guarded because the reader can resend the prompt: completing a Completer
  /// twice throws, which would abort a payment that is otherwise fine.
  void _answerSignature(
    ValueNotifier<CardPaymentState> payment,
    Completer<bool>? signature, {
    required bool accepted,
  }) {
    if (signature == null || signature.isCompleted) return;
    signature.complete(accepted);
    payment.value = payment.value.copyWith(
      step: accepted ? CardStep.processing : CardStep.starting,
      readerPrompt: accepted ? 'Finishing the payment' : 'Cancelling',
    );
  }

  /// Run a card. Returns true only if the money was actually taken — a decline,
  /// an error, or a timeout all return false, so the sale is never recorded as
  /// paid when it was not.
  ///
  /// [manual] takes the *keyed* route rather than a presented card: the number
  /// is typed in. Each acquirer expresses that differently — Connect flags the
  /// transaction card-not-present so the PDQ opens its keypad, Dojo routes to
  /// card-entry UI instead of the reader — so it is passed straight through to
  /// the provider rather than decided here. A venue reaches for this when a
  /// chip will not read or the customer is on the telephone.
  Future<PaymentResult?> _takeCard(
    int amountMinor, {
    bool manual = false,
  }) async {
    final provider = manual
        ? ref.read(manualCardProvider)
        : ref.read(dojoProvider);
    if (provider == null) {
      _toast(
        'Card payments are not set up. Add your card API URL and key in '
        'Settings › Card payments.',
      );
      return null;
    }

    // The clerk needs to know the till is waiting on the customer, and must not
    // be able to press Card twice while it is.
    //
    // Where the provider reports what it is actually doing, the wait can be
    // abandoned: a card payment can sit unanswered for minutes, and a spinner
    // with no message and no way out strands the till mid-service.
    final desktop = provider is DesktopDojoProvider ? provider : null;
    final rest = provider is DojoProvider ? provider : desktop?.intents;
    final connect = provider is ConnectPacProvider ? provider : null;

    // One notifier drives the whole screen: the stage the till knows about,
    // plus whatever the reader is telling the customer.
    final payment = ValueNotifier<CardPaymentState>(
      const CardPaymentState(step: CardStep.starting),
    );
    DojoStage? lastStage;

    // The provider blocks on this when the reader asks for a signature; the
    // Completer is finished by whichever button the clerk presses.
    Completer<bool>? signature;
    Future<bool> askForSignature() {
      final completer = Completer<bool>();
      signature = completer;
      payment.value = payment.value.copyWith(step: CardStep.signature);
      return completer.future;
    }

    // When the sale runs on a card machine, show what the reader is telling
    // the customer ("present card", "enter PIN") rather than a generic wait —
    // the clerk is the one who has to prompt them.
    rest?.onTerminalUpdate = (s) {
      payment.value = payment.value.copyWith(
        step: cardStepFor(stage: lastStage, session: s),
        readerPrompt: s.prompt,
        terminalLabel: rest.terminalId,
      );
    };
    rest?.onSignatureRequested = askForSignature;
    desktop?.onStageChanged = (s) {
      lastStage = s;
      payment.value = payment.value.copyWith(step: cardStepFor(stage: s));
    };

    connect?.onProgress = (p) {
      payment.value = payment.value.copyWith(
        step: cardStepForConnect(p),
        readerPrompt: p.prompt,
        terminalLabel: connect.terminalId,
      );
    };
    connect?.onSignatureRequested = askForSignature;

    // Render the hosted card page inside the till rather than handing it to the
    // system browser: on a Windows touch till there may be no browser to hand
    // it to, and on a tablet the customer ends up holding the whole device.
    desktop?.openCheckout = (url) async {
      if (!mounted) return false;
      unawaited(
        CardCheckoutPage.show(
          context,
          url: url,
          amountLabel: _money(amountMinor),
        ),
      );
      return true;
    };

    unawaited(
      showDialog<void>(
        context: context,
        barrierDismissible: false,
        useRootNavigator: true,
        routeSettings: const RouteSettings(name: CardCheckoutPage.routeName),
        builder: (dialogContext) => ValueListenableBuilder<CardPaymentState>(
          valueListenable: payment,
          builder: (_, state, _) => CardPaymentView(
            state: state,
            amountLabel: _money(amountMinor),
            // Only providers that poll can abandon a wait; the Android drop-in
            // owns its own screen and its own cancel button.
            onCancel: desktop == null && connect == null
                ? null
                : () {
                    // Stop polling; the result comes back as "abandoned",
                    // never as paid or declined.
                    desktop?.cancel();
                    connect?.abandon();
                    Navigator.of(dialogContext).pop();
                  },
            // Signature verification, when the reader asks for it. Answering
            // is what releases the sale, so it must be reachable here.
            onSignatureAccepted: state.step == CardStep.signature
                ? () => _answerSignature(payment, signature, accepted: true)
                : null,
            onSignatureRejected: state.step == CardStep.signature
                ? () => _answerSignature(payment, signature, accepted: false)
                : null,
          ),
        ),
      ),
    );

    final result = await provider.take(
      amountMinor,
      orderId: widget.orderId,
      manual: manual,
    );

    // Detach before disposing, or a late poll would write to a dead notifier.
    rest?.onTerminalUpdate = null;
    rest?.onSignatureRequested = null;
    desktop?.onStageChanged = null;
    desktop?.openCheckout = null;
    connect?.onProgress = null;
    connect?.onSignatureRequested = null;
    payment.dispose();
    // Close the card screens. The checkout page may be sitting on top of the
    // progress dialog, and either may already be gone if the clerk or the
    // customer closed it, so this pops exactly the routes this flow pushed —
    // popping a fixed number of times would take the sale screen with it.
    if (mounted) {
      Navigator.of(context, rootNavigator: true).popUntil(
        (route) => route.settings.name != CardCheckoutPage.routeName,
      );
    }

    if (!result.approved) {
      // An outcome the till cannot trust is not a decline, and a snackbar is
      // the wrong shape for it: the clerk has to go and do something about the
      // reader before charging the card again.
      if (result.uncertainty != PaymentUncertainty.none && mounted) {
        await showDialog<void>(
          context: context,
          barrierDismissible: false,
          builder: (context) => AlertDialog(
            icon: Icon(
              result.uncertainty == PaymentUncertainty.terminalUnreachable
                  ? Icons.error_outline
                  : Icons.help_outline,
              size: 30,
              color: Theme.of(context).colorScheme.error,
            ),
            title: const Text('Did that payment go through?'),
            content: Text(
              '${result.message}\n\n'
              'This sale has NOT been marked as paid. Do not charge the card '
              'again until you know.',
            ),
            actions: [
              FilledButton(
                onPressed: () => Navigator.pop(context),
                child: const Text('Understood'),
              ),
            ],
          ),
        );
      } else {
        _toast(result.message ?? 'Card payment declined.');
      }
      return null;
    }
    return result;
  }

  /// Every caller here is reporting a payment that did *not* happen — a decline,
  /// an unreachable server, a gift card with no balance — so these are errors,
  /// shown in the middle of the screen rather than over the tender keys.
  void _toast(String message) {
    if (!mounted) return;
    PosMessenger.error(context, message);
  }
  // ---- Commerce state ----------------------------------------------------

  /// Reductions the clerk has agreed, kept here rather than on the order so
  /// they can be undone before the sale is committed.
  int _manualDiscountMinor = 0;

  /// Whether the clerk has set a discount *on this screen*. Until they do, the
  /// order's own discount stands — otherwise opening the payment screen would
  /// quietly wipe a discount keyed a moment earlier.
  bool _discountTouched = false;

  /// How the discount was expressed, kept alongside the money so the dialog can
  /// reopen on what the clerk actually chose rather than on a cash figure they
  /// never typed.
  DiscountChoice? _discount;

  int _voucherMinor = 0;
  String? _voucherCode;
  int _pointsMinor = 0;
  int _pointsRedeemed = 0;
  int _gratuityBp = 0;
  bool _gratuityApplies = false;
  bool _gratuityTouched = false;

  LoyaltyCustomer? _customer;

  /// Payments taken so far, and any split in progress.
  TenderState _tender = const TenderState(totals: BasketTotals.empty);

  /// Guards [PaymentPage.initialSplitWays] so it is applied once, not on every
  /// rebuild — re-splitting each frame would keep resetting the shares and
  /// throw away payments already credited to them.
  bool _initialSplitApplied = false;

  /// Lines picked out for Void, exactly as on the sale screen.
  final Set<String> _selected = {};

  /// Notes counted in on the cash keys but not yet taken as a tender.
  ///
  /// Held separately from [_tender] on purpose: this is money on the counter,
  /// not money in the drawer. Nothing is recorded against the bill until the
  /// clerk presses Take, so a miscount is cleared rather than reversed out of
  /// the takings.
  CashTally _cash = CashTally.empty;

  /// Whether the bill may still be changed.
  ///
  /// Once any money has been taken it may not. Voiding an item after a £20 note
  /// is in the drawer drops the total below what has been paid, and the till
  /// would owe change it has no record of agreeing to. The clerk undoes the
  /// tender first (the Undo key), then amends.
  bool get _canAmend => _tender.tenders.isEmpty;

  /// Turns the order's lines into the pricing engine's shape.
  List<PricedLine> _priced(List<OrderLine> lines) => [
        for (final l in lines)
          PricedLine(
            id: l.id,
            pluid: l.pluId,
            name: l.name,
            quantity: l.quantity,
            unitPriceMinor: l.unitPriceMinor,
            taxPercentage: l.taxPercentage,
            note: l.notes,
            // The payment screen shows the same check as the sale screen, so it
            // carries the same attribution.
            addedBy: l.addedBy,
            addedAt: l.addedAt,
          ),
      ];

  BasketTotals _totals(List<OrderLine> lines, Order? order) {
    final settings = ref.read(tenderSettingsProvider);

    // An automatic service charge applies unless the clerk has said otherwise.
    if (!_gratuityTouched && settings.autoAppliesTo(order?.covers)) {
      _gratuityApplies = true;
      _gratuityBp = settings.gratuityDefaultBp;
    }

    // Carry over what was already agreed on the sale screen.
    //
    // This screen used to start both of these at zero and price the bill from
    // the lines alone, so a discount keyed before PAY — and every attached
    // customer's standing discount — was silently dropped and the customer was
    // charged full price. The clerk's own override still wins once they touch
    // the discount here, which is what `_discountTouched` is for.
    final gross = lines.fold<int>(
      0,
      (sum, l) => sum + (l.unitPriceMinor * l.quantity).round(),
    );
    final manual = _discountTouched
        ? _manualDiscountMinor
        : (order?.manualDiscountMinor ?? 0);
    final customer = order == null
        ? 0
        : OrderRepository.customerDiscountOn(order, gross);

    return PricingEngine(promotions: ref.read(promotionsProvider)).price(
      _priced(lines),
      manualDiscountMinor: manual,
      customerDiscountMinor: customer,
      voucherMinor: _voucherMinor,
      pointsMinor: _pointsMinor,
      gratuityBp: _gratuityBp,
      gratuityApplies: _gratuityApplies,
    );
  }

  /// Take a tender. Each kind knows how to obtain its own authorisation before
  /// any money is recorded: a card must be approved, a gift card must have the
  /// balance, a voucher must validate.
  Future<void> _take(
    TenderKind kind,
    int requested, {
    String? cashBreakdown,
  }) async {
    final due = _tender.dueNowMinor;
    if (due <= 0 && kind != TenderKind.voucher && kind != TenderKind.points) {
      return;
    }

    // Never take more than is owed, except cash — where the surplus is change.
    final amount = kind == TenderKind.cash
        ? requested
        : requested.clamp(0, due);

    switch (kind) {
      case TenderKind.cash:
        // No confirmation. Removed in v1.3.1.0 at the venue's request: cash is
        // the fastest tender at the counter and a dialog per sale was costing
        // more than it saved. What the dialog used to say — the change to hand
        // over, or how much is still owed — is now shown where it is actually
        // needed: the change box after the sale settles, and the "more needed"
        // line on the tender panel before it does.
        _record(TenderEntry(
          kind: kind,
          amountMinor: amount,
          cashBreakdown: cashBreakdown,
        ));

      case TenderKind.card:
      case TenderKind.manualCard:
        // Card keeps its confirmation, deliberately, where cash lost one: a tap
        // here starts a live transaction at the reader, and a mis-hit has to be
        // voided at the card machine rather than simply corrected on the till.
        // Manual card carries its own warning on top of that, because a keyed
        // card number is a different liability from a presented one.
        final manual = kind == TenderKind.manualCard;
        if (!await _confirm(kind, amount, due, manual: manual)) return;
        final result = await _takeCard(amount, manual: manual);
        if (result == null) return;

        // Cashback and gratuity are added on the card machine, so the till only
        // finds out about them here. Both have to be recorded — the drawer is
        // short by the cashback, and the tip belongs to whoever earned it.
        if (result.cashbackMinor > 0 || result.gratuityMinor > 0) {
          await _reportReaderExtras(result);
        }

        _record(TenderEntry(
          kind: kind,
          amountMinor: amount,
          entryMode: manual ? 'manual' : 'terminal',
          reference: result.reference,
          cashbackMinor: result.cashbackMinor,
          gratuityMinor: result.gratuityMinor,
        ));

      case TenderKind.giftCard:
        await _takeGiftCard(amount);

      case TenderKind.deposit:
        await _takeDeposit(amount);

      case TenderKind.voucher:
        await _takeVoucher();

      case TenderKind.points:
        await _takePoints();

      case TenderKind.account:
        _record(TenderEntry(kind: kind, amountMinor: amount));
    }
  }

  /// Tell the clerk what the customer added at the card machine.
  ///
  /// Cashback in particular is an instruction, not a notification: the card has
  /// been charged for it and the customer is now waiting for notes out of the
  /// drawer. Left as a snackbar it scrolls away, the customer leaves without
  /// their money, and the drawer is over at cash-up with nothing to explain it.
  Future<void> _reportReaderExtras(PaymentResult result) async {
    if (!mounted) return;
    await showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (context) => AlertDialog(
        icon: const Icon(Icons.account_balance_wallet_outlined, size: 30),
        title: Text(
          result.cashbackMinor > 0 ? 'Give cashback' : 'Gratuity added',
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (result.cashbackMinor > 0) ...[
              Text(
                'Hand the customer ${_money(result.cashbackMinor)} from the '
                'drawer.',
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const SizedBox(height: 8),
            ],
            if (result.gratuityMinor > 0)
              Text(
                'The customer added ${_money(result.gratuityMinor)} as a tip at '
                'the card machine.',
              ),
            const SizedBox(height: 10),
            Text(
              'The card was charged ${_money(result.chargedMinor)} in total.',
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
        ),
        actions: [
          FilledButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Done'),
          ),
        ],
      ),
    );
  }

  /// Last check before money moves. Returns false if the clerk backs out.
  Future<bool> _confirm(
    TenderKind kind,
    int amountMinor,
    int dueMinor, {
    bool manual = false,
  }) async {
    if (!mounted || amountMinor <= 0) return false;
    return confirmTender(
      context,
      kind: kind,
      amountMinor: amountMinor,
      dueMinor: dueMinor,
      manual: manual,
    );
  }

  void _record(TenderEntry entry) {
    setState(() {
      _entry = '';
      _tender = _tender.addTender(entry);
    });
    _settleIfPaid();
  }

  Future<void> _takeGiftCard(int amount) async {
    final commerce = ref.read(commerceRepositoryProvider);
    final result = await showGiftCardDialog(
      context,
      commerce: commerce,
      outstandingMinor: amount,
    );
    if (result == null || !mounted) return;

    try {
      // The server is the authority on the balance, and it decrements under a
      // lock — so this must succeed before the till counts the money.
      await commerce.redeemGiftCard(
        code: result.reference,
        amountMinor: result.amountMinor,
        orderId: widget.orderId,
        clerkName: ref.read(servedByProvider),
      );
      _record(TenderEntry(
        kind: TenderKind.giftCard,
        amountMinor: result.amountMinor,
        reference: result.reference,
      ));
    } on CommerceException catch (e) {
      _toast(e.message);
    } catch (_) {
      _toast('Could not reach the server to redeem that card.');
    }
  }

  Future<void> _takeDeposit(int amount) async {
    final commerce = ref.read(commerceRepositoryProvider);
    final result = await showDepositDialog(
      context,
      commerce: commerce,
      outstandingMinor: amount,
    );
    if (result == null || !mounted) return;

    try {
      final applied = await commerce.redeemDeposit(
        reference: result.reference,
        amountMinor: result.amountMinor,
        orderId: widget.orderId,
      );
      _record(TenderEntry(
        kind: TenderKind.deposit,
        amountMinor: applied,
        reference: result.reference,
      ));
    } on CommerceException catch (e) {
      _toast(e.message);
    } catch (_) {
      _toast('Could not reach the server to redeem that deposit.');
    }
  }

  /// A voucher reduces the bill rather than paying it, so it is not recorded
  /// as a tender — it changes what is owed.
  ///
  /// Applying one only *holds* it. It is marked used when the sale settles
  /// (see [_settleIfPaid]): burning it here meant a clerk who applied a voucher
  /// and then backed out of the payment had spent the customer's single-use
  /// voucher on nothing, with no way to give it back.
  Future<void> _takeVoucher() async {
    // Already holding one — offer to take it off rather than silently
    // replacing it, since only one voucher applies to a bill.
    if (_voucherMinor > 0) {
      final remove = await _confirmRemoval(
        'Remove voucher $_voucherCode?',
        'It comes back off the bill and stays unused.',
      );
      if (remove && mounted) {
        setState(() {
          _voucherMinor = 0;
          _voucherCode = null;
        });
      }
      return;
    }

    final result = await showVoucherDialog(
      context,
      commerce: ref.read(commerceRepositoryProvider),
      subtotalMinor: _tender.totals.netGoodsMinor,
    );
    if (result == null || !mounted) return;

    setState(() {
      _voucherMinor = result.amountMinor;
      _voucherCode = result.reference;
    });
  }

  /// Points also reduce the bill. They are only spent on the server once the
  /// sale settles, so an abandoned payment does not cost the customer points.
  Future<void> _takePoints() async {
    if (_pointsRedeemed > 0) {
      final remove = await _confirmRemoval(
        'Take back $_pointsRedeemed points?',
        'They go back on the bill and stay in the customer\'s balance.',
      );
      if (remove && mounted) {
        setState(() {
          _pointsMinor = 0;
          _pointsRedeemed = 0;
        });
      }
      return;
    }

    final result = await showLoyaltyDialog(
      context,
      commerce: ref.read(commerceRepositoryProvider),
      outstandingMinor: _tender.dueNowMinor,
      // So the dialog can tell the customer what this sale will earn them,
      // which is half of why they hand over their number.
      spendMinor: _tender.totals.netGoodsMinor,
    );
    if (result == null || !mounted) return;

    setState(() {
      _customer = result.customer;
      if (result.points > 0) {
        _pointsMinor = result.amountMinor;
        _pointsRedeemed = result.points;
      }
    });
  }

  /// Take an amount off the bill as a manual discount. This is the clerk's own
  /// reduction — a goodwill gesture or a price match — as distinct from an
  /// automatic offer or a voucher.
  ///
  /// Offered as a percentage or a cash amount: "give them 10% off" is the more
  /// common instruction, and making the clerk do that arithmetic at the counter
  /// is where discounts go wrong.
  Future<void> _applyManualDiscount() async {
    final base = _tender.totals.grossMinor - _tender.totals.promoMinor;
    final choice = await showDiscountDialog(
      context,
      subtotalMinor: base,
      current: _discount,
    );
    if (choice == null || !mounted) return;

    setState(() {
      _discount = choice.amountMinor > 0 ? choice : null;
      _manualDiscountMinor = choice.amountMinor;
      _discountTouched = true;
      _entry = '';
    });
  }

  /// A small yes/no for undoing a reduction. Removing one changes what the
  /// customer owes, so it is not something a stray tap should do.
  Future<bool> _confirmRemoval(String title, String detail) async {
    final yes = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(title),
        content: Text(detail),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Keep it'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Remove'),
          ),
        ],
      ),
    );
    return yes ?? false;
  }

  Future<void> _chooseGratuity() async {
    final settings = ref.read(tenderSettingsProvider);
    final bp = await showGratuityDialog(
      context,
      settings: settings,
      baseMinor: _tender.totals.netGoodsMinor,
      currentBp: _gratuityBp,
    );
    if (bp == null || !mounted) return;

    setState(() {
      _gratuityTouched = true;
      _gratuityBp = bp;
      _gratuityApplies = bp > 0;
    });
  }

  /// Take one note, the moment it is tapped.
  ///
  /// The note keys are quick-cash keys as of v1.3.2.0: tapping £20 puts £20
  /// against the bill straight away, with no confirmation. They used to count
  /// into a tally that a separate "Take cash" button committed, and the second
  /// press was routinely never made — the clerk had the money in the drawer and
  /// the customer was already leaving.
  ///
  /// Consecutive taps *rewrite one payment* rather than stacking up several.
  /// Three twenties is one £60 cash line reading "3 x £20", which is what the
  /// receipt has to say and what the drawer has to reconcile against; three
  /// separate £20 lines would be a worse record of the same event.
  ///
  /// Two cases fall back to a fresh tender rather than merging:
  ///
  ///  * **A split bill.** See [TenderState.replaceLastTender] — rewriting a
  ///    payment that has just settled a share would credit the revision to the
  ///    next person.
  ///  * **Anything taken since.** A card, a voucher, a gift card between the
  ///    notes means the cash line is no longer the last one, and reaching past
  ///    the card to amend it would undo the card.
  Future<void> _takeNote(int valueMinor) async {
    if (valueMinor <= 0) return;

    final last = _tender.tenders.isEmpty ? null : _tender.tenders.last;
    final merging = !_tender.isSplit &&
        _cash.isNotEmpty &&
        last != null &&
        last.kind == TenderKind.cash &&
        last.cashBreakdown != null;

    final tally = (merging ? _cash : CashTally.empty).add(valueMinor);

    if (merging) {
      // Straight to the state: [_take] would add a payment beside the cash line
      // rather than growing it, and there is nothing to authorise for cash.
      setState(() {
        _entry = '';
        _cash = tally;
        _tender = _tender.replaceLastTender(TenderEntry(
          kind: TenderKind.cash,
          amountMinor: tally.totalMinor,
          cashBreakdown: tally.encode(),
        ));
      });
      _settleIfPaid();
      return;
    }

    // The first note of a run goes through the same [_take] path as every other
    // cash payment, so the split accounting and settle-on-paid behaviour are
    // identical however the money was keyed.
    final before = _tender.tenders.length;
    await _take(TenderKind.cash, valueMinor, cashBreakdown: tally.encode());
    if (!mounted) return;

    // Only claim the note once the tender actually landed. A tap on a settled
    // bill is refused upstream, and a badge for money that was never taken is
    // worse than no badge.
    setState(() {
      _cash = _tender.tenders.length > before ? tally : CashTally.empty;
    });
  }

  /// Hand the counted notes back: undo the cash payment the keys built.
  ///
  /// Removes the whole run rather than the last note. A customer taking their
  /// money back takes all of it, and a clerk who mis-tapped one key is quicker
  /// re-tapping two than hunting for a per-note undo.
  void _undoCashNotes() {
    if (_cash.isEmpty) return;
    final last = _tender.tenders.isEmpty ? null : _tender.tenders.last;
    setState(() {
      if (last != null && last.kind == TenderKind.cash) {
        _tender = _tender.removeLastTender();
      }
      _cash = CashTally.empty;
    });
  }

  /// Void the picked lines from the payment screen.
  ///
  /// Deliberately the same rules as the sale screen: a reason is required for
  /// every removal, and the audit record is pushed straight away rather than
  /// waiting for the periodic flush.
  Future<void> _voidSelected({
    required List<OrderLine> lines,
    required Set<String> selected,
  }) async {
    if (selected.isEmpty) {
      PosMessenger.error(context, 'Tap the item(s) on the bill first, then Void.');
      return;
    }

    final going = lines.where((l) => selected.contains(l.id)).toList();
    if (going.isEmpty) return;

    final reason = await showVoidDialog(
      context,
      ref,
      itemCount: going.length,
      itemSummary: going.map((l) => l.name).join(', '),
    );
    if (reason == null) return;

    final removed = await ref
        .read(orderRepositoryProvider)
        .voidLines(widget.orderId, lineIds: selected, reason: reason);

    if (!mounted) return;
    setState(() {
      _selected.clear();
      // The bill just got smaller, so any split is now sized against a total
      // that no longer exists. Drop it rather than leave shares that cannot add
      // up; the clerk re-splits on the new total.
      _tender = _tender.clearSplit();
    });
    unawaited(ref.read(syncServiceProvider).flush());

    PosMessenger.success(
      context,
      going.length == 1
          ? 'Voided ${going.first.name} · ${_money(removed)}'
          : 'Voided ${going.length} items · ${_money(removed)}',
    );
  }

  /// Cancel the whole check and leave the payment screen.
  Future<void> _cancelCheck({required List<OrderLine> lines}) async {
    final repo = ref.read(orderRepositoryProvider);

    if (lines.isEmpty) {
      await repo.voidOrder(widget.orderId, reason: 'Empty');
      if (!mounted) return;
      widget.onSettled();
      Navigator.of(context).pop();
      return;
    }

    final reason = await showVoidDialog(context, ref, wholeCheck: true);
    if (reason == null) return;

    await repo.voidOrder(widget.orderId, reason: reason);
    unawaited(ref.read(syncServiceProvider).flush());

    if (!mounted) return;
    // onSettled clears the till down to a fresh sale, which is what a cancelled
    // check needs too — the order it was showing no longer exists.
    widget.onSettled();
    Navigator.of(context).pop();
    PosMessenger.success(context, 'Check cancelled.');
  }

  Future<void> _chooseSplit() async {
    final choice = await showSplitDialog(context, state: _tender);
    if (choice == null || !mounted) return;

    setState(() {
      _tender = switch (choice.mode) {
        SplitMode.equally => _tender.splitEqually(choice.ways),
        SplitMode.byItem => _tender.splitByItems(choice.groups ?? const []),
        _ => _tender.clearSplit(),
      };
    });
  }

  /// Whether the sale is already being committed.
  ///
  /// [_settleNow] is a long run of awaits — the order rows, the voucher, the
  /// points — before anything modal covers the screen, and a second entry during
  /// that window would write every tender to the order a second time. That was
  /// always reachable in principle; it becomes likely with the note keys, which
  /// land a payment per tap and invite exactly the double-tap that triggers it.
  bool _settling = false;

  /// Commit the sale once everything is paid.
  Future<void> _settleIfPaid() async {
    if (_settling || !_tender.settled) return;
    _settling = true;
    try {
      await _settleNow();
    } finally {
      // Not re-armed when the page has gone: a completed sale pops it, and the
      // flag has nothing left to guard.
      if (mounted) _settling = false;
    }
  }

  Future<void> _settleNow() async {
    final repo = ref.read(orderRepositoryProvider);
    final session = await ref.read(sessionRepositoryProvider).current();

    // Record every tender against the order, so the Z report and the receipt
    // both show how the bill was actually paid.
    final servedBy = ref.read(servedByProvider);
    final servedById = ref.read(servedByIdProvider);

    for (final entry in _tender.tenders) {
      await repo.settle(
        widget.orderId,
        entry.kind.method,
        entry.amountMinor,
        sessionId: session.id,
        cashBreakdown: entry.cashBreakdown,
        staffId: servedById,
        staffName: servedBy,
      );
    }

    final commerce = ref.read(commerceRepositoryProvider);

    // Mark the voucher used only now. Doing it when it was applied burned a
    // single-use voucher on a payment the clerk then abandoned, with no way to
    // hand it back.
    final voucher = _voucherCode;
    if (voucher != null && _voucherMinor > 0) {
      try {
        await commerce.redeemVoucher(voucher);
      } catch (_) {
        // The sale is paid and the customer has had the discount. A voucher
        // that could not be marked used is a reconciliation problem for the
        // back office, not a reason to hold up the receipt.
      }
    }

    // Loyalty is moved only now for the same reason: points are spent when the
    // sale completes, and earned on what was actually paid for the goods.
    final customer = _customer;
    if (customer != null) {
      try {
        if (_pointsRedeemed > 0) {
          await commerce.movePoints(
            customerId: customer.id,
            kind: 'redeem',
            points: _pointsRedeemed,
            orderId: widget.orderId,
          );
        }
        await commerce.movePoints(
          customerId: customer.id,
          kind: 'earn',
          spendMinor: _tender.totals.netGoodsMinor,
          orderId: widget.orderId,
        );
      } catch (_) {
        // Points are a loyalty nicety; failing to award them must never block
        // handing the customer their receipt.
      }
    }

    if (!mounted) return;
    unawaited(_publishReceipt());

    // Resolved through the root container *before* the page pops, and used
    // after. This State is disposed by the pop, and `ref` with it — the same
    // reason _publishReceipt goes through the container.
    final container = ProviderScope.containerOf(context, listen: false);
    final settings = container.read(tillSettingsProvider);

    // Change first, before anything else can cover it. The customer is standing
    // there waiting for money out of the drawer, and a receipt prompt in front of
    // that instruction is how change gets forgotten.
    final timedOut = await _showChange(settings);
    if (!mounted) return;

    // A change window that ran all the way down is the terminal being left, not
    // a clerk moving on: nobody touched it for the whole countdown. Putting a
    // receipt prompt up at that point would only park a dialog behind the idle
    // screen for the next person to find, so it is skipped and the sale is
    // finished the way the countdown said it would be.
    if (!timedOut) {
      await _offerReceipt();
      if (!mounted) return;
    }

    widget.onSettled();
    Navigator.of(context).pop();

    final staff = container.read(staffSessionProvider.notifier);

    // What the countdown promised, and the reason the venue asked for it: the
    // member of staff is signed off and the screen goes back to the picture, so
    // an unattended till is not left open on somebody's shift.
    if (timedOut) staff.signOff();

    // Drop to the idle screen, if the venue has asked for one after every sale —
    // or if the window timed out, which is the same instruction arriving by a
    // different route.
    if (settings.idleEnabled && (settings.idleAfterSale || timedOut)) {
      staff.showIdle();
    }
  }

  /// How much change to hand over.
  ///
  /// A box with one number on it, which is what the moment needs: the clerk is
  /// counting notes out of a drawer and the only question is how much.
  /// Everything else the old confirmation dialog said has either already
  /// happened or is on the receipt.
  ///
  /// Nothing is shown when there is no change — the customer paid exactly, or by
  /// card — because a box saying "£0.00 change" is one more tap between the sale
  /// and the next customer.
  ///
  /// It used to wait for a tap and nothing else, on the reasoning that change
  /// which vanishes on its own is change the customer leaves without. That was
  /// the wrong half of the problem. The tap does not always come — the clerk
  /// hands the money over and turns to the next customer — and what was actually
  /// left behind was a till sat open on somebody's shift with a change box on
  /// it. So it counts down instead, and the countdown is *visible*: the number
  /// stays up, the box says what is about to happen, and any touch stops it.
  ///
  /// Returns true when the countdown ran out rather than being dismissed, which
  /// is what tells the caller to sign the staff member off.
  Future<bool> _showChange(TillSettings settings) async {
    final change = _tender.changeMinor;
    if (change <= 0) return false;

    final timedOut = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (context) => _ChangeWindow(
        changeMinor: change,
        seconds: settings.changeWindowSeconds,
      ),
    );
    return timedOut ?? false;
  }

  /// The amount a tender key will take: what the clerk has keyed, or — when
  /// they have keyed nothing — the whole balance.
  ///
  /// Lives here rather than in the tender column because the keypad and the
  /// tender keys are separate columns of the board now, and both have to agree
  /// on the figure. One owner, read by both.
  int get _amountMinor {
    final keyed = double.tryParse(_entry);
    if (keyed != null && keyed > 0) return (keyed * 100).round();
    return _tender.dueNowMinor;
  }

  @override
  Widget build(BuildContext context) {
    final repo = ref.watch(orderRepositoryProvider);
    final settings = ref.watch(tenderSettingsProvider);
    final branding = ref.watch(brandingProvider);
    final pay = PayPalette.of(context);
    final width = MediaQuery.sizeOf(context).width;

    return StreamBuilder<Order>(
      stream: repo.watchOrder(widget.orderId),
      builder: (context, orderSnap) {
        return StreamBuilder<List<OrderLine>>(
          stream: repo.watchLines(widget.orderId),
          builder: (context, linesSnap) {
            final order = orderSnap.data;
            final lines = linesSnap.data ?? const <OrderLine>[];

            // Re-price on every rebuild, then carry the payments already taken
            // across — the bill can change while it is being paid (a gratuity
            // added, a voucher applied) and the tenders must survive that.
            final totals = _totals(lines, order);
            _tender = _tender.copyWith(totals: totals);

            // A split asked for on the tables screen is applied once the bill
            // has actually priced — dividing before the lines have loaded would
            // split zero into N shares of nothing.
            if (!_initialSplitApplied &&
                widget.initialSplitWays >= 2 &&
                totals.totalMinor > 0) {
              _initialSplitApplied = true;
              _tender = _tender.splitEqually(widget.initialSplitWays);
            }

            final denominations =
                ref.watch(cashDenominationsProvider).value ??
                    const <CashDenomination>[];

            // Selection is kept honest against the live lines: a line voided a
            // moment ago must not stay ticked and be voided again.
            final selected = _selected
                .where((id) => lines.any((l) => l.id == id))
                .toSet();

            final check = PayCheckPanel(
              totals: totals,
              branding: branding,
              tableNumber: order?.tableNumber,
              covers: order?.covers,
              clerkName: ref.read(servedByProvider),
              customerName: _customer?.name ?? order?.customerName,
              selectedLineIds: selected,
              // Same gesture as the sale screen, so Void behaves identically on
              // both. Only offered while nothing has been tendered — see
              // _canAmend.
              onTapLine: _canAmend
                  ? (l) => setState(() {
                        if (!_selected.remove(l.id)) _selected.add(l.id);
                      })
                  : null,
            );

            final column = TenderColumn(
              state: _tender,
              settings: settings,
              denominations: denominations,
              amountMinor: _amountMinor,
              onTender: _take,
              noteKeys: CashNotesPanel(
                denominations: denominations,
                tally: _cash,
                onTakeNote: _takeNote,
                onUndo: _undoCashNotes,
              ),
              onGratuity: _chooseGratuity,
              onSplit: settings.allowSplitBill ? _chooseSplit : null,
              onSelectShare: (i) =>
                  setState(() => _tender = _tender.selectShare(i)),
              onClearSplit: () =>
                  setState(() => _tender = _tender.clearSplit()),
              // Clears the note count alongside the payment when the payment
              // being undone is the one the note keys built. Left behind, the
              // badges would go on claiming money that had just been handed
              // back.
              onUndo: () => setState(() {
                final last = _tender.tenders.isEmpty
                    ? null
                    : _tender.tenders.last;
                if (last != null && last.cashBreakdown != null) {
                  _cash = CashTally.empty;
                }
                _tender = _tender.removeLastTender();
              }),
              onCustomer: _attachCustomer,
              onDiscount: _applyManualDiscount,
              onPrintBill: () =>
                  TillActions.printCurrentBill(context, ref, widget.orderId),
            );

            final keypad = PayKeypad(
              state: _tender,
              settings: settings,
              entry: _entry,
              amountMinor: _amountMinor,
              onKey: _key,
              onTender: _take,
            );

            return Scaffold(
              backgroundColor: pay.canvas,
              body: SafeArea(
                child: Column(
                  children: [
                    _PayHeader(
                      tableNumber: order?.tableNumber,
                      covers: order?.covers,
                      clerkName: ref.read(servedByProvider),
                      // Void and Cancel live here as well as on the sale
                      // screen. A mis-rung item is most often spotted at the
                      // moment the total is read out to the customer, and
                      // having to back out to the sale screen to fix it is how
                      // a whole check ends up cancelled instead of one line.
                      onVoid: _canAmend
                          ? () => _voidSelected(
                                lines: lines,
                                selected: selected,
                              )
                          : null,
                      onCancel:
                          _canAmend ? () => _cancelCheck(lines: lines) : null,
                    ),
                    Expanded(
                      child: _board(
                        context,
                        width: width,
                        check: check,
                        column: column,
                        keypad: keypad,
                      ),
                    ),
                  ],
                ),
              ),
            );
          },
        );
      },
    );
  }

  /// Lay the three columns out for the terminal in front of us.
  ///
  /// The board is a 1920px design and it is drawn as one wherever there is room:
  /// the check on the left, the money in the middle, the keypad on the right,
  /// in the proportions it was accepted at. What changes below that is *how
  /// many columns are on screen at once*, never the columns themselves — a
  /// clerk who learns the till on the counter must find the same keys in the
  /// same order on a handheld.
  Widget _board(
    BuildContext context, {
    required double width,
    required Widget check,
    required Widget column,
    required Widget keypad,
  }) {
    const pad = 20.0;
    const gap = 20.0;

    // Three columns. The proportions are the design's own — 460 / 844 / 520 of
    // 1824 — held as ratios so a 1366px till gets the same board rather than
    // the same pixels with the keypad off the edge.
    if (width >= 1100) {
      final horizontal = width >= 1500 ? 28.0 : 16.0;
      final content = width - horizontal * 2 - gap * 2;
      final checkWidth = (content * 0.252).clamp(280.0, 460.0);
      final keypadWidth = (content * 0.285).clamp(300.0, 520.0);

      return Padding(
        padding: EdgeInsets.fromLTRB(horizontal, pad, horizontal, pad + 8),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SizedBox(width: checkWidth, child: check),
            const SizedBox(width: gap),
            Expanded(child: column),
            const SizedBox(width: gap),
            SizedBox(width: keypadWidth, child: keypad),
          ],
        ),
      );
    }

    // Not wide enough for three. The money and the keypad stay together —
    // keying an amount and taking it is one action — and the check moves to a
    // tab beside them.
    if (width >= 760) {
      return _tabbed(
        context,
        tabs: const ['Pay', 'Check'],
        views: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Expanded(child: column),
              const SizedBox(width: 14),
              SizedBox(width: width * 0.34, child: keypad),
            ],
          ),
          check,
        ],
      );
    }

    // A handheld. One column at a time.
    return _tabbed(
      context,
      tabs: const ['Pay', 'Keys', 'Check'],
      views: [column, keypad, check],
    );
  }

  /// The shortest a column may be drawn before the tab scrolls instead. Below
  /// this the scale factors are producing keys nobody can hit.
  static const _minColumnHeight = 620.0;

  Widget _tabbed(
    BuildContext context, {
    required List<String> tabs,
    required List<Widget> views,
  }) {
    final pay = PayPalette.of(context);

    return DefaultTabController(
      length: tabs.length,
      child: Column(
        children: [
          TabBar(
            labelColor: pay.accent,
            unselectedLabelColor: pay.inkMuted,
            indicatorColor: pay.accent,
            dividerColor: pay.panelLine,
            tabs: [for (final t in tabs) Tab(text: t)],
          ),
          Expanded(
            child: TabBarView(
              children: [
                for (final v in views)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(14, 14, 14, 18),
                    // The columns are laid out against the height they are
                    // given, and on a handheld in landscape that height is not
                    // enough to draw a keypad and a note strip at a size worth
                    // having. Rather than compress everything past legibility,
                    // the column keeps a floor and the tab scrolls to it — the
                    // one place on this screen where scrolling is the lesser
                    // evil, because the alternative is keys too small to hit.
                    child: LayoutBuilder(
                      builder: (context, box) {
                        if (box.maxHeight >= _minColumnHeight) return v;
                        return SingleChildScrollView(
                          child: SizedBox(height: _minColumnHeight, child: v),
                        );
                      },
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  /// Attach a customer without redeeming anything, so the sale still earns
  /// them points.
  Future<void> _attachCustomer() async {
    final result = await showLoyaltyDialog(
      context,
      commerce: ref.read(commerceRepositoryProvider),
      outstandingMinor: _tender.dueNowMinor,
      redeem: false,
    );
    if (result?.customer != null && mounted) {
      setState(() => _customer = result!.customer);
    }
  }
}

/// What to hand back, and how long the till will wait before it signs off.
///
/// Deliberately close to full screen. The venue asked for it bigger, and the
/// reason it should be is that this number is read from the far side of a
/// counter by two people at once — the clerk counting it out of the drawer and
/// the customer checking it. So the amount takes whatever room the terminal has:
/// a [FittedBox] rather than a fixed size, because a phone, a 10" tablet and a
/// 1920px Windows till are all in service and a single font size cannot be right
/// on all three.
///
/// The countdown is stated rather than implied. A bar draining silently would
/// leave the clerk guessing how long they had; a line that says the till is
/// about to sign off, with the seconds on it, does not. Touching anywhere stops
/// it — the point is to catch a terminal nobody is at, not to hurry somebody who
/// is standing there counting.
class _ChangeWindow extends StatefulWidget {
  const _ChangeWindow({required this.changeMinor, required this.seconds});

  final int changeMinor;

  /// How long to wait. 0 means wait indefinitely, which is how this behaved
  /// before the timer was settable, and what a venue gets by setting the back
  /// office field to 0.
  final int seconds;

  @override
  State<_ChangeWindow> createState() => _ChangeWindowState();
}

class _ChangeWindowState extends State<_ChangeWindow> {
  Timer? _ticker;
  late int _left = widget.seconds;

  @override
  void initState() {
    super.initState();
    if (widget.seconds <= 0) return;
    _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) return;
      if (_left <= 1) {
        _ticker?.cancel();
        // True: ran out rather than dismissed. The caller signs the staff member
        // off on the strength of this.
        Navigator.of(context).pop(true);
        return;
      }
      setState(() => _left--);
    });
  }

  /// Stop the clock. Any touch counts — somebody is at the till, which is the
  /// whole question the countdown was asking.
  void _hold() {
    if (_ticker == null) return;
    _ticker?.cancel();
    setState(() => _ticker = null);
  }

  @override
  void dispose() {
    _ticker?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final ink = scheme.onTertiaryContainer;
    final counting = _ticker != null;

    return Dialog(
      backgroundColor: scheme.tertiaryContainer,
      // Nearly the whole screen. This is the only thing the terminal is doing.
      insetPadding: const EdgeInsets.all(24),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
      child: Listener(
        behavior: HitTestBehavior.translucent,
        onPointerDown: (_) => _hold(),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(32, 32, 32, 24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                'CHANGE',
                style: theme.textTheme.titleMedium?.copyWith(
                  color: ink.withValues(alpha: 0.75),
                  letterSpacing: 4,
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 12),

              // The amount, as large as the terminal will draw it. Flexible so
              // it yields to the countdown and the button on a short screen
              // rather than overflowing them off the bottom.
              Flexible(
                child: FittedBox(
                  fit: BoxFit.contain,
                  child: Text(
                    _money(widget.changeMinor),
                    maxLines: 1,
                    style: TextStyle(
                      fontSize: 200,
                      fontWeight: FontWeight.w800,
                      height: 1.05,
                      color: ink,
                    ),
                  ),
                ),
              ),

              if (widget.seconds > 0) ...[
                const SizedBox(height: 20),
                // Drains left to right, so the time left is readable without
                // reading the number — but the number is there as well, because
                // "about a third of a bar" is not an answer to "how long have I
                // got".
                ClipRRect(
                  borderRadius: BorderRadius.circular(4),
                  child: LinearProgressIndicator(
                    value: counting ? _left / widget.seconds : 1,
                    minHeight: 7,
                    backgroundColor: ink.withValues(alpha: 0.15),
                    valueColor: AlwaysStoppedAnimation(
                      counting ? Pos.brand : ink.withValues(alpha: 0.35),
                    ),
                  ),
                ),
                const SizedBox(height: 10),
                Text(
                  counting
                      ? 'Signing off in $_left second${_left == 1 ? '' : 's'}'
                      : 'Timer stopped — tap Given when the change is handed '
                            'over.',
                  textAlign: TextAlign.center,
                  style: theme.textTheme.titleSmall?.copyWith(
                    color: ink.withValues(alpha: 0.8),
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],

              const SizedBox(height: 20),
              SizedBox(
                width: double.infinity,
                height: 76,
                child: FilledButton(
                  onPressed: () => Navigator.pop(context, false),
                  style: FilledButton.styleFrom(
                    backgroundColor: Pos.brand,
                    foregroundColor: Pos.onBrand,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(14),
                    ),
                  ),
                  child: const Text(
                    'Given',
                    style: TextStyle(fontSize: 24, fontWeight: FontWeight.w800),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// The bar across the top of the payment board.
///
/// A plain [AppBar] would put this screen back inside the till's ordinary
/// chrome, which is exactly what the board is not: it is a surface the terminal
/// gives over entirely to taking money, and the bar is part of the surface
/// rather than a frame around it.
///
/// It carries the three facts a clerk needs to know they are on the right bill —
/// table, covers, who is serving — and the two keys that change it. Void and
/// Cancel are as far from Cash and Card as the screen allows, because they are
/// the two irreversible things here and both are one tap.
class _PayHeader extends StatelessWidget {
  const _PayHeader({
    this.tableNumber,
    this.covers,
    this.clerkName,
    this.onVoid,
    this.onCancel,
  });

  final int? tableNumber;
  final int? covers;
  final String? clerkName;

  /// Null once money has been taken: the bill may no longer be amended, and a
  /// live key that refuses is worse than a dead one that explains itself by
  /// being dead.
  final VoidCallback? onVoid;
  final VoidCallback? onCancel;

  @override
  Widget build(BuildContext context) {
    final pay = PayPalette.of(context);
    final compact = MediaQuery.sizeOf(context).width < 1100;

    final facts = <String>[
      if (tableNumber != null) 'Table $tableNumber',
      if (covers != null && covers! > 0) '$covers covers',
      if (clerkName?.isNotEmpty ?? false) clerkName!,
    ];

    return Container(
      height: compact ? 68 : 88,
      padding: EdgeInsets.symmetric(horizontal: compact ? 14 : 28),
      decoration: BoxDecoration(
        border: Border(bottom: BorderSide(color: pay.panelLine)),
      ),
      child: Row(
        children: [
          _HeaderKey(
            fill: pay.chip,
            ink: pay.inkSoft,
            square: true,
            compact: compact,
            onTap: () => Navigator.of(context).pop(),
            child: const Icon(Icons.arrow_back, size: 22),
          ),
          SizedBox(width: compact ? 14 : 22),
          Text(
            'Payment',
            style: TextStyle(
              fontSize: compact ? 19 : 23,
              fontWeight: FontWeight.w600,
              color: pay.ink,
            ),
          ),
          if (facts.isNotEmpty && !compact) ...[
            const SizedBox(width: 22),
            Container(width: 1, height: 30, color: pay.panelLine),
            const SizedBox(width: 22),
            // Flexible so a long staff name shortens the chips rather than
            // pushing Void and Cancel off the right-hand edge.
            Flexible(
              child: SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: Row(
                  children: [
                    for (final fact in facts)
                      Padding(
                        padding: const EdgeInsets.only(right: 10),
                        child: Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 16,
                            vertical: 9,
                          ),
                          decoration: BoxDecoration(
                            color: pay.chip,
                            borderRadius: BorderRadius.circular(999),
                          ),
                          child: Text(
                            fact,
                            style: TextStyle(
                              fontSize: 15,
                              color: pay.inkSoft,
                            ),
                          ),
                        ),
                      ),
                  ],
                ),
              ),
            ),
          ],
          const Spacer(),
          _HeaderKey(
            fill: Colors.transparent,
            ink: pay.inkSoft,
            outline: pay.softLine,
            compact: compact,
            onTap: onVoid,
            child: const Text('Void'),
          ),
          SizedBox(width: compact ? 8 : 12),
          _HeaderKey(
            fill: pay.dangerFill,
            ink: pay.dangerInk,
            compact: compact,
            onTap: onCancel,
            child: Text(compact ? 'Cancel' : 'Cancel sale'),
          ),
        ],
      ),
    );
  }
}

/// One key in the header bar.
class _HeaderKey extends StatelessWidget {
  const _HeaderKey({
    required this.fill,
    required this.ink,
    required this.child,
    this.outline,
    this.square = false,
    this.compact = false,
    this.onTap,
  });

  final Color fill;
  final Color ink;
  final Color? outline;
  final Widget child;
  final bool square;
  final bool compact;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final pay = PayPalette.of(context);
    final size = compact ? 44.0 : 52.0;
    final off = onTap == null;

    return SizedBox(
      height: size,
      width: square ? size : null,
      child: Material(
        color: fill,
        borderRadius: BorderRadius.circular(12),
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(12),
          child: Container(
            alignment: Alignment.center,
            padding: square
                ? EdgeInsets.zero
                : EdgeInsets.symmetric(horizontal: compact ? 14 : 22),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(12),
              border: outline == null
                  ? null
                  : Border.all(color: off ? pay.panelLine : outline!),
            ),
            child: DefaultTextStyle(
              style: TextStyle(
                fontSize: compact ? 15 : 16,
                fontWeight: FontWeight.w500,
                color: off ? pay.inkDim : ink,
              ),
              child: IconTheme(
                data: IconThemeData(color: off ? pay.inkDim : ink),
                child: child,
              ),
            ),
          ),
        ),
      ),
    );
  }
}
