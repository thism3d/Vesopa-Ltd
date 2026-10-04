import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vesopa_epos/data/gym.dart';
import 'package:vesopa_epos/data/local/database.dart';
import 'package:vesopa_epos/data/membership.dart';
import 'package:vesopa_epos/data/memberships_api.dart';
import 'package:vesopa_epos/ui/gym_greeting.dart';
import 'package:vesopa_epos/ui/widgets/nav_rail.dart';

/// The Memberships module at the till (1.13): which plan a fee line is for,
/// what the settle path posts, reading the server's shapes, the module switch,
/// and the gym door's new refusals.
void main() {
  OrderLine line(
    int plu, {
    int price = 1000,
    String? notes,
    double qty = 1,
    int discount = 0,
  }) => OrderLine(
    id: 'l$plu$notes',
    orderId: 'o1',
    pluId: plu,
    name: 'x',
    quantity: qty,
    unitPriceMinor: price,
    taxPercentage: 0,
    lineDiscountMinor: discount,
    notes: notes,
  );

  group('a plan fee line says what it is for', () {
    test('a join round-trips through the note', () {
      final note = membershipLineNote(join: true, planId: 3, planName: 'Gold');
      expect(note, 'Joins Gold [plan 3]');
      final intent = membershipLineIntent(note)!;
      expect(intent.join, isTrue);
      expect(intent.planId, 3);
    });

    test('a renewal round-trips, even with brackets in the plan name', () {
      final note = membershipLineNote(
        join: false,
        planId: 12,
        planName: 'Family [x2]',
      );
      final intent = membershipLineIntent(note)!;
      expect(intent.join, isFalse);
      expect(intent.planId, 12);
    });

    test('an ordinary note is not a plan', () {
      expect(membershipLineIntent('no ice'), isNull);
      expect(membershipLineIntent(null), isNull);
    });
  });

  group('what a paid bill posts', () {
    const renewing = {membershipRenewalPlu, 77};

    test('a join with its joining fee is one join for the whole amount', () {
      final note = membershipLineNote(join: true, planId: 5, planName: 'Gym');
      final s = membershipSettlement([
        line(membershipRenewalPlu, price: 3000, notes: note),
        line(membershipRenewalPlu, price: 1000, notes: note),
        line(42, price: 250),
      ], renewing: renewing);
      expect(s.joins, isTrue);
      expect(s.joinPlanId, 5);
      expect(s.amountMinor, 4000);
    });

    test('the old renewal line is a renewal, after its discount', () {
      final s = membershipSettlement([
        line(77, price: 2000, discount: 500),
        line(42, price: 250),
      ], renewing: renewing);
      expect(s.joins, isFalse);
      expect(s.amountMinor, 1500);
    });

    test('a class drop-in is never membership money', () {
      expect(renewing.contains(classDropInPlu), isFalse);
      final s = membershipSettlement([
        line(classDropInPlu, price: 600),
      ], renewing: renewing);
      expect(s.amountMinor, 0);
    });
  });

  group('reading the back office', () {
    test('a member, with plan, family and history', () {
      final m = Member.fromJson({
        'id': 'c1',
        'name': 'Sarah Hughes',
        'member_number': '00042',
        'state': 'frozen',
        'membership_expiry': '2027-03-31',
        'frozen_from': '2026-10-01',
        'frozen_until': '2026-10-14',
        'days_left': 178,
        'freeze_days_used': 14,
        'plan': {
          'id': 3,
          'name': 'Family',
          'fee_minor': 4500,
          'term_months': 1,
          'joining_fee_minor': 2000,
          'family_size': 4,
          'freeze_days_per_year': 30,
          'includes_gym': true,
          'includes_classes': 1,
        },
        'family': [
          {'id': 'c1', 'name': 'Sarah Hughes', 'state': 'frozen', 'payer': true},
          {'id': 'c2', 'name': 'Tom Hughes', 'state': 'frozen', 'payer': false},
        ],
        'history': [
          {
            'kind': 'freeze',
            'expiry_after': '2027-03-31',
            'created_at': '2026-10-01T09:00:00.000Z',
          },
        ],
      })!;
      expect(m.state, MemberState.frozen);
      expect(m.plan!.joinTotalMinor, 6500);
      expect(m.plan!.includesClasses, isTrue);
      expect(m.expiry, DateTime(2027, 3, 31));
      expect(m.freezeDaysLeft, 16);
      expect(m.family, hasLength(2));
      expect(m.familyHasRoom, isTrue);
      expect(m.history.single.kind, 'freeze');
    });

    test('a class from the list and from the single read count the same', () {
      final listed = ClassSession.fromJson({
        'id': 9,
        'name': 'Spin',
        'starts_at': '2026-10-04T18:30',
        'capacity': 12,
        'booked': 2,
        'attended': 1,
        'waiting': 0,
        'cancelled': false,
        'drop_in_minor': 600,
      })!;
      final single = ClassSession.fromJson({
        'id': 9,
        'name': 'Spin',
        'starts_at': '2026-10-04 18:30:00',
        'capacity': 12,
        'drop_in_minor': 600,
        'bookings': [
          {'customer_id': 'a', 'name': 'A', 'status': 'attended'},
          {'customer_id': 'b', 'name': 'B', 'status': 'booked'},
          {'customer_id': 'c', 'name': 'C', 'status': 'waitlist'},
        ],
      })!;
      expect(listed.startsAt, DateTime(2026, 10, 4, 18, 30));
      expect(single.startsAt, DateTime(2026, 10, 4, 18, 30));
      expect(single.booked, listed.booked);
      expect(single.attended, listed.attended);
      expect(single.waiting, 1);
      expect(single.spaces, 10);
    });

    test('a refusal that wants a drop-in is recognised', () {
      expect(
        needsDropIn(
          MembershipsException(
            'Not covered by a membership. Book as a drop-in (6.00).',
            status: 409,
          ),
        ),
        isTrue,
      );
      expect(
        needsDropIn(
          MembershipsException('This class is for members only.', status: 409),
        ),
        isFalse,
      );
    });

    test('joining sends the plan, the customer and what was paid', () async {
      late Map<String, dynamic> sent;
      late Uri asked;
      final api = MembershipsRepository(
        apiBase: 'https://bo.test',
        terminalToken: 't0k',
        client: MockClient((req) async {
          asked = req.url;
          expect(req.headers['Authorization'], 'Bearer t0k');
          sent = jsonDecode(req.body) as Map<String, dynamic>;
          return http.Response(
            jsonEncode({'id': 'c1', 'name': 'Sarah', 'state': 'active'}),
            201,
          );
        }),
      );
      final m = await api.join(
        schemeId: 3,
        customerId: 'c1',
        amountMinor: 6500,
        staff: 'Jo',
      );
      expect(asked.path, '/till/memberships/members');
      expect(sent, {
        'scheme_id': 3,
        'customer_id': 'c1',
        'amount_minor': 6500,
        'staff': 'Jo',
      });
      expect(m.state, MemberState.active);
    });

    test("the server's refusal is what the clerk is told", () async {
      final api = MembershipsRepository(
        apiBase: 'https://bo.test',
        terminalToken: 't0k',
        client: MockClient(
          (_) async => http.Response(
            jsonEncode({'error': 'Gold does not allow freezing.'}),
            409,
          ),
        ),
      );
      expect(
        () => api.freeze(
          'c1',
          from: DateTime(2026, 10, 4),
          until: DateTime(2026, 10, 10),
        ),
        throwsA(
          isA<MembershipsException>()
              .having((e) => e.message, 'message', 'Gold does not allow freezing.')
              .having((e) => e.status, 'status', 409),
        ),
      );
    });
  });

  group('the module switch', () {
    setUp(() => SharedPreferences.setMockInitialValues({}));

    test('reads /till/modules and remembers it for an offline start', () async {
      final modules = TillModules(
        apiBase: 'https://bo.test',
        terminalToken: 't0k',
        client: MockClient(
          (req) async => http.Response(
            jsonEncode({
              'on': ['gym_door', 'memberships'],
            }),
            200,
          ),
        ),
      );
      expect(modules.memberships, isFalse);
      expect(await modules.sync(), isTrue);
      expect(modules.memberships, isTrue);

      final offline = TillModules(
        apiBase: 'https://bo.test',
        terminalToken: 't0k',
        client: MockClient((_) async => throw Exception('no network')),
      );
      await offline.load();
      expect(await offline.sync(), isFalse);
      expect(offline.memberships, isTrue);
    });

    test('a till with no terminal token shows no Members', () {
      final modules = TillModules(apiBase: 'x', terminalToken: null)
        ..debugSet({'memberships'});
      expect(modules.memberships, isFalse);
    });

    test('Members sits beside the gym, and only when it is on', () {
      expect(
        navDestinationsFor(gym: false, members: false),
        same(navDestinations),
      );
      final both = navDestinationsFor(gym: true, members: true);
      final labels = both.map((d) => d.label).toList();
      expect(labels.indexOf('Members'), labels.indexOf('Gym') + 1);
      expect(labels.indexOf('Gym'), labels.indexOf('Reports') + 1);
      expect(
        navDestinationsFor(gym: false, members: true).length,
        navDestinations.length + 1,
      );
    });
  });

  group('the gym door says why', () {
    Future<WidgetRef> door(WidgetTester tester) async {
      late WidgetRef captured;
      await tester.pumpWidget(
        ProviderScope(
          child: MaterialApp(
            home: Consumer(
              builder: (context, ref, _) {
                captured = ref;
                return const Scaffold(
                  body: Stack(
                    children: [GymGreetingLayer(apiBase: 'https://x.test')],
                  ),
                );
              },
            ),
          ),
        ),
      );
      return captured;
    }

    testWidgets('a frozen membership is not called expired', (tester) async {
      final ref = await door(tester);
      ref
          .read(gymGreetingProvider.notifier)
          .show(
            const GymAnswer(
              outcome: GymOutcome.expired,
              memberName: 'Sarah Hughes',
              refused: true,
              reason: 'frozen',
              message: 'Membership frozen until 2026-11-01',
            ),
            seconds: 6,
          );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.textContaining('membership is frozen'), findsOneWidget);
      expect(find.textContaining('1 November 2026'), findsOneWidget);
      expect(find.textContaining('run out'), findsNothing);
      await tester.pump(const Duration(seconds: 7));
    });

    testWidgets('a plan without the gym says so', (tester) async {
      final ref = await door(tester);
      ref
          .read(gymGreetingProvider.notifier)
          .show(
            const GymAnswer(
              outcome: GymOutcome.expired,
              memberName: 'Tom',
              refused: true,
              reason: 'no_gym',
              message: 'Classes only does not include the gym',
            ),
            seconds: 6,
          );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      expect(
        find.textContaining('Classes only does not include the gym'),
        findsOneWidget,
      );
      await tester.pump(const Duration(seconds: 7));
    });

    test('the refusal is read off the swipe answer', () async {
      SharedPreferences.setMockInitialValues({});
      final gym = GymRepository(
        apiBase: 'https://bo.test',
        terminalToken: 't0k',
        client: MockClient((req) async {
          if (req.url.path.endsWith('/settings')) {
            return http.Response(
              jsonEncode({'enabled': true, 'gym_prefix': '777'}),
              200,
            );
          }
          if (req.url.path.endsWith('/members')) {
            return http.Response('[]', 200);
          }
          return http.Response(
            jsonEncode({
              'outcome': 'expired',
              'refused': true,
              'reason': 'pending',
              'message': 'Membership waiting for approval',
              'member_name': 'Ann',
            }),
            200,
          );
        }),
      );
      await gym.sync();
      final a = await gym.swipe('7770001');
      expect(a.outcome, GymOutcome.expired);
      expect(a.refusedForState, isTrue);
      expect(a.reason, 'pending');
      expect(a.message, 'Membership waiting for approval');
    });
  });
}
