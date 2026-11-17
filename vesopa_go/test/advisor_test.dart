import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vesopa_go/advisor/advisor_state.dart';
import 'package:vesopa_go/advisor/ui/advisor_page.dart';
import 'package:vesopa_go/advisor/ui/advisor_widgets.dart';
import 'package:vesopa_go/data/api.dart';
import 'package:vesopa_go/data/demo_venue.dart';
import 'package:vesopa_go/data/models.dart';
import 'package:vesopa_go/data/session.dart';
import 'package:vesopa_go/ui/theme.dart';

/// Vesopa AI on Go, against the answers the server really sends: the
/// fixtures are written by vesopa_server/test/go-advisor.test.js
/// (ADVISOR_FIXTURES=../vesopa_go/test/fixtures/advisor node test/go-advisor.test.js).
String fixture(String name) => File('test/fixtures/advisor/$name').readAsStringSync();

const venue = Venue(name: 'The Bridge', office: 'the-bridge@vesopa.co.uk', mode: VenueMode.connected);
const owner = Clerk(id: 1, name: 'Owner Olive', pin: '1111');
const ben = Clerk(id: 2, name: 'Bar Ben', pin: '2222', group: 'Bar', permissions: '{"grouped":true}');

/// A back office that answers Vesopa AI from the fixtures and remembers the calls.
class FakeOffice {
  FakeOffice({this.invited = true});
  bool invited;
  final calls = <http.Request>[];

  http.Client get client => MockClient((req) async {
        calls.add(req);
        final path = req.url.path;
        if (path == '/api/go/ai/session') {
          final clerk = (jsonDecode(req.body) as Map)['clerk_id'];
          if (clerk == 2 && !invited) return http.Response(fixture('not_invited.json'), 403);
          return http.Response(fixture(clerk == 2 ? 'redeemed.json' : 'session.json'), 200);
        }
        if (path == '/api/go/ai/invites/redeem') {
          invited = true;
          return http.Response(fixture('redeemed.json'), 200);
        }
        if (path == '/api/go/ai/briefing') return http.Response(fixture('briefing.json'), 200);
        if (path == '/api/go/ai/records') return http.Response(fixture('records_orders.json'), 200);
        if (path == '/api/go/ai/invites') return http.Response(fixture('invites.json'), 200);
        if (path == '/api/go/ai/ask') {
          final b = jsonDecode(req.body) as Map;
          final intent = b['intent'] as String? ?? switch ('${b['question']}'.toLowerCase()) {
            final q when q.contains('stock') => 'stock',
            final q when q.contains('branch') => 'branches',
            final q when q.contains('team') => 'staff',
            final q when q.contains('profit') => 'profit',
            final q when q.contains('why') => 'why',
            _ => 'summary',
          };
          final file = switch (intent) {
            'why_change' || 'why' || 'hours' => 'ask_why.json',
            'stock' || 'stock_movers' => 'ask_stock.json',
            'branches' => 'ask_branches.json',
            'staff' => 'ask_staff.json',
            'profit' || 'top_products' || 'loss_makers' => 'ask_profit.json',
            _ => 'ask_summary.json',
          };
          return http.Response(fixture(file), 200, headers: {'content-type': 'application/json; charset=utf-8'});
        }
        return http.Response('{"error":"not here"}', 404);
      });
}

Future<ProviderContainer> signedOn(WidgetTester tester, FakeOffice office, {Clerk clerk = owner, Size size = const Size(390, 844), bool demo = false}) async {
  FlutterSecureStorage.setMockInitialValues({});
  SharedPreferences.setMockInitialValues({});
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final api = TapApi(base: 'https://office.test', client: office.client)
    ..token = 'terminal'
    ..office = venue.office;
  final box = ProviderContainer(overrides: [apiProvider.overrideWithValue(api)]);
  addTearDown(box.dispose);
  box.read(tapProvider);
  await tester.runAsync(() => Future<void>.delayed(Duration.zero));
  final tap = box.read(tapProvider.notifier);
  if (demo) {
    tap.startDemo();
    tap.signOn(demoClerks.first);
  } else {
    tap.debugLoad(const {}, venue: venue, clerk: clerk);
  }
  await tester.pumpWidget(UncontrolledProviderScope(
    container: box,
    child: MaterialApp(theme: Tp.theme(Brightness.light), darkTheme: Tp.theme(Brightness.dark), home: const Scaffold(body: AdvisorPage())),
  ));
  return box;
}

