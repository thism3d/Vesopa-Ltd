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

  /// The server, e.g. https://menu.vesopaepos.com.
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

  // ---- The member -----------------------------------------------------------

  Future<Map<String, dynamic>> me() => _send('GET', '/loyalty/v1/me');

  Future<Map<String, dynamic>> history({DateTime? before}) => _send(
    'GET',
    '/loyalty/v1/me/history',
    query: {if (before != null) 'before': before.toUtc().toIso8601String()},
  );

  Future<Map<String, dynamic>> messages() => _send('GET', '/loyalty/v1/me/messages');

  Future<void> markRead(String id) => _send('POST', '/loyalty/v1/me/messages/${Uri.encodeComponent(id)}/read');

  Future<void> addWebPush(Map<String, dynamic> subscription) =>
      _send('POST', '/loyalty/v1/me/push', body: {'kind': 'webpush', 'subscription': subscription});

  Future<void> addWindowsChannel(String channelUri) =>
      _send('POST', '/loyalty/v1/me/push', body: {'kind': 'wns', 'channel_uri': channelUri});

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
}
