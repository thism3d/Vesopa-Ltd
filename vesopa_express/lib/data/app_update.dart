import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

/// Moving this app to the version its venue is set to (admin.vesopa.com
/// Versions, 2026-10-05).
///
/// "It asks the user do you want to update or do you want to update on next
/// update." (Nicki Tidbell, describing Newbridge)
///
/// ONE FILE, FIVE APPS, like data/licence.dart: the till, kitchen screen,
/// customer display, kiosk and Loyalty carry identical copies, so the five
/// cannot drift into five ideas of when to update.
///
/// HOW IT FITS TOGETHER
///
///   * Only a copy installed from our own installer (installer/vesopa-app.iss)
///     ever updates itself. That installer writes `vesopa-install.txt` beside
///     the program with the version it installed; a Microsoft Store copy has
///     no such file and is left to the Store.
///   * The device says what it runs on the licence check it already makes
///     every five minutes ([Installation.headers]). The back office answers
///     with `update` when the venue is set to another version, up OR down, and
///     only once Vesopa has switched update prompts on.
///   * The installer is fetched in the background and checked against its
///     SHA-256 before anybody is asked. "Update now" runs it silently and the
///     app comes back on its own; "On next start" runs it the next time the
///     app opens, before anything else.
///
/// NOTHING HERE MAY STOP A VENUE TRADING. Every failure (no network, a bad
/// download, a full disk) is swallowed and simply means no prompt this time.
class AppUpdate {
  const AppUpdate({
    required this.version,
    required this.url,
    required this.sha256,
    this.size,
    this.downgrade = false,
  });

  final String version;
  final String url;
  final String sha256;
  final int? size;

  /// The venue was moved back to an older version.
  final bool downgrade;

  static AppUpdate? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final version = raw['version'];
    final url = raw['url'];
    final sha = raw['sha256'];
    if (version is! String || url is! String || sha is! String) return null;
    if (!url.startsWith('https://') || sha.length != 64) return null;
    return AppUpdate(
      version: version,
      url: url,
      sha256: sha.toLowerCase(),
      size: (raw['size'] as num?)?.toInt(),
      downgrade: raw['downgrade'] == true,
    );
  }
}

/// What this copy of the app is, as the back office is told.
class Installation {
  const Installation({
    required this.version,
    required this.kind,
    required this.deviceId,
    required this.deviceName,
  });

  /// The version actually installed: the installer's own record for a copy
  /// from our installer, else the version built into the app.
  final String version;

  /// `direct` (our installer), `store` (Microsoft Store) or `other` (a phone,
  /// a browser, a developer build). Only `direct` is ever offered an update.
  final String kind;

  final String deviceId;
  final String deviceName;

  bool get updatable => kind == 'direct';

  Map<String, String> get headers => {
        'X-Vesopa-App-Version': version,
        'X-Vesopa-Install': kind,
        'X-Vesopa-Device-Id': deviceId,
        if (deviceName.isNotEmpty) 'X-Vesopa-Device-Name': deviceName,
      };

  static Future<Installation>? _current;

  /// Read once per run. [builtVersion] is the app's own version constant.
  static Future<Installation> current(String builtVersion) =>
      _current ??= _read(builtVersion);

  static Future<Installation> _read(String builtVersion) async {
    var version = builtVersion;
    var kind = 'other';
    var name = '';
    if (!kIsWeb && Platform.isWindows) {
      kind = 'store';
      try {
        name = Platform.localHostname;
        final marker = File(
          '${File(Platform.resolvedExecutable).parent.path}\\vesopa-install.txt',
        );
        if (marker.existsSync()) {
          final recorded = marker.readAsStringSync().trim();
          if (recorded.isNotEmpty) version = recorded;
          kind = 'direct';
        }
      } catch (_) {
        // Unreadable: treated as a Store copy, which is never updated by us.
      }
    }
    var id = '';
    try {
      final prefs = await SharedPreferences.getInstance();
      id = prefs.getString(_idKey) ?? '';
      if (id.isEmpty) {
        id = _newId();
        await prefs.setString(_idKey, id);
      }
    } catch (_) {
      id = _newId();
    }
    return Installation(version: version, kind: kind, deviceId: id, deviceName: name);
  }

  static const _idKey = 'vesopa_install_id';

  static String _newId() {
    final now = DateTime.now().microsecondsSinceEpoch;
    return sha1.convert(utf8.encode('$now-${Object().hashCode}')).toString().substring(0, 24);
  }
}

/// Fetching and running installers.
class Updater {
  static const _pendingKey = 'vesopa_pending_update';
  static const _triedKey = 'vesopa_update_tried';

  /// Versions this run has already dealt with, so a prompt waved away is not
  /// put back every five minutes.
  static final Set<String> _handled = {};

  static Directory _folder() {
    final base = Platform.environment['LOCALAPPDATA'] ?? Directory.systemTemp.path;
    return Directory('$base\\Vesopa\\Updates');
  }

  static Future<bool> _matches(File file, String sha) async {
    try {
      if (!file.existsSync()) return false;
      final digest = await sha256.bind(file.openRead()).first;
      return digest.toString() == sha;
    } catch (_) {
      return false;
    }
  }