Finder tabNamed(String name) => find.descendant(of: find.byType(Tab), matching: find.text(name));

/// Let the fake office answer and the page settle (the charts animate).
Future<void> settle(WidgetTester tester) async {
  for (var i = 0; i < 6; i++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
    await tester.pump(const Duration(milliseconds: 300));
  }
}

void main() {
  test('Vesopa AI calls the routes the server mounts, with the session in its own header', () async {
    final office = FakeOffice();
    final api = TapApi(base: 'https://office.test', client: office.client)..token = 't';
    await api.aiSession(clerkId: 1, pin: '1111');
    await api.aiBriefing('S', site: 2);
    await api.aiAsk('S', question: 'How much today?', previous: {'intent': 'summary', 'period': 'today'});
    await api.aiRecords('S', source: 'orders', period: 'today');
    await api.aiInvites('S');
    expect([for (final c in office.calls) '${c.method} ${c.url.path}'], [
      'POST /api/go/ai/session',
      'GET /api/go/ai/briefing',
      'POST /api/go/ai/ask',
      'GET /api/go/ai/records',
      'GET /api/go/ai/invites',
    ]);
    expect(office.calls.first.headers['X-Vesopa-AI'], isNull, reason: 'opening a session needs only the PIN');
    expect(office.calls.skip(1).every((c) => c.headers['X-Vesopa-AI'] == 'S'), isTrue);
    expect(office.calls[0].headers['Authorization'], 'Bearer t');
    expect(office.calls[1].url.queryParameters['site'], '2');
    final ask = jsonDecode(office.calls[2].body) as Map;
    expect(ask['previous'], {'intent': 'summary', 'period': 'today'});
    expect(ask.containsKey('intent'), isFalse, reason: 'unset fields are not sent');
  });

  test('money reads with thousands, values by kind', () {
    expect(aiMoney(1234567), '£12,345.67');
    expect(aiMoney(-500), '-£5.00');
    expect(formatValue(27.3, 'pct'), '27.3%');
    expect(formatValue(2, 'days'), '2 d');
    expect(formatValue(null, 'money'), '–');
  });

  testWidgets('a manager taps Vesopa AI and is straight into the briefing', (tester) async {
    final office = FakeOffice();
    final box = await signedOn(tester, office);
    await settle(tester);
    expect(office.calls.first.url.path, '/api/go/ai/session');
    expect(jsonDecode(office.calls.first.body), {'clerk_id': 1, 'pin': '1111'}, reason: 'the signed-on PIN, no typing');
    expect(box.read(advisorProvider).phase, AdvisorPhase.ready);
    expect(find.text('Don\'t just see your business. Understand it.'), findsOneWidget);
    expect(find.textContaining('Owner Olive'), findsOneWidget);
    expect(find.text('Today so far'), findsOneWidget);
    expect(find.text('Yesterday'), findsWidgets);
    expect(find.text('Revenue'), findsWidgets);
    // Every figure says what it rests on.
    await tester.dragUntilVisible(find.text('View data'), find.byType(ListView).first, const Offset(0, -300));
    await tester.pump();
    expect(find.textContaining('All sites'), findsWidgets);
    expect(find.textContaining('Latest sale received 2026-11-17 14:20'), findsOneWidget);
    await tester.tap(find.text('View data'));
    await settle(tester);
    expect(office.calls.map((c) => c.url.path), contains('/api/go/ai/records'));
    expect(find.text('Bar till'), findsOneWidget, reason: 'the sale behind the figure, by till');
    expect(tester.takeException(), isNull);
  });

  testWidgets('ask a question: the answer, why, the charts, follow-ups, and the history is kept', (tester) async {
    final office = FakeOffice();
    final box = await signedOn(tester, office);
    await settle(tester);
    await tester.tap(tabNamed('Ask'));
    await settle(tester);
    expect(find.text('Ask about your business'), findsOneWidget);
    await tester.tap(find.text('Why did sales drop yesterday?'));
    await settle(tester);
    // The model's wording first, the figures' own sentence under it, staff names put back.
    expect(find.textContaining('Shift Sam took less'), findsOneWidget);
    expect(find.textContaining('Revenue was £800.00, £300.00 (27.3%) lower'), findsOneWidget);
    expect(find.text('What made the difference'), findsOneWidget);
    expect(find.text('Number of sales'), findsOneWidget);
    final turns = box.read(advisorChatProvider);
    expect(turns.single.answer?['intent'], 'why_change');
    expect(box.read(advisorChatProvider.notifier).previous, {'intent': 'why_change', 'period': 'today'});
    // Follow-up carries what was asked before.
    await tester.scrollUntilVisible(find.text('How did the team do?'), 300, scrollable: find.byType(Scrollable).at(1));
    await tester.tap(find.text('How did the team do?'));
    await settle(tester);
    final follow = jsonDecode(office.calls.where((c) => c.url.path == '/api/go/ai/ask').last.body) as Map;
    expect(follow['previous'], {'intent': 'why_change', 'period': 'today'});
    expect(box.read(advisorChatProvider).length, 2);
    final kept = (await SharedPreferences.getInstance()).getString('vesopa_ai_chat:${venue.office}:1');
    expect(kept, isNotNull, reason: 'kept on this device');
    expect(tester.takeException(), isNull);
  });

  testWidgets('every overview tab draws at phone width without overflow', (tester) async {
    final office = FakeOffice();
    await signedOn(tester, office, size: const Size(360, 740));
    await settle(tester);
    for (final tab in ['Sales', 'Profit', 'Stock', 'People']) {
      await tester.tap(tabNamed(tab));
      await settle(tester);
      expect(tester.takeException(), isNull, reason: tab);
    }
    expect(find.textContaining('Swansea performed best'), findsOneWidget);
    expect(find.text('Sales by employee'), findsOneWidget);
  });

  testWidgets('desktop: two columns and nothing overflows', (tester) async {
    final office = FakeOffice();
    await signedOn(tester, office, size: const Size(1440, 900));
    await settle(tester);
    expect(find.byType(AiColumns), findsWidgets);
    await tester.tap(tabNamed('Profit'));
    await settle(tester);
    expect(find.textContaining('Gross profit £326.67'), findsWidgets);
    expect(tester.takeException(), isNull);
  });

  testWidgets('somebody not invited is told how, and an emailed code lets them in', (tester) async {
    final office = FakeOffice(invited: false);
    final box = await signedOn(tester, office, clerk: ben);
    await settle(tester);
    expect(find.text('Vesopa AI is for managers'), findsOneWidget);
    await tester.tap(find.text('I have an invite code'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'abcd2345');
    await tester.tap(find.text('Use code'));
    await settle(tester);
    final redeem = office.calls.firstWhere((c) => c.url.path == '/api/go/ai/invites/redeem');
    expect(jsonDecode(redeem.body), {'clerk_id': 2, 'pin': '2222', 'code': 'abcd2345'});
    final s = box.read(advisorProvider);
    expect(s.phase, AdvisorPhase.ready);
    expect(s.session!.role, 'invited');
    expect(s.site, 2, reason: 'their invite is for one site, and it is locked to it');
    expect(find.text('Neath'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('the demo has no business behind it, so Vesopa AI says so and asks nothing', (tester) async {
    final office = FakeOffice();
    await signedOn(tester, office, demo: true);
    await settle(tester);
    expect(find.text('Vesopa AI needs a real venue'), findsOneWidget);
    expect(office.calls, isEmpty);
  });

  testWidgets('managers invite by email and see who has access', (tester) async {
    final office = FakeOffice();
    await signedOn(tester, office);
    await settle(tester);
    await tester.tap(find.byTooltip('More'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Invite people'));
    await settle(tester);
    expect(find.text('Invite by email'), findsOneWidget);
    expect(find.text('Bar Ben'), findsOneWidget);
    expect(find.textContaining('Has access'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
