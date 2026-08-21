@Tags(['live'])
library;

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos_kitchen/config/constants.dart';
import 'package:vesopa_epos_kitchen/data/kitchen_api.dart';

/// Signing in to the real back office, through the app's own client.
///
/// Opt-in, and off by default — it talks to a live server, so it has no place
/// in the suite that runs on every change. It exists because "the credentials
/// work" is not something curl can answer on this app's behalf: what matters
/// is that `KitchenApi` parses what the server actually sends, with the real
/// TLS, the real 8-second timeout and the real JSON, rather than a fixture
/// somebody wrote by hand to match what they assumed.
///
///     flutter test --tags live \
///       --dart-define=LIVE_OFFICE=venue@example.com \
///       --dart-define=LIVE_USER=grill \
///       --dart-define=LIVE_PASSWORD=...
///
/// Skipped, not failed, when those are unset: a missing password is somebody
/// running the whole suite, not a broken kitchen.
void main() {
  const office = String.fromEnvironment('LIVE_OFFICE');
  const user = String.fromEnvironment('LIVE_USER');
  const password = String.fromEnvironment('LIVE_PASSWORD');
  final configured = office.isNotEmpty && user.isNotEmpty && password.isNotEmpty;

  group('against ${Api.resolvedBase}', () {
    late KitchenApi api;

    setUp(() => api = KitchenApi(apiBase: Api.resolvedBase));

    test('a kitchen login is accepted and returns the venue', () async {
      final result = await api.signIn(
        office: office,
        username: user,
        password: password,
      );

      expect(result.token, isNotEmpty);
      expect(result.profile.office, office);
      // The venue's name is what the header and the info panel show. A screen
      // that signs in and cannot say where it is has not really signed in.
      expect(result.profile.officeName, isNotNull);
      stdout.writeln(
        '  signed in: ${result.profile.officeName} '
        '(${result.profile.screens.length} named screen'
        '${result.profile.screens.length == 1 ? '' : 's'}, '
        'stations ${result.profile.stationNames})',
      );
    });

    test('the board is readable, and the clock is close to ours', () async {
      await api.signIn(office: office, username: user, password: password);
      final snapshot = await api.board(
        recallWindow: BoardDefaults.recallWindow,
      );

      // Every "8 minutes ago" on the board is drawn from the server's clock
      // against this machine's. An hour of skew paints a board entirely red.
      // `serverTime` is already converted to this machine's zone on the way
      // in, so both sides of this are local.
      final skew = DateTime.now().difference(snapshot.serverTime).abs();
      expect(
        skew,
        lessThan(const Duration(minutes: 5)),
        reason: 'server clock is $skew away from this machine',
      );
      stdout.writeln(
        '  board: ${snapshot.tickets.length} ticket(s), clock skew $skew',
      );
    });

    test('a wrong password is refused, and says so readably', () async {
      await expectLater(
        api.signIn(office: office, username: user, password: 'not-the-one'),
        throwsA(
          isA<KitchenApiError>().having(
            (e) => e.message,
            'message',
            contains('not right'),
          ),
        ),
      );
    });

    test('an unknown venue is refused the same way', () async {
      // The same message for a wrong venue as for a wrong password: telling
      // somebody standing at the screen which half was wrong tells them which
      // logins exist.
      await expectLater(
        api.signIn(
          office: 'nobody@nowhere.invalid',
          username: user,
          password: password,
        ),
        throwsA(isA<KitchenApiError>()),
      );
    });
  }, skip: configured ? false : 'set LIVE_OFFICE, LIVE_USER and LIVE_PASSWORD');
}
