import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/services.dart' show FontLoader;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../config/constants.dart';
import '../main.dart';
import 'screens.dart';

/// The lettering a venue's tills wear.
///
/// Sixteen families ship with the back office and a venue may upload its own;
/// either way the files come from the venue's own back office, over the same
/// connection this till already fetches products and screens on. See
/// `vesopa_server/src/fonts.js` for why they are not fetched from Google.
///
/// **THE OFFLINE RULE, WHICH IS THE WHOLE DESIGN.**
///
/// A till takes money through a broadband outage. That is most of the reason it
/// exists. So a font is downloaded once, written to this terminal's own disk,
/// and registered from disk on every start after that — the network is needed
/// the first time a venue picks a font and never again. A font that has not
/// arrived yet is not an error and is not worth a dialog: the key is lettered
/// in the app's own typeface, which is exactly what every key looked like
/// before this feature existed, and it picks up the venue's font the next time
/// the till can reach the office.
///
/// Nothing here is allowed to throw into a sale. Every failure — no network, a
/// half-written file, a font file that is not a font, a disk that will not be
/// written to — comes out as plain lettering.

/// One weight of one family.
class FontFace {
  const FontFace({required this.weight, required this.url});

  final int weight;

  /// Absolute, resolved against the back office at parse time. The server
  /// sends `/assets/fonts/...` or `/uploads/fonts/...`, which is not something
  /// [http.get] can be handed.
  final String url;

  factory FontFace.fromJson(Map<String, dynamic> j) => FontFace(
    weight: (j['weight'] as num?)?.toInt() ?? 400,
    url: _absolute('${j['url'] ?? ''}'),
  );

  Map<String, dynamic> toJson() => {'weight': weight, 'url': url};

  static String _absolute(String path) {
    if (path.startsWith('http')) return path;
    return '${Api.resolvedBase}$path';
  }

  /// What this face is saved as on disk. The extension matters: the engine
  /// reads the bytes, but a `.ttf` holding OpenType outlines is the kind of
  /// thing that is impossible to diagnose from a directory listing.
  String fileName(String slug) =>
      '$slug-$weight${p.extension(Uri.parse(url).path).isEmpty ? '.ttf' : p.extension(Uri.parse(url).path)}';
}

/// One family — a built-in, or one this venue uploaded.
class VenueFont {
  const VenueFont({
    required this.slug,
    required this.family,
    required this.builtIn,
    required this.faces,
  });

  /// The stable key. A button stores this, never the display name, so renaming
  /// a font in the back office does not un-letter every key using it.
  final String slug;

  /// What a manager called it. Shown in Settings; never used to match.
  final String family;

  final bool builtIn;
  final List<FontFace> faces;

  /// The family name this is registered under with the engine.
  ///
  /// Prefixed so a venue that uploads a font called "Roboto" cannot collide
  /// with anything the app itself ships, and so a slug can never accidentally
  /// name a system font — `fontFamily: 'Arial'` would silently work on Windows
  /// and silently not on Android, which is the worst of both.
  String get engineFamily => 'vf-$slug';

  factory VenueFont.fromJson(Map<String, dynamic> j) => VenueFont(
    slug: '${j['slug'] ?? ''}',
    family: '${j['family'] ?? ''}',
    builtIn: j['builtIn'] == true,
    faces: [
      for (final f in (j['faces'] as List? ?? const []))
        FontFace.fromJson(f as Map<String, dynamic>),
    ],
  );

  Map<String, dynamic> toJson() => {
    'slug': slug,
    'family': family,
    'builtIn': builtIn,
    'faces': [for (final f in faces) f.toJson()],
  };
}

/// Every font this venue may letter a till in.
class FontLibrary {
  const FontLibrary(this.fonts, {this.installed = const <String>{}});

  static const FontLibrary empty = FontLibrary(<VenueFont>[]);

  final List<VenueFont> fonts;

  /// The slugs whose files are on this terminal's disk and registered with the
  /// engine. A font in [fonts] but not in here is one the venue has chosen and
  /// this till has not managed to download yet.
  final Set<String> installed;

  VenueFont? bySlug(String? slug) {
    if (slug == null || slug.isEmpty) return null;
    for (final f in fonts) {
      if (f.slug == slug) return f;
    }
    return null;
  }

  /// The family to hand a `TextStyle`, or null for the app's own typeface.
  ///
  /// The one place that decides, and it says no in three cases that all look
  /// the same to a clerk and are worth keeping apart in the code:
  ///
  ///  * nothing was asked for — most keys, most of the time;
  ///  * a font was asked for that this venue no longer has, because it was
  ///    deleted in the back office after this layout was cached;
  ///  * a font was asked for that is not on this terminal's disk yet.
  ///
  /// The last one is the reason this is a lookup rather than a string
  /// concatenation. Handing the engine a family it has never been given resolves
  /// to *something* — usually the platform default, sometimes a fallback with
  /// different metrics — and a key that silently changes shape is harder to
  /// explain than one that has not changed at all.
  String? familyFor(String? slug) {
    if (slug == null || slug.isEmpty) return null;
    if (!installed.contains(slug)) return null;
    return bySlug(slug)?.engineFamily;
  }

