/// The till's end of the offline ledger (2026-10-27): keeps the snapshot,
/// asks the main till to take each move, holds the venue's list of moves, and
/// -- on the main till -- sends them to the cloud when it is back.
///
/// The rules are in offline_ledger.dart. This is the part that talks: to the
/// back office for the snapshot and the replay, to the main till over the
/// local link for everything else.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';

import 'lan_link.dart';
import 'lan_service.dart';
import 'offline_ledger.dart';

class OfflineMoney {
  OfflineMoney._();
  static final instance = OfflineMoney._();

  final ledger = OfflineLedger();

  String? _apiBase;
  String? _token;
  String _deviceId = '';
  http.Client _client = http.Client();

  bool _wired = false;
  Timer? _snapshotTimer;
  Timer? _replayTimer;
  int _n = 0;

  /// Gift card holds taken while offline: spent at capture, nothing to give
  /// back at release (no money was reserved on the cloud).
  final Map<String, ({String code, int amountMinor, String? orderId, String? clerk})> holds = {};

  /// Whether a move can be taken offline at all: a snapshot to check it
  /// against, and a main till (perhaps this one) to take it.
  bool get ready => ledger.hasSnapshot && LanService.instance.linked;

  Future<void> configure({
    required String apiBase,
    required String? token,
    required String deviceId,
    http.Client? client,
  }) async {
    if (client != null) _client = client;
    _apiBase = apiBase;
    _token = token;
    _deviceId = deviceId;
    if (_wired) return;
    _wired = true;
    await _load();
    final lan = LanService.instance;
    lan.subscribe('ledger', _onMessage);
    lan.handle('ledger', _onRequest);
    lan.whenReady(() => unawaited(_catchUp()));
    _snapshotTimer = Timer.periodic(const Duration(minutes: 10), (_) => unawaited(refreshSnapshot()));
    Timer(const Duration(seconds: 20), () => unawaited(refreshSnapshot()));
    _replayTimer = Timer.periodic(const Duration(seconds: 15), (_) => unawaited(replay()));
  }

  void dispose() {
    _snapshotTimer?.cancel();
    _replayTimer?.cancel();
  }

  // ---- the venue's list --------------------------------------------------

  void _onMessage(LanMessage m) {
    final d = m.data;
    if (d is! Map) return;
    switch (d['op']) {
      case 'entry':
        final e = LedgerEntry.fromJson(d['entry']);
        if (e != null && ledger.add(e)) _save();
      case 'done':
        ledger.markDone('${d['id']}', (d['at'] as num?)?.toInt() ?? 0, failed: d['failed'] as String?);
        _save();
    }
  }

  /// On the main till: take a move, or hand over the list.
  Future<Object?> _onRequest(Object? data, String from) async {
    if (data is! Map) return {'ok': false, 'error': 'Bad request'};
    switch (data['op']) {
      case 'apply':
        final e = LedgerEntry.fromJson(data['entry']);
        if (e == null) return {'ok': false, 'error': 'Bad entry'};
        e.by = from;
        try {
          final taken = ledger.accept(e);
          LanService.instance.publish('ledger', {'op': 'entry', 'entry': taken.toJson()}, log: true);
          _save();
          return {'ok': true, 'entry': taken.toJson()};
        } on LedgerRefused catch (r) {
          return {'ok': false, 'error': r.message};
        }
      case 'state':
        return {'entries': [for (final e in ledger.entries) e.toJson()]};
    }
    return {'ok': false, 'error': 'Unknown request'};
  }

  /// Linked to a (perhaps new) main till: make sure both hold the same list.
  Future<void> _catchUp() async {
    final lan = LanService.instance;
    if (lan.isHub) return;
    try {
      final r = await lan.request('ledger', {'op': 'state'});
      if (r is Map) {
        var changed = false;
        for (final raw in (r['entries'] as List? ?? const [])) {
          final e = LedgerEntry.fromJson(raw);
          if (e != null && ledger.add(e)) changed = true;
        }
        if (changed) _save();
      }
    } catch (_) {}
  }

  /// Ask the main till to take a move. Throws [LedgerRefused] when the money
  /// is not there, [LanUnavailable] when there is no main till to ask.
  Future<LedgerEntry> apply(String kind, Map<String, dynamic> body) async {
    final e = LedgerEntry(
      id: '$_deviceId:${DateTime.now().microsecondsSinceEpoch}:${_n++}',
      kind: kind,
      body: body,
      at: LanService.instance.now(),
    );
    final r = await LanService.instance.request('ledger', {'op': 'apply', 'entry': e.toJson()});
    if (r is! Map || r['ok'] != true) {
      throw LedgerRefused(r is Map ? '${r['error'] ?? 'Refused'}' : 'Refused');
    }
    final taken = LedgerEntry.fromJson(r['entry']) ?? e;
    if (ledger.add(taken)) _save();
    return taken;
  }

