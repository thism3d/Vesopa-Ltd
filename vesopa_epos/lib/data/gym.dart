/// The gym door: a card in, the same card out, and nobody standing there.
///
/// WHAT MAKES THIS DIFFERENT FROM EVERY OTHER CARD
///
/// Every other swipe in this application happens in front of a member of staff.
/// A loyalty card that belongs to nobody opens a form; an expired membership
/// opens a gate the clerk answers; a card from another shop puts up a panel
/// somebody dismisses. All of that is correct at a counter and all of it is
/// wrong here, because "the venue uses this as a self-service where no one mans
/// the till". A dialog at an unmanned door is a door that stays shut until
/// somebody walks over from the other end of the building.
///
/// So nothing in this file, and nothing it leads to, ever waits to be told what
/// to do. The answer is drawn, it clears itself, and the next member can swipe
/// straight over the top of it.
///
/// A SWIPE IS AN EVENT
///
/// The till does not send "sign this member in". It sends "this card was read
/// at this time", with an id of its own making, and lets the server work out
/// which of the two that was — see gym.js. That is what lets a swipe survive
/// the broadband being down: it goes in a queue with the moment it actually
/// happened on it, and replaying it late still lands it in the right place in
/// the day rather than signing somebody in an hour after they left.
///
/// WHY THERE IS A LOCAL ROSTER
///
/// Because a gym door has to work with no network, and a door that could not
/// say a member's name offline would greet a paying member with the word
/// "recorded" and nothing else. The roster is names, numbers and expiry dates —
/// enough to greet somebody and to print the slip that says their membership
/// has run out — and it is small, so it is kept the same way the venue's card
/// rules are kept: in preferences, refreshed whenever the settings are.
///
/// It is deliberately not the photographs. Those are URLs the till already
/// knows how to fetch, and a roster carrying a few hundred images is a sync
/// that fails on a slow line at exactly the moment it is needed.
library;

import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:uuid/uuid.dart';

/// What the door decided.
enum GymOutcome {
  /// Signed in. Green, a name, and the door is done with them.
  entered,

  /// Signed out. The same card again, after the debounce.
  left,

  /// A membership that has run out. The slip prints; whether they are also
  /// refused is the venue's switch — see [GymAnswer.refused].
  expired,

  /// A gym card that belongs to nobody. Said plainly rather than swallowed:
  /// silence is indistinguishable from a reader that has stopped working, and
  /// at an unmanned door there is nobody to tell the difference.
  unknown,

  /// The same card twice within seconds. A reader that double-read, or somebody
  /// who swiped again because the first one did not look like it worked.
  /// Deliberately visible rather than silent, for the same reason as above.
  ignored,

  /// The till could not reach the back office and could not name the card
  /// either — no roster yet. The swipe is queued and will be sorted out when
  /// the link returns, and the member is not kept standing there.
  queued,

  /// The venue does not run a gym, or this card is not a gym card. Nothing is
  /// drawn; the caller falls through to whatever it would have done anyway.
  notGym,
}

/// How the venue's door behaves.
///
/// Every field here is a decision that, made badly, breaks a door with nobody
/// standing at it — so each one is clamped on arrival as well as in the back
/// office, because the back office is not the only way a row is written.
@immutable
class GymSettings {
  const GymSettings({
    this.enabled = false,
    this.gymPrefix = '',
    this.autoCloseHours = 4,
    this.debounceSeconds = 45,
    this.graceDays = 0,
    this.expirySlip = true,
    this.refuseExpired = false,
    this.expiringSoonDays = 14,
    this.greetingSeconds = 6,
    this.showPhoto = true,
  });

  /// Whether this venue runs a gym at all.
  ///
  /// False, and false is the answer for nearly every venue on this platform.
  /// While it is false there is no Gym section on the till, no gym options in
  /// Settings, and a gym card is not a kind of card this till knows about —
  /// which was asked for in those words, twice, and is worth being literal
  /// about: switching the gym off takes the whole thing away.
  final bool enabled;

