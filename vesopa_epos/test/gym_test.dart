/// The gym door on the till, and chiefly the half of it that runs with no
/// network.
///
/// WHY THE OFFLINE PATH IS WHAT THIS FILE IS MOSTLY ABOUT
///
/// The online path is thin: post the swipe, draw what comes back. Everything
/// that can go badly wrong is in the other one, because a gym door has to keep
/// working when the broadband does not — and there is nobody standing at it to
/// notice that it has started giving the wrong answer.
///
/// The specific failure this guards against: the till decides in-or-out from
/// its own picture of who is inside, and the server decides the same thing from
/// its rows. If those two ever reach different conclusions for the same swipe,
/// the board shows somebody in the gym who went home an hour ago — which is the
/// number a fire roll call is read off.
///
/// So the rules are asserted here in the same shape gym.js states them: the
/// debounce, the toggle, the expiry that is inclusive of its own date, and the
/// queue that keeps its order.
library;

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vesopa_epos/data/gym.dart';
import 'package:vesopa_epos/data/swipe_cards.dart';
import 'package:vesopa_epos/ui/widgets/nav_rail.dart';

/// A server that is not there. Every request fails, which is exactly the state
/// under test.
http.Client get _offline =>
    MockClient((_) async => throw http.ClientException('no network'));

/// A server that answers the settings and the roster, and nothing else.
http.Client _serving({
  required Map<String, Object?> settings,
  List<Map<String, Object?>> members = const [],
  List<Map<String, Object?>>? board,
  Map<String, Object?>? swipe,
}) => MockClient((request) async {
  final path = request.url.path;
  if (path.endsWith('/till/gym/settings')) {
    return http.Response(jsonEncode(settings), 200);
  }
  if (path.endsWith('/till/gym/members')) {
    return http.Response(jsonEncode(members), 200);
  }
  if (path.endsWith('/till/gym/board')) {
    return http.Response(jsonEncode(board ?? []), 200);
  }
  if (path.endsWith('/till/gym/swipe')) {
    if (swipe == null) return http.Response('{}', 500);
    return http.Response(jsonEncode(swipe), 200);
  }
  return http.Response('{}', 404);
});

Map<String, Object?> _settings({
  bool enabled = true,
  String prefix = '9777',
  int debounce = 45,
  int grace = 0,
  bool slip = true,
  bool refuse = false,
  int soon = 14,
}) => {
  'enabled': enabled ? 1 : 0,
  'gym_prefix': prefix,
  'auto_close_hours': 4,
  'debounce_seconds': debounce,
  'grace_days': grace,
  'expiry_slip': slip ? 1 : 0,
  'refuse_expired': refuse ? 1 : 0,
  'expiring_soon_days': soon,
  'greeting_seconds': 6,
  'show_photo': 1,
};

String _inDays(int days) {
  final at = DateTime.now().add(Duration(days: days));
  return '${at.year.toString().padLeft(4, '0')}-'
      '${at.month.toString().padLeft(2, '0')}-'
      '${at.day.toString().padLeft(2, '0')}';
}

Map<String, Object?> _member({String? expiry}) => {
  'id': 'cust-1',
  'name': 'Sarah Hughes',
  'member_no': 42,
  'card_number': '977700042',
  'membership_expiry': expiry,
};

/// A repository that has already pulled the venue's rules and roster, and is
/// now on its own.
Future<GymRepository> _ready({
  required Map<String, Object?> settings,
  List<Map<String, Object?>> members = const [],
}) async {
  SharedPreferences.setMockInitialValues({});
  final online = GymRepository(
    apiBase: 'https://example.test',
    terminalToken: 'terminal-token',
    client: _serving(settings: settings, members: members),
  );
  await online.sync();

  // A second instance reading the same preferences: the same terminal, later,
  // with the line down. Nothing is carried over in memory.
  final gym = GymRepository(
    apiBase: 'https://example.test',
    terminalToken: 'terminal-token',
    client: _offline,
  );
  await gym.load();
  return gym;
}

