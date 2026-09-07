import 'commerce.dart';
import 'pricing_engine.dart';

/// One payment taken against a bill.
class TenderEntry {
  const TenderEntry({
    required this.kind,
    required this.amountMinor,
    this.reference,
    this.entryMode,
    this.cashbackMinor = 0,
    this.gratuityMinor = 0,
    this.cashBreakdown,
  });

  final TenderKind kind;
  final int amountMinor;

  /// A gift-card code, deposit reference or card auth code — whatever makes
  /// this payment traceable afterwards.
  final String? reference;

  /// 'terminal' | 'manual' | 'hosted' | 'native'. A manually keyed card
  /// carries different liability from a dipped one, so the receipt and the
  /// Z report must be able to tell them apart.
  final String? entryMode;

  /// Cash handed back out of the drawer at the reader's request.
  ///
  /// Cashback is added on the card machine, not on the till, so the till only
  /// learns of it from the transaction result. It has to be recorded or the
  /// drawer is short by exactly this much at cash-up with nothing to explain it.
  final int cashbackMinor;

  /// Gratuity the customer added — on the till, or at the reader.
  final int gratuityMinor;

  /// The notes counted in on the cash keys, encoded by [CashTally.encode]
  /// (`2000x2,500x1`). Null when the clerk simply keyed an amount, and for
  /// every non-cash tender.
  final String? cashBreakdown;

  /// What the card was actually charged: the amount against the bill plus
  /// anything the customer added at the machine.
  int get chargedMinor => amountMinor + cashbackMinor + gratuityMinor;

  String get label => kind.label;
}

/// How a bill is being divided between people.
enum SplitMode {
  /// Not split.
  none,

  /// Equal shares — "four ways".
  equally,

  /// A named amount at a time — "put £20 on this card".
  byAmount,

  /// Chosen items go on one share.
  byItem,
}

/// A single share of a split bill.
class SplitShare {
  const SplitShare({
    required this.index,
    required this.amountMinor,
    this.paidMinor = 0,
    this.lineIds = const [],
  });

  final int index;
  final int amountMinor;
  final int paidMinor;

  /// For [SplitMode.byItem], which basket lines this share covers.
  final List<String> lineIds;

  int get outstandingMinor => amountMinor - paidMinor;
  bool get settled => outstandingMinor <= 0;

  SplitShare withPayment(int minor) => SplitShare(
        index: index,
        amountMinor: amountMinor,
        paidMinor: paidMinor + minor,
        lineIds: lineIds,
      );
}

/// Tracks what has been paid on a bill and what is left.
///
/// Kept separate from the pricing engine because the two answer different
/// questions: pricing decides what is *owed*, this decides what has been
/// *taken*. Splitting a bill or part-paying it never changes what the goods
/// cost, and conflating the two is how tills end up with a total that drifts
/// as tenders are added.
class TenderState {
  const TenderState({
    required this.totals,
    this.tenders = const [],
    this.splitMode = SplitMode.none,
    this.shares = const [],
    this.activeShare = 0,
  });

  final BasketTotals totals;
  final List<TenderEntry> tenders;
  final SplitMode splitMode;
  final List<SplitShare> shares;

  /// Which share the till is currently taking money for.
  final int activeShare;

  int get paidMinor => tenders.fold(0, (s, t) => s + t.amountMinor);

  /// What is still owed on the whole bill.
  int get outstandingMinor {
    final left = totals.totalMinor - paidMinor;
    return left > 0 ? left : 0;
  }

  /// Money handed over beyond the bill — cash change owed, and only ever from
  /// cash. Overpaying a card is a refund, not change, so the till must not
  /// invite it.
  int get changeMinor {
    final over = paidMinor - totals.totalMinor;
    return over > 0 ? over : 0;
  }

  bool get settled => outstandingMinor <= 0;
  bool get isSplit => splitMode != SplitMode.none && shares.isNotEmpty;

  /// What the current share still owes, or the whole bill when not split.
  int get dueNowMinor {
    if (!isSplit) return outstandingMinor;
    if (activeShare < 0 || activeShare >= shares.length) return outstandingMinor;
    final share = shares[activeShare].outstandingMinor;
    // Never ask for more than the bill has left, even if the shares were
    // rounded up.
    return share < outstandingMinor ? share : outstandingMinor;
  }