  /// The prefix on the front of a gym card, or empty where the venue has not
  /// set one. Mirrored from the card rules, so the door and the classifier can
  /// never disagree about which cards are gym cards.
  final String gymPrefix;

  final int autoCloseHours;

  /// Two reads of one card inside this many seconds are one swipe.
  ///
  /// The most important number here. Without it a reader that double-reads
  /// signs somebody in and straight back out again, leaving the gym holding
  /// nobody and the report holding a three-second visit — and there is nobody
  /// standing there to notice it happen.
  final int debounceSeconds;

  final int graceDays;
  final bool expirySlip;
  final bool refuseExpired;
  final int expiringSoonDays;

  /// How long the greeting stays before the screen clears itself.
  ///
  /// It has to clear itself. A panel carrying somebody's name and photograph,
  /// waiting for a tap nobody is there to give, is the next member's greeting
  /// hidden behind the last member's — and a stranger's face left facing the
  /// room.
  final int greetingSeconds;

  final bool showPhoto;

  static int _int(Object? value, int fallback, int lo, int hi) {
    final n = switch (value) {
      num v => v.toInt(),
      String v => int.tryParse(v) ?? fallback,
      _ => fallback,
    };
    return n < lo ? lo : (n > hi ? hi : n);
  }

  static bool _flag(Object? value, {required bool fallback}) => switch (value) {
    bool v => v,
    num v => v != 0,
    String v => v == '1' || v.toLowerCase() == 'true',
    _ => fallback,
  };

  static GymSettings fromJson(Object? raw) {
    if (raw is! Map) return const GymSettings();
    return GymSettings(
      // Absent means off. A till talking to a server that has not run
      // schema_till_gym.sql must not decide it is a gym.
      enabled: _flag(raw['enabled'], fallback: false),
      gymPrefix: String.fromCharCodes(
        (raw['gym_prefix'] ?? '').toString().codeUnits.where(
          (c) => c >= 0x30 && c <= 0x39,
        ),
      ),
      autoCloseHours: _int(raw['auto_close_hours'], 4, 1, 24),
      debounceSeconds: _int(raw['debounce_seconds'], 45, 0, 600),
      graceDays: _int(raw['grace_days'], 0, 0, 90),
      expirySlip: _flag(raw['expiry_slip'], fallback: true),
      refuseExpired: _flag(raw['refuse_expired'], fallback: false),
      expiringSoonDays: _int(raw['expiring_soon_days'], 14, 0, 120),
      greetingSeconds: _int(raw['greeting_seconds'], 6, 2, 30),
      showPhoto: _flag(raw['show_photo'], fallback: true),
    );
  }

  Map<String, Object?> toJson() => {
    'enabled': enabled ? 1 : 0,
    'gym_prefix': gymPrefix,
    'auto_close_hours': autoCloseHours,
    'debounce_seconds': debounceSeconds,
    'grace_days': graceDays,
    'expiry_slip': expirySlip ? 1 : 0,
    'refuse_expired': refuseExpired ? 1 : 0,
    'expiring_soon_days': expiringSoonDays,
    'greeting_seconds': greetingSeconds,
    'show_photo': showPhoto ? 1 : 0,
  };

  @override
  bool operator ==(Object other) =>
      other is GymSettings &&
      other.enabled == enabled &&
      other.gymPrefix == gymPrefix &&
      other.autoCloseHours == autoCloseHours &&
      other.debounceSeconds == debounceSeconds &&
      other.graceDays == graceDays &&
      other.expirySlip == expirySlip &&
      other.refuseExpired == refuseExpired &&
      other.expiringSoonDays == expiringSoonDays &&
      other.greetingSeconds == greetingSeconds &&
      other.showPhoto == showPhoto;

  @override
  int get hashCode => Object.hash(
    enabled,
    gymPrefix,
    autoCloseHours,
    debounceSeconds,
    graceDays,
    expirySlip,
    refuseExpired,
    expiringSoonDays,
    greetingSeconds,
    showPhoto,
  );
}

