import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/fonts.dart';
import 'package:vesopa_epos/data/screens.dart';
import 'package:vesopa_epos/data/till_settings.dart';

/// The lettering a venue's tills wear.
///
/// The promise guarded here is the same one screens_test.dart guards, applied
/// to a new thing that can go wrong: **nothing about a font may stop a till
/// drawing.** A font is chosen in an office and arrives at a counter over a
/// broadband line that may be down, may be down for a week, and may come back
/// after the font it was going to fetch has been deleted. Every one of those
/// has to come out as a key lettered in the app's own typeface — the way every
/// key looked before this feature existed — and never as a blank screen, a
/// wrong-looking key, or an exception in front of a customer.
void main() {
  VenueFont font(String slug, {bool builtIn = true, List<int> weights = const [400]}) =>
      VenueFont.fromJson({
        'slug': slug,
        'family': slug.toUpperCase(),
        'builtIn': builtIn,
        'faces': [
          for (final w in weights) {'weight': w, 'url': '/assets/fonts/$slug/$slug-$w.ttf'},
        ],
      });

  group('what the till agrees to letter a key in', () {
    test('a font nobody asked for is the app’s own, and costs nothing', () {
      const library = FontLibrary.empty;
      expect(library.familyFor(null), isNull);
      expect(library.familyFor(''), isNull);
    });

    test('a font on this terminal’s disk resolves to a family', () {
      final library = FontLibrary([font('inter')]).withInstalled({'inter'});
      expect(library.familyFor('inter'), 'vf-inter');
    });

    test('a font the venue has but this terminal has not downloaded is refused', () {
      // The case this lookup exists for. Handing the engine a family it has
      // never been given resolves to *something* — the platform default, or a
      // fallback with different metrics — so a key would silently change shape
      // and then change back when the download landed. Better that it has not
      // changed at all yet.
      final library = FontLibrary([font('inter')]);
      expect(library.installed, isEmpty);
      expect(library.familyFor('inter'), isNull);
    });

    test('a font deleted in the back office after the layout was cached is refused', () {
      final library = FontLibrary([font('inter')]).withInstalled({'inter'});
      expect(library.familyFor('brand-sans'), isNull);
    });

    test('the family is prefixed, so a venue cannot name a system font', () {
      // `fontFamily: 'Arial'` would silently work on Windows and silently not
      // on Android — the worst of both. Every family the till registers is
      // under a name only this app uses.
      final library = FontLibrary([
        font('arial', builtIn: false),
      ]).withInstalled({'arial'});
      expect(library.familyFor('arial'), 'vf-arial');
      expect(library.bySlug('arial')!.engineFamily, startsWith('vf-'));
    });
  });

  group('the list survives whatever arrives', () {
    test('an empty payload is an empty library, not a crash', () {
      expect(FontLibrary.fromJson(const {}).fonts, isEmpty);
      expect(FontLibrary.fromJson(const {'fonts': []}).fonts, isEmpty);
    });

    test('a family carries its weights, in order', () {
      final library = FontLibrary.fromJson({
        'fonts': [
          {
            'slug': 'inter',
            'family': 'Inter',
            'builtIn': true,
            'faces': [
              {'weight': 700, 'url': '/assets/fonts/inter/inter-700.ttf'},
              {'weight': 400, 'url': '/assets/fonts/inter/inter-400.ttf'},
            ],
          },
        ],
      });
      expect(library.fonts.single.faces.length, 2);
      expect(library.bySlug('inter')!.family, 'Inter');
    });

    test('a server path becomes something the till can actually fetch', () {
      // The back office stores these as on-site paths and refuses anything
      // off-site, so what arrives is never a URL — and handing that straight to
      // an HTTP client fails. Same fix, and same reason, as a key's picture.
      final face = FontFace.fromJson(const {
        'weight': 400,
        'url': '/assets/fonts/inter/inter-400.ttf',
      });
      expect(face.url, startsWith('http'));
      expect(face.url, endsWith('/assets/fonts/inter/inter-400.ttf'));
    });

    test('a face keeps the extension it was served with', () {
      // The engine reads the bytes, but a .ttf holding OpenType outlines is
      // impossible to diagnose from a directory listing on a terminal.
      final otf = FontFace.fromJson(const {
        'weight': 400,
        'url': '/uploads/fonts/brand-sans-400-abc.otf',
      });
      expect(otf.fileName('brand-sans'), 'brand-sans-400.otf');
    });

    test('a round trip through the cache keeps every family', () {
      final original = FontLibrary([
        font('inter', weights: const [400, 700]),
        font('brand-sans', builtIn: false),
      ]);
      final back = FontLibrary.fromJson(original.toJson());
      expect(back.fonts.map((f) => f.slug).toList(), ['inter', 'brand-sans']);
      expect(back.bySlug('brand-sans')!.builtIn, isFalse);
      // And nothing is installed until the files have actually been found —
      // a cache is a list of names, not a list of fonts this till can draw.
      expect(back.installed, isEmpty);
    });
  });

  group('a key’s own lettering', () {
    Map<String, dynamic> key(Map<String, dynamic> over) => {
      'row': 0,
      'col': 0,
      'kind': 'product',
      'pluId': 1,
      ...over,
    };

    test('a key with no font of its own inherits, rather than refusing', () {
      final b = ScreenButton.fromJson(key(const {}));
      expect(b.fontFamily, isNull);
      expect(b.fontSize, isNull);
    });

    test('a font and a size arrive as themselves', () {
      final b = ScreenButton.fromJson(
        key(const {'fontFamily': 'bebas-neue', 'fontSize': 26}),
      );
      expect(b.fontFamily, 'bebas-neue');
      expect(b.fontSize, 26);
    });

    test('a font name that is not a slug is cut down rather than refused', () {
      // This ends up naming a font family on a counter. A value the till does
      // not like has to come out as plain lettering on a key that still works,
      // not as a screen that will not draw.
      final b = ScreenButton.fromJson(key(const {'fontFamily': ' Bebas Neue!! '}));
      expect(b.fontFamily, 'bebasneue');
      expect(
        ScreenButton.fromJson(key(const {'fontFamily': '!!!'})).fontFamily,
        isNull,
      );
      expect(
        ScreenButton.fromJson(key(const {'fontFamily': 42})).fontFamily,
        '42',
      );
    });

    test('a size out of all proportion is clamped, not honoured', () {
      expect(
        ScreenButton.fromJson(key(const {'fontSize': 900})).fontSize,
        72,
      );
      expect(ScreenButton.fromJson(key(const {'fontSize': 1})).fontSize, 8);
    });

    test('the lettering survives the cache', () {
      const original = ScreenButton(
        row: 0,
        col: 0,
        kind: ScreenButtonKind.page,
        targetScreenId: 4,
        fontFamily: 'brand-sans',
        fontSize: 18,
      );
      final back = ScreenButton.fromJson(original.toJson());
      expect(back.fontFamily, 'brand-sans');
      expect(back.fontSize, 18);
    });
  });

  group('the venue’s own choice', () {
    test('a settings row with no font is the app’s own lettering', () {
      // Which is what every till wore before this existed, and what a back
      // office that has not run schema_till_fonts.sql yet will keep sending.
      expect(TillSettings.fromJson(const {}).fontFamily, isNull);
      expect(
        TillSettings.fromJson(const {'font_family': ''}).fontFamily,
        isNull,
      );
    });

    test('a chosen font is carried', () {
      expect(
        TillSettings.fromJson(const {'font_family': 'inter'}).fontFamily,
        'inter',
      );
    });

    test('changing the font is a change the till notices', () {
      // TillSettings is compared by value to stop the whole app rebuilding
      // every two minutes when the poll returns the same row. A field left out
      // of that comparison is a setting that reaches the terminal and never
      // reaches the screen.
      const plain = TillSettings();
      const lettered = TillSettings(fontFamily: 'inter');
      expect(plain == lettered, isFalse);
      expect(plain.hashCode == lettered.hashCode, isFalse);
      expect(lettered == const TillSettings(fontFamily: 'inter'), isTrue);
    });
  });
}