  TenderState copyWith({
    BasketTotals? totals,
    List<TenderEntry>? tenders,
    SplitMode? splitMode,
    List<SplitShare>? shares,
    int? activeShare,
  }) =>
      TenderState(
        totals: totals ?? this.totals,
        tenders: tenders ?? this.tenders,
        splitMode: splitMode ?? this.splitMode,
        shares: shares ?? this.shares,
        activeShare: activeShare ?? this.activeShare,
      );

  /// Record a payment, crediting the active share when the bill is split.
  TenderState addTender(TenderEntry entry) {
    final updatedShares = [...shares];
    if (isSplit && activeShare >= 0 && activeShare < updatedShares.length) {
      updatedShares[activeShare] =
          updatedShares[activeShare].withPayment(entry.amountMinor);
    }

    final next = copyWith(
      tenders: [...tenders, entry],
      shares: updatedShares,
    );

    // Move to the next unsettled share automatically: the clerk has just
    // finished with this person and the queue does not wait.
    if (next.isSplit && updatedShares[activeShare].settled) {
      final nextIndex =
          updatedShares.indexWhere((s) => !s.settled, activeShare + 1);
      if (nextIndex != -1) return next.copyWith(activeShare: nextIndex);
    }
    return next;
  }

  /// Swap the last payment for a revised one.
  ///
  /// What the note keys are built on. A customer handing over a twenty and then
  /// a five has made *one* cash payment of £25, not two — the receipt has to say
  /// "2 x £20, 1 x £5" against a single line, and the drawer has to balance
  /// against a single line. So the second tap rewrites the first payment rather
  /// than adding another beside it.
  ///
  /// Deliberately not offered on a split bill. [addTender] moves to the next
  /// unsettled share when one is cleared, so a remove-then-add on a share that
  /// has just been settled would credit the revised amount to the *next* person.
  /// The callers check [isSplit] first and take a fresh tender instead.
  TenderState replaceLastTender(TenderEntry entry) {
    if (tenders.isEmpty) return addTender(entry);
    return removeLastTender().addTender(entry);
  }

  /// Undo the last payment. Used when a card is declined after the clerk has
  /// already recorded it, or a note is handed back.
  TenderState removeLastTender() {
    if (tenders.isEmpty) return this;
    final last = tenders.last;
    final updatedShares = [...shares];
    if (isSplit && activeShare >= 0 && activeShare < updatedShares.length) {
      updatedShares[activeShare] =
          updatedShares[activeShare].withPayment(-last.amountMinor);
    }
    return copyWith(
      tenders: tenders.sublist(0, tenders.length - 1),
      shares: updatedShares,
    );
  }

  /// Divide what is outstanding into [ways] equal shares.
  ///
  /// Pennies that do not divide evenly go onto the first share rather than
  /// being dropped — four ways on £10.01 is £2.51 + £2.50 + £2.50 + £2.50,
  /// and must still add up to the bill.
  TenderState splitEqually(int ways) {
    if (ways < 2) return copyWith(splitMode: SplitMode.none, shares: const []);

    final base = outstandingMinor ~/ ways;
    final remainder = outstandingMinor - (base * ways);

    return copyWith(
      splitMode: SplitMode.equally,
      activeShare: 0,
      shares: [
        for (var i = 0; i < ways; i++)
          SplitShare(index: i, amountMinor: base + (i == 0 ? remainder : 0)),
      ],
    );
  }

  /// Split by putting named lines on their own shares.
  TenderState splitByItems(List<List<String>> groups) {
    if (groups.length < 2) {
      return copyWith(splitMode: SplitMode.none, shares: const []);
    }

    final byId = {for (final l in totals.lines) l.id: l};
    final itemised = <int>[
      for (final group in groups)
        group
            .map((id) => byId[id]?.netMinor ?? 0)
            .fold<int>(0, (s, v) => s + v),
    ];

    // Service, and any reduction taken against the bill rather than a line, is
    // attached to nothing — so it has to be placed, and the shares have to go
    // on summing to the bill either way.
    final covered = itemised.fold<int>(0, (s, v) => s + v);
    final amounts = _apportion(itemised, outstandingMinor - covered, covered);

    return copyWith(
      splitMode: SplitMode.byItem,
      activeShare: 0,
      shares: [
        for (var i = 0; i < groups.length; i++)
          SplitShare(index: i, amountMinor: amounts[i], lineIds: groups[i]),
      ],
    );
  }

