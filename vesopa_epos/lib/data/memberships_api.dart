/// The Memberships module, from the till: plans, members and today's classes.
///
/// WHAT THIS IS, AND WHAT IT IS NOT
///
/// The back office (vesopa_server/src/memberships.js) decides everything: what
/// a plan costs, where a renewal runs to, how many freeze days are left, who
/// may book a class. This file only asks it, over the same terminal token the
/// gym door and the wallet passes use, and reads the answers into shapes the
/// till can draw. Not one date is worked out here, for the same reason the old
/// renewal never worked one out either: two tills and a back office each
/// adding a term on their own clock is three different expiries for one
/// member.
///
/// NOTHING HERE IS QUEUED
///
/// Joining, renewing, freezing and cancelling are changes to what somebody has
/// paid for. A till that said "frozen" on a request that never arrived has told
/// a member something untrue, so every write either reaches the back office or
/// throws a [MembershipsException] the screen says out loud — the rule
/// `CommerceRepository.renewMembership` has always followed.
///
/// THE MONEY IS NOT HERE EITHER
///
/// A fee is a line on the bill and goes through tendering like everything
/// else; the join or renewal is posted from the settle path once the bill is
/// paid. See data/membership.dart and the settle code in ui/payment_page.dart.
library;

import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

/// Something the back office refused, or could not be asked.
///
/// [status] is the HTTP status, or null when the till never got an answer.
class MembershipsException implements Exception {
  MembershipsException(this.message, {this.status});

  final String message;
  final int? status;

  @override
  String toString() => message;
}

int? _int(Object? v) => switch (v) {
  num n => n.toInt(),
  String s => int.tryParse(s),
  _ => null,
};

String? _text(Object? v) {
  if (v == null) return null;
  final s = v.toString().trim();
  return s.isEmpty ? null : s;
}

bool _bool(Object? v) => v == true || v == 1 || v == '1';

/// A `YYYY-MM-DD` from the server, as local midnight. The same rule as
/// `parseMembershipDay`: only the day is read, so British summer time cannot
/// expire a member an evening early.
DateTime? _day(Object? v) {
  final s = _text(v);
  if (s == null || s.length < 10) return null;
  final d = DateTime.tryParse(s.substring(0, 10));
  return d == null ? null : DateTime(d.year, d.month, d.day);
}

/// `YYYY-MM-DDTHH:MM` in the venue's own clock, read as local time. The server
/// formats class times without a zone on purpose: six o'clock spin is six
/// o'clock on the wall, whatever the database's zone.
DateTime? _moment(Object? v) {
  final s = _text(v);
  if (s == null) return null;
  return DateTime.tryParse(s.replaceFirst(' ', 'T'));
}

/// The date as the server wants it.
String isoDay(DateTime d) =>
    '${d.year.toString().padLeft(4, '0')}-'
    '${d.month.toString().padLeft(2, '0')}-'
    '${d.day.toString().padLeft(2, '0')}';

/// A plan: a loyalty scheme the venue has made a membership.
@immutable
class MemberPlan {
  const MemberPlan({
    required this.id,
    required this.name,
    this.feeMinor = 0,
    this.termMonths = 12,
    this.joiningFeeMinor = 0,
    this.familySize = 1,
    this.freezeDaysPerYear = 0,
    this.includesGym = false,
    this.includesClasses = false,
    this.active = true,
    this.colour,
    this.seasonEnds,
  });

  final int id;
  final String name;
  final int feeMinor;
  final int termMonths;
  final int joiningFeeMinor;
  final int familySize;
  final int freezeDaysPerYear;
  final bool includesGym;
  final bool includesClasses;
  final bool active;
  final String? colour;

  /// The venue's season date, when it runs one.
  final DateTime? seasonEnds;

  /// What joining costs at the counter: the term's fee and the joining fee.
  int get joinTotalMinor => feeMinor + joiningFeeMinor;