/// A member whose card opens the door, as the till keeps them.
@immutable
class GymMember {
  const GymMember({
    required this.id,
    required this.name,
    required this.cardNumber,
    this.memberNo,
    this.membershipExpiry,
    this.photoUrl,
  });

  final String id;
  final String name;
  final String cardNumber;
  final int? memberNo;

  /// The date on the card, or null. A null expiry is never expired — a venue
  /// running a gym on cards with no dates on them has members, not expired
  /// members, and a door that turned them all away on the first morning is a
  /// door nobody opens again.
  final DateTime? membershipExpiry;

  final String? photoUrl;

  static GymMember? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final id = (raw['id'] ?? '').toString();
    final card = (raw['card_number'] ?? '').toString();
    if (id.isEmpty || card.isEmpty) return null;
    return GymMember(
      id: id,
      name: (raw['name'] ?? '').toString(),
      cardNumber: card,
      memberNo: switch (raw['member_no']) {
        num v => v.toInt(),
        String v => int.tryParse(v),
        _ => null,
      },
      membershipExpiry: switch (raw['membership_expiry']) {
        final String v when v.isNotEmpty => DateTime.tryParse(v),
        _ => null,
      },
      photoUrl: switch (raw['photo_url']) {
        final String v when v.isNotEmpty => v,
        _ => null,
      },
    );
  }

  Map<String, Object?> toJson() => {
    'id': id,
    'name': name,
    'card_number': cardNumber,
    'member_no': memberNo,
    'membership_expiry': membershipExpiry == null
        ? null
        : '${membershipExpiry!.year.toString().padLeft(4, '0')}-'
              '${membershipExpiry!.month.toString().padLeft(2, '0')}-'
              '${membershipExpiry!.day.toString().padLeft(2, '0')}',
    'photo_url': photoUrl,
  };
}

/// One visit, as the board draws it.
@immutable
class GymVisit {
  const GymVisit({
    required this.id,
    required this.memberName,
    required this.cardNumber,
    required this.enteredAt,
    this.leftAt,
    this.memberNo,
    this.minutes = 0,
    this.expired = false,
    this.closedBy,
    this.photoUrl,
  });

  final int id;
  final String memberName;
  final String cardNumber;
  final int? memberNo;
  final DateTime enteredAt;
  final DateTime? leftAt;
  final int minutes;
  final bool expired;

  /// 'card', 'auto' or 'office'. A visit the sweep closed has a length nobody
  /// measured, and the board says so rather than presenting a guess as a fact.
  final String? closedBy;

  final String? photoUrl;

  /// In the gym now. The one thing the board colours from.
  bool get inGym => leftAt == null;

  static GymVisit? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final entered = DateTime.tryParse((raw['entered_at'] ?? '').toString());
    if (entered == null) return null;
    return GymVisit(
      id: switch (raw['id']) {
        num v => v.toInt(),
        String v => int.tryParse(v) ?? 0,
        _ => 0,
      },
      memberName: (raw['member_name'] ?? '').toString(),
      cardNumber: (raw['card_number'] ?? '').toString(),
      memberNo: switch (raw['member_no']) {
        num v => v.toInt(),
        String v => int.tryParse(v),
        _ => null,
      },
      enteredAt: entered,
      leftAt: switch (raw['left_at']) {
        final String v when v.isNotEmpty => DateTime.tryParse(v),
        _ => null,
      },
      minutes: switch (raw['minutes']) {
        num v => v.toInt(),
        String v => int.tryParse(v) ?? 0,
        _ => 0,
      },
      expired: switch (raw['expired']) {
        num v => v != 0,
        bool v => v,
        String v => v == '1',
        _ => false,
      },
      closedBy: switch (raw['closed_by']) {
        final String v when v.isNotEmpty => v,
        _ => null,
      },
      photoUrl: switch (raw['photo_url']) {
        final String v when v.isNotEmpty => v,
        _ => null,
      },
    );
  }
}