  // ---- the cloud ---------------------------------------------------------------

  Map<String, String> get _headers => {
        if ((_token ?? '').isNotEmpty) 'Authorization': 'Bearer $_token',
        'Content-Type': 'application/json',
      };

  bool _snapshotting = false;

  /// A fresh copy of the venue's members, cards and vouchers.
  Future<void> refreshSnapshot() async {
    final base = _apiBase;
    if (base == null || (_token ?? '').isEmpty || _snapshotting) return;
    _snapshotting = true;
    try {
      final res = await _client
          .get(Uri.parse('$base/api/lan/snapshot'), headers: _headers)
          .timeout(const Duration(seconds: 60));
      if (res.statusCode != 200) return;
      final j = jsonDecode(res.body) as Map<String, dynamic>;
      ledger.setSnapshot(j, at: LanService.instance.now());
      _save(snapshot: true);
    } catch (_) {
      // Offline, or a back office without the route: keep the copy we have.
    } finally {
      _snapshotting = false;
    }
  }

  bool _replaying = false;

  /// On the main till, once the cloud answers: send each move, in order, once.
  Future<void> replay() async {
    final lan = LanService.instance;
    final base = _apiBase;
    if (!lan.isHub || base == null || _replaying) return;
    final todo = ledger.toReplay;
    if (todo.isEmpty) return;
    _replaying = true;
    final conflicts = <Map<String, Object?>>[];
    var sent = 0;
    try {
      for (final e in todo) {
        final path = replayPath(e.kind);
        if (path.isEmpty) continue;
        http.Response res;
        try {
          res = await _client
              .post(
                Uri.parse('$base$path'),
                headers: {..._headers, 'X-Vesopa-Offline-Id': e.id},
                body: jsonEncode(e.body),
              )
              .timeout(const Duration(seconds: 15));
        } catch (_) {
          break; // still offline: try again on the next tick, in the same order
        }
        if (res.statusCode >= 500) break;
        String? failed;
        if (res.statusCode >= 400) {
          try {
            failed = '${(jsonDecode(res.body) as Map)['error'] ?? res.statusCode}';
          } catch (_) {
            failed = 'HTTP ${res.statusCode}';
          }
          conflicts.add({
            'device': e.by,
            'kind': e.kind,
            'ref': e.id,
            'detail': {'error': failed, 'body': e.body},
          });
        }
        final at = lan.now();
        ledger.markDone(e.id, at, failed: failed);
        lan.publish('ledger', {'op': 'done', 'id': e.id, 'at': at, 'failed': ?failed}, log: true);
        sent++;
      }
    } finally {
      _replaying = false;
      if (sent > 0) _save();
    }
    if (conflicts.isNotEmpty) unawaited(lan.logConflicts(conflicts));
    if (sent > 0 && ledger.toReplay.isEmpty) unawaited(refreshSnapshot());
  }

  // ---- on disk ---------------------------------------------------------------

  File? _file;
  File? _snapFile;
  Timer? _saveTimer;
  bool _saveSnapshot = false;

  Future<void> _load() async {
    try {
      final dir = await getApplicationSupportDirectory();
      _file = File('${dir.path}${Platform.pathSeparator}lan_ledger.json');
      _snapFile = File('${dir.path}${Platform.pathSeparator}lan_snapshot.json');
      if (await _snapFile!.exists()) {
        final j = jsonDecode(await _snapFile!.readAsString()) as Map<String, dynamic>;
        ledger.setSnapshot({...j, 'applied': const []}, at: (j['at'] as num?)?.toInt() ?? 1);
      }
      if (await _file!.exists()) {
        final list = jsonDecode(await _file!.readAsString()) as List;
        for (final raw in list) {
          final e = LedgerEntry.fromJson(raw);
          if (e != null) ledger.add(e);
        }
      }
    } catch (_) {
      // A file that will not read is a till starting with nothing offline,
      // which is what it had before this existed.
    }
  }

  void _save({bool snapshot = false}) {
    _saveSnapshot = _saveSnapshot || snapshot;
    _saveTimer?.cancel();
    _saveTimer = Timer(const Duration(milliseconds: 300), () async {
      try {
        await _file?.writeAsString(jsonEncode([for (final e in ledger.entries) e.toJson()]), flush: true);
        if (_saveSnapshot) {
          _saveSnapshot = false;
          await _snapFile?.writeAsString(jsonEncode(ledger.snapshotJson()), flush: true);
        }
      } catch (_) {}
    });
  }
}