  static MemberPlan? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final id = _int(raw['id']);
    if (id == null) return null;
    return MemberPlan(
      id: id,
      name: _text(raw['name']) ?? 'Plan $id',
      feeMinor: _int(raw['fee_minor']) ?? 0,
      termMonths: _int(raw['term_months']) ?? 12,
      joiningFeeMinor: _int(raw['joining_fee_minor']) ?? 0,
      familySize: (_int(raw['family_size']) ?? 1).clamp(1, 99),
      freezeDaysPerYear: _int(raw['freeze_days_per_year']) ?? 0,
      includesGym: _bool(raw['includes_gym']),
      includesClasses: _bool(raw['includes_classes']),
      active: raw['active'] == null || _bool(raw['active']),
      colour: _text(raw['colour']),
      seasonEnds: _day(raw['season_ends']),
    );
  }
}

/// Where a membership stands today. Worked out by the server.
enum MemberState {
  none,
  pending,
  active,
  frozen,
  expired,
  cancelled;

  static MemberState parse(Object? v) => switch (_text(v)) {
    'pending' => MemberState.pending,
    'active' => MemberState.active,
    'frozen' => MemberState.frozen,
    'expired' => MemberState.expired,
    'cancelled' => MemberState.cancelled,
    _ => MemberState.none,
  };

  String get label => switch (this) {
    MemberState.none => 'Not a member',
    MemberState.pending => 'Waiting for approval',
    MemberState.active => 'Active',
    MemberState.frozen => 'Frozen',
    MemberState.expired => 'Expired',
    MemberState.cancelled => 'Cancelled',
  };
}

@immutable
class FamilyMember {
  const FamilyMember({
    required this.id,
    required this.name,
    this.memberNumber,
    this.state = MemberState.none,
    this.payer = false,
  });

  final String id;
  final String name;
  final String? memberNumber;
  final MemberState state;
  final bool payer;

  static FamilyMember? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final id = _text(raw['id']);
    if (id == null) return null;
    return FamilyMember(
      id: id,
      name: _text(raw['name']) ?? '',
      memberNumber: _text(raw['member_number']),
      state: MemberState.parse(raw['state']),
      payer: _bool(raw['payer']),
    );
  }
}

@immutable
class MemberEvent {
  const MemberEvent({
    required this.kind,
    this.expiryAfter,
    this.amountMinor,
    this.note,
    this.via,
    this.at,
  });

  final String kind;
  final DateTime? expiryAfter;
  final int? amountMinor;
  final String? note;
  final String? via;
  final DateTime? at;

  static MemberEvent? fromJson(Object? raw) {
    if (raw is! Map) return null;
    return MemberEvent(
      kind: _text(raw['kind']) ?? '',
      expiryAfter: _day(raw['expiry_after']),
      amountMinor: _int(raw['amount_minor']),
      note: _text(raw['note']),
      via: _text(raw['via']),
      // A real timestamp, Z and all: parsed as the moment it is.
      at: DateTime.tryParse(_text(raw['created_at']) ?? '')?.toLocal(),
    );
  }
}

/// One member, as the list and the card show them.
@immutable
class Member {
  const Member({
    required this.id,
    required this.name,
    this.memberNumber,
    this.email,
    this.phone,
    this.cardNumber,
    this.photoUrl,
    this.state = MemberState.none,
    this.plan,
    this.expiry,
    this.daysLeft,
    this.frozenFrom,
    this.frozenUntil,
    this.freezeScheduled = false,
    this.familyHeadId,
    this.family = const [],
    this.history = const [],
    this.freezeDaysUsed = 0,
  });

  final String id;
  final String name;
  final String? memberNumber;
  final String? email;
  final String? phone;
  final String? cardNumber;
  final String? photoUrl;
  final MemberState state;
  final MemberPlan? plan;
  final DateTime? expiry;
  final int? daysLeft;
  final DateTime? frozenFrom;
  final DateTime? frozenUntil;

  /// A freeze booked to start on a later day.
  final bool freezeScheduled;

  /// The payer, when this member is on somebody else's family plan.
  final String? familyHeadId;
  final List<FamilyMember> family;
  final List<MemberEvent> history;
  final int freezeDaysUsed;

  bool get isFamilyMember => familyHeadId != null;

  /// Freeze days this plan still allows in the rolling year.
  int get freezeDaysLeft {
    final allowed = plan?.freezeDaysPerYear ?? 0;
    return (allowed - freezeDaysUsed).clamp(0, allowed);
  }

  /// Whether another person can still go on this family plan.
  bool get familyHasRoom =>
      !isFamilyMember &&
      plan != null &&
      plan!.familySize > 1 &&
      family.length < plan!.familySize;

