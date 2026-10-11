/// The Events & tickets module, from the till: the gate.
///
/// WHAT THIS IS
///
/// The back office (the Events & tickets module) sells the tickets and keeps
/// the list of who has been let in. The till does two things with it at the
/// gate: shows the events from yesterday to a week ahead with how many have
/// been sold and how many are through the door, and checks a ticket in when it
/// is scanned or typed.
///
/// Same terminal token as every other `/till/*` call — see
/// data/memberships_api.dart, whose shape this copies.
///
/// NOTHING HERE IS QUEUED, AND NOTHING IS DECIDED HERE
///
/// "Admit" is the back office's answer, never the till's. A till that let
/// somebody in on a ticket it could not check would let the same screenshot in
/// at every gate in the venue, so a check-in either reaches the back office or
/// throws a [TicketsException] that the gate says out loud. The code is sent
/// exactly as scanned — the server strips the `VT:` a ticket's QR carries.
library;

import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

/// Something the back office refused, or could not be asked.
///
/// [status] is the HTTP status, or null when the till never got an answer.
class TicketsException implements Exception {
  TicketsException(this.message, {this.status});

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

/// `YYYY-MM-DDTHH:MM` in the venue's own clock, read as local time — the same
/// rule as a class's start time. A full timestamp with a zone is read as the
/// moment it is.
DateTime? _moment(Object? v) {
  final s = _text(v);
  if (s == null) return null;
  final t = DateTime.tryParse(s.replaceFirst(' ', 'T'));
  if (t == null) return null;
  return t.isUtc ? t.toLocal() : t;
}

@immutable
class TicketType {
  const TicketType({required this.id, required this.name, this.priceMinor = 0});

  final int id;
  final String name;
  final int priceMinor;

  static TicketType? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final id = _int(raw['id']);
    if (id == null) return null;
    return TicketType(
      id: id,
      name: _text(raw['name']) ?? 'Ticket',
      priceMinor: _int(raw['price_minor']) ?? 0,
    );
  }
}

/// One event, as the gate lists it.
@immutable
class TicketEvent {
  const TicketEvent({
    required this.id,
    required this.title,
    this.startsAt,
    this.types = const [],
    this.sold = 0,
    this.checkedIn = 0,
  });

  final int id;
  final String title;
  final DateTime? startsAt;
  final List<TicketType> types;
  final int sold;
  final int checkedIn;

  /// Sold and not yet through the door.
  int get toCome => (sold - checkedIn).clamp(0, sold);

  static TicketEvent? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final id = _int(raw['id']);
    if (id == null) return null;
    return TicketEvent(
      id: id,
      title: _text(raw['title']) ?? 'Event $id',
      startsAt: _moment(raw['starts_at']),
      types: [
        for (final t
            in (raw['ticket_types'] is List
                ? raw['ticket_types'] as List
                : const []))
          ?TicketType.fromJson(t),
      ],
      sold: _int(raw['sold']) ?? 0,
      checkedIn: _int(raw['checked_in']) ?? 0,
    );
  }
}

/// The ticket the back office found.
@immutable
class ScannedTicket {
  const ScannedTicket({
    this.code,
    this.eventTitle,
    this.startsAt,
    this.type,
    this.holder,
  });

  final String? code;
  final String? eventTitle;
  final DateTime? startsAt;
  final String? type;
  final String? holder;

  static ScannedTicket? fromJson(Object? raw) {
    if (raw is! Map) return null;
    return ScannedTicket(
      code: _text(raw['code']),
      eventTitle: _text(raw['event_title']),
      startsAt: _moment(raw['starts_at']),
      type: _text(raw['type']),
      holder: _text(raw['holder']),
    );
  }
}

enum CheckinOutcome {
  /// First scan: let them in.
  admitted,

  /// This ticket has been through the gate already.
  alreadyUsed,

  /// No such ticket.
  invalid,
}

/// What the gate shows after a scan.
@immutable
class CheckinResult {
  const CheckinResult({
    required this.outcome,
    this.ticket,
    this.checkedInAt,
    this.message,
  });

  final CheckinOutcome outcome;
  final ScannedTicket? ticket;

  /// When it was first scanned, for [CheckinOutcome.alreadyUsed].
  final DateTime? checkedInAt;

  /// The server's own words, when it gave some.
  final String? message;

  bool get admitted => outcome == CheckinOutcome.admitted;

