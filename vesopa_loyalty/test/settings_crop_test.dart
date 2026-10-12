import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vesopa_loyalty/data/preferences.dart';
import 'package:vesopa_loyalty/platform/brightness.dart';
import 'package:vesopa_loyalty/ui/membership_section.dart';
import 'package:vesopa_loyalty/ui/photo_crop.dart';

void main() {
  group('photo crop', () {
    const photo = Size(2000, 1000);

    test('starts centred, the short side filling the window', () {
      final c = PhotoCrop.centred(photo);
      expect(c.source(photo), const Rect.fromLTWH(500, 0, 1000, 1000));
      expect(c.scale(photo, 300), 0.3);
    });

    test('never shows anything outside the photo', () {
      final c = PhotoCrop.centred(photo).moved(
        image: photo, window: 300, windowCentre: const Offset(200, 200),
        from: const Offset(200, 200), to: const Offset(2000, 2000), // a long drag down and right
      );
      final r = c.source(photo);
      expect(r.left, 0);
      expect(r.top, 0);
      expect(r.right, lessThanOrEqualTo(photo.width));
      expect(r.bottom, lessThanOrEqualTo(photo.height));
    });

    test('a pinch keeps the point under the fingers where it was', () {
      const window = 300.0, centre = Offset(200, 200), finger = Offset(260, 230);
      final start = PhotoCrop.centred(photo);
      final s0 = start.scale(photo, window);
      final under = start.centre + (finger - centre) / s0;
      final zoomed = start.moved(image: photo, window: window, windowCentre: centre, from: finger, to: finger, scaleBy: 2);
      expect(zoomed.zoom, 2);
      final s1 = zoomed.scale(photo, window);
      final after = zoomed.centre + (finger - centre) / s1;
      expect((after - under).distance, lessThan(1e-9));
      expect(zoomed.source(photo).width, 500);
    });

    test('zoom stays between 1 and the most there is', () {
      final c = PhotoCrop.centred(photo);
      expect(c.zoomedTo(0.2, photo).zoom, 1);
      expect(c.zoomedTo(50, photo).zoom, PhotoCrop.maxZoom);
    });

    test('the saved square is never more than 1024 nor less than 256', () {
      expect(PhotoCrop.outputSide(3000), 1024);
      expect(PhotoCrop.outputSide(600.4), 600);
      expect(PhotoCrop.outputSide(90), 256);
    });

    test('encodes a JPEG', () {
      final rgba = Uint8List(16 * 16 * 4)..fillRange(0, 16 * 16 * 4, 200);
      final jpeg = PhotoCrop.encodeJpeg(rgba, 16);
      expect(jpeg.sublist(0, 2), [0xFF, 0xD8]);
    });
  });

  group('settings', () {
    test('appearance is remembered', () async {
      SharedPreferences.setMockInitialValues({});
      final first = ProviderContainer();
      expect(first.read(appearanceProvider), ThemeMode.system);
      await first.read(appearanceProvider.notifier).set(ThemeMode.dark);
      first.dispose();

      final again = ProviderContainer();
      again.read(appearanceProvider);
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      expect(again.read(appearanceProvider), ThemeMode.dark);
      again.dispose();
    });

    test('turning the card glow off tells ScreenGlow', () async {
      SharedPreferences.setMockInitialValues({});
      final c = ProviderContainer();
      await c.read(cardGlowProvider.notifier).set(false);
      expect(ScreenGlow.allowed, isFalse);
      expect((await SharedPreferences.getInstance()).getBool(CardGlowNotifier.key), isFalse);
      await c.read(cardGlowProvider.notifier).set(true);
      expect(ScreenGlow.allowed, isTrue);
      c.dispose();
    });
  });

  group('membership', () {
    test('term progress counts from the start of the term', () {
      final p = termProgress(expiry: '2027-01-01', termMonths: 12, today: DateTime(2026, 7, 2));
      expect(p, closeTo(0.5, 0.01));
      expect(termProgress(expiry: null, termMonths: 12, today: DateTime(2026)), isNull);
    });

    test('a renewal reminder only in the last month of an active membership', () {
      expect(renewalDue({'state': 'active', 'plan': {}, 'days_left': 12}), isTrue);
      expect(renewalDue({'state': 'active', 'plan': {}, 'days_left': 60}), isFalse);
      expect(renewalDue({'state': 'expired', 'plan': {}, 'days_left': -3}), isFalse);
    });

    test('benefits in plain words', () {
      final lines = planBenefits(
        {'term_months': 12, 'includes_classes': true, 'class_credits_per_month': 8, 'family_size': 4, 'freeze_days_per_year': 30},
        freezeUsed: 10,
      ).map((l) => l.$2).toList();
      expect(lines, contains('8 classes a month'));
      expect(lines, contains('Covers up to 4 people'));
      expect(lines, contains('20 of 30 freeze days left this year'));
    });
  });
}