  static Member? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final id = _text(raw['id']);
    if (id == null) return null;
    return Member(
      id: id,
      name: _text(raw['name']) ?? '',
      memberNumber: _text(raw['member_number']) ?? _text(raw['member_no']),
      email: _text(raw['email']),
      phone: _text(raw['phone']),
      cardNumber: _text(raw['card_number']),
      photoUrl: _text(raw['photo_url']),
      state: MemberState.parse(raw['state']),
      plan: MemberPlan.fromJson(raw['plan']),
      expiry: _day(raw['membership_expiry']),
      daysLeft: _int(raw['days_left']),
      frozenFrom: _day(raw['frozen_from']),
      frozenUntil: _day(raw['frozen_until']),
      freezeScheduled: _bool(raw['freeze_scheduled']),
      familyHeadId: _text(raw['family_head_id']),
      family: [
        for (final f in (raw['family'] is List ? raw['family'] as List : const []))
          ?FamilyMember.fromJson(f),
      ],
      history: [
        for (final e
            in (raw['history'] is List ? raw['history'] as List : const []))
          ?MemberEvent.fromJson(e),
      ],
      freezeDaysUsed: _int(raw['freeze_days_used']) ?? 0,
    );
  }
}

/// A class on the timetable, on one day.
@immutable
class ClassSession {
  const ClassSession({
    required this.id,
    required this.name,
    this.startsAt,
    this.endsAt,
    this.capacity = 0,
    this.booked = 0,
    this.waiting = 0,
    this.attended = 0,
    this.instructor,
    this.room,
    this.cancelled = false,
    this.dropInMinor,
    this.colour,
    this.bookings = const [],
  });

  final int id;
  final String name;
  final DateTime? startsAt;
  final DateTime? endsAt;
  final int capacity;
  final int booked;
  final int waiting;
  final int attended;
  final String? instructor;
  final String? room;
  final bool cancelled;

  /// What somebody not covered by a membership pays. Null: members only.
  final int? dropInMinor;
  final String? colour;
  final List<ClassBooking> bookings;

  int get spaces => (capacity - booked).clamp(0, capacity);

  static ClassSession? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final id = _int(raw['id']);
    if (id == null) return null;
    final bookings = [
      for (final b
          in (raw['bookings'] is List ? raw['bookings'] as List : const []))
        ?ClassBooking.fromJson(b),
    ];
    // The single-session answer carries bookings and no counts; the list
    // carries counts and no bookings. Either way the screen shows both.
    final counted = raw['booked'] != null;
    return ClassSession(
      id: id,
      name: _text(raw['name']) ?? 'Class',
      startsAt: _moment(raw['starts_at']),
      endsAt: _moment(raw['ends_at']),
      capacity: _int(raw['capacity']) ?? 0,
      booked: counted
          ? _int(raw['booked']) ?? 0
          : bookings
                .where((b) => b.status == 'booked' || b.status == 'attended')
                .length,
      waiting: counted
          ? _int(raw['waiting']) ?? 0
          : bookings.where((b) => b.status == 'waitlist').length,
      attended: counted
          ? _int(raw['attended']) ?? 0
          : bookings.where((b) => b.status == 'attended').length,
      instructor: _text(raw['instructor']),
      room: _text(raw['room']),
      cancelled: _bool(raw['cancelled']),
      dropInMinor: _int(raw['drop_in_minor']),
      colour: _text(raw['colour']),
      bookings: bookings,
    );
  }
}

@immutable
class ClassBooking {
  const ClassBooking({
    required this.customerId,
    required this.name,
    required this.status,
    this.memberNumber,
    this.via,
  });

  final String customerId;
  final String name;

  /// booked, attended, waitlist or no_show.
  final String status;
  final String? memberNumber;
  final String? via;

  bool get attended => status == 'attended';

  static ClassBooking? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final id = _text(raw['customer_id']);
    if (id == null) return null;
    return ClassBooking(
      customerId: id,
      name: _text(raw['name']) ?? '',
      status: _text(raw['status']) ?? 'booked',
      memberNumber: _text(raw['member_no']),
      via: _text(raw['via']),
    );
  }
}

// -----------------------------------------------------------------------------
// Which modules this venue runs
// -----------------------------------------------------------------------------

const _keyModules = 'till.modules';

