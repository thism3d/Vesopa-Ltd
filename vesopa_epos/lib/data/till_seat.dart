/// This till's licence seat.
///
/// A venue buys a number of till licences, and every till signed in holds one
/// (src/till_seats.js on the server). The seat is claimed at sign-in -- a venue
/// with every licence in use is refused there, with the tills holding them
/// named -- and released when the till signs out, or when a manager signs the
/// till out from the back office (Devices).
///
/// A till released from the back office learns it the next time it shows its
/// terminal token: the server answers 401 with `signed_out`. The shell asks
/// every couple of minutes, and signs the till out once its sales are safe.
library;

import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;

import '../main.dart' show apiBaseProvider, sessionProvider;

enum SeatStatus {
  /// Signed in and holding a licence (or on a server without licences).
  held,

  /// Signed out from the back office. The till should follow.
  signedOut,

  /// No answer -- offline, or an older server. Never a reason to act.
  unknown,
}

class TillSeat {
  const TillSeat({required this.status, this.limit, this.inUse = 0});

  static const unknown = TillSeat(status: SeatStatus.unknown);

  final SeatStatus status;

  /// How many tills the venue is licensed for. Null is no limit.
  final int? limit;

  /// How many are signed in now, this one included.
  final int inUse;

  /// "2 of 3 tills in use", for About.
  String? get describe => switch (status) {
    SeatStatus.held when limit != null => '$inUse of $limit till licences in use',
    SeatStatus.held => '$inUse ${inUse == 1 ? 'till' : 'tills'} signed in',
    SeatStatus.signedOut => 'Signed out from the back office',
    SeatStatus.unknown => null,
  };
}

/// Ask the back office about this till's seat.
Future<TillSeat> checkTillSeat(String apiBase, String terminalToken) async {
  try {
    final res = await http
        .get(
          Uri.parse('$apiBase/till/seat'),
          headers: {'Authorization': 'Bearer $terminalToken'},
        )
        .timeout(const Duration(seconds: 10));
    if (res.statusCode == 401) {
      final body = jsonDecode(res.body);
      // Only the server's own "signed out" is acted on. Any other 401 -- a
      // clock out by a day, a server with a new secret -- is left to the
      // messages that already explain those.
      if (body is Map && body['signed_out'] == true) {
        return const TillSeat(status: SeatStatus.signedOut);
      }
      return TillSeat.unknown;
    }
    if (res.statusCode != 200) return TillSeat.unknown;
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    return TillSeat(
      status: SeatStatus.held,
      limit: (body['limit'] as num?)?.toInt(),
      inUse: (body['in_use'] as num?)?.toInt() ?? 0,
    );
  } catch (_) {
    return TillSeat.unknown;
  }
}

/// Give this till's licence back, on a verified sign-out. Best effort: a till
/// signing out with no network keeps its seat until a manager releases it.
Future<void> releaseTillSeat(String apiBase, String terminalToken) async {
  try {
    await http
        .post(
          Uri.parse('$apiBase/till/seat/release'),
          headers: {'Authorization': 'Bearer $terminalToken'},
        )
        .timeout(const Duration(seconds: 6));
  } catch (_) {
    // Nothing to do: see above.
  }
}

/// This till's seat, for the About page.
final tillSeatProvider = FutureProvider.autoDispose<TillSeat>((ref) async {
  final token = ref.watch(sessionProvider).terminalToken;
  if (token == null) return TillSeat.unknown;
  return checkTillSeat(ref.watch(apiBaseProvider), token);
});
