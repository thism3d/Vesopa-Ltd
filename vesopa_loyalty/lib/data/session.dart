import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../platform/location.dart';
import '../platform/push.dart';
import '../platform/watch.dart';
import 'watch_card.dart';
import 'api.dart';
import 'brand.dart';

/// Which venue this app is, and where its server is.
///
/// A BROWSER KNOWS FROM ITS ADDRESS. The app is served at
/// `https://loyalty.vesopa.com/<slug>/`, so the venue is in the path and there
/// is nothing to ask. (It used to be `menu.vesopaepos.com/app/<slug>/`, which
/// now redirects there.)
///
/// NOTHING ELSE HAS AN ADDRESS. Windows, Android and an iPhone have only what
/// they were built with or what somebody told them, so the venue is chosen
/// once, on first run, and kept.
///
/// It used to be a compile-time constant on those platforms. That is fine for
/// a venue with a Store listing of its own and quietly wrong for the one
/// listing that serves every venue: whichever slug was passed at build time
/// became the app for everybody who installed it, and no other venue's member
/// could reach their own card. LOYALTY_SLUG is still honoured -- a venue
/// shipping its own build should not have to ask its members anything -- but
/// it is now a default rather than the only answer.
class AppConfig {
  const AppConfig({required this.base, required this.slug});

  final String base;
  final String slug;

  /// The venue a build was made for, where it was made for one.
  static const buildSlug = String.fromEnvironment('LOYALTY_SLUG');
  static const apiBase = String.fromEnvironment(
    'LOYALTY_API',
    defaultValue: 'https://loyalty.vesopa.com',
  );

  /// The venue in this page's address, in a browser.
  static String? slugFromUrl() {
    if (!kIsWeb) return null;
    final segments = Uri.base.pathSegments.where((s) => s.isNotEmpty).toList();
    // The old address, /app/<slug>/, for a page opened before the redirect.
    final i = segments.indexOf('app');
    if (i >= 0 && i + 1 < segments.length) return segments[i + 1];
    // loyalty.vesopa.com/<slug>/
    if (segments.isNotEmpty && RegExp(r'^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$').hasMatch(segments.first)) {
      return segments.first;
    }
    return null;
  }

  /*
   * A venue code, or the link a venue hands out.
   *
   * Somebody typing this in has a table card or a text message in front of
   * them, and what is printed on it is the whole address. Demanding they pick
   * the last word out of it is how a first run gets abandoned, so a full link
   * is accepted and the code taken out of it.
   */
  static String? cleanSlug(String input) {
    var value = input.trim();
    if (value.isEmpty) return null;
    if (value.contains('/')) {
      /*
       * A LINK HAS TO BE AN APP LINK. Taking the last segment of whatever was
       * pasted turned any path at all into a venue code -- ../../etc/passwd
       * became "passwd" -- which the server would then refuse with a message
       * about the venue rather than about what was typed.
       */
      final uri = Uri.tryParse(value.startsWith('http') ? value : 'https://$value');
      final segments = uri?.pathSegments ?? const [];
      final i = segments.indexOf('app');
      if (i < 0 || i + 1 >= segments.length) return null;
      value = segments[i + 1];
    }
    value = value.toLowerCase().trim();
    // The same shape the server accepts (src/loyalty_app.js SLUG).
    return RegExp(r'^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$').hasMatch(value) ? value : null;
  }
  /// What the server records this session as. Four builds now, not two:
  /// a device list that calls an iPhone "windows" is a device list nobody
  /// can use to spot a sign-in they did not make.
  String get platform {
    if (kIsWeb) return 'web';
    return switch (defaultTargetPlatform) {
      TargetPlatform.android => 'android',
      TargetPlatform.iOS => 'ios',
      _ => 'windows',
    };
  }
}

const _venueKey = 'loyalty_venue_slug';

/// The venue this app is showing, and how it is changed.
///
/// Null means nobody has said yet, which on a native build is the ordinary
/// state of a fresh install and is what puts the venue picker on screen.
class VenueNotifier extends AsyncNotifier<String?> {
  @override
  Future<String?> build() async {
    final fromUrl = AppConfig.slugFromUrl();
    if (fromUrl != null) return fromUrl;
    try {
      final prefs = await SharedPreferences.getInstance();
      final saved = prefs.getString(_venueKey);
      if (saved != null && saved.isNotEmpty) return saved;
    } catch (_) {
      // A device that cannot read its own settings can still be told again.
    }
    return AppConfig.buildSlug.isEmpty ? null : AppConfig.buildSlug;
  }

  Future<void> choose(String slug) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_venueKey, slug);
    } catch (_) {
      // Not fatal: this run works, and it asks again next time.
    }
    state = AsyncData(slug);
  }

  /// Forget the venue, so the app asks again. Used by "Change venue".
  Future<void> forget() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.remove(_venueKey);
    } catch (_) {
      // Nothing to do: the picker is shown either way.
    }
    state = const AsyncData(null);
  }
}

final venueProvider = AsyncNotifierProvider<VenueNotifier, String?>(VenueNotifier.new);

