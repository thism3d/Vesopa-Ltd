/// A bill, cut into the rounds it was rung in.
///
/// Two people served the same table an hour apart, and the till holds one bill
/// for it. That is right — it is one table — but it is not one *transaction*:
///
///     Table 1
///     Nicky · 19:08      Fish & Chips, Chips, Sticky Toffee, IPA
///     Muzahid Islam · 15:21   Chicken Wings
///
/// Those are two customers. Each has to be payable on its own, and both have to
/// be payable together, and until now the till could only take all of it.
///
/// The check view has been drawing these headings since the staff attribution
/// went in — it just kept the rule to itself, inside a private `_blocks` on the
/// widget. Splitting a bill by round needs the same rule, and a second copy of
/// it would be a bill that groups one way on screen and another way when it is
/// paid. So it lives here, once, and the widget reads it.
///
/// A round is a *contiguous* run, not everything one person ever rang. If Nicky
/// serves, then Muzahid serves, then Nicky serves again, that is three rounds —
/// because it is three approaches to the counter, and the third one is a
/// different customer from the first.
library;

import 'modifier_layout.dart';
import 'pricing_engine.dart';

/// A run of items rung by one person, in one go.
class BillRound {
  BillRound({required this.who, required this.at, required this.lines});

  /// Who rang them. Null for lines the till has no attribution for — bills
  /// taken before staff sign-on existed, and orders arriving from a phone.
  final String? who;

  /// When the run started.
  final DateTime? at;

  final List<PricedLine> lines;

  /// `Nicky · 19:08`, or just the name when there is no time.
  ///
  /// Null when there is nobody to name, which is the ordinary counter sale and
  /// wants no heading at all.
  String? get label {
    final name = who?.trim();
    if (name == null || name.isEmpty) return null;
    final when = at;
    if (when == null) return name;
    final hh = when.hour.toString().padLeft(2, '0');
    final mm = when.minute.toString().padLeft(2, '0');
    return '$name  ·  $hh:$mm';
  }

  /// What this round is worth, after any per-line offers.
  ///
  /// Deliberately not the share of a bill-wide discount — that is apportioned
  /// across shares when the split is actually made
  /// (`TenderState.splitByItems`), and doing it in two places would let the
  /// figure shown differ from the figure charged.
  int get subtotalMinor =>
      lines.fold<int>(0, (sum, line) => sum + line.netMinor);

  Set<String> get lineIds => {for (final line in lines) line.id};
}

/// Cut [lines] into rounds.
///
/// Order is preserved exactly. Modifiers are never a round of their own: they
/// follow the item above them, which is already true of the order the lines
/// arrive in and is asserted here so a future reordering cannot break it
/// quietly.
List<BillRound> roundsOf(List<PricedLine> lines) {
  final rounds = <BillRound>[];

  for (final line in lines) {
    final who = line.addedBy?.trim();
    final open = rounds.isEmpty ? null : rounds.last;

    // A modifier belongs to the item above it whatever it says about itself.
    // Its `addedBy` is normally the same person, but a manager amending
    // somebody else's line is exactly the case where it is not — and that must
    // not open a new round containing one word.
    final continues =
        open != null && (open.who == who || line.parentLineId != null);

    if (continues) {
      open.lines.add(line);
    } else {
      rounds.add(BillRound(who: who, at: line.addedAt, lines: [line]));
    }
  }

  return rounds;
}

/// Whether this bill is worth showing round headings for.
///
/// One round is not a round — it is just the bill, and a heading over the whole
/// of it names something there is nothing to tell apart from. Same for a bill
/// with no attribution at all, which is every bill on a till nobody signs on
/// to.
///
/// This is the rule the payment screen uses to decide whether to draw the
/// headings item 5 asked to remove: gone on an ordinary sale, kept on a table
/// where they are what you tap to pay one person's round.
bool hasRounds(List<BillRound> rounds) =>
    rounds.length > 1 && rounds.any((r) => r.label != null);

/// The lines of the picked rounds, as a set of ids ready for a split.
///
/// Closed over the modifier relation on the way out, so a share can never end
/// up holding an answer without its question. See [withModifiersOf].
Set<String> lineIdsOfRounds(
  Iterable<BillRound> picked,
  List<PricedLine> allLines,
) =>
    withModifiersOf(
      {for (final round in picked) ...round.lineIds},
      allLines,
      idOf: (l) => l.id,
      parentOf: (l) => l.parentLineId,
    );
