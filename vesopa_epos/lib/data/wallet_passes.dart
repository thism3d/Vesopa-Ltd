/// The cards a customer already carries on their phone.
///
/// WHAT THIS IS FOR AT A COUNTER
///
/// Two moments, and they are different:
///
///   * a customer who has a pass and cannot find it — the clerk brings it up,
///     and the customer scans it off the screen facing them;
///   * a customer who does not have one — the clerk shows them a code, they
///     point a phone at it, and the card lands in their wallet.
///
/// Both are the same request: give me the links for this person. Whether they
/// already hold the pass or are about to is not something the till needs to
/// know, because the link builds the pass either way.
///
/// ONE LINK, EITHER PHONE
///
/// The server decides what to serve from what asked: an iPhone gets a signed
/// `.pkpass`, anything else is redirected to the Google save link. So there is
/// one code on screen and the clerk never has to ask which phone somebody has —
/// which at a counter is the difference between this being used and not.
///
/// AUTHENTICATED WITH THE TERMINAL TOKEN
///
/// Not the public `?office=` routes the catalogue sync uses. This says which
/// cards a named person holds, and knowing a venue's contact email must not be
/// enough to ask.
library;

import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

/// One card a customer can be handed.
@immutable
class WalletPass {
  const WalletPass({
    required this.kind,
    required this.label,
    required this.name,
    required this.cardNumber,
    required this.scanUrl,
  });

  /// 'loyalty' | 'customer' | 'giftcard' | 'staff' | 'promo'.
  final String kind;

  /// What to call it on screen — "Loyalty Card", "Gift Card".
  final String label;

  /// Whose card it is.
  final String name;

  /// The number the barcode carries. The same one on the plastic, so a phone
  /// and a card scan to the same person.
  final String cardNumber;

  /// What the QR encodes. Device-aware at the far end — see the note above.
  final String scanUrl;

  static WalletPass? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final kind = raw['kind'];
    final url = raw['scan_url'];
    if (kind is! String || url is! String || url.isEmpty) return null;
    return WalletPass(
      kind: kind,
      label: (raw['label'] as String?)?.trim().isNotEmpty ?? false
          ? (raw['label'] as String).trim()
          : kind,
      name: (raw['name'] as String?)?.trim() ?? '',
      cardNumber: (raw['card_number'] as String?)?.trim() ?? '',
      scanUrl: url,
    );
  }
}

/// What the venue offers, and what this person holds.
@immutable
class WalletOffer {
  const WalletOffer({
    required this.enabled,
    required this.programName,
    required this.passes,
  });

  /// Whether the venue issues wallet passes at all. False is a normal answer
  /// and the till says so rather than showing an empty list, which reads as a
  /// fault.
  final bool enabled;

  final String programName;
  final List<WalletPass> passes;

  static const none = WalletOffer(enabled: false, programName: '', passes: []);
}

class WalletException implements Exception {
  WalletException(this.message);
  final String message;

  @override
  String toString() => message;
}

class WalletRepository {
  WalletRepository({
    required this.apiBase,
    required this.terminalToken,
    http.Client? client,
  }) : _client = client ?? http.Client();

  final String apiBase;

  /// Null on a terminal commissioned before terminal tokens existed. Such a
  /// till shows nothing rather than falling back to an unauthenticated route —
  /// there is none, and there should not be.
  final String? terminalToken;

  final http.Client _client;

  bool get available => (terminalToken ?? '').isNotEmpty;

  /// Every pass this venue would issue to [subjectId].
  Future<WalletOffer> forSubject(String subjectId) async {
    final token = terminalToken;
    if (token == null || token.isEmpty) return WalletOffer.none;

    final http.Response res;
    try {
      res = await _client
          .get(
            Uri.parse(
              '$apiBase/till/wallet/passes'
              '?subject_id=${Uri.encodeComponent(subjectId)}',
            ),
            headers: {'Authorization': 'Bearer $token'},
          )
          .timeout(const Duration(seconds: 10));
    } catch (e) {
      throw WalletException(
        'The till could not reach the back office, so it cannot show this '
        "customer's cards.",
      );
    }

    if (res.statusCode != 200) {
      throw WalletException('The back office refused that request.');
    }

    final body = jsonDecode(res.body);
    if (body is! Map) return WalletOffer.none;

    return WalletOffer(
      enabled: body['enabled'] == true,
      programName: (body['program_name'] as String?)?.trim() ?? '',
      passes: [
        for (final entry in (body['passes'] as List? ?? const []))
          ?WalletPass.fromJson(entry),
      ],
    );
  }
}
