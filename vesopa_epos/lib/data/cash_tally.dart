import 'local/database.dart';

/// The notes and coins a customer has actually handed over, counted in on the
/// cash keys.
///
/// Modelled as a count per denomination rather than a running total, because
/// that is what the clerk is doing physically — four taps on the £5 key is four
/// five-pound notes, and both the customer watching the screen and the receipt
/// afterwards need to see it that way. A bare "£20" cannot be checked against
/// what is in the hand.
///
/// Immutable: every change returns a new tally, so the payment screen's state
/// updates are as ordinary as any other setState.
class CashTally {
  const CashTally([this.counts = const {}]);

  /// Denomination value in pence -> how many were handed over.
  final Map<int, int> counts;

  static const empty = CashTally();

  bool get isEmpty => counts.isEmpty;
  bool get isNotEmpty => counts.isNotEmpty;

  /// What has been counted in, in pence.
  int get totalMinor =>
      counts.entries.fold(0, (sum, e) => sum + (e.key * e.value));

  /// How many notes in total, for "3 notes · £40" style summaries.
  int get pieceCount => counts.values.fold(0, (sum, n) => sum + n);

  CashTally add(int valueMinor, [int howMany = 1]) {
    final next = Map<int, int>.from(counts);
    final count = (next[valueMinor] ?? 0) + howMany;
    if (count <= 0) {
      next.remove(valueMinor);
    } else {
      next[valueMinor] = count;
    }
    return CashTally(next);
  }

  CashTally remove(int valueMinor) => add(valueMinor, -1);

  CashTally clear() => empty;

  /// Biggest note first — the order the drawer is counted in, and the order a
  /// customer hands things over.
  List<MapEntry<int, int>> get descending {
    final entries = counts.entries.toList()
      ..sort((a, b) => b.key.compareTo(a.key));
    return entries;
  }

  /// Compact form for the payments row: `2000x2,500x1`.
  ///
  /// Deliberately not JSON. It goes in a single column, is written once and
  /// read back only to reprint the same receipt, and this survives being
  /// eyeballed in a database client.
  String encode() => descending.map((e) => '${e.key}x${e.value}').join(',');

  /// Parse [encode]'s output. Anything malformed yields an empty tally rather
  /// than throwing — a receipt must still print if this column is ever junk.
  static CashTally decode(String? raw) {
    if (raw == null || raw.trim().isEmpty) return empty;

    final counts = <int, int>{};
    for (final part in raw.split(',')) {
      final bits = part.split('x');
      if (bits.length != 2) continue;
      final value = int.tryParse(bits[0].trim());
      final count = int.tryParse(bits[1].trim());
      if (value == null || count == null || value <= 0 || count <= 0) continue;
      counts[value] = count;
    }
    return CashTally(counts);
  }

  /// Human-readable, for a receipt line: `2 x £20, 1 x £5`.
  ///
  /// [labels] maps a denomination value to what the back office calls it, so a
  /// venue that renamed its keys sees its own wording. Anything not in the map
  /// falls back to a plain pounds-and-pence rendering.
  String describe([Map<int, String> labels = const {}]) => descending
      .map((e) => '${e.value} x ${labels[e.key] ?? _money(e.key)}')
      .join(', ');

  static String _money(int minor) => minor % 100 == 0
      ? '£${minor ~/ 100}'
      : '£${(minor / 100).toStringAsFixed(2)}';
}

/// Denomination labels keyed by value, for [CashTally.describe].
Map<int, String> labelsFor(List<CashDenomination> denominations) => {
      for (final d in denominations) d.valueMinor: d.label,
    };
