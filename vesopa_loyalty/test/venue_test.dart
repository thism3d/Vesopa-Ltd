import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_loyalty/data/api.dart';
import 'package:vesopa_loyalty/data/session.dart';

void main() {
  group('Continue with Vesopa, before there is a venue', () {
    test('one venue: signed in, and told where', () {
      final way = VesopaWayIn.fromJson({
        'token': 't',
        'venue': {'slug': 'vesopa-test', 'name': 'The Vesopa Kitchen'},
      });
      expect(way.token, 't');
      expect(way.venue?.slug, 'vesopa-test');
      expect(way.venues, isEmpty);
    });

    test('several venues: no token, a choice', () {
      final way = VesopaWayIn.fromJson({
        'venues': [
          {'slug': 'the-crown', 'name': 'The Crown'},
          {'slug': 'the-mill'},
          'not a venue',
        ],
      });
      expect(way.token, isNull);
      expect(way.venues.map((v) => v.name), ['The Crown', 'the-mill']);
    });
  });

  group('a venue code, however somebody has it written down', () {
    test('a bare code', () {
      expect(AppConfig.cleanSlug('the-crown'), 'the-crown');
      expect(AppConfig.cleanSlug('  The-Crown  '), 'the-crown');
    });

    test('the whole link off a table card', () {
      // What is actually printed is the address, so that is what gets pasted.
      expect(
        AppConfig.cleanSlug('https://menu.vesopaepos.com/app/the-crown/'),
        'the-crown',
      );
      expect(
        AppConfig.cleanSlug('menu.vesopaepos.com/app/the-crown'),
        'the-crown',
      );
    });

    test('a link on a host we have not moved to yet', () {
      expect(
        AppConfig.cleanSlug('https://loyalty.vesopa.com/app/the-crown/'),
        'the-crown',
      );
    });

    test('nonsense is refused rather than saved', () {
      // Saving a bad code turns the next screen into a sign-in that fails for
      // reasons nobody can see, which is far worse than saying so here.
      expect(AppConfig.cleanSlug(''), isNull);
      expect(AppConfig.cleanSlug('   '), isNull);
      expect(AppConfig.cleanSlug('a'), isNull);
      expect(AppConfig.cleanSlug('has spaces'), isNull);
      expect(AppConfig.cleanSlug('UPPER_SCORE'), isNull);
      expect(AppConfig.cleanSlug('-leading'), isNull);
      expect(AppConfig.cleanSlug('trailing-'), isNull);
    });

    test('a path traversal is not a venue', () {
      expect(AppConfig.cleanSlug('../../etc/passwd'), isNull);
      expect(AppConfig.cleanSlug('https://menu.vesopaepos.com/app/../admin'), isNull);
    });
  });
}
