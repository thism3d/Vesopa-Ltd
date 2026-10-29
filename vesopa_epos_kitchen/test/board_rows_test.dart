import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos_kitchen/data/screen_profile.dart';
import 'package:vesopa_epos_kitchen/data/ticket.dart';
import 'package:vesopa_epos_kitchen/ui/theme.dart';
import 'package:vesopa_epos_kitchen/ui/widgets/board_grid.dart';
import 'package:vesopa_epos_kitchen/ui/widgets/ticket_card.dart';

/// The board in rows (Pontardawe RFC, 2026-10-29: "can the kitchen screen all
/// be in line … instead of just placing in any gap"): tickets read left to
/// right in order, each row starts level, and the cards in a row are the same
/// height so their Done buttons line up.
void main() {
  Ticket ticket(int n, int items) => Ticket(
        id: 't$n',
        orderId: 'order-$n',
        ticketNo: 'T$n',
        kind: TicketKind.sale,
        placedAt: DateTime(2026, 10, 29, 12, n),
        tableNumber: n,
        lines: [
          for (var i = 0; i < items; i++)
            TicketLine(id: 't$n-$i', seq: i, quantity: 1, name: 'Item $i', stations: const {'kp1'}),
        ],
        stations: const [TicketStation(station: 'kp1', done: false)],
      );

  testWidgets('tickets sit in level rows, in order, the same height across a row', (tester) async {
    await tester.binding.setSurfaceSize(const Size(1400, 2400));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    // Uneven on purpose: a two-item order beside a seven-item one.
    final tickets = [ticket(1, 2), ticket(2, 7), ticket(3, 1), ticket(4, 4), ticket(5, 1)];
    await tester.pumpWidget(ProviderScope(child: MaterialApp(
      theme: Kds.theme(),
      home: Scaffold(
        body: BoardGrid(
          columns: 3,
          itemCount: tickets.length,
          itemBuilder: (context, i) => TicketCard(
            key: ValueKey(tickets[i].id),
            ticket: tickets[i],
            profile: ScreenProfile.allStations,
            now: DateTime(2026, 10, 29, 12, 30),
            labelFor: (s) => s,
            onBump: () {},
          ),
        ),
      ),
    )));
    await tester.pump();
    expect(tester.takeException(), isNull);

    Rect at(int n) => tester.getRect(find.byKey(ValueKey('t$n')));

    // Row one: tickets 1, 2, 3 from left to right, level at the top and bottom.
    expect(at(1).left, lessThan(at(2).left));
    expect(at(2).left, lessThan(at(3).left));
    expect(at(1).top, at(2).top);
    expect(at(2).top, at(3).top);
    expect(at(1).height, closeTo(at(2).height, 0.5), reason: 'a short order is drawn as tall as its row');
    expect(at(3).height, closeTo(at(2).height, 0.5));

    // Row two starts below the whole of row one, again from the left.
    expect(at(4).top, greaterThan(at(2).bottom));
    expect(at(4).top, at(5).top);
    expect(at(4).left, closeTo(at(1).left, 0.5));
    expect(at(5).left, closeTo(at(2).left, 0.5));

    // The Done buttons of a row are in one line.
    final dones = find.text('Done');
    expect(dones, findsNWidgets(5));
    final y = [for (final e in dones.evaluate()) tester.getCenter(find.byWidget(e.widget).first).dy];
    expect(y[0], closeTo(y[1], 0.5));
    expect(y[1], closeTo(y[2], 0.5));
  });
}
