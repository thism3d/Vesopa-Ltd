import 'dart:convert';

import 'package:http/http.dart' as http;

/// Something the server said no to, in words a customer can read.
class ApiError implements Exception {
  ApiError(this.message, {this.status = 0, this.needsName = false});

  final String message;
  final int status;

  /// A new address: the code was right, and the server wants a name before it
  /// makes them a member. The code is not spent -- ask again with a name.
  final bool needsName;

  /// Signed out, on this device or from another one.
  bool get signedOut => status == 401;

  @override
  String toString() => message;
}

/// The venue's loyalty API: `/loyalty/v1` on the back office.
///
/// One venue per app, named by its [slug] -- the address the venue chose in
/// the back office (Loyalty App). Everything a customer sees comes through
/// here; the app keeps nothing but its sign-in token.
class LoyaltyApi {
  LoyaltyApi({required this.base, required this.slug, http.Client? client})
    : _http = client ?? http.Client();

  /// The server, e.g. https://menu.vesopa.com.
  final String base;
  final String slug;
  final http.Client _http;

  /// The customer's token, once signed in.
  String? token;

  static const _timeout = Duration(seconds: 20);

  Uri _u(String path, [Map<String, String>? query]) =>
      Uri.parse('$base$path').replace(queryParameters: query);

  /// A path from the server made absolute: logos, fonts and images can come
  /// back relative to it.
  String resolve(String url) =>
      url.startsWith('http://') || url.startsWith('https://') ? url : '$base${url.startsWith('/') ? '' : '/'}$url';

  Map<String, String> get _headers => {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    if (token != null) 'Authorization': 'Bearer $token',
  };

  Future<Map<String, dynamic>> _send(
    String method,
    String path, {
    Object? body,
    Map<String, String>? query,
  }) async {
    final http.Response res;
    try {
      final req = http.Request(method, _u(path, query))..headers.addAll(_headers);
      if (body != null) req.body = jsonEncode(body);
      res = await http.Response.fromStream(await _http.send(req).timeout(_timeout));
    } catch (_) {
      throw ApiError('No connection. Check you are online and try again.');
    }
    Map<String, dynamic> json = const {};
    try {
      final decoded = jsonDecode(res.body);
      if (decoded is Map<String, dynamic>) json = decoded;
    } catch (_) {
      // Not JSON: said below by status.
    }
    if (res.statusCode >= 200 && res.statusCode < 300) return json;
    if (res.statusCode == 409 && json['needs_name'] == true) {
      throw ApiError('Tell us your name to join.', status: 409, needsName: true);
    }
    throw ApiError(
      (json['error'] as String?) ?? 'Something went wrong. Please try again.',
      status: res.statusCode,
    );
  }

  // ---- The venue ------------------------------------------------------------

  Future<Map<String, dynamic>> app() => _send('GET', '/loyalty/v1/app/${Uri.encodeComponent(slug)}');

  // ---- Signing in -----------------------------------------------------------

  Future<void> requestCode(String email) =>
      _send('POST', '/loyalty/v1/app/${Uri.encodeComponent(slug)}/code', body: {'email': email});

  /// Swap a code for a token. [name] only for somebody joining.
  Future<String> verify({
    required String email,
    required String code,
    String? name,
    required String platform,
  }) async {
    final json = await _send(
      'POST',
      '/loyalty/v1/app/${Uri.encodeComponent(slug)}/verify',
      body: {'email': email, 'code': code, 'name': ?name, 'platform': platform},
    );
    return json['token'] as String;
  }

  String get _app => '/loyalty/v1/app/${Uri.encodeComponent(slug)}';

  /// An email address and a password.
  Future<String> signInWithPassword({
    required String email,
    required String password,
    required String platform,
  }) async {
    final json = await _send('POST', '$_app/password',
        body: {'email': email, 'password': password, 'platform': platform});
    return json['token'] as String;
  }

  /// What the browser needs to offer a passkey. The address is a hint: with
  /// one we can name that member's keys, without one the browser offers
  /// whatever it holds for this site.
  Future<Map<String, dynamic>> passkeyOptions({String? email}) =>
      _send('POST', '$_app/passkey/options', body: {'email': ?email});

  Future<String> signInWithPasskey({
    required String challenge,
    required Map<String, dynamic> credential,
    required String platform,
  }) async {
    final json = await _send('POST', '$_app/passkey/verify',
        body: {'challenge': challenge, 'credential': credential, 'platform': platform});
    return json['token'] as String;
  }

