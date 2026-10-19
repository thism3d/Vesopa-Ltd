import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:path_provider/path_provider.dart';

/// Teya's Windows ePOS SDK app, run by the till (2026-10-19).
///
/// Teya's rule (docs.teya.com, ePOS SDK overview): "Where an Android, Windows
/// or iOS SDK covers your platform, always use the SDK." On Windows the SDK is
/// an executable (TeyaEposIntegrationsApp.exe) that the till starts as a
/// sub-process and talks to over JSON-RPC on its standard input and output,
/// one JSON message per line. It handles the merchant's Teya sign-in, the
/// store and card machine link, token refresh and the payment itself.
///
/// It is 130 MB, so it is not in the till's installer: a till at a venue that
/// uses Teya downloads it the first time (from the address the Vesopa server
/// gives, Teya's own CDN), checks it is signed by Teya's certificate, and keeps
/// it under the till's local app data. Every other till never fetches it.
class TeyaSdkInfo {
  const TeyaSdkInfo({
    required this.clientId,
    required this.clientSecret,
    required this.production,
    required this.version,
    required this.url,
    required this.thumbprint,
  });

  final String clientId;
  final String clientSecret;
  final bool production;
  final String version;
  final String url;

  /// SHA-1 thumbprint of Teya's signing certificate (signing_cert.cer).
  final String thumbprint;

  static TeyaSdkInfo? fromJson(Object? j) {
    if (j is! Map) return null;
    final win = j['windows'];
    if (win is! Map) return null;
    final id = '${j['client_id'] ?? ''}';
    final secret = '${j['client_secret'] ?? ''}';
    final url = '${win['url'] ?? ''}';
    if (id.isEmpty || secret.isEmpty || url.isEmpty) return null;
    return TeyaSdkInfo(
      clientId: id,
      clientSecret: secret,
      production: j['production'] == true,
      version: '${win['version'] ?? ''}',
      url: url,
      thumbprint: '${win['thumbprint'] ?? ''}'.toUpperCase(),
    );
  }
}

class TeyaSdkException implements Exception {
  TeyaSdkException(this.message, {this.code});
  final String message;
  final int? code;
  @override
  String toString() => message;
}

/// The running SDK app, one per till process.
class TeyaSdk {
  TeyaSdk._();
  static final TeyaSdk instance = TeyaSdk._();

  static const exeName = 'TeyaEposIntegrationsApp.exe';

  Process? _process;
  String? _initializedFor;
  int _nextId = 1;
  final _pending = <String, Completer<Map<String, dynamic>>>{};
  final _notifications = StreamController<Map<String, dynamic>>.broadcast();

  /// Messages without an id: payment state changes.
  Stream<Map<String, dynamic>> get notifications => _notifications.stream;

  /// What the till's Settings shows about the SDK.
  String status = 'Not started';

  /// Store and card machine from the last successful setup.
  Map<String, dynamic>? store;
  Map<String, dynamic>? terminal;

  bool get running => _process != null;

  Future<Directory> _home(String version) async {
    final base = await getApplicationSupportDirectory();
    return Directory(
      '${base.path}${Platform.pathSeparator}teya_sdk${Platform.pathSeparator}$version',
    );
  }

  Future<String?> _findExe(Directory dir) async {
    if (!await dir.exists()) return null;
    await for (final f in dir.list(recursive: true)) {
      if (f is File && f.path.toLowerCase().endsWith(exeName.toLowerCase()))
        return f.path;
    }
    return null;
  }