void main() {
  // ---------------------------------------------------------------------------
  // The section only exists where the venue has a gym
  // ---------------------------------------------------------------------------

  group('the sections a till shows', () {
    test('are unchanged for a venue with no gym', () {
      // Nearly every venue on this platform is a pub. "If disabled nothing of
      // gym options appears in the till" -- and the cheapest way for that to go
      // wrong is a Gym entry sitting in the rail of every pub in the estate.
      expect(navDestinationsFor(gym: false), same(navDestinations));
    });

    test('gain exactly one when it does', () {
      final with_ = navDestinationsFor(gym: true);
      expect(with_.length, navDestinations.length + 1);
      expect(with_.where((d) => d.label == 'Gym').length, 1);
    });

    test('put the gym after Reports, not last', () {
      // The order of a rail is a claim about how often each thing is used. At a
      // gym the board is looked at far more than Products or Functions, and
      // putting it last files the venue's main screen below two they may never
      // open.
      final labels = [for (final d in navDestinationsFor(gym: true)) d.label];
      expect(labels.indexOf('Gym'), labels.indexOf('Reports') + 1);
      expect(labels.indexOf('Gym'), lessThan(labels.indexOf('Settings')));
    });

    test('keep every section a till already had, in order', () {
      // Adding a row shifts every index after it. The shell routes by label and
      // re-finds its section when the list changes shape -- but only because
      // nothing was dropped or reordered on the way past.
      final labels = [for (final d in navDestinationsFor(gym: true)) d.label];
      final before = [for (final d in navDestinations) d.label];
      expect(labels.where(before.contains).toList(), before);
    });
  });

  // ---------------------------------------------------------------------------
  // Which cards are gym cards
  // ---------------------------------------------------------------------------

  group('what counts as a gym card', () {
    test('the gym prefix classifies ahead of nothing else matching', () {
      const settings = CardSettings(gymPrefix: '9777');
      expect(settings.classify('977700042'), CardKind.gym);
    });

    test('a longer prefix still wins, as it does for every other programme', () {
      // A venue with 9998 for loyalty and 99980 for the gym gets the more
      // specific answer, not whichever was compared first.
      const settings = CardSettings(loyaltyPrefix: '9998', gymPrefix: '99980');
      expect(settings.classify('9998000001'), CardKind.gym);
      expect(settings.classify('9998100001'), CardKind.loyalty);
    });

    test('an empty gym prefix matches nothing at all', () {
      // Without this guard `startsWith('')` makes every card in the building a
      // gym card at a venue that has not set one -- hotel keys, bank cards,
      // another shop's loyalty card.
      const settings = CardSettings();
      expect(settings.classify('977700042'), isNull);
      expect(settings.prefixFor(CardKind.gym), '');
    });

    test('a server that has never heard of the gym reads as no gym', () {
      // A till deployed ahead of its server must not decide it is a gym.
      final settings = CardSettings.fromJson(<String, Object?>{
        'clerk_prefix': '9999',
      });
      expect(settings.gymPrefix, '');

      final gym = GymSettings.fromJson(<String, Object?>{});
      expect(gym.enabled, isFalse);
    });

    test('the prefix survives a round trip through storage', () {
      const before = CardSettings(gymPrefix: '9777');
      final after = CardSettings.fromJson(before.toJson());
      expect(after.gymPrefix, '9777');
      expect(after.classify('977700001'), CardKind.gym);
    });
  });

  // ---------------------------------------------------------------------------
  // The gym being switched off takes the whole thing away
  // ---------------------------------------------------------------------------

  group('a venue with the gym switched off', () {
    test('does not treat a gym card as a gym card', () async {
      final gym = await _ready(settings: _settings(enabled: false));
      expect(gym.isGymCard('977700042'), isFalse);
      expect(gym.live, isFalse);
    });

    test('and a swipe says nothing, so the card falls through', () async {
      final gym = await _ready(settings: _settings(enabled: false));
      final answer = await gym.swipe('977700042');
      expect(answer.outcome, GymOutcome.notGym);
      expect(answer.speaks, isFalse);
    });

    test('a terminal with no token has no gym either', () async {
      SharedPreferences.setMockInitialValues({});
      final gym = GymRepository(
        apiBase: 'https://example.test',
        terminalToken: null,
        client: _offline,
      );
      await gym.load();
      expect(gym.live, isFalse);
      // The door records who was in the building. There is no unauthenticated
      // route for that, and a till commissioned before terminal tokens existed
      // must say so rather than half-work.
      expect(await gym.swipe('977700042'), isA<GymAnswer>());
    });
  });

  // ---------------------------------------------------------------------------
  // In, out, and the double read
  // ---------------------------------------------------------------------------

  group('the door with no network', () {
    test('greets the member by name from the cached roster', () async {
      final gym = await _ready(settings: _settings(), members: [_member()]);
      final answer = await gym.swipe('977700042');

      expect(answer.outcome, GymOutcome.entered);
      expect(answer.memberName, 'Sarah Hughes');
      expect(answer.memberNo, 42);
      // Not "recorded" and nothing else. A paying member standing at a door
      // deserves their own name on the screen whether or not the broadband is
      // up, which is the entire reason the roster is cached.
    });

    test('the same card again signs them out, not in twice', () async {
      final gym = await _ready(
        settings: _settings(debounce: 0),
        members: [_member()],
      );
      expect((await gym.swipe('977700042')).outcome, GymOutcome.entered);
      final out = await gym.swipe('977700042');
      expect(out.outcome, GymOutcome.left);
      expect(out.memberName, 'Sarah Hughes');
    });

    test('a double read is ignored rather than signing them straight out', () async {
      // The single most important rule at an unmanned door. A reader that
      // double-reads would otherwise leave the gym holding nobody and the
      // report holding a three-second visit, with nobody there to notice.
      final gym = await _ready(
        settings: _settings(debounce: 45),
        members: [_member()],
      );
      await gym.swipe('977700042');
      final again = await gym.swipe('977700042');
      expect(again.outcome, GymOutcome.ignored);
      expect(again.memberName, 'Sarah Hughes');

      // And they are still in: a third swipe, still inside the window, is
      // still ignored rather than becoming a departure.
      expect((await gym.swipe('977700042')).outcome, GymOutcome.ignored);
    });

    test('a card nobody holds is said plainly', () async {
      final gym = await _ready(settings: _settings(), members: [_member()]);
      final answer = await gym.swipe('977799999');
      expect(answer.outcome, GymOutcome.unknown);
      expect(answer.cardNumber, '977799999');
    });

    test('with no roster at all it says "recorded" rather than "not you"', () async {
      // The difference matters. "Your card is not recognised" is a thing to
      // tell somebody only when the till actually knows; a terminal that has
      // never synced does not know, and saying it anyway sends a paying member
      // looking for a member of staff who is not there.
      final gym = await _ready(settings: _settings(), members: const []);
      final answer = await gym.swipe('977700042');
      expect(answer.outcome, GymOutcome.queued);
    });
  });

  // ---------------------------------------------------------------------------
  // Memberships that have run out
  // ---------------------------------------------------------------------------

  group('an expired membership', () {
    test('is let in, flagged, and prints a slip', () async {
      final gym = await _ready(
        settings: _settings(),
        members: [_member(expiry: _inDays(-10))],
      );
      final answer = await gym.swipe('977700042');

      expect(answer.outcome, GymOutcome.expired);
      expect(answer.refused, isFalse);
      expect(answer.printSlip, isTrue);
      expect(answer.expiredDays, 10);
    });

    test('is refused where the venue has asked for that', () async {
      final gym = await _ready(
        settings: _settings(refuse: true),
        members: [_member(expiry: _inDays(-2))],
      );
      final answer = await gym.swipe('977700042');
      expect(answer.refused, isTrue);
      expect(answer.printSlip, isTrue);

      // Refused means not inside, so the next swipe is an arrival and not a
      // departure. Getting this wrong would sign a refused member "out" of a
      // gym they were never let into.
      final next = await gym.swipe('977700042');
      expect(next.outcome, GymOutcome.expired);
      expect(next.refused, isTrue);
    });

    test('works ON the expiry date and not the day after', () async {
      final today = await _ready(
        settings: _settings(),
        members: [_member(expiry: _inDays(0))],
      );
      expect((await today.swipe('977700042')).outcome, GymOutcome.entered);

      final yesterday = await _ready(
        settings: _settings(),
        members: [_member(expiry: _inDays(-1))],
      );
      expect((await yesterday.swipe('977700042')).outcome, GymOutcome.expired);
    });

    test('is still valid inside the venue grace period', () async {
      final gym = await _ready(
        settings: _settings(grace: 7),
        members: [_member(expiry: _inDays(-3))],
      );
      final answer = await gym.swipe('977700042');
      expect(answer.outcome, GymOutcome.entered);
      expect(answer.printSlip, isFalse);
    });

    test('a membership with no date is never expired', () async {
      final gym = await _ready(settings: _settings(), members: [_member()]);
      expect((await gym.swipe('977700042')).outcome, GymOutcome.entered);
    });

    test('a warning is given inside the window and not outside it', () async {
      final soon = await _ready(
        settings: _settings(soon: 14),
        members: [_member(expiry: _inDays(4))],
      );
      expect((await soon.swipe('977700042')).expiringInDays, 4);

      final later = await _ready(
        settings: _settings(soon: 14),
        members: [_member(expiry: _inDays(300))],
      );
      expect((await later.swipe('977700042')).expiringInDays, isNull);
    });
  });

  // ---------------------------------------------------------------------------
  // The queue
  // ---------------------------------------------------------------------------

  group('swipes taken with the line down', () {
    test('are queued, one per swipe', () async {
      final gym = await _ready(
        settings: _settings(debounce: 0),
        members: [_member()],
      );
      await gym.swipe('977700042');
      await gym.swipe('977700042');
      expect(await gym.pending(), 2);
    });

    test('are queued even when the card belongs to nobody here', () async {
      // The till may simply be out of date. Throwing the swipe away is the one
      // thing that cannot be undone later.
      final gym = await _ready(settings: _settings(), members: [_member()]);
      await gym.swipe('977799999');
      expect(await gym.pending(), 1);
    });

    test('reach the server oldest first, with the time they happened', () async {
      SharedPreferences.setMockInitialValues({});
      final sent = <Map<String, Object?>>[];

      final gym = GymRepository(
        apiBase: 'https://example.test',
        terminalToken: 'terminal-token',
        client: MockClient((request) async {
          if (request.url.path.endsWith('/till/gym/settings')) {
            return http.Response(jsonEncode(_settings(debounce: 0)), 200);
          }
          if (request.url.path.endsWith('/till/gym/members')) {
            return http.Response(jsonEncode([_member()]), 200);
          }
          if (request.url.path.endsWith('/till/gym/swipe')) {
            sent.add(jsonDecode(request.body) as Map<String, Object?>);
            return http.Response(jsonEncode({'outcome': 'in'}), 200);
          }
          return http.Response('{}', 404);
        }),
      );
      await gym.sync();
      sent.clear();

      // Two swipes taken offline, then the link comes back.
      final offlineGym = GymRepository(
        apiBase: 'https://example.test',
        terminalToken: 'terminal-token',
        client: _offline,
      );
      await offlineGym.load();
      await offlineGym.swipe('977700042');
      await Future<void>.delayed(const Duration(milliseconds: 20));
      await offlineGym.swipe('977700042');

      await gym.flush();

      expect(sent.length, 2);
      expect(await gym.pending(), 0);

      // Order is not decoration. The server decides in from out by looking at
      // whether a visit was open at the moment of the swipe, so a departure
      // that overtook its own arrival would be recorded as an arrival.
      final first = DateTime.parse(sent[0]['at']! as String);
      final second = DateTime.parse(sent[1]['at']! as String);
      expect(first.isAfter(second), isFalse);

      // And each carries an id of its own, which is what makes the server able
      // to recognise a replay rather than opening a second visit.
      expect(sent[0]['swipe_id'], isNot(sent[1]['swipe_id']));
      expect((sent[0]['swipe_id']! as String).length, greaterThan(8));
    });

    test('a swipe the server will never accept is dropped, not retried for ever',
        () async {
      SharedPreferences.setMockInitialValues({});
      final gym = GymRepository(
        apiBase: 'https://example.test',
        terminalToken: 'terminal-token',
        client: MockClient((request) async {
          if (request.url.path.endsWith('/till/gym/settings')) {
            return http.Response(jsonEncode(_settings()), 200);
          }
          if (request.url.path.endsWith('/till/gym/members')) {
            return http.Response(jsonEncode([_member()]), 200);
          }
          // The venue switched the gym off while this was sitting in the queue.
          return http.Response('{"error":"no gym"}', 404);
        }),
      );
      await gym.sync();

      final offlineGym = GymRepository(
        apiBase: 'https://example.test',
        terminalToken: 'terminal-token',
        client: _offline,
      );
      await offlineGym.load();
      await offlineGym.swipe('977700042');
      expect(await offlineGym.pending(), 1);

      await gym.flush();
      // A queue that cannot drain is a queue that grows until it is the reason
      // the till is slow, and there is nowhere for this one to go.
      expect(await gym.pending(), 0);
    });

    test('a server that is merely broken keeps the queue', () async {
      SharedPreferences.setMockInitialValues({});
      final gym = GymRepository(
        apiBase: 'https://example.test',
        terminalToken: 'terminal-token',
        client: MockClient((request) async {
          if (request.url.path.endsWith('/till/gym/settings')) {
            return http.Response(jsonEncode(_settings()), 200);
          }
          if (request.url.path.endsWith('/till/gym/members')) {
            return http.Response(jsonEncode([_member()]), 200);
          }
          return http.Response('{"error":"boom"}', 500);
        }),
      );
      await gym.sync();

      final offlineGym = GymRepository(
        apiBase: 'https://example.test',
        terminalToken: 'terminal-token',
        client: _offline,
      );
      await offlineGym.load();
      await offlineGym.swipe('977700042');

      await gym.flush();
      expect(await gym.pending(), 1, reason: 'a 500 is worth trying again');
    });
  });

  // ---------------------------------------------------------------------------
  // What the server says wins
  // ---------------------------------------------------------------------------

  group('with the link up', () {
    test('the server decides, and the local picture follows it', () async {
      SharedPreferences.setMockInitialValues({});
      final gym = GymRepository(
        apiBase: 'https://example.test',
        terminalToken: 'terminal-token',
        client: _serving(
          settings: _settings(),
          members: [_member()],
          swipe: {
            'outcome': 'in',
            'member_name': 'Sarah Hughes',
            'member_no': 42,
            'print_slip': false,
          },
        ),
      );
      await gym.sync();

      final answer = await gym.swipe('977700042');
      expect(answer.outcome, GymOutcome.entered);
      expect(answer.memberName, 'Sarah Hughes');
      // Nothing was queued: it went straight across.
      expect(await gym.pending(), 0);
    });

    test('an expired answer from the server asks for the slip', () async {
      SharedPreferences.setMockInitialValues({});
      final gym = GymRepository(
        apiBase: 'https://example.test',
        terminalToken: 'terminal-token',
        client: _serving(
          settings: _settings(),
          members: [_member()],
          swipe: {
            'outcome': 'expired',
            'member_name': 'Sarah Hughes',
            'membership_expiry': '2026-01-31',
            'expired_days': 40,
            'refused': false,
            'print_slip': true,
          },
        ),
      );
      await gym.sync();

      final answer = await gym.swipe('977700042');
      expect(answer.outcome, GymOutcome.expired);
      expect(answer.printSlip, isTrue);
      expect(answer.expiredDays, 40);
      expect(answer.membershipExpiry, '2026-01-31');
    });

    test('the board overwrites who this till thinks is inside', () async {
      // The mirror exists only to answer an offline swipe. Letting it drift
      // from the server's answer is the one way it could do harm, so a board
      // read replaces it outright.
      SharedPreferences.setMockInitialValues({});
      final gym = GymRepository(
        apiBase: 'https://example.test',
        terminalToken: 'terminal-token',
        client: _serving(
          settings: _settings(debounce: 0),
          members: [_member()],
          board: [
            {
              'id': 7,
              'member_name': 'Sarah Hughes',
              'card_number': '977700042',
              'entered_at': DateTime.now()
                  .subtract(const Duration(minutes: 30))
                  .toIso8601String(),
              'left_at': null,
              'in_now': 1,
              'minutes': 30,
            },
          ],
        ),
      );
      await gym.sync();
      final visits = await gym.board();
      expect(visits, isNotNull);
      expect(visits!.single.inGym, isTrue);
      expect(visits.single.memberName, 'Sarah Hughes');

      // The server said she is inside, so the next offline swipe is a
      // departure -- even though this instance never saw her arrive.
      final offlineGym = GymRepository(
        apiBase: 'https://example.test',
        terminalToken: 'terminal-token',
        client: _offline,
      );
      await offlineGym.load();
      expect((await offlineGym.swipe('977700042')).outcome, GymOutcome.left);
    });

    test('a board that cannot be read is null, not an empty gym', () async {
      SharedPreferences.setMockInitialValues({});
      final gym = GymRepository(
        apiBase: 'https://example.test',
        terminalToken: 'terminal-token',
        client: _offline,
      );
      await gym.load();
      // "Nobody is here" and "we cannot say who is here" are not the same
      // sentence, and only one of them means somebody should go and look.
      expect(await gym.board(), isNull);
    });
  });

  // ---------------------------------------------------------------------------
  // Settings that arrive badly
  // ---------------------------------------------------------------------------

  group('settings that arrive badly', () {
    test('are clamped rather than believed', () {
      final settings = GymSettings.fromJson(<String, Object?>{
        'enabled': 1,
        'debounce_seconds': 99999,
        'auto_close_hours': 0,
        'greeting_seconds': 0,
        'grace_days': -5,
      });
      expect(settings.debounceSeconds, 600);
      expect(settings.autoCloseHours, 1);
      // A greeting that never clears would leave a stranger's name and face on
      // a screen facing the room.
      expect(settings.greetingSeconds, 2);
      expect(settings.graceDays, 0);
    });

    test('a prefix with punctuation in it is reduced to digits', () {
      final settings = GymSettings.fromJson(<String, Object?>{
        'gym_prefix': ';97 77?',
      });
      expect(settings.gymPrefix, '9777');
    });

    test('survive a round trip through storage unchanged', () {
      const before = GymSettings(
        enabled: true,
        gymPrefix: '9777',
        debounceSeconds: 30,
        refuseExpired: true,
      );
      expect(GymSettings.fromJson(before.toJson()), before);
    });
  });
}