  Future<void> requestSmsCode(String phone) =>
      _send('POST', '$_app/sms', body: {'phone': phone});

  Future<String> signInWithSms({
    required String phone,
    required String code,
    required String platform,
  }) async {
    final json = await _send('POST', '$_app/sms/verify',
        body: {'phone': phone, 'code': code, 'platform': platform});
    return json['token'] as String;
  }

  /// Finish Continue with Vesopa. The code is swapped for a token by the
  /// server, never here: that call wants a secret a web app cannot keep, and
  /// a token from auth has no business being in the browser.
  /// One of [code] (the web, with its verifier) or [idToken] (a native app
  /// that did its own exchange). The server takes either.
  Future<String> signInWithVesopa({
    String? code,
    String? verifier,
    String? redirectUri,
    String? idToken,
    required String platform,
  }) async {
    final json = await _send('POST', '$_app/vesopa', body: {
      'code': ?code,
      'code_verifier': ?verifier,
      'redirect_uri': ?redirectUri,
      'id_token': ?idToken,
      'platform': platform,
    });
    return json['token'] as String;
  }

  // ---- The member's account -------------------------------------------------

  Future<Map<String, dynamic>> account() => _send('GET', '/loyalty/v1/me/account');

  Future<void> setName(String name) =>
      _send('PUT', '/loyalty/v1/me/account', body: {'name': name});

  Future<void> setPassword({String? current, required String password}) =>
      _send('POST', '/loyalty/v1/me/password', body: {'current': ?current, 'password': password});

  Future<void> removePassword(String current) =>
      _send('POST', '/loyalty/v1/me/password', body: {'current': current, 'remove': true});

  Future<void> addPhone(String phone) =>
      _send('POST', '/loyalty/v1/me/phone', body: {'phone': phone});

  Future<void> confirmPhone({required String phone, required String code}) =>
      _send('POST', '/loyalty/v1/me/phone/verify', body: {'phone': phone, 'code': code});

  Future<void> removePhone() => _send('DELETE', '/loyalty/v1/me/phone');

  Future<Map<String, dynamic>> passkeyRegistrationOptions() =>
      _send('POST', '/loyalty/v1/me/passkeys/options');

  Future<void> addPasskey({
    required String challenge,
    required Map<String, dynamic> credential,
    String? name,
  }) => _send('POST', '/loyalty/v1/me/passkeys',
      body: {'challenge': challenge, 'credential': credential, 'name': ?name});

  Future<void> removePasskey(String id) =>
      _send('DELETE', '/loyalty/v1/me/passkeys/${Uri.encodeComponent(id)}');

  Future<int> signOutOthers() async {
    final json = await _send('POST', '/loyalty/v1/me/signout-others');
    return (json['signed_out'] as num?)?.toInt() ?? 0;
  }

  // ---- The member -----------------------------------------------------------

  Future<Map<String, dynamic>> me() => _send('GET', '/loyalty/v1/me');

  Future<Map<String, dynamic>> history({DateTime? before}) => _send(
    'GET',
    '/loyalty/v1/me/history',
    query: {if (before != null) 'before': before.toUtc().toIso8601String()},
  );

  /// The news. [before] pages back when the venue keeps everything; the
  /// answer says `more` when there is another page to ask for.
  Future<Map<String, dynamic>> messages({DateTime? before}) => _send(
    'GET',
    '/loyalty/v1/me/messages',
    query: {if (before != null) 'before': before.toUtc().toIso8601String()},
  );

  /// The member's own photograph onto their card. A multipart upload, the
  /// one call here that is not JSON.
  Future<String> uploadPhoto(List<int> bytes, String filename) async {
    final req = http.MultipartRequest('POST', _u('/loyalty/v1/me/photo'))
      ..headers.addAll({if (token != null) 'Authorization': 'Bearer $token', 'Accept': 'application/json'})
      ..files.add(http.MultipartFile.fromBytes('image', bytes, filename: filename));
    final http.Response res;
    try {
      res = await http.Response.fromStream(await _http.send(req).timeout(const Duration(seconds: 60)));
    } catch (_) {
      throw ApiError('No connection. Check you are online and try again.');
    }
    Map<String, dynamic> json = const {};
    try {
      final decoded = jsonDecode(res.body);
      if (decoded is Map<String, dynamic>) json = decoded;
    } catch (_) {
      // Said below by status.
    }
    if (res.statusCode >= 200 && res.statusCode < 300) return json['photo_url'] as String;
    throw ApiError((json['error'] as String?) ?? 'The photo could not be saved.', status: res.statusCode);
  }