/// What to put on the screen, and whether to print.
@immutable
class GymAnswer {
  const GymAnswer({
    required this.outcome,
    this.memberName,
    this.memberNo,
    this.photoUrl,
    this.membershipExpiry,
    this.expiredDays,
    this.expiringInDays,
    this.minutes,
    this.refused = false,
    this.printSlip = false,
    this.cardNumber,
  });

  const GymAnswer.notGym() : this._plain(GymOutcome.notGym);
  const GymAnswer._plain(this.outcome)
    : memberName = null,
      memberNo = null,
      photoUrl = null,
      membershipExpiry = null,
      expiredDays = null,
      expiringInDays = null,
      minutes = null,
      refused = false,
      printSlip = false,
      cardNumber = null;

  final GymOutcome outcome;
  final String? memberName;
  final int? memberNo;
  final String? photoUrl;

  /// The date on the card, as text, because it is printed and read rather than
  /// calculated with.
  final String? membershipExpiry;

  final int? expiredDays;

  /// Days left, but only inside the window the venue set. A number that turns
  /// up eleven months out is a number members stop reading.
  final int? expiringInDays;

  /// How long they were in, on the way out.
  final int? minutes;

  final bool refused;

  /// Whether the till should print the expired-membership slip.
  ///
  /// Decided by the server where there is one and locally where there is not,
  /// but printed in exactly one place either way — see `ui/card_actions.dart`.
  final bool printSlip;

  final String? cardNumber;

  /// Whether this answer is worth drawing at all.
  bool get speaks => outcome != GymOutcome.notGym;
}

/// A swipe waiting to reach the back office.
@immutable
class _QueuedSwipe {
  const _QueuedSwipe({
    required this.id,
    required this.cardNumber,
    required this.at,
  });

  final String id;
  final String cardNumber;
  final DateTime at;

  Map<String, Object?> toJson() => {
    'id': id,
    'card_number': cardNumber,
    'at': at.toIso8601String(),
  };

  static _QueuedSwipe? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final at = DateTime.tryParse((raw['at'] ?? '').toString());
    final id = (raw['id'] ?? '').toString();
    final card = (raw['card_number'] ?? '').toString();
    if (at == null || id.isEmpty || card.isEmpty) return null;
    return _QueuedSwipe(id: id, cardNumber: card, at: at);
  }
}

const _keySettings = 'gym.settings';
const _keyMembers = 'gym.members';
const _keyOpen = 'gym.open';
const _keyQueue = 'gym.queue';

/// The venue's gym: its rules, its members, and the door.
class GymRepository {
  GymRepository({
    required this.apiBase,
    required this.terminalToken,
    http.Client? client,
  }) : _client = client ?? http.Client();

  final String apiBase;

  /// Null on a terminal commissioned before terminal tokens existed. Such a
  /// till has no gym: the door records who was in the building, and there is no
  /// unauthenticated route for that.
  final String? terminalToken;

  final http.Client _client;
  static const _timeout = Duration(seconds: 8);
  static const _uuid = Uuid();

  GymSettings _settings = const GymSettings();
  List<GymMember> _members = const [];

  /// Who this till believes is inside, by card number, and since when.
  ///
  /// A mirror of the server's answer, not a second source of truth. It exists
  /// for the one case the server cannot serve: an offline swipe, where the till
  /// has to decide by itself whether this is somebody arriving or leaving. When
  /// the link is up the server's answer overwrites it, so the two cannot drift
  /// for longer than one swipe.
  Map<String, DateTime> _open = {};

  GymSettings get settings => _settings;
  List<GymMember> get members => List.unmodifiable(_members);

  /// Whether this venue runs a gym, and this terminal can take part.
  bool get live => _settings.enabled && (terminalToken ?? '').isNotEmpty;

