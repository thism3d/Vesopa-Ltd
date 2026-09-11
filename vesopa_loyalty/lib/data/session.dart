import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../platform/location.dart';
import '../platform/push.dart';
import 'api.dart';
import 'brand.dart';

/// Which venue this app is, and where its server is.
///
/// In a browser both come from the address: the app is served at
/// `https://menu.vesopaepos.com/app/<slug>/`. A Windows build is one venue's,
/// named when it is built:
///
///     flutter build windows --dart-define=LOYALTY_SLUG=<slug>
class AppConfig {
  const AppConfig({required this.base, required this.slug});

  final String base;
  final String slug;

  static const _slug = String.fromEnvironment('LOYALTY_SLUG');
  static const _api = String.fromEnvironment('LOYALTY_API', defaultValue: 'https://menu.vesopaepos.com');

  static AppConfig resolve() {
    if (kIsWeb) {
      final segments = Uri.base.pathSegments;
      final i = segments.indexOf('app');
      if (i >= 0 && i + 1 < segments.length && segments[i + 1].isNotEmpty) {
        return AppConfig(base: Uri.base.origin, slug: segments[i + 1]);
      }
      // Run locally (flutter run -d chrome): the venue from the build.
      return const AppConfig(base: _api, slug: _slug);
    }
    return const AppConfig(base: _api, slug: _slug);
  }

  String get platform => kIsWeb ? 'web' : 'windows';
}

final configProvider = Provider<AppConfig>((ref) => AppConfig.resolve());

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

/// The customer's sign-in token for this venue. Null when signed out.
class SessionNotifier extends AsyncNotifier<String?> {
  String get _key => 'loyalty_token_${ref.read(configProvider).slug}';

  @override
  Future<String?> build() async {
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
        if (channel.kind == 'wns') {
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
