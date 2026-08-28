/// Terminals that know about each other.
///
/// Three things a venue with more than one till has always needed and never
/// had, and they are one file because they are one idea: a bill, a clerk and a
/// shift belong to the venue, not to the machine that happens to be nearest.
///
///   * **Shared open bills.** A table saved at the bar can be recalled at the
///     station by the door. Bills are pushed to the server as they change and
///     pulled back by every other terminal in the venue.
///   * **One clerk, one terminal.** Signing on somewhere moves the session
///     rather than adding one, and the bill they had in hand comes with them.
///   * **The time clock.** A shift opens when somebody arrives and closes when
///     they leave, and a manager reads it in the back office.
///
/// ---------------------------------------------------------------------------
/// The rule this file may not break
/// ---------------------------------------------------------------------------
/// **None of this is on the path that takes money.** A till with no network
/// rings up, prints and settles exactly as it did before: everything here
/// either succeeds quietly or fails quietly, and the sale is recorded locally
/// and drained through the outbox as it always was. What a cut-off terminal
/// loses is *sight* of the other terminal's tables — and it says so rather
/// than showing an empty room.
///
/// That is why nothing in here throws at a caller who is mid-sale, and why
/// every method that a clerk is waiting on has a timeout measured in seconds.
library;

import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

/// A bill sitting somewhere in the venue, as this terminal last heard of it.
class RemoteBill {
  const RemoteBill({
    required this.id,
    required this.status,
    required this.rev,
    this.terminal,
    this.tableNumber,
    this.roomId,
    this.covers,
    this.staffId,
    this.clerkName,
    this.totalMinor = 0,
    this.lineCount = 0,
    this.payload,
  });

  factory RemoteBill.fromJson(Map<String, dynamic> j) => RemoteBill(
    id: j['id'] as String,
    status: (j['status'] as String?) ?? 'open',
    rev: (j['rev'] as num?)?.toInt() ?? 0,
    terminal: j['terminal'] as String?,
    tableNumber: (j['table_number'] as num?)?.toInt(),
    roomId: (j['room_id'] as num?)?.toInt(),
    covers: (j['covers'] as num?)?.toInt(),
    staffId: (j['staff_id'] as num?)?.toInt(),
    clerkName: j['clerk_name'] as String?,
    totalMinor: (j['total_minor'] as num?)?.toInt() ?? 0,
    lineCount: (j['line_count'] as num?)?.toInt() ?? 0,
    payload: j['payload'] as Map<String, dynamic>?,
  );

  final String id;

  /// 'open' — in hand on a terminal — or 'parked' against a table.
  final String status;

  /// The server's change number. The only ordering a terminal may trust; see
  /// schema_terminals.sql for why a timestamp cannot do this job.
  final int rev;

  /// Which terminal is holding it. Compared against this one's own name to
  /// decide whether a bill may be opened here or has to be taken over first.
  final String? terminal;

  final int? tableNumber;
  final int? roomId;
  final int? covers;
  final int? staffId;
  final String? clerkName;
  final int totalMinor;
  final int lineCount;

  /// The basket itself: the till's own order JSON, header fields plus `lines`.
  /// Null when the server held a payload it could not parse, which is drawn as
  /// a table that cannot be opened rather than as a crash.
  final Map<String, dynamic>? payload;

  bool get isParked => status == 'parked';
}

/// What came back from a poll of the change feed.
class BillFeed {
  const BillFeed({
    required this.rev,
    this.changed = const [],
    this.removed = const [],
  });

  /// The cursor to send next time.
  final int rev;
  final List<RemoteBill> changed;

  /// Bills that have been settled, cancelled or merged away. A deletion is a
  /// change, and a feed that only reported live rows could never express one —
  /// which is how a settled table stays on another terminal's plan for ever.
  final List<String> removed;

  bool get isEmpty => changed.isEmpty && removed.isEmpty;
}

