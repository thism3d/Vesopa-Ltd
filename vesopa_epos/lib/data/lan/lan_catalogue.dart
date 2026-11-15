/// The menu, prices, screens and staff over the venue's own network
/// (2026-11-15, owner: a slave till takes "menu, prices and staff" from the
/// master).
///
/// Every till keeps the last good answer the back office gave it for each of
/// its catalogue downloads. When a download fails -- the internet is down, or
/// this till has never had it -- the till asks the main till for its copy over
/// the local link, and reads that exactly as it would have read the back
/// office's answer. Any till may be the main one, so every till keeps the
/// copies. The link is encrypted with the venue's key (staff PINs travel in
/// the staff list, as they do from the back office).
///
/// A till that hears the main till has something newer than it holds asks
/// its own downloads to run again ([onNewer]), so a price changed while one
/// till was cut off reaches it without anyone restarting it.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';

import 'lan_link.dart';
import 'lan_service.dart';

class LanCatalogue {
  LanCatalogue._();
  static final instance = LanCatalogue._();

  /// A second till, for a test that stands two side by side.
  LanCatalogue.forTest();

  static const channel = 'catalogue';

  /// The downloads kept: the name is the file and the key on the link.
  static const keys = {'products', 'departments', 'deals', 'denominations', 'staff', 'screens', 'modifiers'};

  Directory? _dir;
  final Map<String, String> _hash = {};
  bool _started = false;
  Timer? _debounce;
  final Set<String> _newer = {};

  /// Run the downloads again: the main till holds something newer.
  Future<void> Function(Set<String> keys)? onNewer;

  /// Where the copies are kept. Set in tests.
  Future<Directory?> Function() directory = () async {
    try {
      final base = await getApplicationSupportDirectory();
      return Directory('${base.path}${Platform.pathSeparator}lan-catalogue');
    } catch (_) {
      return null;
    }
  };

  /// The link, so a test can stand two tills side by side.
  bool Function() linked = () => LanService.instance.linked;
  bool Function() isHub = () => LanService.instance.isHub;
  bool Function(String channel, Object? data, {String? key}) publish =
      (channel, data, {key}) => LanService.instance.publish(channel, data, key: key);
  Future<Object?> Function(String channel, Object? data) request =
      (channel, data) => LanService.instance.request(channel, data, timeout: const Duration(seconds: 8));

  /// Answer the other tills, and listen for a newer catalogue. Once.
  void start() {
    if (_started) return;
    _started = true;
    final lan = LanService.instance;
    lan.handle(channel, (data, from) => answer(data));
    lan.subscribe(channel, heard);
    // A new main till has no notes of what anybody holds: say what is here.
    lan.whenReady(() => unawaited(announce()));
  }

  Future<Directory?> _folder() async {
    final known = _dir;
    if (known != null) return known;
    final d = await directory();
    if (d == null) return null;
    try {
      await d.create(recursive: true);
    } catch (_) {
      return null;
    }
    return _dir = d;
  }

  Future<File?> _file(String key) async {
    final d = await _folder();
    return d == null ? null : File('${d.path}${Platform.pathSeparator}$key.json');
  }

  static String _digest(List<int> bytes) => sha1.convert(bytes).toString();

  Future<String?> _held(String key) async {
    final known = _hash[key];
    if (known != null) return known;
    try {
      final f = await _file(key);
      if (f == null || !await f.exists()) return null;
      return _hash[key] = _digest(await f.readAsBytes());
    } catch (_) {
      return null;
    }
  }

  /// One catalogue download: the back office first, the main till's copy when
  /// that fails. Returns what the caller would have had from the back office.
  Future<http.Response> fetch(String key, Future<http.Response> Function() cloud) async {
    http.Response? res;
    Object? failure;
    try {
      res = await cloud();
    } catch (e) {
      failure = e;
    }
    if (res != null && res.statusCode == 200) {
      unawaited(keep(key, res.bodyBytes));
      return res;
    }
    // A refusal that is about this till (signed out, not licensed) is not the
    // internet being down: the main till's copy must not paper over it.
    if (res != null && (res.statusCode == 401 || res.statusCode == 403)) return res;
    final local = await fromMainTill(key);
    if (local != null) return local;
    if (res != null) return res;
    throw failure ?? const SocketException('The back office could not be reached');
  }

  /// Keep the back office's answer, and tell the link when it is a new one.
  Future<void> keep(String key, List<int> bytes) async {
    if (!keys.contains(key) || bytes.isEmpty) return;
    final digest = _digest(bytes);
    if (await _held(key) == digest) return;
    try {
      final f = await _file(key);
      if (f == null) return;
      final tmp = File('${f.path}.new');
      await tmp.writeAsBytes(bytes, flush: true);
      await tmp.rename(f.path);
      _hash[key] = digest;
    } catch (_) {
      return;
    }
    if (linked()) publish(channel, {'hash': digest, 'at': DateTime.now().millisecondsSinceEpoch}, key: key);
  }

  /// What this till holds, onto the link (after a new main till appears).
  Future<void> announce() async {
    if (!linked() || !isHub()) return;
    for (final key in keys) {
      final digest = await _held(key);
      if (digest != null) publish(channel, {'hash': digest, 'at': DateTime.now().millisecondsSinceEpoch}, key: key);
    }
  }

  /// The main till's copy of [key], as an answer from the back office.
  Future<http.Response?> fromMainTill(String key) async {
    if (!linked() || isHub()) return null;
    try {
      final got = await request(channel, {'key': key});
      if (got is! Map || got['body'] is! String) return null;
      final bytes = utf8.encode(got['body'] as String);
      // Kept here too, quietly: this till may be the main one tomorrow.
      unawaited(_store(key, bytes));
      return http.Response.bytes(bytes, 200, headers: const {'content-type': 'application/json; charset=utf-8'});
    } on LanUnavailable {
      return null;
    } on TimeoutException {
      return null;
    } catch (_) {
      return null;
    }
  }

  Future<void> _store(String key, List<int> bytes) async {
    try {
      final f = await _file(key);
      if (f == null) return;
      await f.writeAsBytes(bytes, flush: true);
      _hash[key] = _digest(bytes);
    } catch (_) {}
  }

  /// On the main till: another till asking for a copy.
  Future<Object?> answer(Object? data) async {
    final key = data is Map ? '${data['key'] ?? ''}' : '';
    if (!keys.contains(key)) throw const LanUnavailable('Not a catalogue this till keeps');
    final f = await _file(key);
    if (f == null || !await f.exists()) throw LanUnavailable('The main till has no copy of $key yet');
    return {'key': key, 'body': utf8.decode(await f.readAsBytes())};
  }

  /// A till saying what it holds. Something different from ours, from the main
  /// till's side of the link: run that download again, shortly, all at once.
  Future<void> heard(LanMessage m) async {
    final key = m.key;
    final d = m.data;
    if (key == null || d is! Map || !keys.contains(key)) return;
    if (isHub()) return;
    if ('${d['hash'] ?? ''}' == await _held(key)) return;
    _newer.add(key);
    _debounce?.cancel();
    _debounce = Timer(const Duration(seconds: 2), () {
      final wanted = {..._newer};
      _newer.clear();
      final run = onNewer;
      if (run != null && wanted.isNotEmpty) unawaited(run(wanted).catchError((Object _) {}));
    });
  }
}
