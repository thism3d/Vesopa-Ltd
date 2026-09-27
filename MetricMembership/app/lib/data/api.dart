import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

/// Something the server said no to, in words a member can read.
class ApiError implements Exception {
  ApiError(this.message, {this.status = 0, this.code = ''});

  final String message;
  final int status;
  final String code;

  bool get signedOut => status == 401;

  @override
  String toString() => message;
}

/// Where the Metric server is, and what this build is.
class AppConfig {
  /// The web app is served by the server it talks to, so it asks its own
  /// address. Everything else was built knowing it.
  static const _apiOverride = String.fromEnvironment('METRIC_API');
  static String get apiBase {
    if (_apiOverride.isNotEmpty) return _apiOverride;
    if (kIsWeb) return Uri.base.origin;
    return 'https://metric.vesopa.com';
  }

  static const version = '1.0.0';

  /// What the activity log records this app as.
  static String get platform {
    if (kIsWeb) return 'web';
    return switch (defaultTargetPlatform) {
      TargetPlatform.android => 'android',
      TargetPlatform.iOS => 'ios',
      TargetPlatform.windows => 'windows',
      TargetPlatform.macOS => 'macos',
      _ => 'other',
    };
  }

  static String get appLabel => 'metric-$platform $version';
}

/// The Metric membership API: `/api/v1` on metric.vesopa.com.
class MetricApi {
  MetricApi({String? base, http.Client? client})
    : base = base ?? AppConfig.apiBase,
      _http = client ?? http.Client();

  final String base;
  final http.Client _http;

  String? token;

  static const _timeout = Duration(seconds: 20);

  Map<String, String> get _headers => {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-Metric-App': AppConfig.appLabel,
    if (token != null) 'Authorization': 'Bearer $token',
  };

  Future<Map<String, dynamic>> _send(String method, String path, {Object? body}) async {
    final http.Response res;
    try {
      final req = http.Request(method, Uri.parse('$base/api/v1$path'))..headers.addAll(_headers);
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
    throw ApiError(
      (json['error'] as String?) ?? 'Something went wrong. Please try again.',
      status: res.statusCode,
      code: (json['code'] as String?) ?? '',
    );
  }

  /// The Vesopa Auth client this server was set up with.
  Future<String> authClientId() async => ((await _send('GET', '/brand'))['authClientId'] as String?) ?? '';

  /// What Metric's staff chose under Appearance in the console.
  Future<Map<String, dynamic>> brand() => _send('GET', '/brand');

  /// Continue with Vesopa. Web sends the code; native sends the id token.
  Future<({String token, Member member})> signIn({
    String? code,
    String? verifier,
    String? redirectUri,
    String? idToken,
  }) async {
    final json = await _send('POST', '/auth/vesopa', body: {
      'code': ?code,
      'verifier': ?verifier,
      'redirectUri': ?redirectUri,
      'idToken': ?idToken,
    });
    return (token: json['token'] as String, member: Member.fromJson(json['member'] as Map<String, dynamic>));
  }

  Future<Account> me() async => Account.fromJson(await _send('GET', '/me'));

  Future<Member> updateMe({String? name, String? phone, String? company}) async {
    final json = await _send('PATCH', '/me', body: {'name': ?name, 'phone': ?phone, 'company': ?company});
    return Member.fromJson(json['member'] as Map<String, dynamic>);
  }

  Future<void> deleteAccount() => _send('DELETE', '/me');

  Future<Vehicle> addVehicle({required String plate, String make = '', String colour = '', String nickname = ''}) async {
    final json = await _send('POST', '/vehicles', body: {'plate': plate, 'make': make, 'colour': colour, 'nickname': nickname});
    return Vehicle.fromJson(json['vehicle'] as Map<String, dynamic>);
  }

  Future<void> removeVehicle(int id) => _send('DELETE', '/vehicles/$id');

  Future<List<Visit>> visits() async {
    final json = await _send('GET', '/visits');
    return ((json['visits'] as List?) ?? const []).map((v) => Visit.fromJson(v as Map<String, dynamic>)).toList();
  }

  Future<List<Site>> sites() async {
    final json = await _send('GET', '/sites');
    return ((json['sites'] as List?) ?? const []).map((v) => Site.fromJson(v as Map<String, dynamic>)).toList();
  }

  Future<void> log(List<Map<String, dynamic>> events) => _send('POST', '/log', body: {'events': events});
}

class Member {
  const Member({
    required this.id,
    required this.memberNo,
    required this.name,
    required this.email,
    required this.phone,
    required this.company,
    required this.status,
    required this.standing,
    this.validFrom,
    this.validTo,
    this.planName = '',
    this.maxVehicles = 3,
  });

