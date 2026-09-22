import 'dart:convert';

import 'package:http/http.dart' as http;

import 'local/database.dart';
import 'sync_service.dart';

/// Why a logout was refused.
class LogoutBlocked implements Exception {
  LogoutBlocked(this.message);
  final String message;

  @override
  String toString() => message;
}

/// Signing out of a till is not the same as signing out of a website: whatever
/// is on this terminal and nowhere else is *the only copy* of that money.
///
/// So the sequence is deliberate:
///   1. Verify the password against the live server — an offline terminal
///      cannot confirm who is standing in front of it, and letting anyone close
///      the till would be worse than making them wait for a signal.
///   2. Flush the outbox, so every sale taken offline reaches the server.
///   3. Only then clear the session.
///
/// If any step fails, the logout is refused and the reason is shown. Wiping a
/// terminal that still holds unsynced sales would destroy takings.
class AuthService {
  AuthService({
    required this.apiBase,
    required this.db,
    required this.sync,
    http.Client? client,
  }) : _client = client ?? http.Client();

  final String apiBase;
  final AppDatabase db;
  final SyncService sync;
  final http.Client _client;

  /// How many sales are still waiting to reach the server.
  Future<int> pendingCount() async {
    final rows = await db.select(db.outboxEntries).get();
    return rows.length;
  }

  /// Any bill still sitting on a table. Closing the till on these would strand
  /// them where the next shift cannot see them.
  Future<int> parkedCount() async {
    final rows = await (db.select(db.orders)
          ..where((o) => o.status.equals('parked')))
        .get();
    return rows.length;
  }

  Future<bool> _verify(String email, String password) async {
    final res = await _client
        .post(
          Uri.parse('$apiBase/api/login'),
          headers: {'Content-Type': 'application/json'},
          body: jsonEncode({'email': email, 'password': password}),
        )
        .timeout(const Duration(seconds: 12));

    if (res.statusCode == 200) return true;
    if (res.statusCode == 401) return false;

    // 403 (paused office) and anything else are not a wrong password — say so
    // rather than telling the clerk they mistyped.
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    throw LogoutBlocked(
      (body['error'] as String?) ?? 'Server refused the sign-in.',
    );
  }

  /// Returns normally only if the till is safe to hand over.
  Future<void> logout({
    required String email,
    required String password,
  }) async {
    // 1. Who is this?
    final bool ok;
    try {
      ok = await _verify(email, password);
    } on LogoutBlocked {
      rethrow;
    } catch (e) {
      throw LogoutBlocked(
        'Cannot reach the server to confirm your password. '
        'Connect to the network and try again — signing out now could leave '
        'unsynced sales on this terminal.\n\n$e',
      );
    }
    if (!ok) throw LogoutBlocked('That password is not correct.');

    // 2. Get every offline sale onto the server.
    await sync.flush();

    final pending = await pendingCount();
    if (pending > 0) {
      throw LogoutBlocked(
        '$pending sale(s) could not be sent to the server. '
        'Signing out now would risk losing them. Check the connection and try '
        'again.',
      );
    }

    // 3. Parked bills are not lost — they stay on this terminal — but the
    //    person taking over must know they are there.
    final parked = await parkedCount();
    if (parked > 0) {
      throw LogoutBlocked(
        '$parked bill(s) are still open on tables. Settle or clear them before '
        'signing out.',
      );
    }
  }
}