  /// Whether [number] is a gym card in this venue.
  ///
  /// Both halves matter. An empty prefix matches nothing — without that guard
  /// `startsWith('')` would make every card in the building a gym card at a
  /// venue that had switched the programme off. And the gym being switched off
  /// takes gym cards away entirely rather than leaving them as unknown cards
  /// the till then offers to turn into products.
  bool isGymCard(String number) =>
      live &&
      _settings.gymPrefix.isNotEmpty &&
      number.startsWith(_settings.gymPrefix);

  // ---------------------------------------------------------------------------
  // What was stored last time
  // ---------------------------------------------------------------------------

  /// Read what this terminal already knew. Called once at start-up.
  ///
  /// Never throws and never blocks on the network. A gym door that could not
  /// open until the back office answered would be a gym door that does not open
  /// at seven in the morning when the broadband is still coming up.
  Future<GymSettings> load() async {
    try {
      final prefs = await SharedPreferences.getInstance();

      final raw = prefs.getString(_keySettings);
      if (raw != null && raw.isNotEmpty) {
        _settings = GymSettings.fromJson(jsonDecode(raw));
      }

      final roster = prefs.getString(_keyMembers);
      if (roster != null && roster.isNotEmpty) {
        _members = [
          for (final entry in jsonDecode(roster) as List)
            ?GymMember.fromJson(entry),
        ];
      }

      final open = prefs.getString(_keyOpen);
      if (open != null && open.isNotEmpty) {
        _open = {
          for (final entry in (jsonDecode(open) as Map).entries)
            entry.key.toString(): ?DateTime.tryParse(entry.value.toString()),
        };
      }
    } catch (_) {
      // A stored blob this build cannot read is a terminal that falls back to
      // "no gym", which is exactly what a fresh one does.
    }
    return _settings;
  }

  /// Pull the rules and the roster from the back office.
  ///
  /// Returns whether the rules arrived. A failure is not reported anywhere: the
  /// till carries on with what it had, which is the whole reason it is stored.
  Future<bool> sync() async {
    final token = terminalToken;
    if (token == null || token.isEmpty) return false;

    try {
      final res = await _client
          .get(
            Uri.parse('$apiBase/till/gym/settings'),
            headers: {'Authorization': 'Bearer $token'},
          )
          .timeout(_timeout);
      if (res.statusCode != 200) return false;

      _settings = GymSettings.fromJson(jsonDecode(res.body));
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_keySettings, jsonEncode(_settings.toJson()));
    } catch (_) {
      return false;
    }