/// Where to talk to, and as which venue.
///
/// Empty while the venue is unknown. Nothing that needs a venue is built
/// until it is: main.dart shows the picker instead.
final configProvider = Provider<AppConfig>((ref) {
  final slug = ref.watch(venueProvider).value ?? '';
  // In a browser the address is also the server. Everywhere else the
  // server is a constant, because there is no address to take it from.
  final base = AppConfig.slugFromUrl() != null ? Uri.base.origin : AppConfig.apiBase;
  return AppConfig(base: base, slug: slug);
});

final apiProvider = Provider<LoyaltyApi>((ref) {
  final c = ref.watch(configProvider);
  return LoyaltyApi(base: c.base, slug: c.slug);
});

/// The venue's look, fonts loaded.
final brandProvider = FutureProvider<Brand>((ref) async {
  final api = ref.watch(apiProvider);
  final brand = Brand.fromJson(await api.app(), api.resolve);
  await brand.loadFonts();
  return brand;
});

String _tokenKey(String slug) => 'loyalty_token_$slug';

/// Keep a sign-in token for a venue before the app has switched to it.
///
/// Continue with Vesopa learns the venue and the token in one answer; writing
/// the token first means the venue's session finds it the moment it is built.
Future<void> rememberToken(String slug, String token) async {
  final prefs = await SharedPreferences.getInstance();
  await prefs.setString(_tokenKey(slug), token);
}

/// The customer's sign-in token for this venue. Null when signed out.
class SessionNotifier extends AsyncNotifier<String?> {
  String get _key => _tokenKey(ref.read(configProvider).slug);

  @override
  Future<String?> build() async {
    // Watched, so a change of venue is a change of session, not the last
    // venue's token carried into the next one.
    ref.watch(configProvider);
    final prefs = await SharedPreferences.getInstance();
    final token = prefs.getString(_key);
    ref.read(apiProvider).token = token;
    return token;
  }

  Future<void> signedIn(String token) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_key, token);
    ref.read(apiProvider).token = token;
    state = AsyncData(token);
  }

  /// Forget the token here. The server side is the caller's (sign out, remove).
  Future<void> clear() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_key);
    ref.read(apiProvider).token = null;
    state = const AsyncData(null);
    // Signed out here, so the card goes from the watch too.
    unawaited(sendToWatch(watchSignedOut));
  }
}

final sessionProvider = AsyncNotifierProvider<SessionNotifier, String?>(SessionNotifier.new);

final meProvider = FutureProvider<Map<String, dynamic>>((ref) async {
  final token = await ref.watch(sessionProvider.future);
  if (token == null) throw ApiError('Please sign in.', status: 401);
  return ref.read(apiProvider).me();
});

final messagesProvider = FutureProvider<Map<String, dynamic>>((ref) async {
  final token = await ref.watch(sessionProvider.future);
  if (token == null) throw ApiError('Please sign in.', status: 401);
  return ref.read(apiProvider).messages();
});

/// The customer's two choices, kept on this device.
class Choices {
  Choices(this._prefs, this._slug);

  final SharedPreferences _prefs;
  final String _slug;

  static Future<Choices> of(String slug) async => Choices(await SharedPreferences.getInstance(), slug);

  bool get notifications => _prefs.getBool('push_on_$_slug') ?? false;
  Future<void> setNotifications(bool on) => _prefs.setBool('push_on_$_slug', on);

  bool get nearby => _prefs.getBool('near_on_$_slug') ?? false;
  Future<void> setNearby(bool on) => _prefs.setBool('near_on_$_slug', on);
}

/// On every start, signed in: hand the server this device's notification
/// channel again (a browser can rotate it; a Windows channel lasts thirty
/// days), and the position if the customer asked for nearby offers.
/// Returns whether they are at the venue now.
Future<bool> refreshChannels(LoyaltyApi api, Brand brand, String slug) async {
  final choices = await Choices.of(slug);
  if (choices.notifications && pushAvailable(brand)) {
    final channel = await pushCurrent(brand);
    if (channel != null) {
      try {
        if (channel.isDeviceToken) {
          await api.addDeviceToken(channel.kind, channel.channelUri!);
        } else if (channel.kind == 'wns') {
          await api.addWindowsChannel(channel.channelUri!);
        } else {
          await api.addWebPush(channel.subscription!);
        }
      } catch (_) {
        // Next start.
      }
    }
  }
  if (choices.nearby) {
    final p = await currentPosition();
    if (p != null) {
      try {
        return await api.reportLocation(latitude: p.latitude, longitude: p.longitude, accuracy: p.accuracy);
      } catch (_) {
        return false;
      }
    }
  }
  return false;
}

/// Money in the venue's currency. Every Vesopa venue is in the UK.
String money(int minor) => '£${(minor / 100).toStringAsFixed(2)}';

const _months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/// "12 Sep 2026, 18:40" from the server's timestamp.
String when(Object? iso, {bool time = true}) {
  final d = iso is String ? DateTime.tryParse(iso)?.toLocal() : null;
  if (d == null) return '';
  final day = '${d.day} ${_months[d.month - 1]} ${d.year}';
  if (!time) return day;
  return '$day, ${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
}