  /// The installer for [update], downloaded and checked, or null.
  static Future<File?> fetch(AppUpdate update) async {
    try {
      final dir = _folder();
      await dir.create(recursive: true);
      final file = File('${dir.path}\\${update.sha256.substring(0, 16)}-setup.exe');
      if (await _matches(file, update.sha256)) return file;
      final part = File('${file.path}.part');
      final client = http.Client();
      try {
        final res = await client
            .send(http.Request('GET', Uri.parse(update.url)))
            .timeout(const Duration(seconds: 30));
        if (res.statusCode != 200) return null;
        final sink = part.openWrite();
        await res.stream.pipe(sink);
      } finally {
        client.close();
      }
      if (!await _matches(part, update.sha256)) {
        if (part.existsSync()) await part.delete();
        return null;
      }
      if (file.existsSync()) await file.delete();
      return await part.rename(file.path);
    } catch (_) {
      return null;
    }
  }

  /// Run the installer silently and leave; it closes nothing we have not
  /// closed, replaces the program and starts it again.
  static Future<void> install(AppUpdate update, File installer) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_triedKey, update.version);
      await prefs.remove(_pendingKey);
      await Process.start(
        installer.path,
        const ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/RELAUNCH=1'],
        mode: ProcessStartMode.detached,
      );
    } catch (_) {
      return; // Could not start it: carry on as we are.
    }
    exit(0);
  }

  /// "On next start": remember it, and [applyPending] runs it then.
  static Future<void> later(AppUpdate update, File installer) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(
        _pendingKey,
        jsonEncode({
          'version': update.version,
          'url': update.url,
          'sha256': update.sha256,
          'path': installer.path,
        }),
      );
    } catch (_) {}
  }

  /// Call first thing in main(), after WidgetsFlutterBinding.ensureInitialized().
  /// Runs an update somebody chose to take "on next start", and returns only
  /// when there is none (or it could not be run).
  static Future<void> applyPending(String builtVersion) async {
    if (kIsWeb || !Platform.isWindows) return;
    try {
      final me = await Installation.current(builtVersion);
      if (!me.updatable) return;
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(_pendingKey);
      if (raw == null) return;
      final pending = jsonDecode(raw) as Map<String, dynamic>;
      final update = AppUpdate.fromJson(pending);
      if (update == null || _same(update.version, me.version)) {
        await prefs.remove(_pendingKey);
        return;
      }
      final file = File(pending['path'] as String? ?? '');
      if (!await _matches(file, update.sha256)) {
        await prefs.remove(_pendingKey);
        return;
      }
      await install(update, file);
    } catch (_) {}
  }

  /// Whether to offer [update] to this copy now.
  static Future<bool> _wanted(AppUpdate update, Installation me) async {
    if (!me.updatable || _same(update.version, me.version)) return false;
    if (_handled.contains(update.version)) return false;
    try {
      // Installed once already and still not on it: the installer did not
      // take. Asking again would loop; the admin page shows the device behind.
      final prefs = await SharedPreferences.getInstance();
      if (prefs.getString(_triedKey) == update.version) return false;
    } catch (_) {}
    return true;
  }

  static bool _same(String a, String b) => _norm(a) == _norm(b);

  static String _norm(String v) {
    final parts = v.split('+').first.trim().split('.');
    while (parts.length > 3 && parts.last == '0') {
      parts.removeLast();
    }
    return parts.join('.');
  }
}

/// Offer [update]: fetch it quietly, then ask "Update now" or "On next start".
///
/// Safe to call on every licence answer: it asks at most once per version per
/// run, and does nothing for a Store copy or when nothing changed. [ready] is
/// checked again just before asking, so a till can decline while a bill is
/// open and be asked at the next check instead.
Future<void> offerUpdate(
  BuildContext context, {
  required AppUpdate? update,
  required String appName,
  required String builtVersion,
  bool Function()? ready,
}) async {
  if (update == null || kIsWeb || !Platform.isWindows) return;
  final me = await Installation.current(builtVersion);
  if (!await Updater._wanted(update, me)) return;
  if (ready != null && !ready()) return;
  Updater._handled.add(update.version);
  final file = await Updater.fetch(update);
  if (file == null) {
    Updater._handled.remove(update.version); // try again at the next check
    return;
  }
  if (!context.mounted || (ready != null && !ready())) {
    Updater._handled.remove(update.version);
    return;
  }
  final now = await showDialog<bool>(
    context: context,
    barrierDismissible: false,
    builder: (context) => AlertDialog(
      title: Text(update.downgrade ? '$appName is moving to version ${update.version}' : 'A new version of $appName is ready'),
      content: Text(
        update.downgrade
            ? 'Vesopa has set this device back to version ${update.version} (it has ${me.version}). '
                'Updating closes $appName for about a minute and opens it again.'
            : 'Version ${update.version} is ready to install (this device has ${me.version}). '
                'Updating closes $appName for about a minute and opens it again.',
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(false),
          child: const Text('On next start'),
        ),
        FilledButton(
          onPressed: () => Navigator.of(context).pop(true),
          child: const Text('Update now'),
        ),
      ],
    ),
  );
  if (now == true) {
    await Updater.install(update, file);
  } else {
    await Updater.later(update, file);
  }
}

/// For a screen customers face (the customer display, the kiosk), where a
/// question nobody at the counter can answer must not appear: fetch [update]
/// quietly and take it the next time the app starts.
Future<void> stageUpdate(AppUpdate? update, {required String builtVersion}) async {
  if (update == null || kIsWeb || !Platform.isWindows) return;
  final me = await Installation.current(builtVersion);
  if (!await Updater._wanted(update, me)) return;
  Updater._handled.add(update.version);
  final file = await Updater.fetch(update);
  if (file == null) {
    Updater._handled.remove(update.version);
    return;
  }
  await Updater.later(update, file);
}