  /// Spread [extra] across shares in proportion to what each is worth.
  ///
  /// This used to put the whole of it on share 1, which is wrong in the case
  /// that actually turns up: a table with a bill-wide offer. Table 1 carrying
  /// −£6.05 across £60.50 gave the entire discount to whoever paid first, so
  /// two people splitting the same bill down the middle paid £24.20 and
  /// £30.25 — and the till gave no reason why.
  ///
  /// Pro-rata by share value instead, decided with the venue on 2026-09-07:
  /// each share carries its portion of the offer in proportion to what it is
  /// worth. Nobody is asked to make a judgement with a table waiting, and the
  /// shares always add back to the bill.
  ///
  /// [extra] is routinely negative — a discount is the common case — and every
  /// step below is written to hold for both signs.
  static List<int> _apportion(List<int> itemised, int extra, int covered) {
    final out = [...itemised];
    if (extra == 0 || out.isEmpty) return out;

    // Nothing to be proportional *to*. Every share is worth nothing — a bill of
    // zero-priced items carrying a service charge — so there is no ratio to be
    // fair with, and it goes on the first share as it always did.
    if (covered == 0) {
      out[0] += extra;
      return out;
    }

    var handed = 0;
    for (var i = 0; i < out.length; i++) {
      // Truncating towards zero, deliberately and in both directions: this can
      // only ever hand out less than [extra] in magnitude, never more, so what
      // is left below is a remainder to place rather than an overdraft to claw
      // back off somebody who has already been quoted a figure.
      final portion = (extra * itemised[i]) ~/ covered;
      out[i] += portion;
      handed += portion;
    }

    // The pennies that would not divide, onto the largest share.
    //
    // They have to go somewhere or the split stops adding up to the bill, and
    // the largest share is where a penny is least likely to be noticed against
    // the figure it is attached to. At most one penny per share can be at
    // stake, so this is a rounding decision, not a fairness one.
    final remainder = extra - handed;
    if (remainder != 0) {
      var largest = 0;
      for (var i = 1; i < itemised.length; i++) {
        if (itemised[i] > itemised[largest]) largest = i;
      }
      out[largest] += remainder;
    }

    return out;
  }

  /// Abandon a split and go back to one bill.
  TenderState clearSplit() =>
      copyWith(splitMode: SplitMode.none, shares: const [], activeShare: 0);

  /// Select which share is being paid.
  TenderState selectShare(int index) =>
      index >= 0 && index < shares.length ? copyWith(activeShare: index) : this;

  /// Notes a UK counter will not take, so a key is never offered for one.
  ///
  /// £50 only, and it is here rather than in the venue's presets because the
  /// round-up below *manufactures* amounts: a £47 bill rounds to £50 on its own,
  /// with nothing in the settings to stop it. Dropping 5000 from the configured
  /// presets alone would leave that key appearing on exactly the bills where a
  /// clerk is most likely to press it by reflex.
  ///
  /// A venue that does take £50 notes puts 5000 back in its cash presets, and
  /// the check below lets a configured preset through — this only governs what
  /// the till invents.
  static const _notOffered = {5000};

  /// Cash rounded up to a sensible note or coin, for the quick keys.
  ///
  /// Returns only amounts above what is owed — a key offering less than the
  /// bill would take a payment the customer has not made.
  List<int> cashSuggestions(List<int> presets) {
    final due = dueNowMinor;
    if (due <= 0) return const [];

    // Exact is always offered, whatever it comes to: it is not a note the
    // customer has to have, it is the bill.
    final out = <int>{due};
    for (final preset in presets) {
      if (preset > due) out.add(preset);
    }
    // The next round pound and the next round five.
    final nextPound = ((due + 99) ~/ 100) * 100;
    if (nextPound > due && !_notOffered.contains(nextPound)) out.add(nextPound);
    final nextFive = ((due + 499) ~/ 500) * 500;
    if (nextFive > due && !_notOffered.contains(nextFive)) out.add(nextFive);

    final list = out.toList()..sort();
    return list.take(5).toList();
  }
}
