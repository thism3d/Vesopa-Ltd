import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
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
import 'package:vesopa_go/modes/device_mode.dart';
import 'package:vesopa_go/ui/theme.dart';
import 'package:vesopa_go/ui/tv.dart';

/// The kitchen board on a television (2026-11-19, Play's Android TV
/// listing): a 1080p TV is 960x540 points, as narrow as a phone, but it gets
/// the wall screen's grid, and the remote alone marks a ticket done.
Ticket _ticket(String id) => Ticket.fromJson({
      'id': id,
      'kind': 'table',
      'ticketNo': id,
      'tableNumber': int.parse(id.substring(1)),
      'staffName': 'Megan',
      'placedAt': DateTime.now().subtract(const Duration(minutes: 3)).toIso8601String(),
      'lines': [
        {'id': '$id-1', 'seq': 1, 'quantity': 1, 'name': 'Fish and chips', 'stations': ['kp1']},
      ],
      'stations': [
        {'station': 'kp1', 'status': 'open'},
      ],
    });

final bumped = <String>[];

class _Board extends TicketBoard {
  @override
  BoardState build() => BoardState(tickets: [_ticket('T1'), _ticket('T2'), _ticket('T3'), _ticket('T4')], online: true);
  @override
  Future<void> start(String office, String wsUrl) async {}
  @override
  Future<void> bump(Ticket ticket) async => bumped.add(ticket.id);
}

class _Inbox extends DineInInbox {
  @override
  void start() {}
}

class _Session extends KitchenSessionController {
  @override
  Future<KitchenSession> build() async => KitchenSession(
        token: 't',
        office: 'kitchen@example.com',
        officeName: 'The Vesopa Kitchen',
        screenId: 5,
        screens: [ScreenProfile.fromJson({'id': 5, 'name': 'Main kitchen', 'sites': <int>[]})],
      );
}

void main() {
  setUp(bumped.clear);

  Future<void> tv(WidgetTester tester, {required bool isTv}) async {
    SharedPreferences.setMockInitialValues({});
    tester.view.physicalSize = const Size(1920, 1080);
    tester.view.devicePixelRatio = 2;
    addTearDown(tester.view.reset);
    GoDevice.debugTv = isTv;
    addTearDown(() => GoDevice.debugTv = false);
    await tester.pumpWidget(ProviderScope(
      overrides: [
        ticketBoardProvider.overrideWith(_Board.new),
        dineInInboxProvider.overrideWith(_Inbox.new),
        kitchenSessionProvider.overrideWith(_Session.new),
        allergenLabelsProvider.overrideWith((_) async => const {}),
      ],
      child: MaterialApp(theme: tvFocusTheme(Tp.theme(Brightness.dark)), home: const KitchenModePage()),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
  }

  testWidgets('a 1080p TV gets the grid: tickets side by side, not the phone list', (tester) async {
    await tv(tester, isTv: true);
    final a = tester.getTopLeft(find.byKey(const ValueKey('card-T1')));
    final b = tester.getTopLeft(find.byKey(const ValueKey('card-T2')));
    expect(b.dy, a.dy, reason: 'the second ticket beside the first');
    expect(b.dx, greaterThan(a.dx));
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('the same size phone keeps its swipe list', (tester) async {
    await tv(tester, isTv: false);
    expect(find.byKey(const ValueKey('card-T1')), findsNothing, reason: 'the phone list has no grid boxes');
    expect(find.text('Table #1'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('the remote alone: arrows to a Done, OK marks it done', (tester) async {
    await tv(tester, isTv: true);
    for (var i = 0; i < 12 && bumped.isEmpty; i++) {
      final focused = FocusManager.instance.primaryFocus?.context?.widget;
      final onDone = FocusManager.instance.primaryFocus?.context != null &&
          find
              .ancestor(of: find.byWidget(focused!), matching: find.byKey(const ValueKey('bump-T1')))
              .evaluate()
              .isNotEmpty;
      if (onDone) {
        await tester.sendKeyEvent(LogicalKeyboardKey.select);
        await tester.pump();
        break;
      }
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
      await tester.pump();
    }
    expect(bumped, ['T1'], reason: 'Down from the top reaches the first ticket\'s Done, and OK presses it');
    await tester.pumpWidget(const SizedBox());
  });

  test('a TV is a kitchen screen or a customer display, nothing else (owner, 2026-11-19)', () {
    GoDevice.debugTv = true;
    addTearDown(() => GoDevice.debugTv = false);
    expect(DeviceMode.available, [DeviceMode.kitchen, DeviceMode.display]);
    GoDevice.debugTv = false;
    expect(DeviceMode.available, DeviceMode.values);
  });
}
