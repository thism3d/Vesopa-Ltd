import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vesopa_go/kitchen/data/dinein_inbox.dart';
import 'package:vesopa_go/kitchen/data/kitchen_session.dart';
import 'package:vesopa_go/kitchen/data/providers.dart';
import 'package:vesopa_go/kitchen/data/screen_profile.dart';
import 'package:vesopa_go/kitchen/data/ticket.dart';
import 'package:vesopa_go/kitchen/data/ticket_board.dart';
import 'package:vesopa_go/kitchen/ui/kitchen_mode_page.dart';

/// The kitchen board (2026-11-04): every ticket box the same size; a ticket
/// with more than fits says More and opens whole; a kitchen that cooks for
/// some sites shows only theirs.
Ticket _ticket(String id, int items, {int? site}) => Ticket.fromJson({
      'id': id,
      'kind': 'sale',
      'ticketNo': id.toUpperCase(),
      'staffName': 'Sam',
      'placedAt': DateTime.now().subtract(const Duration(minutes: 3)).toIso8601String(),
      'siteId': ?site,
      'lines': [
        for (var i = 0; i < items; i++) {'id': '$id-$i', 'seq': i, 'quantity': 1, 'name': 'Dish $id $i', 'stations': ['kp1']},
      ],
      'stations': [
        {'station': 'kp1', 'status': 'open'},
      ],
    });

class _Board extends TicketBoard {
  _Board(this.tickets);
  final List<Ticket> tickets;
  @override
  BoardState build() => BoardState(tickets: tickets, online: true);
  @override
  Future<void> start(String office, String wsUrl) async {}
}

class _Inbox extends DineInInbox {
  @override
  void start() {}
}

class _Session extends KitchenSessionController {
  _Session(this.session);
  final KitchenSession session;
  @override
  Future<KitchenSession> build() async => session;
}

void main() {
  Future<void> show(WidgetTester tester, List<Ticket> tickets, {Set<int> sites = const {}}) async {
    SharedPreferences.setMockInitialValues({});
    tester.view.physicalSize = const Size(2732, 2048);
    tester.view.devicePixelRatio = 2;
    addTearDown(tester.view.reset);
    final session = KitchenSession(
      token: 't',
      office: 'kitchen@example.com',
      officeName: 'The Vesopa Kitchen',
      screenId: 5,
      screens: [ScreenProfile.fromJson({'id': 5, 'name': 'Main kitchen', 'sites': sites.toList()})],
    );
    await tester.pumpWidget(ProviderScope(
      overrides: [
        ticketBoardProvider.overrideWith(() => _Board(tickets)),
        dineInInboxProvider.overrideWith(_Inbox.new),
        kitchenSessionProvider.overrideWith(() => _Session(session)),
        allergenLabelsProvider.overrideWith((_) async => const {}),
      ],
      child: const MaterialApp(home: KitchenModePage()),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
  }

  testWidgets('every ticket is the same size; a long one says More and opens whole', (tester) async {
    await show(tester, [_ticket('a', 1), _ticket('b', 14), _ticket('c', 3)]);
    final sizes = {for (final id in ['a', 'b', 'c']) tester.getSize(find.byKey(ValueKey('card-$id')))};
    expect(sizes.length, 1, reason: 'one size for every box: $sizes');
    expect(find.byKey(const ValueKey('ticket-more')), findsOneWidget);
    expect(find.text('Dish b 13'), findsOneWidget, reason: 'laid out, but clipped inside the box');

    await tester.tap(find.byKey(const ValueKey('ticket-more')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('bump-b-full')), findsOneWidget, reason: 'the whole ticket, with its Done');
    expect(find.text('Print'), findsOneWidget);
  });

  testWidgets('a kitchen for one site shows that site and orders from nowhere known', (tester) async {
    await show(tester, [_ticket('bar', 1, site: 1), _ticket('lounge', 1, site: 2), _ticket('kiosk', 1)], sites: {2});
    expect(find.byKey(const ValueKey('card-lounge')), findsOneWidget);
    expect(find.byKey(const ValueKey('card-kiosk')), findsOneWidget);
    expect(find.byKey(const ValueKey('card-bar')), findsNothing);
  });
}