/// The modules switched on for this venue, from `GET /till/modules`.
///
/// Stored and then pulled, exactly as the gym rules are: a till that started
/// with no network shows what it showed yesterday rather than losing the
/// Members section until the broadband comes up. Only the keys that are ON are
/// sent, so "not allowed" and "switched off" are the same answer here.
class TillModules {
  TillModules({
    required this.apiBase,
    required this.terminalToken,
    http.Client? client,
  }) : _client = client ?? http.Client();

  final String apiBase;
  final String? terminalToken;
  final http.Client _client;

  Set<String> _on = const {};

  Set<String> get on => Set.unmodifiable(_on);

  bool isOn(String key) => _on.contains(key);

  /// Whether the Memberships module is on, and this till can take part —
  /// every route behind it wants the terminal token.
  bool get memberships =>
      isOn('memberships') && (terminalToken ?? '').isNotEmpty;

  /// What this terminal knew last time. Never throws.
  Future<void> load() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final saved = prefs.getStringList(_keyModules);
      if (saved != null) _on = saved.toSet();
    } catch (_) {
      // Nothing stored, or nothing readable: no modules, which is what a new
      // till shows.
    }
  }

  /// Ask the back office. Returns whether it answered; keeps what it had when
  /// it did not.
  Future<bool> sync() async {
    final token = terminalToken;
    if (token == null || token.isEmpty) return false;
    try {
      final res = await _client
          .get(
            Uri.parse('$apiBase/till/modules'),
            headers: {'Authorization': 'Bearer $token'},
          )
          .timeout(const Duration(seconds: 8));
      if (res.statusCode != 200) return false;
      final body = jsonDecode(res.body);
      final list = body is Map ? body['on'] : null;
      if (list is! List) return false;
      _on = {for (final k in list) k.toString()};
      final prefs = await SharedPreferences.getInstance();
      await prefs.setStringList(_keyModules, _on.toList()..sort());
      return true;
    } catch (_) {
      return false;
    }
  }

  @visibleForTesting
  void debugSet(Set<String> on) => _on = on;
}

// -----------------------------------------------------------------------------
// The routes
// -----------------------------------------------------------------------------

class MembershipsRepository {
  MembershipsRepository({
    required this.apiBase,
    required this.terminalToken,
    http.Client? client,
  }) : _client = client ?? http.Client();

  final String apiBase;
  final String? terminalToken;
  final http.Client _client;
  static const _timeout = Duration(seconds: 10);

  bool get available => (terminalToken ?? '').isNotEmpty;

  Future<Object?> _send(String method, String path, {Object? body}) async {
    final token = terminalToken;
    if (token == null || token.isEmpty) {
      throw MembershipsException(
        'This till has no terminal token, so it cannot reach memberships. '
        'Sign it in to the venue again.',
      );
    }
    final uri = Uri.parse('$apiBase$path');
    final headers = {
      'Authorization': 'Bearer $token',
      if (body != null) 'Content-Type': 'application/json',
    };
    final http.Response res;
    try {
      res = await (method == 'GET'
              ? _client.get(uri, headers: headers)
              : _client.post(
                  uri,
                  headers: headers,
                  body: jsonEncode(body ?? const {}),
                ))
          .timeout(_timeout);
    } catch (_) {
      throw MembershipsException(
        'The till could not reach the back office. Nothing was changed.',
      );
    }
    Object? decoded;
    try {
      decoded = jsonDecode(res.body);
    } catch (_) {
      decoded = null;
    }
    if (res.statusCode >= 400) {
      final said = decoded is Map ? _text(decoded['error']) : null;
      throw MembershipsException(
        said ??
            (res.statusCode == 404
                ? 'Memberships are not switched on for this venue.'
                : 'The back office refused that (${res.statusCode}).'),
        status: res.statusCode,
      );
    }
    return decoded;
  }

  Member _member(Object? raw) {
    final m = Member.fromJson(raw);
    if (m == null) {
      throw MembershipsException('The back office sent back no member.');
    }
    return m;
  }

  Future<List<MemberPlan>> plans() async {
    final list = await _send('GET', '/till/memberships/plans');
    return [
      if (list is List)
        for (final p in list) ?MemberPlan.fromJson(p),
    ];
  }

