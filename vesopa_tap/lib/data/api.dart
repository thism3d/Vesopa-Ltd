/// Vesopa Tap's calls to the back office.
///
/// A Tap phone is a terminal. It is commissioned like a till and reads the
/// till's own endpoints (staff, screens, open bills), so a table opened on a
/// phone is on every till at once and the other way round. Card payments go
/// through /api/tap/* (vesopa_server/src/tap.js): the venue's Dojo key never
/// comes to the phone.
library;

import 'dart:convert';

import 'package:http/http.dart' as http;

import '../config/constants.dart';
import 'models.dart';

class TapApiError implements Exception {
  const TapApiError(this.status, this.message);
  final int status;
  final String message;
  @override
  String toString() => message;
}

class TapApi {
  TapApi({this.base = apiBase, http.Client? client}) : _client = client ?? http.Client();

  final String base;
  final http.Client _client;

  /// The terminal token, once commissioned.
  String? token;

  Future<Map<String, dynamic>> _send(String method, String path, [Object? body]) async {
    final req = http.Request(method, Uri.parse('$base$path'))
      ..headers.addAll({
        'Accept': 'application/json',
        if (body != null) 'Content-Type': 'application/json',
        if (token != null) 'Authorization': 'Bearer $token',
      });
    if (body != null) req.body = jsonEncode(body);
    final http.Response res;
    try {
      res = await http.Response.fromStream(await _client.send(req).timeout(const Duration(seconds: 20)));
    } catch (_) {
      throw const TapApiError(0, 'No connection to Vesopa. Check the wifi or mobile data.');
    }
    Map<String, dynamic> j;
    try {
      final d = res.body.isEmpty ? <String, dynamic>{} : jsonDecode(res.body);
      j = d is Map<String, dynamic> ? d : {'items': d};
    } catch (_) {
      j = {};
    }
    if (res.statusCode >= 400) {
      throw TapApiError(res.statusCode, (j['error'] as String?) ?? 'Vesopa answered ${res.statusCode}.');
    }
    return j;
  }

  // ---- Setting the phone up --------------------------------------------------

  /// Continue with Vesopa: an ID token in, a terminal token out. Shared with
  /// the till; `app: tap` lets the back office show it as a phone.
  Future<Map<String, dynamic>> commission(String idToken, {required String device, required String platform}) =>
      _send('POST', '/api/terminal/vesopa/commission', {
        'id_token': idToken,
        'app': 'tap',
        'name': device,
        'platform': platform,
      });

  /// A login that runs several sites picks one with the five-minute pass.
  Future<Map<String, dynamic>> commissionSite(String pickToken, int officeId, {required String device}) =>
      _send('POST', '/api/terminal/vesopa/commission/site', {
        'pick_token': pickToken,
        'office_id': officeId,
        'app': 'tap',
        'name': device,
      });

  /// A new venue on Vesopa Tap alone (docs/PLAN.md, phase 2: server side).
  Future<Map<String, dynamic>> registerVenue({
    required String idToken,
    required String venueName,
    required String businessType,
    required String postcode,
  }) =>
      _send('POST', '/api/tap/register', {
        'id_token': idToken,
        'venue_name': venueName,
        'business_type': businessType,
        'postcode': postcode,
      });

  // ---- What the venue is selling, and who works there ---------------------------

  Future<List<Clerk>> staff() async {
    final j = await _send('GET', '/api/till/staff');
    final list = (j['staff'] ?? j['items'] ?? const []) as List;
    return [for (final s in list) Clerk.fromJson(s as Map<String, dynamic>)];
  }

  Future<Map<String, dynamic>> screens() => _send('GET', '/api/till/screens');

  // ---- Shared open bills (vesopa_server/src/terminals.js) --------------------------

  Future<Map<String, dynamic>> openBills({int since = 0}) => _send('GET', '/api/till/open-bills?since=$since');
  Future<Map<String, dynamic>> saveBill(Map<String, Object?> bill) => _send('POST', '/api/till/open-bills', bill);
  Future<Map<String, dynamic>> claimBill(String id) => _send('POST', '/api/till/open-bills/$id/claim');

  // ---- Card payments on this phone (vesopa_server/src/tap.js) ----------------------

  Future<Map<String, dynamic>> tapConfig() => _send('GET', '/api/tap/config');

  /// A Tap to Pay terminal secret for Dojo's SDK (six hours).
  Future<String> tapSecret(String platform) async =>
      (await _send('POST', '/api/tap/secret', {'platform': platform}))['secret'] as String;

  Future<Map<String, dynamic>> createPayment({
    required String id,
    required int amountMinor,
    int tipMinor = 0,
    String? billRef,
    String? clerk,
  }) =>
      _send('POST', '/api/tap/payments', {
        'id': id,
        'amount_minor': amountMinor,
        'tip_minor': tipMinor,
        'bill_ref': billRef,
        'clerk': clerk,
      });

  Future<Map<String, dynamic>> payment(String id) => _send('GET', '/api/tap/payments/$id');
  Future<Map<String, dynamic>> cancelPayment(String id) => _send('POST', '/api/tap/payments/$id/cancel');
}