  final int id;
  final String memberNo;
  final String name;
  final String email;
  final String phone;
  final String company;

  /// pending | active | suspended | closed
  final String status;

  /// Why the barrier would or would not open today: ok, pending, suspended,
  /// expired, not_started ...
  final String standing;
  final String? validFrom;
  final String? validTo;
  final String planName;
  final int maxVehicles;

  bool get opensBarriers => standing == 'ok';

  factory Member.fromJson(Map<String, dynamic> j) {
    final plan = j['plan'] as Map<String, dynamic>?;
    return Member(
      id: (j['id'] as num).toInt(),
      memberNo: (j['memberNo'] as String?) ?? '',
      name: (j['name'] as String?) ?? '',
      email: (j['email'] as String?) ?? '',
      phone: (j['phone'] as String?) ?? '',
      company: (j['company'] as String?) ?? '',
      status: (j['status'] as String?) ?? 'pending',
      standing: (j['standing'] as String?) ?? 'pending',
      validFrom: j['validFrom'] as String?,
      validTo: j['validTo'] as String?,
      planName: (plan?['name'] as String?) ?? '',
      maxVehicles: (plan?['maxVehicles'] as num?)?.toInt() ?? 3,
    );
  }
}

class Vehicle {
  const Vehicle({
    required this.id,
    required this.plate,
    required this.display,
    this.make = '',
    this.colour = '',
    this.nickname = '',
    this.lastSeen,
  });

  final int id;
  final String plate;
  final String display;
  final String make;
  final String colour;
  final String nickname;
  final LastSeen? lastSeen;

  String get description => [colour, make].where((s) => s.isNotEmpty).join(' ');

  factory Vehicle.fromJson(Map<String, dynamic> j) => Vehicle(
    id: (j['id'] as num).toInt(),
    plate: (j['plate'] as String?) ?? '',
    display: (j['display'] as String?) ?? (j['plate'] as String? ?? ''),
    make: (j['make'] as String?) ?? '',
    colour: (j['colour'] as String?) ?? '',
    nickname: (j['nickname'] as String?) ?? '',
    lastSeen: j['lastSeen'] is Map<String, dynamic> ? LastSeen.fromJson(j['lastSeen'] as Map<String, dynamic>) : null,
  );
}

class LastSeen {
  const LastSeen({required this.direction, required this.at, required this.site});
  final String direction;
  final DateTime at;
  final String site;

  factory LastSeen.fromJson(Map<String, dynamic> j) => LastSeen(
    direction: (j['direction'] as String?) ?? 'unknown',
    at: DateTime.tryParse((j['at'] as String?) ?? '')?.toLocal() ?? DateTime.now(),
    site: (j['site'] as String?) ?? '',
  );
}

class Visit {
  const Visit({
    required this.plate,
    this.display = '',
    required this.direction,
    required this.decision,
    required this.reason,
    required this.at,
    required this.site,
    required this.gate,
  });

  final String plate;
  final String display;
  final String direction;
  final String decision;
  final String reason;
  final DateTime at;
  final String site;
  final String gate;

  bool get opened => decision == 'open';

  factory Visit.fromJson(Map<String, dynamic> j) => Visit(
    plate: (j['plate'] as String?) ?? '',
    display: (j['display'] as String?) ?? '',
    direction: (j['direction'] as String?) ?? 'unknown',
    decision: (j['decision'] as String?) ?? 'deny',
    reason: (j['reason'] as String?) ?? '',
    at: DateTime.tryParse((j['at'] as String?) ?? '')?.toLocal() ?? DateTime.now(),
    site: (j['site'] as String?) ?? '',
    gate: (j['gate'] as String?) ?? '',
  );
}

class Site {
  const Site({required this.id, required this.name, required this.address});
  final int id;
  final String name;
  final String address;

  factory Site.fromJson(Map<String, dynamic> j) =>
      Site(id: (j['id'] as num).toInt(), name: (j['name'] as String?) ?? '', address: (j['address'] as String?) ?? '');
}

class Account {
  const Account({required this.member, required this.vehicles});
  final Member member;
  final List<Vehicle> vehicles;

  factory Account.fromJson(Map<String, dynamic> j) => Account(
    member: Member.fromJson(j['member'] as Map<String, dynamic>),
    vehicles: ((j['vehicles'] as List?) ?? const []).map((v) => Vehicle.fromJson(v as Map<String, dynamic>)).toList(),
  );
}
