import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_loyalty/data/brand.dart';

void main() {
  String resolve(String u) => u.startsWith('http') ? u : 'https://menu.example$u';

  test('a venue brand is read from the server, relative URLs made absolute', () {
    final b = Brand.fromJson({
      'slug': 'pontardawe-rfc',
      'name': 'Pontardawe RFC',
      'venue': 'Pontardawe RFC',
      'welcome': 'Hi',
      'logo': '/uploads/logo.png',
      'colours': {'primary': '#AA0000', 'accent': '#FFD700', 'background': '#FFFFFF', 'text': '#111111'},
      'fonts': {
        'heading': {
          'slug': 'oswald',
          'family': 'Oswald',
          'faces': [
            {'weight': 700, 'url': '/assets/fonts/oswald/Oswald-Bold.ttf'},
          ],
        },
        'body': null,
      },
      'links': {'website': 'https://example.org', 'phone': '', 'x': 5},
      'location': {'latitude': 51.72, 'longitude': -3.85, 'radius_m': 300},
      'points': {'value_minor': 1, 'min_redeem': 100},
      'push': {'web': {'vapid_public_key': 'BKey'}, 'windows': false},
    }, resolve);

    expect(b.name, 'Pontardawe RFC');
    expect(b.logo, 'https://menu.example/uploads/logo.png');
    expect(b.primary, const Color(0xFFAA0000));
    expect(b.headingFont?.family, 'venue-Oswald');
    expect(b.headingFont?.faces.single.url, 'https://menu.example/assets/fonts/oswald/Oswald-Bold.ttf');
    expect(b.bodyFont, isNull);
    // Empty and non-string links are dropped.
    expect(b.links, {'website': 'https://example.org'});
    expect(b.location?.radiusM, 300);
    expect(b.minRedeem, 100);
    expect(b.vapidPublicKey, 'BKey');
    expect(b.windowsPush, isFalse);
  });

  test('a bad colour falls back rather than failing', () {
    final b = Brand.fromJson({'colours': {'primary': 'red'}}, resolve);
    expect(b.primary, const Color(0xFF1E3A8A));
    expect(b.name, 'Loyalty');
  });

  test('text on a colour is readable', () {
    expect(Brand.onColour(const Color(0xFFFFFFFF)), const Color(0xFF111111));
    expect(Brand.onColour(const Color(0xFF000000)), Colors.white);
  });
}