  FontLibrary withInstalled(Set<String> slugs) =>
      FontLibrary(fonts, installed: slugs);

  factory FontLibrary.fromJson(Map<String, dynamic> j) => FontLibrary([
    for (final f in (j['fonts'] as List? ?? const []))
      VenueFont.fromJson(f as Map<String, dynamic>),
  ]);

  Map<String, dynamic> toJson() => {
    'fonts': [for (final f in fonts) f.toJson()],
  };
}

class FontsRepository {
  FontsRepository({required this.apiBase, http.Client? client})
    : _client = client ?? http.Client();

  final String apiBase;
  final http.Client _client;

  static const _key = 'vesopa_till_fonts';

  /// Families already handed to the engine in this run of the app.
  ///
  /// Static, and deliberately: [FontLoader] registers with the engine, which
  /// outlives any provider. Registering the same family twice is not an error
  /// but it re-parses the file and appends a second copy of every face, and a
  /// till left running for a week through a hundred catalogue pushes would do
  /// that a hundred times.
  static final Set<String> _registered = <String>{};

  /// The list, from the office if it can be reached and from the cache if not.
  ///
  /// [wanted] is the set of slugs this venue is actually lettering something
  /// in. Only those are downloaded, and that matters more than it looks: the
  /// catalogue is sixteen built-in families before a venue has uploaded
  /// anything, and fetching the lot would be four and a half megabytes over a
  /// venue's broadband to draw one screen in one of them. Empty means download
  /// nothing, which is the right answer for a venue that has chosen no font.
  Future<FontLibrary> load(String office, {Set<String> wanted = const {}}) async {
    FontLibrary library;
    try {
      final res = await _client
          .get(Uri.parse('$apiBase/api/till/fonts?office=$office'))
          .timeout(const Duration(seconds: 8));
      if (res.statusCode == 200) {
        library = FontLibrary.fromJson(
          jsonDecode(res.body) as Map<String, dynamic>,
        );
        final prefs = await SharedPreferences.getInstance();
        await prefs.setString(_key, jsonEncode(library.toJson()));
      } else {
        library = await _cached();
      }
    } catch (_) {
      library = await _cached();
    }

    return library.withInstalled(await _install(library, wanted));
  }

