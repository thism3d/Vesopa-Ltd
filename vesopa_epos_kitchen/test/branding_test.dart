import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos_kitchen/data/kitchen_api.dart';
import 'package:vesopa_epos_kitchen/data/kitchen_branding.dart';

/// White-label branding, and the fallbacks that keep a screen drawable.
///
/// The thing under test is not really the parsing — it is the promise the model
/// makes: **nothing a venue can type into the back office may leave a screen
/// unable to draw itself.** A colour with a typo in it, a hold somebody entered
/// in seconds instead of milliseconds, a logo field that arrived as null; each
/// of those is a thing a person will do, and each of them has to come out as a
/// board on a wall rather than as a red screen in a kitchen.
void main() {
  group('branding falls back rather than failing', () {
    test('nothing configured is the standard Vesopa look', () {
      const branding = KitchenBranding.standard;

      expect(branding.displayName, 'Vesopa Kitchen');
      expect(branding.isCustomised, isFalse);
      expect(branding.background, isNull);
      expect(branding.accent, isNull);
      expect(branding.logoUrl, isNull);
      expect(branding.splashEnabled, isTrue);
      expect(branding.showPoweredBy, isTrue);
    });

    test('a missing branding block is the standard look, not a crash', () {
      expect(KitchenBranding.fromJson(null).displayName, 'Vesopa Kitchen');
    });

    test('an empty name falls back to the product name', () {
      final branding = KitchenBranding.fromJson({'appName': '   '});
      expect(branding.displayName, 'Vesopa Kitchen');
      expect(branding.isCustomised, isFalse);
    });

    test('a name that is set is used, and counts as customised', () {
      final branding = KitchenBranding.fromJson({'appName': ' The Bell  '});
      expect(branding.displayName, 'The Bell');
      expect(branding.isCustomised, isTrue);
    });

    // Every one of these is something a person can produce in the back office
    // by typing, and every one of them has to end up drawing the built-in
    // colour rather than throwing on a wall-mounted machine.
    for (final bad in ['', '  ', 'nonsense', '#12345', '#1234567', 'ff00zz']) {
      test('a colour of "$bad" falls back to the built-in one', () {
        final branding = KitchenBranding.fromJson({
          'splashBg': bad,
          'accent': bad,
        });
        expect(branding.background, isNull);
        expect(branding.accent, isNull);
      });
    }

    test('a good colour parses, with or without its hash', () {
      expect(
        KitchenBranding.fromJson({'splashBg': '#a5c715'}).background,
        const Color(0xFFA5C715),
      );
      expect(
        KitchenBranding.fromJson({'accent': 'A5C715'}).accent,
        const Color(0xFFA5C715),
      );
    });

    test('a colour survives the round trip to the wire and back', () {
      const original = KitchenBranding(
        background: Color(0xFF1E2430),
        accent: Color(0xFFD03227),
      );
      final returned = KitchenBranding.fromJson(original.toJson());

      expect(returned.background, original.background);
      expect(returned.accent, original.accent);
    });
  });

  group('the hold is clamped', () {
    // The server clamps this too. It is checked again here because the server
    // is not the only thing that can produce it: this same parser reads the
    // *cache* on disk, which was written by whatever version of the app was
    // installed last.
    test('a hold longer than six seconds is cut to six', () {
      final branding = KitchenBranding.fromJson({'splashMs': 60000});
      expect(branding.splashHold, const Duration(seconds: 6));
    });

    test('a negative hold becomes none at all', () {
      final branding = KitchenBranding.fromJson({'splashMs': -500});
      expect(branding.splashHold, Duration.zero);
    });

    test('zero is allowed, and is not treated as unset', () {
      final branding = KitchenBranding.fromJson({'splashMs': 0});
      expect(branding.splashHold, Duration.zero);
      // Still shown — the animation plays and clears itself. Turning the start
      // screen off entirely is the separate switch.
      expect(branding.splashEnabled, isTrue);
    });

    test('a missing hold is the default, not zero', () {
      expect(
        KitchenBranding.fromJson(const {}).splashHold,
        KitchenBranding.standard.splashHold,
      );
    });
  });

  group('the logo resolves against this screen’s own server', () {
    test('no logo is no URL', () {
      expect(KitchenBranding.standard.logoFor('https://example.test'), isNull);
      expect(
        KitchenBranding.fromJson({'logoUrl': ''}).logoFor('https://example.test'),
        isNull,
      );
    });

    // Stored as a path and resolved at draw time, so a venue moved to another
    // server — or a screen pointed at staging — does not keep fetching the old
    // one's pictures.
    test('an upload path is hung off the API base', () {
      final branding = KitchenBranding.fromJson({
        'logoUrl': '/uploads/bell.png',
      });
      expect(
        branding.logoFor('https://backoffice.example'),
        'https://backoffice.example/uploads/bell.png',
      );
    });

    test('a path without a leading slash still resolves', () {
      final branding = KitchenBranding.fromJson({'logoUrl': 'uploads/b.png'});
      expect(
        branding.logoFor('https://backoffice.example'),
        'https://backoffice.example/uploads/b.png',
      );
    });

    test('an absolute URL is left alone', () {
      final branding = KitchenBranding.fromJson({
        'logoUrl': 'https://cdn.example/logo.png',
      });
      expect(
        branding.logoFor('https://backoffice.example'),
        'https://cdn.example/logo.png',
      );
    });
  });

  group('branding arrives with the profile', () {
    // The screen reads this once at sign-in and once per reconnect, bundled
    // with the screens and station names — so the start screen is branded on a
    // cold boot with no network. If this seam breaks, the wall silently
    // reverts to the Vesopa look and nobody can say why.
    test('a profile carries the venue’s branding', () {
      final profile = KitchenProfile.fromJson({
        'office': 'bell@example.test',
        'officeName': 'The Bell',
        'screens': [],
        'branding': {
          'appName': 'Bell Kitchen',
          'tagline': 'Swansea',
          'splashBg': '#1e2430',
          'accent': '#00a6a6',
          'splashMs': 900,
          'showPoweredBy': false,
        },
      });

      expect(profile.branding.displayName, 'Bell Kitchen');
      expect(profile.branding.tagline, 'Swansea');
      expect(profile.branding.background, const Color(0xFF1E2430));
      expect(profile.branding.accent, const Color(0xFF00A6A6));
      expect(profile.branding.splashHold, const Duration(milliseconds: 900));
      expect(profile.branding.showPoweredBy, isFalse);
      expect(profile.branding.isCustomised, isTrue);
    });

    test('a profile from a server without branding still parses', () {
      // An older server, or one mid-deploy. The screen must sign in and draw a
      // board regardless.
      final profile = KitchenProfile.fromJson({
        'office': 'bell@example.test',
        'screens': [],
      });

      expect(profile.branding.displayName, 'Vesopa Kitchen');
      expect(profile.branding.isCustomised, isFalse);
    });

    test('branding survives the profile’s own cache round trip', () {
      final profile = KitchenProfile.fromJson({
        'office': 'bell@example.test',
        'screens': [],
        'branding': {'appName': 'Bell Kitchen', 'accent': '#00a6a6'},
      });
      final cached = KitchenProfile.fromJson(profile.toJson());

      expect(cached.branding.displayName, 'Bell Kitchen');
      expect(cached.branding.accent, const Color(0xFF00A6A6));
    });
  });
}