    // The roster only where there is a gym. A pub must not be pulling a member
    // list every two minutes for a feature it does not have.
    if (_settings.enabled) {
      await _syncMembers();
      // And anything that could not be sent while the line was down. Here
      // rather than on a timer of its own: this runs on start-up, on every
      // reconnect and on the settings poll, which is every moment a queued
      // swipe could newly get through.
      await flush();
    }
    return true;
  }

  Future<void> _syncMembers() async {
    final token = terminalToken;
    if (token == null || token.isEmpty) return;
    try {
      final res = await _client
          .get(
            Uri.parse('$apiBase/till/gym/members'),
            headers: {'Authorization': 'Bearer $token'},
          )
          .timeout(const Duration(seconds: 20));
      if (res.statusCode != 200) return;

      final list = jsonDecode(res.body);
      if (list is! List) return;
      _members = [
        for (final entry in list)
          ?GymMember.fromJson(entry),
      ];
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(
        _keyMembers,
        jsonEncode([for (final m in _members) m.toJson()]),
      );
    } catch (_) {
      // Keep the roster we had. An empty one would turn every member in the
      // venue into an unknown card at the next swipe.
    }
  }

  // ---------------------------------------------------------------------------
  // The door
  // ---------------------------------------------------------------------------

  /// Somebody swiped.
  ///
  /// Never throws. There is nobody at this till to read an exception, and a
  /// door that threw would leave a member standing in front of a screen that
  /// says nothing at all.
  Future<GymAnswer> swipe(String cardNumber) async {
    if (!isGymCard(cardNumber)) return const GymAnswer.notGym();

    final at = DateTime.now();
    final swipeId = _uuid.v4();

    final token = terminalToken;
    if (token != null && token.isNotEmpty) {
      try {
        final res = await _client
            .post(
              Uri.parse('$apiBase/till/gym/swipe'),
              headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer $token',
              },
              body: jsonEncode({
                'card_number': cardNumber,
                'swipe_id': swipeId,
                'at': at.toIso8601String(),
              }),
            )
            .timeout(_timeout);

        if (res.statusCode == 200) {
          final answer = _readAnswer(jsonDecode(res.body), cardNumber);
          await _mirror(cardNumber, answer, at);
          return answer;
        }
        // 404 is the gym being switched off under us between the settings poll
        // and this swipe. Say nothing and let the caller fall through, which is
        // the same thing that happens to a card with no prefix match.
        if (res.statusCode == 404) return const GymAnswer.notGym();
      } catch (_) {
        // Offline. Fall through to the local answer below rather than telling a
        // paying member to come back when the broadband is fixed.
      }
    }

    return _offlineSwipe(cardNumber, at: at, swipeId: swipeId);
  }

  /// The same decision, made here, when the back office cannot be reached.
  ///
  /// Reaches the same conclusion as the server for the same swipe, because both
  /// read the same three things: is there a visit open for this card, how long
  /// ago did it open, and has the membership run out. The swipe is queued with
  /// the time it happened, so when it does arrive the server records the visit
  /// exactly where it belongs in the day.
  Future<GymAnswer> _offlineSwipe(
    String cardNumber, {
    required DateTime at,
    required String swipeId,
  }) async {
    await _queue(_QueuedSwipe(id: swipeId, cardNumber: cardNumber, at: at));

    final member = _memberFor(cardNumber);
    if (member == null) {
      // No roster yet, or a card issued since the last sync. Not called
      // "unknown": the till genuinely does not know, and telling somebody their
      // card is not recognised when it may well be is worse than telling them
      // it has been recorded.
      if (_members.isEmpty) {
        return GymAnswer(outcome: GymOutcome.queued, cardNumber: cardNumber);
      }
      return GymAnswer(outcome: GymOutcome.unknown, cardNumber: cardNumber);
    }

    final since = _open[cardNumber];
    if (since != null) {
      if (at.difference(since).inSeconds < _settings.debounceSeconds) {
        return GymAnswer(
          outcome: GymOutcome.ignored,
          memberName: member.name,
          memberNo: member.memberNo,
        );
      }
      _open.remove(cardNumber);
      await _saveOpen();
      return GymAnswer(
        outcome: GymOutcome.left,
        memberName: member.name,
        memberNo: member.memberNo,
        photoUrl: _settings.showPhoto ? member.photoUrl : null,
        minutes: at.difference(since).inMinutes,
      );
    }

    final days = _daysLeft(member.membershipExpiry);
    final expired = days != null && days + _settings.graceDays < 0;

    if (expired && _settings.refuseExpired) {
      return GymAnswer(
        outcome: GymOutcome.expired,
        refused: true,
        memberName: member.name,
        memberNo: member.memberNo,
        photoUrl: _settings.showPhoto ? member.photoUrl : null,
        membershipExpiry: _dateText(member.membershipExpiry),
        expiredDays: days.abs(),
        printSlip: _settings.expirySlip,
      );
    }

    _open[cardNumber] = at;
    await _saveOpen();

    return GymAnswer(
      outcome: expired ? GymOutcome.expired : GymOutcome.entered,
      memberName: member.name,
      memberNo: member.memberNo,
      photoUrl: _settings.showPhoto ? member.photoUrl : null,
      membershipExpiry: _dateText(member.membershipExpiry),
      expiredDays: expired ? days.abs() : null,
      expiringInDays:
          !expired &&
              days != null &&
              _settings.expiringSoonDays > 0 &&
              days <= _settings.expiringSoonDays
          ? days
          : null,
      printSlip: expired && _settings.expirySlip,
    );
  }

  GymAnswer _readAnswer(Object? raw, String cardNumber) {
    if (raw is! Map) return const GymAnswer.notGym();
    int? asInt(Object? v) => switch (v) {
      num n => n.toInt(),
      String s => int.tryParse(s),
      _ => null,
    };
    return GymAnswer(
      outcome: switch ((raw['outcome'] ?? '').toString()) {
        'in' => GymOutcome.entered,
        'out' => GymOutcome.left,
        'expired' => GymOutcome.expired,
        'unknown' => GymOutcome.unknown,
        'ignored' => GymOutcome.ignored,
        _ => GymOutcome.notGym,
      },
      memberName: switch (raw['member_name']) {
        final String v when v.isNotEmpty => v,
        _ => null,
      },
      memberNo: asInt(raw['member_no']),
      photoUrl: switch (raw['photo_url']) {
        final String v when v.isNotEmpty => v,
        _ => null,
      },
      membershipExpiry: switch (raw['membership_expiry']) {
        final String v when v.isNotEmpty => v,
        _ => null,
      },
      expiredDays: asInt(raw['expired_days']),
      expiringInDays: asInt(raw['expiring_in_days']),
      minutes: asInt(raw['minutes']),
      refused: raw['refused'] == true || raw['refused'] == 1,
      printSlip: raw['print_slip'] == true || raw['print_slip'] == 1,
      cardNumber: cardNumber,
    );
  }

  /// Keep the local picture of who is inside in step with the server's answer.
  Future<void> _mirror(String card, GymAnswer answer, DateTime at) async {
    switch (answer.outcome) {
      case GymOutcome.entered:
        _open[card] = at;
      case GymOutcome.expired:
        if (!answer.refused) _open[card] = at;
      case GymOutcome.left:
        _open.remove(card);
      case GymOutcome.unknown:
      case GymOutcome.ignored:
      case GymOutcome.queued:
      case GymOutcome.notGym:
        return;
    }
    await _saveOpen();
  }

  GymMember? _memberFor(String cardNumber) {
    for (final member in _members) {
      if (member.cardNumber == cardNumber) return member;
    }
    return null;
  }

  /// Whole days from today to [expiry]. Negative once it has passed.
  ///
  /// Both sides are flattened to midnight first. Without that, a membership
  /// expiring today reads as expired at one minute past midnight and valid at
  /// half past eleven the night before, depending on the time of the swipe —
  /// and the rule everywhere else in this product is that a card works *on* its
  /// expiry date.
  int? _daysLeft(DateTime? expiry) {
    if (expiry == null) return null;
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final on = DateTime(expiry.year, expiry.month, expiry.day);
    return on.difference(today).inDays;
  }

  String? _dateText(DateTime? date) {
    if (date == null) return null;
    return '${date.year.toString().padLeft(4, '0')}-'
        '${date.month.toString().padLeft(2, '0')}-'
        '${date.day.toString().padLeft(2, '0')}';
  }

  // ---------------------------------------------------------------------------
  // The board
  // ---------------------------------------------------------------------------

  /// Who is in the gym, from the back office.
  ///
  /// Returns null when it cannot be read, which is a different thing from an
  /// empty gym and is drawn differently — "nobody is here" and "we cannot say
  /// who is here" are not the same sentence, and only one of them means
  /// somebody should go and look.
  Future<List<GymVisit>?> board({DateTime? date}) async {
    final token = terminalToken;
    if (token == null || token.isEmpty) return null;
    try {
      final day = date == null ? '' : '?date=${_dateText(date)}';
      final res = await _client
          .get(
            Uri.parse('$apiBase/till/gym/board$day'),
            headers: {'Authorization': 'Bearer $token'},
          )
          .timeout(_timeout);
      if (res.statusCode != 200) return null;

      final list = jsonDecode(res.body);
      if (list is! List) return null;

      final visits = [
        for (final entry in list)
          ?GymVisit.fromJson(entry),
      ];

      // The server has just told this till who is inside. Take it: the mirror
      // exists only to answer an offline swipe, and letting it drift from the
      // real answer is the one way it could ever do harm.
      _open = {
        for (final visit in visits)
          if (visit.inGym) visit.cardNumber: visit.enteredAt,
      };
      await _saveOpen();

      return visits;
    } catch (_) {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // The queue
  // ---------------------------------------------------------------------------

  /// How many swipes are waiting to be sent.
  Future<int> pending() async {
    final prefs = await SharedPreferences.getInstance();
    return _readQueue(prefs).length;
  }

  /// Send everything that is waiting, oldest first.
  ///
  /// Order matters and is not decoration: the server decides in from out by
  /// looking at whether a visit was open at the moment of the swipe, so a
  /// departure that overtook its own arrival would be read as an arrival.
  ///
  /// A swipe that the server rejects outright is dropped rather than retried
  /// for ever. A queue that cannot drain is a queue that grows until it is the
  /// reason the till is slow, and the only thing lost is one line of a door log
  /// the server has already refused to accept.
  Future<void> flush() async {
    final token = terminalToken;
    if (token == null || token.isEmpty) return;

    final prefs = await SharedPreferences.getInstance();
    final queued = _readQueue(prefs);
    if (queued.isEmpty) return;

    final remaining = <_QueuedSwipe>[];
    var stopped = false;

    for (final swipe in queued) {
      if (stopped) {
        remaining.add(swipe);
        continue;
      }
      try {
        final res = await _client
            .post(
              Uri.parse('$apiBase/till/gym/swipe'),
              headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer $token',
              },
              body: jsonEncode({
                'card_number': swipe.cardNumber,
                'swipe_id': swipe.id,
                'at': swipe.at.toIso8601String(),
              }),
            )
            .timeout(_timeout);

        // 2xx is accepted. So is 404 — the venue has switched the gym off since
        // this was queued, and there is nowhere for it to go. Anything else in
        // the 4xx range is a swipe the server will never take, and holding it
        // would block every swipe behind it for ever.
        if (res.statusCode >= 500) {
          remaining.add(swipe);
          stopped = true;
        }
      } catch (_) {
        // Still offline. Keep this one and everything after it, in order.
        remaining.add(swipe);
        stopped = true;
      }
    }

    await _writeQueue(prefs, remaining);
  }

  Future<void> _queue(_QueuedSwipe swipe) async {
    final prefs = await SharedPreferences.getInstance();
    final queued = _readQueue(prefs)..add(swipe);
    // A cap, because this is a door in a room that could be offline for a week.
    // The oldest go first: the newest swipes are the ones the board still needs
    // to be right about.
    await _writeQueue(
      prefs,
      queued.length > 2000 ? queued.sublist(queued.length - 2000) : queued,
    );
  }

  List<_QueuedSwipe> _readQueue(SharedPreferences prefs) {
    try {
      final raw = prefs.getString(_keyQueue);
      if (raw == null || raw.isEmpty) return [];
      return [
        for (final entry in jsonDecode(raw) as List)
          ?_QueuedSwipe.fromJson(entry),
      ];
    } catch (_) {
      return [];
    }
  }

  Future<void> _writeQueue(
    SharedPreferences prefs,
    List<_QueuedSwipe> queue,
  ) async {
    if (queue.isEmpty) {
      await prefs.remove(_keyQueue);
      return;
    }
    await prefs.setString(
      _keyQueue,
      jsonEncode([for (final swipe in queue) swipe.toJson()]),
    );
  }

  Future<void> _saveOpen() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(
        _keyOpen,
        jsonEncode({
          for (final entry in _open.entries)
            entry.key: entry.value.toIso8601String(),
        }),
      );
    } catch (_) {
      // Worst case the till forgets who is inside and reads the next swipe as
      // an arrival. The server still has the truth and corrects it on the next
      // board read.
    }
  }
}