  Future<List<Member>> search(String query, {String? state}) async {
    final params = [
      if (query.trim().isNotEmpty) 'q=${Uri.encodeComponent(query.trim())}',
      if (state != null) 'state=${Uri.encodeComponent(state)}',
    ].join('&');
    final list = await _send(
      'GET',
      '/till/memberships/members${params.isEmpty ? '' : '?$params'}',
    );
    return [
      if (list is List)
        for (final m in list) ?Member.fromJson(m),
    ];
  }

  Future<Member> member(String id) async => _member(
    await _send('GET', '/till/memberships/members/${Uri.encodeComponent(id)}'),
  );

  /// Join a plan. [customerId] for somebody the venue knows; [newCustomer]
  /// (name, email, phone, card_number) for somebody it does not. A family
  /// member gives [familyHeadId] and no plan — they take the payer's.
  Future<Member> join({
    int? schemeId,
    String? customerId,
    Map<String, String>? newCustomer,
    String? familyHeadId,
    int? amountMinor,
    String? staff,
  }) async => _member(
    await _send(
      'POST',
      '/till/memberships/members',
      body: {
        'scheme_id': ?schemeId,
        'customer_id': ?customerId,
        'customer': ?newCustomer,
        'family_head_id': ?familyHeadId,
        'amount_minor': ?amountMinor,
        'staff': ?staff,
      },
    ),
  );

  Future<Member> _action(
    String id,
    String action, [
    Map<String, Object?> body = const {},
  ]) async => _member(
    await _send(
      'POST',
      '/till/memberships/members/${Uri.encodeComponent(id)}/$action',
      body: body,
    ),
  );

  Future<Member> renew(String id, {int? amountMinor, String? staff}) =>
      _action(id, 'renew', {'amount_minor': ?amountMinor, 'staff': ?staff});

  Future<Member> freeze(
    String id, {
    required DateTime from,
    required DateTime until,
    String? staff,
  }) => _action(id, 'freeze', {
    'from': isoDay(from),
    'until': isoDay(until),
    'staff': ?staff,
  });

  Future<Member> unfreeze(String id, {String? staff}) =>
      _action(id, 'unfreeze', {'staff': ?staff});

  /// Cancel. [now] ends it today; otherwise it runs to its expiry and stops.
  Future<Member> cancel(String id, {bool now = false, String? staff}) =>
      _action(id, 'cancel', {'now': now, 'staff': ?staff});

  /// Undo a cancellation, or approve a member waiting for approval.
  Future<Member> reinstate(String id, {String? staff}) =>
      _action(id, 'reinstate', {'staff': ?staff});

  // ---- Classes ---------------------------------------------------------------

  Future<List<ClassSession>> sessions(DateTime from, {DateTime? to}) async {
    final list = await _send(
      'GET',
      '/till/classes/sessions?from=${isoDay(from)}&to=${isoDay(to ?? from)}',
    );
    return [
      if (list is List)
        for (final s in list) ?ClassSession.fromJson(s),
    ];
  }

  Future<ClassSession> session(int id) async {
    final s = ClassSession.fromJson(
      await _send('GET', '/till/classes/sessions/$id'),
    );
    if (s == null) throw MembershipsException('No such class.');
    return s;
  }

  /// Returns the booking status: booked or waitlist.
  Future<String> book(int sessionId, String customerId, {bool dropIn = false}) async {
    final r = await _send(
      'POST',
      '/till/classes/sessions/$sessionId/book',
      body: {'customer_id': customerId, 'drop_in': dropIn},
    );
    return (r is Map ? _text(r['status']) : null) ?? 'booked';
  }

  Future<void> unbook(int sessionId, String customerId) => _send(
    'POST',
    '/till/classes/sessions/$sessionId/unbook',
    body: {'customer_id': customerId},
  );

  Future<void> checkIn(
    int sessionId,
    String customerId, {
    bool dropIn = false,
  }) => _send(
    'POST',
    '/till/classes/sessions/$sessionId/checkin',
    body: {'customer_id': customerId, 'drop_in': dropIn},
  );
}

/// Whether a refusal from book or check-in means "only as a drop-in".
///
/// The server says so in words — "Not covered by a membership. Book as a
/// drop-in (5.00)." — and a 409. Read here, in one place, so the screen can
/// offer the drop-in rather than repeat the refusal.
bool needsDropIn(MembershipsException e) =>
    e.status == 409 && e.message.toLowerCase().contains('drop-in');
