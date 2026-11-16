/// Vesopa AI's server calls from Go (vesopa_server/src/ai_advisor.js).
///
/// A Go phone holds a terminal token, which on purpose opens nothing of the
/// back office. Vesopa AI is for managers, so a manager's id and PIN buy a
/// two-hour `ai` token (POST /api/tap/ai/session; the server checks the PIN
/// and the till's is_manager itself), and that token opens the /api/ai routes
/// and nothing else.
///
/// Every figure arrives worked out by the server. This file only carries it.
library;

import 'dart:convert';

import 'package:http/http.dart' as http;

import '../data/api.dart';

class AdvisorApi {
  AdvisorApi(this.tap, {http.Client? client}) : _client = client ?? http.Client();

  final TapApi tap;
  final http.Client _client;
  String? _token;
  DateTime? _expires;
  int? _clerkId;

  bool get signedIn => _token != null && _expires != null && DateTime.now().isBefore(_expires!);

  /// A manager's id and PIN, checked by the server.
  Future<void> signIn(int clerkId, String pin) async {
    if (signedIn && _clerkId == clerkId) return;
    final r = await tap.post('/api/tap/ai/session', {'clerk_id': clerkId, 'pin': pin});
    _token = r['token'] as String?;
    _clerkId = clerkId;
    final secs = (r['expires_in'] as num?)?.toInt() ?? 7200;
    _expires = DateTime.now().add(Duration(seconds: secs - 60));
  }

  void signOut() {
    _token = null;
    _expires = null;
    _clerkId = null;
  }

  Future<dynamic> _send(String method, String path, [Object? body]) async {
    final req = http.Request(method, Uri.parse('${tap.base}$path'))
      ..headers.addAll({
        'Accept': 'application/json',
        if (body != null) 'Content-Type': 'application/json',
        if (_token != null) 'Authorization': 'Bearer $_token',
      });
    if (body != null) req.body = jsonEncode(body);
    final http.Response res;
    try {
      res = await http.Response.fromStream(await _client.send(req).timeout(const Duration(seconds: 45)));
    } catch (_) {
      throw const TapApiError(0, 'No connection to Vesopa. Check the wifi or mobile data.');
    }
    dynamic j;
    try {
      j = res.body.isEmpty ? <String, dynamic>{} : jsonDecode(res.body);
    } catch (_) {
      j = <String, dynamic>{};
    }
    if (res.statusCode == 401) signOut();
    if (res.statusCode >= 400) {
      final msg = j is Map ? j['error'] as String? : null;
      throw TapApiError(res.statusCode, msg ?? 'Vesopa answered ${res.statusCode}.');
    }
    return j;
  }

  String _site(String? site) => site == null || site.isEmpty ? '' : '?site=${Uri.encodeQueryComponent(site)}';

  Future<Map<String, dynamic>> me() async => (await _send('GET', '/api/ai/me')) as Map<String, dynamic>;

  Future<Map<String, dynamic>> briefing({String? site}) async =>
      (await _send('GET', '/api/ai/briefing${_site(site)}')) as Map<String, dynamic>;

  Future<Map<String, dynamic>> ask(String question, {int? conversationId, String? site, bool save = true}) async =>
      (await _send('POST', '/api/ai/ask', {
        'question': question,
        'conversation_id': ?conversationId,
        if (site != null && site.isNotEmpty) 'site': site,
        if (!save) 'save': false,
      })) as Map<String, dynamic>;

  Future<List<Map<String, dynamic>>> conversations() async =>
      ((await _send('GET', '/api/ai/conversations')) as List).cast<Map<String, dynamic>>();

  Future<Map<String, dynamic>> conversation(int id) async =>
      (await _send('GET', '/api/ai/conversations/$id')) as Map<String, dynamic>;

  Future<Map<String, dynamic>> records(Map<String, dynamic> rec, {String? site}) async {
    final q = <String, String>{'kind': '${rec['kind']}'};
    if (rec['from'] != null) {
      q['from'] = '${rec['from']}';
      q['to'] = '${rec['to']}';
    }
    if (site != null && site.isNotEmpty) q['site'] = site;
    return (await _send('GET', '/api/ai/records?${Uri(queryParameters: q).query}')) as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> invite({required String email, String? name, List<int> sites = const [], bool profit = false, bool staff = false}) async =>
      (await _send('POST', '/api/ai/invites', {'email': email, 'name': ?name, 'sites': sites, 'profit': profit, 'staff': staff})) as Map<String, dynamic>;
}
