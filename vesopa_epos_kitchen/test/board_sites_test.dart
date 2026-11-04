import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos_kitchen/data/screen_profile.dart';
import 'package:vesopa_epos_kitchen/data/ticket.dart';
import 'package:vesopa_epos_kitchen/data/ticket_board.dart';

/// Which sites a kitchen cooks for (2026-11-04): a venue with four sites may
/// run two kitchens, and each shows the orders of its own sites' tills.
void main() {
  Ticket ticket(String id, {int? siteId, String? terminal}) => Ticket.fromJson({
    'id': id,
    'kind': 'sale',
    'placedAt': DateTime.now().toIso8601String(),
    'siteId': ?siteId,
    'terminal': ?terminal,
    'lines': [
      {
        'id': '$id-l',
        'seq': 0,
        'quantity': 1,
        'name': 'Chips',
        'stations': ['kp1'],
      },
    ],
    'stations': [
      {'station': 'kp1', 'status': 'open'},
    ],
  });

  final board = BoardState(
    tickets: [
      ticket('bar', siteId: 1),
      ticket('lounge', siteId: 2),
      ticket('link', terminal: 'LOUNGE-TILL'),
      ticket('kiosk'),
    ],
  );

  ScreenProfile screen(Set<int> sites) => ScreenProfile.fromJson({
    'id': 5,
    'name': 'Main',
    'sites': sites.toList(),
    'till_sites': {'LOUNGE-TILL': 2},
  });

  test('a kitchen with no sites chosen cooks for every site', () {
    expect(board.open(screen({})).map((t) => t.id), [
      'bar',
      'lounge',
      'link',
      'kiosk',
    ]);
  });

  test('a kitchen shows its own sites, and orders from nowhere known', () {
    expect(board.open(screen({1})).map((t) => t.id), ['bar', 'kiosk']);
    expect(board.open(screen({2})).map((t) => t.id), [
      'lounge',
      'link',
      'kiosk',
    ]);
    expect(board.counts(screen({1})).single.quantity, 2);
  });

  test('a ticket heard over the local link is placed by its till', () {
    final heard = Ticket.fromTill(
      {
        'id': 'x',
        'terminal': 'LOUNGE-TILL',
        'placed_at': DateTime.now().toIso8601String(),
        'lines': [
          {'id': 'x-l', 'quantity': 1, 'name': 'Pie', 'stations': 'kp1'},
        ],
      },
      tillSites: {'LOUNGE-TILL': 2},
    );
    expect(heard.siteId, 2);
    expect(Ticket.fromJson(heard.toJson()).siteId, 2);
  });

  test('a profile keeps its sites through the cache', () {
    final kept = ScreenProfile.fromJson(screen({1, 2}).toJson());
    expect(kept.sites, {1, 2});
    expect(kept.tillSites, {'LOUNGE-TILL': 2});
  });
}