  /// The thumbprint of the certificate that signed [path], read by Windows.
  static Future<String> signerThumbprint(String path) async {
    final escaped = path.replaceAll("'", "''");
    final r = await Process.run('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "(Get-AuthenticodeSignature -LiteralPath '$escaped').SignerCertificate.Thumbprint",
    ]);
    return '${r.stdout}'.trim().toUpperCase();
  }

  /// Download and unpack the SDK app when this till does not have it yet.
  Future<String> install(
    TeyaSdkInfo info, {
    void Function(String)? onStatus,
  }) async {
    final dir = await _home(info.version);
    final have = await _findExe(dir);
    if (have != null &&
        (info.thumbprint.isEmpty ||
            await signerThumbprint(have) == info.thumbprint)) {
      return have;
    }
    void say(String s) {
      status = s;
      onStatus?.call(s);
    }

    say('Downloading Teya (about 75 MB, once)…');
    final tmp = Directory('${dir.path}.download');
    if (await tmp.exists()) await tmp.delete(recursive: true);
    await tmp.create(recursive: true);
    final zip = File('${tmp.path}${Platform.pathSeparator}sdk.zip');
    final client = HttpClient();
    try {
      final req = await client.getUrl(Uri.parse(info.url));
      final res = await req.close();
      if (res.statusCode != 200)
        throw TeyaSdkException(
          'Teya\'s download answered ${res.statusCode}. Try again later.',
        );
      await res.pipe(zip.openWrite());
    } on TeyaSdkException {
      rethrow;
    } catch (e) {
      throw TeyaSdkException('Could not download Teya: $e');
    } finally {
      client.close(force: true);
    }

    say('Unpacking Teya…');
    // The download holds signing_cert.cer and the distributable zip; the
    // distributable holds the app folder.
    Future<void> expand(String zipPath, String into) async {
      final r = await Process.run('powershell', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Expand-Archive -LiteralPath '${zipPath.replaceAll("'", "''")}' -DestinationPath '${into.replaceAll("'", "''")}' -Force",
      ]);
      if (r.exitCode != 0)
        throw TeyaSdkException(
          'Could not unpack Teya: ${'${r.stderr}'.trim()}',
        );
    }

    final outer = '${tmp.path}${Platform.pathSeparator}outer';
    await expand(zip.path, outer);
    String? inner;
    await for (final f in Directory(outer).list(recursive: true)) {
      if (f is File && f.path.toLowerCase().endsWith('.zip')) inner = f.path;
    }
    final app = '${tmp.path}${Platform.pathSeparator}app';
    if (inner != null) {
      await expand(inner, app);
    } else {
      await Directory(outer).rename(app);
    }
    final exe = await _findExe(Directory(app));
    if (exe == null)
      throw TeyaSdkException('The Teya download did not contain the Teya app.');

    // Teya sign the executable; a file that is not theirs is never run.
    if (info.thumbprint.isNotEmpty) {
      say('Checking Teya\'s signature…');
      final got = await signerThumbprint(exe);
      if (got != info.thumbprint) {
        await tmp.delete(recursive: true);
        throw TeyaSdkException(
          'The Teya download is not signed by Teya, so it was not used.',
        );
      }
    }
    if (await dir.exists()) await dir.delete(recursive: true);
    await Directory(app).rename(dir.path);
    try {
      await tmp.delete(recursive: true);
    } catch (_) {}
    final placed = await _findExe(dir);
    if (placed == null)
      throw TeyaSdkException('Teya could not be installed on this till.');
    say('Teya installed');
    return placed;
  }

  /// Start the SDK app (installing it first if needed) and initialize it.
  Future<void> start(
    TeyaSdkInfo info, {
    required String version,
    String? eposInstanceId,
    void Function(String)? onStatus,
  }) async {
    final key = '${info.clientId}|${info.production}|${info.version}';
    if (_process != null && _initializedFor == key) return;
    await stop();
    final exe = await install(info, onStatus: onStatus);
    // An SDK app left over from a till that did not close cleanly would
    // hold the link files: stop it before starting ours.
    try {
      await Process.run('taskkill', ['/IM', exeName, '/F']);
    } catch (_) {}
    status = 'Starting Teya…';
    onStatus?.call(status);
    final p = await Process.start(
      exe,
      const [],
      workingDirectory: File(exe).parent.path,
    );
    _process = p;
    p.stdout
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .listen(_onLine, onDone: _onExit);
    p.stderr.drain<void>();
    unawaited(p.exitCode.then((_) => _onExit()));
    final r = await call('initialize', {
      'requesterId': 'vesopa-epos',
      'requesterVersion': version,
      'isProductionEnv': info.production,
      'clientId': info.clientId,
      'clientSecret': info.clientSecret,
      if (eposInstanceId != null && eposInstanceId.isNotEmpty)
        'eposInstanceId': eposInstanceId,
    }, const Duration(seconds: 60));
    if (r['type'] != 'initialize->ack')
      throw TeyaSdkException('Teya did not start properly.');
    _initializedFor = key;
    status = 'Teya started';
    onStatus?.call(status);
  }

  void _onLine(String line) {
    final text = line.trim();
    if (text.isEmpty) return;
    Map<String, dynamic> j;
    try {
      final d = jsonDecode(text);
      if (d is! Map<String, dynamic>) return;
      j = d;
    } catch (_) {
      return; // a log line
    }
    final id = j['id'];
    if (id == null) {
      final result = j['result'];
      if (result is Map<String, dynamic>) _notifications.add(result);
      return;
    }
    final c = _pending.remove('$id');
    if (c == null || c.isCompleted) return;
    final err = j['error'];
    if (err is Map) {
      c.completeError(
        TeyaSdkException(
          '${err['message'] ?? 'Teya refused the request.'}',
          code: (err['code'] as num?)?.toInt(),
        ),
      );
    } else {
      final result = j['result'];
      c.complete(result is Map<String, dynamic> ? result : <String, dynamic>{});
    }
  }

  void _onExit() {
    if (_process == null) return;
    _process = null;
    _initializedFor = null;
    status = 'Teya stopped';
    for (final c in _pending.values) {
      if (!c.isCompleted)
        c.completeError(TeyaSdkException('Teya stopped unexpectedly.'));
    }
    _pending.clear();
  }

  /// Call a method and wait for its answer. Setup can show Teya's sign-in
  /// screens, so it has no practical time limit.
  Future<Map<String, dynamic>> call(
    String method, [
    Map<String, dynamic>? params,
    Duration timeout = const Duration(seconds: 30),
  ]) => _call(method, params, timeout);

  Future<Map<String, dynamic>> _call(
    String method,
    Map<String, dynamic>? params,
    Duration timeout,
  ) async {
    final p = _process;
    if (p == null) throw TeyaSdkException('Teya is not running on this till.');
    final id = '${_nextId++}';
    final c = Completer<Map<String, dynamic>>();
    _pending[id] = c;
    p.stdin.writeln(
      jsonEncode({
        'jsonrpc': '2.0',
        'id': id,
        'method': method,
        'params': ?params,
      }),
    );
    await p.stdin.flush();
    return c.future.timeout(
      timeout,
      onTimeout: () {
        _pending.remove(id);
        throw TeyaSdkException('Teya did not answer in time.');
      },
    );
  }

  /// Sign in, store and card machine: shows Teya's screens the first time.
  Future<Map<String, dynamic>> setup() async {
    final r = await _call('setup', null, const Duration(minutes: 30));
    if (r['response'] == 'SUCCESS') {
      store = r['store'] as Map<String, dynamic>?;
      terminal = r['terminal'] as Map<String, dynamic>?;
      status = 'Ready';
    }
    return r;
  }

  Future<void> stop() async {
    final p = _process;
    _process = null;
    _initializedFor = null;
    if (p != null) {
      try {
        p.kill();
      } catch (_) {}
    }
  }
}