  Future<FontLibrary> _cached() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(_key);
      if (raw == null || raw.isEmpty) return FontLibrary.empty;
      return FontLibrary.fromJson(jsonDecode(raw) as Map<String, dynamic>);
    } catch (_) {
      return FontLibrary.empty;
    }
  }

  /// Where the files live. Application support, not a cache directory: a cache
  /// is a place the operating system may empty, and a till that loses its
  /// lettering because Windows wanted the space — offline, mid-service — is a
  /// till nobody can fix at the counter.
  Future<Directory> _dir() async {
    final base = await getApplicationSupportDirectory();
    final dir = Directory(p.join(base.path, 'fonts'));
    if (!dir.existsSync()) dir.createSync(recursive: true);
    return dir;
  }

  /// Download anything missing, then register every family that is complete.
  ///
  /// Returns the slugs that are actually usable. A family whose bold is on disk
  /// and whose regular is not is *not* usable: the engine would letter every
  /// key in bold and the venue would have asked for neither.
  Future<Set<String>> _install(FontLibrary library, Set<String> wanted) async {
    if (library.fonts.isEmpty || wanted.isEmpty) return const <String>{};

    final Directory dir;
    try {
      dir = await _dir();
    } catch (_) {
      // No writable support directory. Nothing else here can work; plain
      // lettering, and no noise.
      return const <String>{};
    }

    final ready = <String>{};
    for (final font in library.fonts) {
      if (font.faces.isEmpty || !wanted.contains(font.slug)) continue;

      // Already handed to the engine in this run. Skipped before anything
      // touches the disk: a till hears a push every time a price changes, and
      // re-reading a megabyte of font files to conclude nothing had moved is
      // work done on a machine that is also taking money.
      if (_registered.contains(font.engineFamily)) {
        ready.add(font.slug);
        continue;
      }

      final bytes = <int, Uint8List>{};
      for (final face in font.faces) {
        final file = File(p.join(dir.path, face.fileName(font.slug)));
        try {
          if (file.existsSync() && file.lengthSync() > 0) {
            bytes[face.weight] = await file.readAsBytes();
            continue;
          }
          final res = await _client
              .get(Uri.parse(face.url))
              .timeout(const Duration(seconds: 20));
          if (res.statusCode != 200 || res.bodyBytes.isEmpty) continue;
          // Written to a temporary name and renamed, so a download cut off
          // halfway cannot leave a truncated file that every later start reads
          // as "already downloaded" and hands to the engine.
          final part = File('${file.path}.part');
          await part.writeAsBytes(res.bodyBytes, flush: true);
          await part.rename(file.path);
          bytes[face.weight] = res.bodyBytes;
        } catch (_) {
          // Offline, or this one face is unreachable. Carry on: the family is
          // only counted as ready if every face arrived.
        }
      }

      if (bytes.length != font.faces.length) continue;

      {
        try {
          _registered.add(font.engineFamily);
          final loader = FontLoader(font.engineFamily);
          // The engine picks a weight by reading each file's own metadata, so
          // the faces are added in whatever order and bold still resolves as
          // bold — but they are sorted anyway, because a family whose first
          // face is the bold one falls back to bold for a weight it has no
          // match for, and that fallback is where "everything is bold" comes
          // from.
          for (final weight in bytes.keys.toList()..sort()) {
            loader.addFont(
              Future.value(ByteData.view(bytes[weight]!.buffer)),
            );
          }
          await loader.load();
        } catch (_) {
          // A file that is not a font, or an engine that refused it. Take the
          // family back out so a later refresh can try again.
          _registered.remove(font.engineFamily);
          continue;
        }
      }
      ready.add(font.slug);
    }
    return ready;
  }

  /// Send a font file from this counter to the back office.
  ///
  /// On the terminal token, not on the office alone. Every other till route is
  /// a read; this one puts a file on the office's disk, and an unauthenticated
  /// write scoped by an email address is not a trade worth making.
  ///
  /// Throws with the server's own message on failure, because the server's
  /// message is the useful one — it is the only thing that can say "a .woff2
  /// works in a browser but not on a till".
  Future<void> upload({
    required String terminalToken,
    required File file,
    required String family,
    required int weight,
  }) async {
    final request = http.MultipartRequest(
      'POST',
      Uri.parse('$apiBase/api/till/fonts'),
    )
      ..headers['Authorization'] = 'Bearer $terminalToken'
      ..fields['family'] = family
      ..fields['weight'] = '$weight'
      ..files.add(await http.MultipartFile.fromPath('font', file.path));

    final streamed = await request.send().timeout(const Duration(seconds: 60));
    final res = await http.Response.fromStream(streamed);
    if (res.statusCode >= 200 && res.statusCode < 300) return;

    String message = 'That font would not upload.';
    try {
      final body = jsonDecode(res.body) as Map<String, dynamic>;
      if (body['error'] is String) message = body['error'] as String;
    } catch (_) {
      // A proxy's HTML error page, or nothing at all. The default reads better
      // than a stack trace at a counter.
    }
    throw Exception(message);
  }

  /// Change the font this venue's tills wear, from this till.
  Future<void> setVenueFont({
    required String terminalToken,
    required String? slug,
  }) async {
    final res = await _client
        .put(
          Uri.parse('$apiBase/api/till/font'),
          headers: {
            'Authorization': 'Bearer $terminalToken',
            'Content-Type': 'application/json',
          },
          body: jsonEncode({'fontFamily': slug ?? ''}),
        )
        .timeout(const Duration(seconds: 15));
    if (res.statusCode >= 200 && res.statusCode < 300) return;
    throw Exception('That font could not be set — ${res.statusCode}.');
  }
}

final fontsRepositoryProvider = Provider<FontsRepository>(
  (ref) => FontsRepository(apiBase: ref.watch(apiBaseProvider)),
);

/// The venue's fonts, downloaded and registered, refreshed when the back office
/// says so.
///
/// Listens for the same `screens` push a layout does, because that is what the
/// back office sends when a font is uploaded or removed — one message, one
/// handler, and no version of the till that ignores a second one.
///
/// **What gets downloaded is what is used, not what is on offer.** The venue's
/// own font plus every font named by a key on any programmed screen — which on
/// most venues is nothing at all, and on the rest is one or two families out of
/// eighteen. See [FontsRepository.load].
final fontsProvider = FutureProvider<FontLibrary>((ref) async {
  ref.listen(syncEventsProvider, (_, next) {
    final type = next.value?.type;
    if (type == 'screens' || type == 'till-settings') ref.invalidateSelf();
  });

  final office = ref.watch(officeProvider);
  if (office.isEmpty) return FontLibrary.empty;

  final wanted = <String>{};
  final venue = ref.watch(tillSettingsProvider).fontFamily;
  if (venue != null && venue.isNotEmpty) wanted.add(venue);
  // Every key that asks for a font of its own, across every screen — including
  // the ones a till has not opened yet. A page button leads to a screen the
  // clerk will reach mid-service, and fetching its lettering at the moment of
  // the tap is how a key changes shape in front of a customer.
  for (final screen in ref.watch(screensProvider).value?.screens ?? const []) {
    for (final button in screen.buttons) {
      final slug = button.fontFamily;
      if (slug != null && slug.isNotEmpty) wanted.add(slug);
    }
  }

  return ref.watch(fontsRepositoryProvider).load(office, wanted: wanted);
});

/// The family every key inherits, or null for the app's own typeface.
///
/// Null while the list is still loading, which is the honest answer: the
/// alternative is lettering the whole till in the app's font, then swapping the
/// lot a second later when the download finishes, in front of a customer.
final venueFontFamilyProvider = Provider<String?>((ref) {
  final library = ref.watch(fontsProvider).value;
  if (library == null) return null;
  final slug = ref.watch(tillSettingsProvider).fontFamily;
  return library.familyFor(slug);
});
