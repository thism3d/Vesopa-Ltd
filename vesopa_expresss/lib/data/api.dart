/// The back office, as the kiosk sees it.
///
/// Nine calls. Everything about money is decided on the other side of these:
/// the kiosk sends item ids and quantities, and is told what they cost, what
/// number the order has, and how the card machine is getting on.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;

import '../config/constants.dart';
import 'models.dart';

class ExpressApiError implements Exception {
  ExpressApiError(this.status, this.message, {this.code});

  /// 0 when the server could not be reached at all.
  final int status;
  final String message;
  final String? code;

  /// This kiosk's token is no good any more: it was removed in the back
  /// office, or never was a kiosk. The only way on is to set it up again.
  bool get signedOut => code == 'kiosk_signed_out' || code == 'kiosk_revoked';

  bool get expressOff => code == 'express_off';

  bool get offline => status == 0;

  @override
  String toString() => message;
}

class ExpressApi {
  ExpressApi({http.Client? client}) : _client = client ?? http.Client();

  final http.Client _client;

  /// The kiosk's own token, once it has one.
  String? token;

  Uri _uri(String path) => Uri.parse('${ExpressConfig.resolvedBase}$path');

  Map<String, String> get _headers => {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'x-express-version': '${ExpressConfig.version}+${ExpressConfig.build}',
    if (token != null) 'Authorization': 'Bearer $token',
  };

  Future<Map<String, dynamic>> _send(String method, String path, [Object? body]) async {
    http.Response res;
    try {
      final request = http.Request(method, _uri(path))
        ..headers.addAll(_headers);
      if (body != null) request.body = jsonEncode(body);
      res = await http.Response.fromStream(
        await _client.send(request).timeout(const Duration(seconds: 25)),
      );
    } on TimeoutException {
      throw ExpressApiError(0, 'The kiosk could not reach the kitchen in time.');
    } on SocketException {
      throw ExpressApiError(0, 'The kiosk has lost its connection.');
    } on http.ClientException {
      throw ExpressApiError(0, 'The kiosk has lost its connection.');
    }

    Map<String, dynamic> json;
    try {
      final decoded = jsonDecode(res.body.isEmpty ? '{}' : res.body);
      json = decoded is Map<String, dynamic> ? decoded : {'data': decoded};
    } catch (_) {
      json = const {};
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw ExpressApiError(
        res.statusCode,
        (json['error'] as String?) ?? 'Something went wrong (${res.statusCode}).',
        code: json['code'] as String?,
      );
    }
    return json;
  }

  /// Whether this server offers Continue with Vesopa, and where to send it.
  /// The till's own question -- a kiosk commissions through the same client.
  Future<({bool enabled, String issuer, String clientId})> vesopaOption() async {
    final j = await _send('GET', '/api/terminal/vesopa/enabled');
    return (
      enabled: j['enabled'] == true && (j['clientId'] as String?) != null,
      issuer: (j['issuer'] as String?) ?? 'https://auth.vesopa.com',
      clientId: (j['clientId'] as String?) ?? '',
    );
  }

  Future<({String token, String kioskName, String venueName, bool passcodeSet})> commission(
    String idToken, {
    String? name,
    String? screen,
  }) async {
    final j = await _send('POST', '/api/express/commission', {
      'id_token': idToken,
      'name': ?name,
      'screen': ?screen,
      'app_version': '${ExpressConfig.version}+${ExpressConfig.build}',
    });
    return (
      token: j['token'] as String,
      kioskName: ((j['kiosk'] as Map?)?['name'] as String?) ?? 'Kiosk',
      venueName: ((j['venue'] as Map?)?['name'] as String?) ?? '',
      passcodeSet: j['passcode_set'] == true,
    );
  }

  /// The config as JSON as well as parsed, so it can be kept on disk -- the
  /// exit passcode has to work with no network.
  Future<(KioskConfig, String)> config() async {
    final j = await _send('GET', '/api/express/kiosk/config');
    return (KioskConfig.fromJson(j), jsonEncode(j));
  }

  Future<KioskMenu> menu() async => KioskMenu.fromJson(await _send('GET', '/api/express/kiosk/menu'));

  Future<void> setFirstPasscode(String passcode) =>
      _send('POST', '/api/express/kiosk/passcode', {'passcode': passcode});

  Future<OrderView> placeOrder({
    required String clientRef,
    required String orderType,
    required String payment,
    required List<Map<String, Object>> lines,
    String? name,
  }) async => OrderView.fromJson(
    await _send('POST', '/api/express/kiosk/orders', {
      'client_ref': clientRef,
      'order_type': orderType,
      'payment': payment,
      'name': ?name,
      'lines': lines,
    }),
  );

  Future<OrderView> order(String publicId) async =>
      OrderView.fromJson(await _send('GET', '/api/express/kiosk/orders/$publicId'));

  Future<OrderView> retry(String publicId) async =>
      OrderView.fromJson(await _send('POST', '/api/express/kiosk/orders/$publicId/retry'));

  Future<OrderView> cancel(String publicId) async =>
      OrderView.fromJson(await _send('POST', '/api/express/kiosk/orders/$publicId/cancel'));

  /// A picture's address. The menu stores uploads as paths on the back office.
  static String? imageUrl(String? raw) {
    if (raw == null || raw.isEmpty) return null;
    if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
    return '${ExpressConfig.resolvedBase}${raw.startsWith('/') ? '' : '/'}$raw';
  }
}
