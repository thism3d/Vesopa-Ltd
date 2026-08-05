import 'dart:convert';

import 'package:drift/drift.dart';
import 'package:http/http.dart' as http;

import 'local/database.dart';

/// Why a staff list could not be pulled, in words a manager standing at the
/// till can act on.
class StaffSyncFailed implements Exception {
  StaffSyncFailed(this.message);
  final String message;

  @override
  String toString() => message;
}

/// The venue's staff, and the PIN check that signs them on.
///
/// Two rules shape this class:
///
///  1. **The check is local.** A till that could only verify a PIN online would
///     stop selling the moment the broadband dropped — with the idle lock on,
///     it would not even open. So the list is cached in SQLite and every check
///     reads the cache.
///
///  2. **The pull is authenticated.** The rest of the till's sync uses public
///     `?office=` routes, which is fine for a product list and not remotely
///     fine for credentials. This one route goes out with the terminal token
///     from commissioning, so knowing a venue's contact email is not enough to
///     download its PINs.
class StaffRepository {
  StaffRepository({
    required this.apiBase,
    required this.db,
    required this.terminalToken,
    http.Client? client,
  }) : _client = client ?? http.Client();

  final String apiBase;
  final AppDatabase db;

  /// Null on a terminal commissioned before v1.3.1.0.
  final String? terminalToken;

  final http.Client _client;

  /// Every member of staff who may sign on, as the till last saw them.
  Future<List<StaffData>> all() =>
      (db.select(db.staff)..orderBy([(s) => OrderingTerm(expression: s.pluid)]))
          .get();

  Future<bool> get isEmpty async => (await all()).isEmpty;

  /// Pull the list and replace the cache.
  ///
  /// Replaced wholesale rather than merged: someone removed in the back office
  /// must stop being able to sign on, and a merge would leave their row (and
  /// their PIN) working on the terminal indefinitely.
  ///
  /// The write is a single transaction, so a failure part-way cannot leave the
  /// till with an empty staff table and no way in.
  Future<void> sync({Duration timeout = const Duration(seconds: 10)}) async {
    final token = terminalToken;
    if (token == null) {
      throw StaffSyncFailed(
        'This terminal was set up before staff sign-on existed. Sign the till '
        'in again from Settings to enable it.',
      );
    }

    final http.Response res;
    try {
      res = await _client
          .get(
            Uri.parse('$apiBase/till/staff'),
            headers: {'Authorization': 'Bearer $token'},
          )
          .timeout(timeout);
    } catch (e) {
      throw StaffSyncFailed(
        'Could not reach the back office to update the staff list.\n\n$e',
      );
    }

    if (res.statusCode == 401) {
      throw StaffSyncFailed(
        (jsonDecode(res.body) as Map<String, dynamic>)['error'] as String? ??
            'This terminal needs to be signed in again.',
      );
    }
    if (res.statusCode != 200) {
      throw StaffSyncFailed('The back office refused the staff list.');
    }

    final rows = (jsonDecode(res.body) as List)
        .cast<Map<String, dynamic>>()
        // A row with no PIN cannot be signed on with, and would otherwise match
        // an empty entry on the pad.
        .where((r) => (r['pin'] as String?)?.trim().isNotEmpty ?? false)
        .toList();

    await db.transaction(() async {
      await db.delete(db.staff).go();
      for (final r in rows) {
        await db.into(db.staff).insert(
              StaffData(
                id: (r['id'] as num).toInt(),
                pluid: (r['pluid'] as num?)?.toInt() ?? 0,
                name: (r['name'] as String?)?.trim().isNotEmpty ?? false
                    ? (r['name'] as String).trim()
                    : 'Staff ${r['id']}',
                pin: (r['pin'] as String).trim(),
              ),
              mode: InsertMode.insertOrReplace,
            );
      }
    });
  }

  /// Who this PIN belongs to, or null if it belongs to nobody.
  ///
  /// Cache first, server second — and only on a miss.
  ///
  /// The cache is the fast path and the offline path: an equality check against a
  /// handful of local rows, so the overwhelmingly common case (someone who has
  /// signed on before) costs no network at all and works with the broadband down.
  ///
  /// A miss is the interesting case. It means either a wrong PIN, or a member of
  /// staff added in the back office moments ago whose row has not reached this
  /// terminal — and those are indistinguishable from the cache alone. Guessing
  /// "wrong PIN" is what made a newly added person unable to sign on until
  /// something else happened to refresh the list. So a miss re-pulls the list and
  /// checks once more.
  ///
  /// One round trip, only when it can change the answer, and the cache is left
  /// current afterwards. A genuinely wrong PIN costs that same round trip, which
  /// is the right way round: mistyping is rare, and being unable to sign on is
  /// worse than waiting a moment to be told.
  Future<StaffData?> byPin(String pin) async {
    final trimmed = pin.trim();
    if (trimmed.isEmpty) return null;

    final cached = await _cachedByPin(trimmed);
    if (cached != null) return cached;

    // Nothing to gain from asking when this terminal cannot ask.
    if (terminalToken == null) return null;

    try {
      await sync(timeout: const Duration(seconds: 5));
    } on StaffSyncFailed {
      // Offline, or the token has been revoked. The cache already said no, and
      // that is the best answer available.
      return null;
    }
    return _cachedByPin(trimmed);
  }

  /// The local half of [byPin]. The back office refuses to issue two people the
  /// same PIN, which is what makes a single match the right answer here rather
  /// than a guess between candidates.
  Future<StaffData?> _cachedByPin(String pin) =>
      (db.select(db.staff)..where((s) => s.pin.equals(pin))).getSingleOrNull();
}