/// The answer to signing a clerk on: where they were, and what they were
/// holding.
class ClerkClaim {
  const ClerkClaim({
    this.moved = false,
    this.previousTerminal,
    this.basket,
  });

  /// True when this sign-on took the clerk off another terminal.
  final bool moved;
  final String? previousTerminal;

  /// The bill they had in hand there, if it still exists and still has
  /// something on it. This is the half that makes "the items follow them" true.
  final RemoteBill? basket;

  static const none = ClerkClaim();
}

/// One person's shift, open or closed.
class ClockEntry {
  const ClockEntry({
    required this.id,
    required this.staffId,
    this.staffName,
    required this.clockedInAt,
    this.clockedOutAt,
  });

  factory ClockEntry.fromJson(Map<String, dynamic> j) => ClockEntry(
    id: (j['id'] as num).toInt(),
    staffId: (j['staff_id'] as num).toInt(),
    staffName: j['staff_name'] as String?,
    clockedInAt: DateTime.parse(j['clocked_in_at'] as String).toLocal(),
    clockedOutAt: j['clocked_out_at'] == null
        ? null
        : DateTime.parse(j['clocked_out_at'] as String).toLocal(),
  );

  final int id;
  final int staffId;
  final String? staffName;
  final DateTime clockedInAt;
  final DateTime? clockedOutAt;

  bool get isOpen => clockedOutAt == null;

  /// How long this shift has run — to now while it is still open, because a
  /// manager looking at lunchtime wants what the person on the floor has done
  /// so far rather than a blank.
  Duration get worked =>
      (clockedOutAt ?? DateTime.now()).difference(clockedInAt);
}

/// The venue's clock, as the till last saw it.
class ClockState {
  const ClockState({this.open = const [], this.today = const []});

  final List<ClockEntry> open;
  final List<ClockEntry> today;

  static const empty = ClockState();

  bool isOn(int staffId) => open.any((e) => e.staffId == staffId);
}

/// Raised only where a clerk is standing in front of the answer.
///
/// Everything on the background paths swallows its failures. This exists for
/// the two actions somebody is waiting on — clocking in, and taking a table
/// over — where saying nothing would leave them pressing the key again.
class TerminalUnavailable implements Exception {
  TerminalUnavailable(this.message);
  final String message;

  @override
  String toString() => message;
}

/// The till's half of the shared-terminal routes.
///
/// Authorised with the **terminal token**, not a session and not an `?office=`
/// query. Unlike a price list these routes carry what customers have ordered
/// and who is on shift, so knowing a venue's contact email must not be enough
/// to read them. A terminal commissioned before the token existed has
/// [canShare] false and works exactly as it always did — on its own.
class TerminalService {
  TerminalService({
    required this.apiBase,
    required this.terminalToken,
    required this.terminalName,
    http.Client? client,
  }) : _client = client ?? http.Client();

  final String apiBase;

  /// Null on a terminal commissioned before v1.3.1.0.
  final String? terminalToken;

  /// What this machine calls itself. Goes on the bill it is holding and into
  /// the clerk session, so a manager reading either can tell the two tills in a
  /// venue apart.
  final String terminalName;

  final http.Client _client;

  /// Whether this terminal can talk to the others at all.
  bool get canShare => terminalToken != null;

  Map<String, String> get _headers => {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer $terminalToken',
  };

  static const _quick = Duration(seconds: 8);

  // ---------------------------------------------------------------------------
  // Open bills
  // ---------------------------------------------------------------------------

