import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vesopa_go/counter/data/journal.dart';
import 'package:vesopa_go/data/models.dart';

Bill _paid(String id) => Bill(
      id: id,
      name: 'Sale',
      lines: const [BillLine(id: 'l', product: Product(id: 'p', name: 'Becks', priceMinor: 380, category: 'bottles'))],
      tenders: [Tender(id: 't$id', amountMinor: 380, kind: 'cash', at: DateTime(2026))],
    );

void main() {
  setUp(() => Journal.persist = true);

  test('a sale paid before the stored day is read is kept, numbered after it, and saved', () async {
    SharedPreferences.setMockInitialValues({});
    final first = ProviderContainer();
    first.read(journalProvider.notifier).record(_paid('a'), categoryNames: const {});
    await Future<void>.delayed(const Duration(milliseconds: 50));
    first.dispose();

    // The device restarts; the very first thing it does is take a sale.
    final second = ProviderContainer();
    addTearDown(second.dispose);
    second.read(journalProvider.notifier).record(_paid('b'), categoryNames: const {});
    await Future<void>.delayed(const Duration(milliseconds: 50));
    final j = second.read(journalProvider);
    expect([for (final s in j.sales) s.id], ['b', 'a']);
    expect([for (final s in j.sales) s.number], [2, 1]);

    final third = ProviderContainer();
    addTearDown(third.dispose);
    third.read(journalProvider);
    await Future<void>.delayed(const Duration(milliseconds: 50));
    expect(third.read(journalProvider).sales.length, 2, reason: 'both reached storage');
  });
}