  Future<void> removePhoto() => _send('DELETE', '/loyalty/v1/me/photo');

  Future<void> markRead(String id) => _send('POST', '/loyalty/v1/me/messages/${Uri.encodeComponent(id)}/read');

  Future<void> addWebPush(Map<String, dynamic> subscription) =>
      _send('POST', '/loyalty/v1/me/push', body: {'kind': 'webpush', 'subscription': subscription});

  Future<void> addWindowsChannel(String channelUri) =>
      _send('POST', '/loyalty/v1/me/push', body: {'kind': 'wns', 'channel_uri': channelUri});

  /// A phone's push token: `fcm` on Android, `apns` on an iPhone.
  ///
  /// Sent as `device_token` and not as a channel URI, because it is not a URL —
  /// the server posts to Google's or Apple's gateway, never to an address the
  /// device supplied.
  Future<void> addDeviceToken(String kind, String deviceToken) =>
      _send('POST', '/loyalty/v1/me/push', body: {'kind': kind, 'device_token': deviceToken});

  Future<void> removePush(String endpoint) =>
      _send('DELETE', '/loyalty/v1/me/push', body: {'endpoint': endpoint});

  /// Returns whether they are at the venue now.
  Future<bool> reportLocation({required double latitude, required double longitude, double? accuracy}) async {
    final json = await _send(
      'POST',
      '/loyalty/v1/me/location',
      body: {'latitude': latitude, 'longitude': longitude, 'accuracy': ?accuracy},
    );
    return json['near'] == true;
  }

  Future<void> forgetLocation() => _send('DELETE', '/loyalty/v1/me/location');

  Future<void> signOut() => _send('POST', '/loyalty/v1/me/signout');

  Future<void> removeApp() => _send('DELETE', '/loyalty/v1/me');

  /// A deletion request already made from this membership, if one is waiting.
  Future<Map<String, dynamic>?> deletionRequest() async {
    final json = await _send('GET', '/loyalty/v1/me/deletion');
    return json['request'] as Map<String, dynamic>?;
  }

  /// Ask for this membership's data to be deleted: `scheduled` after [days]
  /// (7, 15 or 30), or `review` for as soon as possible. Vesopa Auth runs it.
  Future<Map<String, dynamic>?> requestDeletion({required String mode, int? days}) async {
    final json = await _send('POST', '/loyalty/v1/me/deletion', body: {
      'mode': mode,
      if (days != null) 'delay_days': days,
    });
    return json['request'] as Map<String, dynamic>?;
  }

  /// Continue with Vesopa before there is a venue: the Store app's way in.
  ///
  /// Needs no [slug] of its own. The server answers with a token and the venue
  /// when this account has been let into one (or into [slug], once chosen),
  /// or with the venues to choose from when it has been let into several. An
  /// account no venue has invited is refused with words to show.
  Future<VesopaWayIn> continueWithVesopa({
    required String idToken,
    String? slug,
    required String platform,
  }) async {
    final json = await _send('POST', '/loyalty/v1/vesopa',
        body: {'id_token': idToken, 'slug': ?slug, 'platform': platform});
    return VesopaWayIn.fromJson(json);
  }
}

/// A venue a Vesopa account has been given.
class VesopaVenue {
  const VesopaVenue({required this.slug, required this.name, this.icon});

  final String slug;
  final String name;
  final String? icon;

  factory VesopaVenue.fromJson(Map<String, dynamic> json) => VesopaVenue(
    slug: json['slug'] as String,
    name: (json['name'] as String?) ?? json['slug'] as String,
    icon: json['icon'] as String?,
  );
}

/// What Continue with Vesopa came back with: signed in, or a choice to make.
class VesopaWayIn {
  const VesopaWayIn({this.token, this.venue, this.venues = const []});

  final String? token;
  final VesopaVenue? venue;
  final List<VesopaVenue> venues;

  factory VesopaWayIn.fromJson(Map<String, dynamic> json) => VesopaWayIn(
    token: json['token'] as String?,
    venue: json['venue'] is Map<String, dynamic>
        ? VesopaVenue.fromJson(json['venue'] as Map<String, dynamic>)
        : null,
    venues: ((json['venues'] as List?) ?? const [])
        .whereType<Map<String, dynamic>>()
        .map(VesopaVenue.fromJson)
        .toList(),
  );
}