  /// What has changed in the venue since [since].
  ///
  /// Returns null when the terminal could not ask — offline, or not
  /// commissioned. Null and "nothing changed" are deliberately different
  /// answers: the first means the plan on screen may be stale and the till
  /// should say so, the second means it is right.
  Future<BillFeed?> pullBills({int since = 0}) async {
    if (!canShare) return null;
    try {
      final res = await _client
          .get(
            Uri.parse('$apiBase/till/open-bills?since=$since'),
            headers: _headers,
          )
          .timeout(_quick);
      if (res.statusCode != 200) return null;
      final body = jsonDecode(res.body) as Map<String, dynamic>;
      return BillFeed(
        rev: (body['rev'] as num?)?.toInt() ?? since,
        changed: [
          for (final b in (body['bills'] as List? ?? const []))
            RemoteBill.fromJson(b as Map<String, dynamic>),
        ],
        removed: [
          for (final g in (body['removed'] as List? ?? const []))
            (g as Map<String, dynamic>)['id'] as String,
        ],
      );
    } catch (_) {
      return null;
    }
  }

  /// Put a bill on the venue's shared plan, or update the one that is there.
  ///
  /// Best effort by design, and the reason is worth stating: this is called
  /// every time an item goes on a bill. A clerk ringing up a round while the
  /// broadband is flapping must not see an error per item, and must not wait
  /// for a timeout between presses. It returns false and the next push carries
  /// the whole basket anyway — the payload is the bill entire, not a delta, so
  /// one that got through makes every one that did not irrelevant.
  Future<bool> pushBill({
    required String id,
    required Map<String, dynamic> payload,
    required int totalMinor,
    required int lineCount,
    String status = 'open',
    int? tableNumber,
    int? roomId,
    int? covers,
    int? staffId,
    String? clerkName,
  }) async {
    if (!canShare) return false;
    try {
      final res = await _client
          .post(
            Uri.parse('$apiBase/till/open-bills'),
            headers: _headers,
            body: jsonEncode({
              'id': id,
              'terminal': terminalName,
              'status': status,
              'table_number': tableNumber,
              'room_id': roomId,
              'covers': covers,
              'staff_id': staffId,
              'clerk_name': clerkName,
              'total_minor': totalMinor,
              'line_count': lineCount,
              'payload': payload,
            }),
          )
          .timeout(_quick);
      return res.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  /// The bill is settled, cancelled or merged away: take it off the plan.
  Future<bool> retireBill(String id, {String reason = 'settled'}) async {
    if (!canShare) return false;
    try {
      final res = await _client
          .delete(
            Uri.parse('$apiBase/till/open-bills/$id?reason=$reason'),
            headers: _headers,
          )
          .timeout(_quick);
      return res.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  /// Take a bill another terminal was holding.
  ///
  /// This one *does* throw. A clerk who has pressed a table and is standing
  /// there needs to be told the difference between "it is yours" and "it was
  /// settled while you were reaching for it", and a silent no-op reads as a
  /// till that has frozen.
  Future<RemoteBill> claimBill(String id) async {
    if (!canShare) {
      throw TerminalUnavailable(
        'This terminal was set up before shared tables existed. Sign the till '
        'in again from Settings to enable them.',
      );
    }
    late final http.Response res;
    try {
      res = await _client
          .post(
            Uri.parse('$apiBase/till/open-bills/$id/claim'),
            headers: _headers,
            body: jsonEncode({'terminal': terminalName}),
          )
          .timeout(_quick);
    } catch (_) {
      throw TerminalUnavailable(
        'Could not reach the other tills. This one is offline, so it can only '
        'open bills it is holding itself.',
      );
    }
    if (res.statusCode == 404) {
      throw TerminalUnavailable(
        'That bill is no longer open — it has been settled or cancelled on '
        'another terminal.',
      );
    }
    if (res.statusCode != 200) {
      throw TerminalUnavailable('The server refused that (${res.statusCode}).');
    }
    return RemoteBill.fromJson(jsonDecode(res.body) as Map<String, dynamic>);
  }

  // ---------------------------------------------------------------------------
  // One clerk, one terminal
  // ---------------------------------------------------------------------------

  /// Claim this clerk for this terminal, wherever they were before.
  ///
  /// Never throws, and that is the whole design. A till that refused to sign
  /// somebody on because the broadband was down would be a till that cannot
  /// sell — a far worse fault than a clerk being live in two places for the
  /// length of an outage. Offline, this returns [ClerkClaim.none] and the
  /// sign-on goes ahead locally exactly as it always has.
  Future<ClerkClaim> claimClerk({
    required int staffId,
    required String staffName,
  }) async {
    if (!canShare) return ClerkClaim.none;
    try {
      final res = await _client
          .post(
            Uri.parse('$apiBase/till/clerk-session'),
            headers: _headers,
            body: jsonEncode({
              'staff_id': staffId,
              'staff_name': staffName,
              'terminal': terminalName,
            }),
          )
          .timeout(_quick);
      if (res.statusCode != 200) return ClerkClaim.none;
      final body = jsonDecode(res.body) as Map<String, dynamic>;
      final basket = body['basket'] as Map<String, dynamic>?;
      return ClerkClaim(
        moved: body['moved'] == true,
        previousTerminal: body['previousTerminal'] as String?,
        basket: basket == null ? null : RemoteBill.fromJson(basket),
      );
    } catch (_) {
      return ClerkClaim.none;
    }
  }

  /// Remember what this clerk has in hand, so it can follow them.
  ///
  /// Null [basketId] is "they are holding nothing", which is what a completed
  /// sale leaves behind.
  Future<void> setClerkBasket({required int staffId, String? basketId}) async {
    if (!canShare) return;
    try {
      await _client
          .put(
            Uri.parse('$apiBase/till/clerk-session/basket'),
            headers: _headers,
            body: jsonEncode({'staff_id': staffId, 'basket_id': basketId}),
          )
          .timeout(_quick);
    } catch (_) {
      // The next sign-on simply offers whatever the server last heard about.
    }
  }

  Future<void> releaseClerk(int staffId) async {
    if (!canShare) return;
    try {
      await _client
          .delete(
            Uri.parse('$apiBase/till/clerk-session/$staffId'),
            headers: _headers,
          )
          .timeout(_quick);
    } catch (_) {
      // Signing off is local and has already happened. The server's row ages
      // out the next time this person signs on anywhere.
    }
  }

  // ---------------------------------------------------------------------------
  // The time clock
  // ---------------------------------------------------------------------------

  Future<ClockState?> pullClock() async {
    if (!canShare) return null;
    try {
      final res = await _client
          .get(Uri.parse('$apiBase/till/clock'), headers: _headers)
          .timeout(_quick);
      if (res.statusCode != 200) return null;
      final body = jsonDecode(res.body) as Map<String, dynamic>;
      List<ClockEntry> parse(String key) => [
        for (final e in (body[key] as List? ?? const []))
          ClockEntry.fromJson(e as Map<String, dynamic>),
      ];
      return ClockState(open: parse('open'), today: parse('today'));
    } catch (_) {
      return null;
    }
  }

  /// Clock in, or clock out. The server's own state decides which, so a double
  /// tap cannot open two shifts or close one twice.
  ///
  /// Throws, because somebody is standing in front of it. A shift that silently
  /// did not start is a wage that silently is not paid.
  Future<String> punch({required int staffId, required String staffName}) async {
    if (!canShare) {
      throw TerminalUnavailable(
        'This terminal was set up before the time clock existed. Sign the till '
        'in again from Settings to enable it.',
      );
    }
    late final http.Response res;
    try {
      res = await _client
          .post(
            Uri.parse('$apiBase/till/clock'),
            headers: _headers,
            body: jsonEncode({
              'staff_id': staffId,
              'staff_name': staffName,
              'terminal': terminalName,
            }),
          )
          .timeout(_quick);
    } catch (_) {
      throw TerminalUnavailable(
        'Could not reach the back office, so nothing was recorded. Try again '
        'when the till is back online.',
      );
    }
    if (res.statusCode != 200) {
      throw TerminalUnavailable('The server refused that (${res.statusCode}).');
    }
    return (jsonDecode(res.body) as Map<String, dynamic>)['state'] as String;
  }
}
