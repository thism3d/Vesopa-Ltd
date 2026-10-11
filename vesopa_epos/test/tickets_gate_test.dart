import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vesopa_epos/data/events_api.dart';
import 'package:vesopa_epos/data/local/database.dart' show Product;
import 'package:vesopa_epos/data/screens.dart';
import 'package:vesopa_epos/data/memberships_api.dart';
import 'package:vesopa_epos/data/sync_service.dart';
import 'package:vesopa_epos/data/training_mode.dart';
import 'package:vesopa_epos/main.dart';
import 'package:vesopa_epos/ui/theme.dart';
import 'package:vesopa_epos/ui/tickets_page.dart';
import 'package:vesopa_epos/ui/widgets/here_bar.dart';
import 'package:vesopa_epos/ui/widgets/nav_rail.dart';
import 'package:vesopa_epos/ui/widgets/programmed_bar.dart';

/// The Events & tickets gate at the till: reading the events, what a scan
/// sends and what each answer means, the module switch, and the page itself.
void main() {
  const ticket = {
    'code': 'ABC123',
    'event_title': 'Quiz night',
    'starts_at': '2026-10-11T19:30',
    'type': 'Adult',
    'holder': 'Sarah Hughes',
  };

  EventsRepository api(
    Future<http.Response> Function(http.Request) handler, {
    String? token = 't0k',
  }) => EventsRepository(
    apiBase: 'https://bo.test',
    terminalToken: token,
    client: MockClient(handler),
  );

  group('reading the back office', () {
    test('the events, with their ticket types and counts', () async {
      late http.Request asked;
      final list = await api((req) async {
        asked = req;
        return http.Response(
          jsonEncode({
            'events': [
              {
                'id': 4,
                'title': 'Quiz night',
                'starts_at': '2026-10-11T19:30',
                'ticket_types': [
                  {'id': 1, 'name': 'Adult', 'price_minor': 500},
                  {'id': 2, 'name': 'Child', 'price_minor': '0'},
                ],
                'sold': 40,
                'checked_in': 12,
              },
              {'title': 'no id, not an event'},
            ],
          }),
          200,
        );
      }).events();
      expect(asked.method, 'GET');
      expect(asked.url.path, '/till/events');
      expect(asked.headers['Authorization'], 'Bearer t0k');
      final e = list.single;
      expect(e.title, 'Quiz night');
      expect(e.startsAt, DateTime(2026, 10, 11, 19, 30));
      expect(e.types.map((t) => t.name), ['Adult', 'Child']);
      expect(e.types.first.priceMinor, 500);
      expect(e.sold, 40);
      expect(e.checkedIn, 12);
      expect(e.toCome, 28);
    });

    test('a first scan admits, and sends the code exactly as scanned', () async {
      late Map<String, dynamic> sent;
      late http.Request asked;
      final r = await api((req) async {
        asked = req;
        sent = jsonDecode(req.body) as Map<String, dynamic>;
        return http.Response(jsonEncode({'ok': true, 'ticket': ticket}), 200);
      }).checkIn('VT:ABC123', staff: 'Jo');
      expect(asked.method, 'POST');
      expect(asked.url.path, '/till/events/checkin');
      expect(asked.headers['Authorization'], 'Bearer t0k');
      expect(sent, {'code': 'VT:ABC123', 'staff': 'Jo'});
      expect(r.outcome, CheckinOutcome.admitted);
      expect(r.ticket!.holder, 'Sarah Hughes');
      expect(r.ticket!.type, 'Adult');
    });

    test('a repeat is an answer, with when it was first scanned', () async {
      final r = await api(
        (_) async => http.Response(
          jsonEncode({
            'ok': false,
            'already': true,
            'checked_in_at': '2026-10-11T14:32',
            'ticket': ticket,
            'message': 'Already checked in',
          }),
          200,
        ),
      ).checkIn('ABC123');
      expect(r.outcome, CheckinOutcome.alreadyUsed);
      expect(r.checkedInAt, DateTime(2026, 10, 11, 14, 32));
    });

    test('a code that is no ticket is an answer, not an error', () async {
      final r = await api(
        (_) async => http.Response(
          jsonEncode({'ok': false, 'message': 'Not a valid ticket'}),
          404,
        ),
      ).checkIn('nonsense');
      expect(r.outcome, CheckinOutcome.invalid);
      expect(r.message, 'Not a valid ticket');
    });

    test('a server without the module is a refusal, said out loud', () {
      expect(
        api((_) async => http.Response('Not found', 404)).checkIn('X'),
        throwsA(
          isA<TicketsException>().having((e) => e.status, 'status', 404),
        ),
      );
    });

    test('a refusal carries the server\'s words', () {
      expect(
        api(
          (_) async => http.Response(jsonEncode({'error': 'Bad token'}), 401),
        ).checkIn('X'),
        throwsA(
          isA<TicketsException>()
              .having((e) => e.message, 'message', 'Bad token')
              .having((e) => e.status, 'status', 401),
        ),
      );
    });

    test('no network: NOT checked, never a guess', () {
      expect(
        api((_) async => throw Exception('offline')).checkIn('X'),
        throwsA(
          isA<TicketsException>().having(
            (e) => e.message,
            'message',
            contains('NOT checked'),
          ),
        ),
      );
    });

    test('a till with no terminal token cannot ask', () {
      expect(
        api((_) async => http.Response('{}', 200), token: null).events(),
        throwsA(isA<TicketsException>()),
      );
    });

    test('a bare prefix or blank is not worth sending', () {
      expect(looksLikeTicketCode(''), isFalse);
      expect(looksLikeTicketCode('   '), isFalse);
      expect(looksLikeTicketCode('VT:'), isFalse);
      expect(looksLikeTicketCode('VT:ABC'), isTrue);
      expect(looksLikeTicketCode('abc'), isTrue);
    });
  });

  group('what the gate says', () {
    final now = DateTime(2026, 10, 11, 20);

    test('admit names the holder and the ticket type', () {
      final look = gateLookFor(
        CheckinResult.fromJson({'ok': true, 'ticket': ticket})!,
        now: now,
      );
      expect(look.ok, isTrue);
      expect(look.headline, 'Admit: Sarah Hughes · Adult');
      expect(look.detail, 'Quiz night · Today 19:30');
    });

    test('a repeat says when, in red', () {
      final look = gateLookFor(
        CheckinResult.fromJson({
          'ok': false,
          'already': true,
          'checked_in_at': '2026-10-11T14:32',
          'ticket': ticket,
        })!,
        now: now,
      );
      expect(look.ok, isFalse);
      expect(look.headline, 'Already scanned at 14:32');
    });

    test('a repeat from another day gives the day too', () {
      final look = gateLookFor(
        CheckinResult.fromJson({
          'ok': false,
          'already': true,
          'checked_in_at': '2026-10-10T21:05',
          'ticket': ticket,
        })!,
        now: now,
      );
      expect(look.headline, 'Already scanned at 10 Oct 21:05');
    });

    test('an unknown code', () {
      final look = gateLookFor(
        CheckinResult.fromJson({'ok': false, 'message': 'Not a valid ticket'})!,
        now: now,
      );
      expect(look.ok, isFalse);
      expect(look.headline, 'Not a valid ticket');
    });
  });

  group('the module switch and the key', () {
    setUp(() => SharedPreferences.setMockInitialValues({}));

    test('Tickets is gated by the events module and the terminal token', () {
      final on = TillModules(apiBase: 'x', terminalToken: 't')
        ..debugSet({'events'});
      expect(on.events, isTrue);
      expect(on.memberships, isFalse);
      final noToken = TillModules(apiBase: 'x', terminalToken: null)
        ..debugSet({'events'});
      expect(noToken.events, isFalse);
    });

    test('Tickets sits with the front-desk sections, only when on', () {
      expect(navDestinationsFor(gym: false), same(navDestinations));
      final labels = navDestinationsFor(
        gym: true,
        members: true,
        tickets: true,
      ).map((d) => d.label).toList();
      expect(labels.indexOf('Tickets'), labels.indexOf('Members') + 1);
      expect(
        navDestinationsFor(gym: false, tickets: true).map((d) => d.label),
        contains('Tickets'),
      );
    });

    test('a programmable key opens it', () {
      expect(goSections['go_tickets'], 'Tickets');
    });

    testWidgets('on a bar, the Tickets key is lit while the gate is open', (
      tester,
    ) async {
      ScreenButton go(String k, int col) => ScreenButton(
        row: 0,
        col: col,
        kind: ScreenButtonKind.function,
        functionKey: k,
      );
      final top = TillScreen(
        id: 20,
        name: 'Top',
        surface: ScreenSurface.topBar,
        rows: 1,
        cols: 3,
        buttons: [go('go_sale', 0), go('go_tickets', 1), go('go_reports', 2)],
      );
      Widget host(String section) => ProviderScope(
        child: MaterialApp(
          theme: buildPosTheme(Brightness.light),
          home: Scaffold(
            body: SizedBox(
              width: 600,
              height: 120,
              child: ProgrammedBar(
                bar: top,
                screens: ScreenSet([top]),
                products: const <int, Product>{},
                onSaleScreen: false,
                live: BarLive(
                  currentOrderId: 'o',
                  currentOrder: null,
                  totalMinor: 0,
                  screenName: section,
                  section: section,
                  onSwitchOrder: (_) {},
                ),
                onProduct: (_) {},
                onPage: (_) {},
                onFunction: (_) {},
                onModifier: (_) {},
              ),
            ),
          ),
        ),
      );

      await tester.pumpWidget(host('Tickets'));
      await tester.pumpAndSettle();
      expect(find.text('Tickets'), findsOneWidget);
      expect(find.byType(HereBar), findsOneWidget);

      await tester.pumpWidget(host('Receipts'));
      await tester.pumpAndSettle();
      expect(find.byType(HereBar), findsNothing);
    });
  });

  group('the page', () {
    Widget gate({
      required Set<String> modules,
      required EventsRepository repo,
      bool training = false,
    }) {
      final tm = TillModules(apiBase: 'x', terminalToken: 't')
        ..debugSet(modules);
      return ProviderScope(
        overrides: [
          tillModulesProvider.overrideWithValue(tm),
          eventsRepositoryProvider.overrideWithValue(repo),
          servedByProvider.overrideWithValue('Jo'),
          trainingModeProvider.overrideWithValue(training),
          syncEventsProvider.overrideWith(
            (ref) => const Stream<SyncEvent>.empty(),
          ),
        ],
        child: const MaterialApp(home: Scaffold(body: TicketsPage())),
      );
    }

    EventsRepository server({List<String>? sent}) => api((req) async {
      if (req.method == 'GET') {
        return http.Response(
          jsonEncode({
            'events': [
              {
                'id': 1,
                'title': 'Quiz night',
                'starts_at': '2026-10-11T19:30',
                'ticket_types': const [],
                'sold': 10,
                'checked_in': 3,
              },
            ],
          }),
          200,
        );
      }
      final code = (jsonDecode(req.body) as Map)['code'] as String;
      sent?.add(code);
      if (code == 'VT:GOOD') {
        return http.Response(jsonEncode({'ok': true, 'ticket': ticket}), 200);
      }
      return http.Response(
        jsonEncode({'ok': false, 'message': 'Not a valid ticket'}),
        404,
      );
    });

    testWidgets('switched off, it says how to switch it on', (tester) async {
      await tester.pumpWidget(gate(modules: {}, repo: server()));
      expect(find.text('Events & tickets is switched off'), findsOneWidget);
    });

    testWidgets('a scan and Return admits, and the box is ready again', (
      tester,
    ) async {
      final sent = <String>[];
      await tester.pumpWidget(
        gate(modules: {'events'}, repo: server(sent: sent)),
      );
      await tester.pumpAndSettle();
      expect(find.text('Quiz night'), findsOneWidget);
      expect(find.text('10'), findsOneWidget);

      final box = find.byKey(const ValueKey('ticket-scan'));
      expect(tester.widget<TextField>(box).focusNode!.hasFocus, isTrue);

      await tester.enterText(box, 'VT:GOOD');
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pump();
      await tester.pump();
      expect(sent, ['VT:GOOD']);
      expect(find.text('Admit: Sarah Hughes · Adult'), findsOneWidget);
      expect(tester.widget<TextField>(box).controller!.text, isEmpty);
      expect(tester.widget<TextField>(box).focusNode!.hasFocus, isTrue);

      await tester.enterText(box, 'VT:BAD');
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pump();
      await tester.pump();
      expect(find.text('Not a valid ticket'), findsOneWidget);
      expect(find.textContaining('Admit:'), findsNothing);

      // Clears itself.
      await tester.pump(const Duration(seconds: 7));
      expect(find.text('Not a valid ticket'), findsNothing);
    });

    testWidgets('practice cannot use a real ticket', (tester) async {
      final sent = <String>[];
      await tester.pumpWidget(
        gate(modules: {'events'}, repo: server(sent: sent), training: true),
      );
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('ticket-scan')),
        'VT:GOOD',
      );
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pump();
      expect(sent, isEmpty);
      expect(find.text('Not in training mode'), findsOneWidget);
      await tester.pump(const Duration(seconds: 7));
    });
  });
}
