/// The venue's card rules, and issuing a card.
///
/// Reading a card does not come through here. The till classifies a swipe
/// itself against the prefixes cached below, and then asks whichever store
/// already owns the answer:
///
///   * a staff card — the till's own cached staff list, so signing on works
///     with the broadband down (see `staff_repository.dart`);
///   * a loyalty card — `CommerceRepository.loyaltyByCard`, because points are
///     money-adjacent and the same member can be at two tills at once;
///   * a gift card — `CommerceRepository.giftCard`, for the same reason.
///
/// A fourth lookup here would be a second way to ask three questions that
/// already have answers, and the two would drift.
///
/// WHY THE SETTINGS ARE CACHED AND THE WRITES ARE NOT
///
/// The prefixes are cached on the terminal and survive a restart, because a
/// till that could not tell a staff card from a gift card until the broadband
/// came back would be a till nobody can sign on to. They change perhaps once in
/// the life of a venue.
///
/// Issuing is never cached and never queued. A card number is a *credential*:
/// two terminals that each handed out number 42 offline would produce two
/// members holding the same card, and the second one to swipe silently loads
/// the first one's points. So the number is allocated by the server, under a
/// row lock, or not at all — and a till that cannot reach the back office says
/// so rather than inventing one.
library;

import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import 'swipe_cards.dart';

/// Why a card could not be issued, in words a manager can act on.
class CardException implements Exception {
  CardException(this.message);
  final String message;

  @override
  String toString() => message;
}

/// A card that has just been issued, and what to do with it.
class IssuedCard {
  const IssuedCard({
    required this.kind,
    required this.number,
    required this.cardNumber,
    required this.track,
  });

  final CardKind kind;

  /// The human-facing number — the 1 in 999800001. What a member quotes on the
  /// phone and what a manager reads off a list.
  final int number;

  /// The full number, prefix included and sentinels excluded. This is what goes
  /// in the database, in a QR code, and on a phone.
  final String cardNumber;

  /// The full track, sentinels and all: what to hand an encoder.
  ///
  /// The one place the sentinels are added back, because this is the one output
  /// that is a *stripe* rather than a record of a number.
  final String track;
}

const _keySettings = 'cards.settings';

class CardRepository {
  CardRepository({
    required this.apiBase,
    required this.terminalToken,
    http.Client? client,
  }) : _client = client ?? http.Client();

  final String apiBase;

  /// Null on a terminal commissioned before terminal tokens existed. Such a
  /// till reads cards using the defaults and cannot issue them, which is the
  /// honest behaviour: issuing writes a credential, and there is no
  /// unauthenticated route for that.
  final String? terminalToken;

  final http.Client _client;

  static const _timeout = Duration(seconds: 10);

  CardSettings? _cached;

  /// The rules in force right now.
  ///
  /// Never null and never blocking. Before the first sync this is whatever was
  /// stored on this terminal, and before *that* it is the defaults — which are
  /// this venue's real numbers, so even the very first swipe on a brand new
  /// terminal with no network behaves correctly.
  CardSettings get settings => _cached ?? const CardSettings();

  /// Whether this terminal can issue a card.
  bool get canIssue => (terminalToken ?? '').isNotEmpty;

  /// Read what was stored last time. Called once at start-up.
  Future<CardSettings> load() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(_keySettings);
      if (raw != null && raw.isNotEmpty) {
        _cached = CardSettings.fromJson(jsonDecode(raw));
      }
    } catch (_) {
      // A stored blob this build cannot read is a terminal that falls back to
      // the defaults, which is exactly what a fresh one does.
    }
    return settings;
  }

  /// Pull the rules from the back office and keep them.
  ///
  /// Returns whether they arrived. A failure is not worth reporting anywhere:
  /// the till carries on with what it had, which is the whole reason it is
  /// stored.
  Future<bool> sync() async {
    final token = terminalToken;
    if (token == null || token.isEmpty) return false;

    try {
      final res = await _client
          .get(
            Uri.parse('$apiBase/till/cards/settings'),
            headers: {'Authorization': 'Bearer $token'},
          )
          .timeout(_timeout);
      if (res.statusCode != 200) return false;

      final settings = CardSettings.fromJson(jsonDecode(res.body));
      _cached = settings;

      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_keySettings, jsonEncode(settings.toJson()));
      return true;
    } catch (_) {
      return false;
    }
  }

  /// Take the next number for [kind] and attach it to somebody.
  ///
  /// The number comes from the server, under a lock — see the note at the top
  /// of this file for why it may not come from here.
  Future<IssuedCard> issue({
    required CardKind kind,
    String? subjectId,
    String? subjectName,
    String? issuedBy,
    String? terminal,
  }) async {
    final token = terminalToken;
    if (token == null || token.isEmpty) {
      throw CardException(
        'This terminal was set up before card issuing existed. Sign the till '
        'in again from Settings to enable it.',
      );
    }

    final http.Response res;
    try {
      res = await _client
          .post(
            Uri.parse('$apiBase/till/cards/issue'),
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer $token',
            },
            body: jsonEncode({
              'kind': kind.name,
              'subject_id': subjectId,
              'subject_name': subjectName,
              'issued_by': issuedBy,
              'terminal': terminal,
            }),
          )
          .timeout(_timeout);
    } catch (e) {
      throw CardException(
        'The till could not reach the back office, so no card number was '
        'issued. Nothing has been written to the card.',
      );
    }

    final body = jsonDecode(res.body) as Map<String, dynamic>;
    if (res.statusCode >= 400) {
      throw CardException(
        body['error'] as String? ?? 'The back office refused to issue a card.',
      );
    }

    final cardNumber = body['card_number'] as String? ?? '';
    return IssuedCard(
      kind: kind,
      number: (body['number'] as num?)?.toInt() ?? 0,
      cardNumber: cardNumber,
      // Taken from the server where it sent one, and built here where it did
      // not. Both produce the same string; the fallback is so that a slightly
      // older server does not leave the screen with nothing to show the person
      // holding the encoder.
      track: body['track'] as String? ?? CardSettings.trackFor(cardNumber),
    );
  }

  /// Attach a card somebody already holds to a member or a member of staff.
  ///
  /// The other half of issuing, and the one a venue moving from another system
  /// needs most: their cards are already printed and those numbers were not
  /// allocated here.
  Future<void> assign({
    required String cardNumber,
    required String subjectId,
    String? subjectName,
    String? issuedBy,
    String? terminal,
  }) async {
    final token = terminalToken;
    if (token == null || token.isEmpty) {
      throw CardException(
        'This terminal was set up before card issuing existed. Sign the till '
        'in again from Settings to enable it.',
      );
    }

    final http.Response res;
    try {
      res = await _client
          .post(
            Uri.parse('$apiBase/till/cards/assign'),
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer $token',
            },
            body: jsonEncode({
              'card_number': cardNumber,
              'subject_id': subjectId,
              'subject_name': subjectName,
              'issued_by': issuedBy,
              'terminal': terminal,
            }),
          )
          .timeout(_timeout);
    } catch (e) {
      throw CardException(
        'The till could not reach the back office, so the card was not '
        'attached to anybody.',
      );
    }

    if (res.statusCode >= 400) {
      final body = jsonDecode(res.body) as Map<String, dynamic>;
      throw CardException(
        body['error'] as String? ?? 'The back office refused that card.',
      );
    }
  }
}
