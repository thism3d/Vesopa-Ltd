/// Splitting a bill and adding a tip, in whole pence, so that the shares
/// always add up to exactly what is due -- never a penny lost or invented.
library;

import 'models.dart';

/// [dueMinor] in [ways] shares. The odd pennies go on the first shares, so
/// £10.00 three ways is 3.34, 3.33, 3.33.
List<int> splitEqually(int dueMinor, int ways) {
  if (ways < 1) throw ArgumentError.value(ways, 'ways');
  if (dueMinor <= 0) return List.filled(ways, 0);
  final base = dueMinor ~/ ways;
  final extra = dueMinor % ways;
  return [for (var i = 0; i < ways; i++) base + (i < extra ? 1 : 0)];
}

/// What one seat owes: its own lines, plus an even share of the table's
/// (seat 0) lines and of the service charge. Seats are 1..[seats].
Map<int, int> splitBySeat(Bill bill, int seats) {
  if (seats < 1) throw ArgumentError.value(seats, 'seats');
  final own = {for (var s = 1; s <= seats; s++) s: 0};
  var shared = 0;
  for (final l in bill.lines) {
    if (l.seat >= 1 && l.seat <= seats) {
      own[l.seat] = own[l.seat]! + l.totalMinor;
    } else {
      shared += l.totalMinor;
    }
  }
  final sharedParts = splitEqually(shared, seats);
  final shares = {for (var s = 1; s <= seats; s++) s: own[s]! + sharedParts[s - 1]};
  // Service charge in proportion to what each seat had, the last seat taking
  // the remainder so the total is exact.
  final service = bill.serviceMinor;
  if (service > 0) {
    final sub = bill.subtotalMinor;
    var given = 0;
    for (var s = 1; s <= seats; s++) {
      final part = s == seats ? service - given : (sub == 0 ? 0 : (service * shares[s]! / sub).round());
      shares[s] = shares[s]! + part;
      given += part;
    }
  }
  return shares;
}

/// The price of the chosen quantities of lines, with the service charge on top
/// at the bill's rate: paying for "my two pints and the burger".
int priceOfItems(Bill bill, Map<String, int> quantities) {
  var sum = 0;
  for (final l in bill.lines) {
    final q = quantities[l.id] ?? 0;
    if (q <= 0) continue;
    if (q > l.unpaidQuantity) throw ArgumentError('Only ${l.unpaidQuantity} of ${l.product.name} left to pay');
    sum += l.unitMinor * q;
  }
  return sum + (sum * bill.serviceChargePercent / 100).round();
}

/// A percentage tip on [amountMinor], rounded to the penny.
int tipPercent(int amountMinor, double percent) => (amountMinor * percent / 100).round();