  /// Read one answer from `POST /till/events/checkin`. Null when it is not an
  /// answer at all.
  static CheckinResult? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final ticket = ScannedTicket.fromJson(raw['ticket']);
    if (raw['ok'] == true) {
      return CheckinResult(
        outcome: CheckinOutcome.admitted,
        ticket: ticket,
        message: _text(raw['message']),
      );
    }
    if (raw['already'] == true) {
      return CheckinResult(
        outcome: CheckinOutcome.alreadyUsed,
        ticket: ticket,
        checkedInAt: _moment(raw['checked_in_at']),
        message: _text(raw['message']),
      );
    }
    if (raw['ok'] == false) {
      return CheckinResult(
        outcome: CheckinOutcome.invalid,
        ticket: ticket,
        message: _text(raw['message']),
      );
    }
    return null;
  }
}

class EventsRepository {
  EventsRepository({
    required this.apiBase,
    required this.terminalToken,
    http.Client? client,
  }) : _client = client ?? http.Client();

  final String apiBase;
  final String? terminalToken;
  final http.Client _client;
  static const _timeout = Duration(seconds: 10);

  bool get available => (terminalToken ?? '').isNotEmpty;

  Future<http.Response> _send(String method, String path, {Object? body}) async {
    final token = terminalToken;
    if (token == null || token.isEmpty) {
      throw TicketsException(
        'This till has no terminal token, so it cannot check tickets. '
        'Sign it in to the venue again.',
      );
    }
    final uri = Uri.parse('$apiBase$path');
    final headers = {
      'Authorization': 'Bearer $token',
      if (body != null) 'Content-Type': 'application/json',
    };
    try {
      return await (method == 'GET'
              ? _client.get(uri, headers: headers)
              : _client.post(uri, headers: headers, body: jsonEncode(body)))
          .timeout(_timeout);
    } catch (_) {
      throw TicketsException(
        method == 'GET'
            ? 'The till could not reach the back office.'
            : 'The till could not reach the back office, so the ticket was '
                  'NOT checked. Try again, or check it on another till.',
      );
    }
  }

  static Object? _decode(http.Response res) {
    try {
      return jsonDecode(res.body);
    } catch (_) {
      return null;
    }
  }

  static TicketsException _refusal(http.Response res, Object? decoded) {
    final said = decoded is Map
        ? _text(decoded['error']) ?? _text(decoded['message'])
        : null;
    return TicketsException(
      said ??
          (res.statusCode == 404
              ? 'Events & tickets is not switched on for this venue.'
              : 'The back office refused that (${res.statusCode}).'),
      status: res.statusCode,
    );
  }

  /// Events from yesterday to a week ahead, in the order the server sends.
  Future<List<TicketEvent>> events() async {
    final res = await _send('GET', '/till/events');
    final decoded = _decode(res);
    if (res.statusCode >= 400) throw _refusal(res, decoded);
    final list = decoded is Map ? decoded['events'] : decoded;
    return [
      if (list is List)
        for (final e in list) ?TicketEvent.fromJson(e),
    ];
  }

  /// Check one ticket in. [code] is what was scanned or typed, unchanged.
  ///
  /// A repeat and an unknown code are answers, not errors — the gate shows
  /// them in red. Only a till that could not ask, or a back office that
  /// refused for some other reason, throws.
  Future<CheckinResult> checkIn(String code, {String? staff}) async {
    final res = await _send(
      'POST',
      '/till/events/checkin',
      body: {'code': code, 'staff': ?staff},
    );
    final decoded = _decode(res);
    final result = CheckinResult.fromJson(decoded);
    // 200 for a first scan and a repeat; 404 with ok:false for a code that
    // is no ticket. Anything else — and a 404 with no such body, which is a
    // server without the module — is a refusal.
    if (result != null && (res.statusCode == 200 || res.statusCode == 404)) {
      return result;
    }
    if (res.statusCode >= 400) throw _refusal(res, decoded);
    throw TicketsException('The back office sent back no answer for that.');
  }
}

/// Whether [text] is worth sending: something other than whitespace or a bare
/// `VT:` prefix.
bool looksLikeTicketCode(String text) {
  final t = text.trim();
  if (t.isEmpty) return false;
  final bare = t.toUpperCase().startsWith('VT:') ? t.substring(3).trim() : t;
  return bare.isNotEmpty;
}
