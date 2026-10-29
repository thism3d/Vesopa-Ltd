import 'dart:convert';

import 'package:drift/drift.dart';
import 'package:http/http.dart' as http;

import 'local/database.dart';
import 'sync_service.dart';
import 'vesopa_sso.dart';

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
          // Practice bills (training mode) do not count: they are nobody's
          // money, and are cleared on their own.
          ..where((o) => o.status.equals('parked') & o.training.equals(false)))
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

    await _handOver();
  }

  /// Sign out confirmed with the person's Vesopa account rather than a typed
  /// password (2026-10-27).
  ///
  /// With Vesopa as the way in, an account has no password the back office
  /// holds -- the Users page stopped offering "Reset password" for that reason
  /// -- so the password box could never be answered and a till could not be
  /// signed out. The person signs in to Vesopa again (their own password,
  /// passkey or two-step, in the browser) and the back office says whether
  /// they are one of this venue's users (`/api/vesopa/confirm`).
  Future<void> logoutWithVesopa({
    required String issuer,
    required String clientId,
    required String? terminalToken,
    void Function(Uri url)? onUrl,
  }) async {
    final idToken = await VesopaSso(issuer: issuer, clientId: clientId).authorize(onUrl: onUrl);
    final http.Response res;
    try {
      res = await _client
          .post(
            Uri.parse('$apiBase/api/vesopa/confirm'),
            headers: {
              'Content-Type': 'application/json',
              if ((terminalToken ?? '').isNotEmpty) 'Authorization': 'Bearer $terminalToken',
            },
            body: jsonEncode({'id_token': idToken}),
          )
          .timeout(const Duration(seconds: 15));
    } catch (e) {
      throw LogoutBlocked(
        'Cannot reach the server to confirm who you are. Connect to the network '
        'and try again.\n\n$e',
      );
    }
    if (res.statusCode != 200) {
      String? why;
      try {
        why = (jsonDecode(res.body) as Map<String, dynamic>)['error'] as String?;
      } catch (_) {}
      throw LogoutBlocked(why ?? 'Vesopa could not confirm that sign-in.');
    }
    await _handOver();
  }

  /// Everything after "who is this?": the sales sent, the tables checked.
  Future<void> _handOver() async {
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
