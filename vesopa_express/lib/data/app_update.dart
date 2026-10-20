import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
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
///     no such file. Since 2026-10-08 a Store copy is told about its venue's
///     version too and, once the Store has it, asks the same question and
///     updates in place through the Store's own update service ([StoreUpdate])
///     -- forward only, as the Store goes.
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
    this.storeId,
    this.switchToDirect = false,
  });

  final String version;
  final String url;
  final String sha256;
  final int? size;

  /// The venue was moved back to an older version.
  final bool downgrade;

  /// Set when this copy came from the Microsoft Store (2026-10-08): this is
  /// the app's Store product. A Store copy cannot run our installer -- that
  /// puts a second app beside it -- so it updates through the Store
  /// ([StoreUpdate]).
  final String? storeId;

  bool get viaStore => storeId != null;

  /// A Store copy set back to an older version (2026-10-08): the Store cannot
  /// go back, so it moves to our own installer, taking everything on it with
  /// it ([Handover]). From then on it moves either way like any of ours.
  final bool switchToDirect;

  static AppUpdate? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final version = raw['version'];
    if (raw['store'] == true) {
      final id = raw['store_id'];
      if (version is! String || id is! String || !RegExp(r'^[0-9A-Z]{12}$').hasMatch(id)) return null;
      return AppUpdate(version: version, url: '', sha256: '', storeId: id);
    }
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
      switchToDirect: raw['switch'] == true,
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
        // This copy asks the Store itself whether an update is there, so the
        // back office need not wait for the "live on the Store" mark.
        if (kind == 'store') 'X-Vesopa-Store-Check': '1',
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

/// A Microsoft Store copy updating in place (2026-10-08): "on store apps it
/// should act the same way no matter" (the owner). The Windows side is
/// windows/runner/store_update.cpp, through Windows.Services.Store -- the
/// update still comes from the Store, which is what the Store allows.
class StoreUpdate {
  static const _channel = MethodChannel('vesopa/store_update');

  /// The newest version the Store has for this copy, or null when it has
  /// none (or this is not a Store package, or the Store did not answer).
  static Future<String?> available() async {
    try {
      final r = await _channel.invokeMethod<Object?>('check');
      if (r is! Map || r['available'] != true) return null;
      final v = r['version'];
      return v is String && v.isNotEmpty ? v : '';
    } catch (_) {
      return null;
    }
  }

  /// Download and install it. On success Windows closes the app and opens it
  /// again on the new version; anything else returns and the app carries on.
  static Future<String> install() async {
    try {
      return await _channel.invokeMethod<String>('install') ?? 'failed';
    } catch (_) {
      return 'failed';
    }
  }
}

/// Fetching and running installers.
class Updater {
  static const _pendingKey = 'vesopa_pending_update';
  static const _triedKey = 'vesopa_update_tried';
  static const _pendingStoreKey = 'vesopa_pending_store_update';
  static const _pendingMoveKey = 'vesopa_pending_move_to_direct';

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
  static Future<File?> fetch(AppUpdate update, {Directory? into}) async {
    try {
      // A Store copy's AppData is its own private copy, which an installer
      // started outside it cannot see: it downloads to [Handover]'s folder.
      final dir = into ?? _folder();
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
      if (me.kind == 'store') return await _applyPendingStore(me);
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

  /// "On next start" on a Store copy: take the Store's update now, if it
  /// still has one. Asked once: a failure does not loop at every start.
  static Future<void> _applyPendingStore(Installation me) async {
    final prefs = await SharedPreferences.getInstance();
    final move = prefs.getString(_pendingMoveKey);
    if (move != null) {
      await prefs.remove(_pendingMoveKey);
      final pending = jsonDecode(move) as Map<String, dynamic>;
      final update = AppUpdate.fromJson(pending);
      final file = File(pending['path'] as String? ?? '');
      if (update != null && await _matches(file, update.sha256)) {
        await Handover.leave(update, file);
      }
    }
    final version = prefs.getString(_pendingStoreKey);
    if (version == null) return;
    await prefs.remove(_pendingStoreKey);
    if (_same(version, me.version)) return;
    if (await StoreUpdate.available() == null) return;
    await prefs.setString(_triedKey, version);
    await StoreUpdate.install();
  }

  static Future<void> _moveLater(AppUpdate update, File installer) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(
        _pendingMoveKey,
        jsonEncode({
          'version': update.version,
          'url': update.url,
          'sha256': update.sha256,
          'downgrade': true,
          'switch': true,
          'path': installer.path,
        }),
      );
    } catch (_) {}
  }

  static Future<void> _laterFromStore(AppUpdate update) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_pendingStoreKey, update.version);
    } catch (_) {}
  }

  /// Whether to offer [update] to this copy now. A Store update only to a
  /// Store copy, an installer only to one of ours.
  static Future<bool> _wanted(AppUpdate update, Installation me) async {
    if (update.viaStore || update.switchToDirect ? me.kind != 'store' : !me.updatable) return false;
    if (_same(update.version, me.version)) return false;
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
/// run, and does nothing when nothing changed. [ready] is
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
  if (update.switchToDirect) {
    final file = await Updater.fetch(update, into: Handover.folder());
    if (file == null || !context.mounted || (ready != null && !ready())) {
      Updater._handled.remove(update.version);
      return;
    }
    final now = await _ask(context, update, appName: appName, current: me.version, version: update.version);
    if (now == true) {
      await Handover.leave(update, file);
    } else {
      await Updater._moveLater(update, file);
    }
    return;
  }
  if (update.viaStore) {
    // Only once the Store has it: until then (certification) there is
    // nothing to install, so ask again at the next check.
    final there = await StoreUpdate.available();
    if (there == null || !context.mounted || (ready != null && !ready())) {
      Updater._handled.remove(update.version);
      return;
    }
    final now = await _ask(context, update, appName: appName, current: me.version,
        version: there.isEmpty ? update.version : _short(there));
    if (now == true) {
      try {
        final prefs = await SharedPreferences.getInstance();
        await prefs.setString(Updater._triedKey, update.version);
      } catch (_) {}
      await StoreUpdate.install();
    } else {
      await Updater._laterFromStore(update);
    }
    return;
  }
  final file = await Updater.fetch(update);
  if (file == null) {
    Updater._handled.remove(update.version); // try again at the next check
    return;
  }
  if (!context.mounted || (ready != null && !ready())) {
    Updater._handled.remove(update.version);
    return;
  }
  final now = await _ask(context, update, appName: appName, current: me.version, version: update.version);
  if (now == true) {
    await Updater.install(update, file);
  } else {
    await Updater.later(update, file);
  }
}

/// "Update now" (true) or "On next start", the same for every kind of copy.
Future<bool?> _ask(
  BuildContext context,
  AppUpdate update, {
  required String appName,
  required String current,
  required String version,
}) =>
    showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (context) => AlertDialog(
        title: Text(update.downgrade ? '$appName is moving to version $version' : 'A new version of $appName is ready'),
        content: Text(
          update.switchToDirect
              ? 'Vesopa has set this device back to version $version (it has $current). '
                  'The Microsoft Store cannot go back a version, so this moves $appName to '
                  "Vesopa's own installer, with everything on it. It closes for about a minute "
                  'and opens again.'
              : update.downgrade
              ? 'Vesopa has set this device back to version $version (it has $current). '
                  'Updating closes $appName for about a minute and opens it again.'
              : 'Version $version is ready to install (this device has $current). '
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

/// 1.15.1.0 as people read it: 1.15.1.
String _short(String v) => Updater._norm(v);

/// For a screen customers face (the customer display, the kiosk), where a
/// question nobody at the counter can answer must not appear: fetch [update]
/// quietly and take it the next time the app starts.
///
/// A Store copy does the same: once the Store has the update, it is taken
/// at the next start.
Future<void> stageUpdate(AppUpdate? update, {required String builtVersion}) async {
  if (update == null || kIsWeb || !Platform.isWindows) return;
  final me = await Installation.current(builtVersion);
  if (!await Updater._wanted(update, me)) return;
  if (update.switchToDirect) {
    Updater._handled.add(update.version);
    final file = await Updater.fetch(update, into: Handover.folder());
    if (file == null) {
      Updater._handled.remove(update.version);
      return;
    }
    await Updater._moveLater(update, file);
    return;
  }
  if (update.viaStore) {
    if (await StoreUpdate.available() == null) return; // not there yet: next check
    Updater._handled.add(update.version);
    await Updater._laterFromStore(update);
    return;
  }
  Updater._handled.add(update.version);
  final file = await Updater.fetch(update);
  if (file == null) {
    Updater._handled.remove(update.version);
    return;
  }
  await Updater.later(update, file);
}

/// Moving a Microsoft Store copy to our own installer (2026-10-08): "I need
/// to move back" (the owner), which the Store cannot do.
///
/// A Store copy keeps its AppData in a private copy under
/// %LOCALAPPDATA%\Packages\<family>\LocalCache\Roaming, so:
///
///   1. The Store copy downloads our installer (checked against its SHA-256)
///      into a plain folder in the user's profile, leaves a marker there,
///      starts the installer through Explorer -- outside its package, where
///      an install is a real one -- and closes.
///   2. Our copy, first thing at its first start ([adopt]), sees the marker,
///      copies the Store copy's whole data folder over -- settings, sign-in,
///      and the till's database with its -wal file of unsent sales -- keeps
///      anything already there beside it, and removes the Store copy, so
///      nobody opens the old one by mistake.
class Handover {
  static Directory folder() => Directory(
        '${Platform.environment['USERPROFILE'] ?? Directory.systemTemp.path}\\Vesopa Handover',
      );

  static String _exe() =>
      File(Platform.resolvedExecutable).uri.pathSegments.last.toLowerCase();

  static File _marker() => File('${folder().path}\\${_exe()}.move');

  /// The Store copy's half: hand over to [installer] and close.
  static Future<void> leave(AppUpdate update, File installer) async {
    try {
      final dir = folder();
      await dir.create(recursive: true);
      await _marker().writeAsString(jsonEncode({
        'version': update.version,
        'at': DateTime.now().toIso8601String(),
      }));
      // A moment's pause first, so this copy has closed its files.
      final script = File('${dir.path}\\move-${_exe()}.cmd');
      await script.writeAsString(
        '@echo off\r\n'
        'ping -n 4 127.0.0.1 >nul\r\n'
        '"${installer.path}" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /RELAUNCH=1\r\n',
      );
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(Updater._triedKey, update.version);
      await Process.start('explorer.exe', [script.path], mode: ProcessStartMode.detached);
    } catch (_) {
      return; // Could not start it: carry on as we are.
    }
    exit(0);
  }

  /// Our copy's half. Call first thing in main(), before anything opens
  /// local storage. [dataFolder] is `<CompanyName>\<ProductName>` from
  /// windows/runner/Runner.rc, where Windows keeps this app's AppData.
  static Future<void> adopt(String dataFolder) async {
    if (kIsWeb || !Platform.isWindows) return;
    try {
      final marker = _marker();
      if (!marker.existsSync()) return;
      final mine = File('${File(Platform.resolvedExecutable).parent.path}\\vesopa-install.txt');
      if (!mine.existsSync()) return; // the Store copy itself: not yet
      final local = Platform.environment['LOCALAPPDATA'];
      final roaming = Platform.environment['APPDATA'];
      if (local == null || roaming == null) return;
      Directory? from;
      String? family;
      var newest = DateTime(1970);
      for (final pkg in Directory('$local\\Packages').listSync().whereType<Directory>()) {
        final d = Directory('${pkg.path}\\LocalCache\\Roaming\\$dataFolder');
        if (!d.existsSync()) continue;
        final t = d.statSync().modified;
        if (from == null || t.isAfter(newest)) {
          from = d;
          newest = t;
          family = pkg.uri.pathSegments.where((x) => x.isNotEmpty).last;
        }
      }
      if (from == null) {
        marker.deleteSync();
        return;
      }
      final to = Directory('$roaming\\$dataFolder');
      if (to.existsSync()) {
        // Kept beside it, not thrown away. Copied rather than renamed: the
        // activity log may already hold a file open in there.
        final stamp = DateTime.now().toIso8601String().replaceAll(RegExp(r'[^0-9]'), '').substring(0, 14);
        await _copy(to, Directory('${to.path} before move $stamp'));
      }
      await _copy(from, to);
      marker.deleteSync();
      // The old Store copy goes, now that everything on it is here.
      await Process.start(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          "Get-AppxPackage | Where-Object { \$_.PackageFamilyName -eq '$family' } | Remove-AppxPackage",
        ],
        mode: ProcessStartMode.detached,
      );
    } catch (_) {
      // Nothing here may stop the app opening.
    }
  }

  static Future<void> _copy(Directory from, Directory to) async {
    await to.create(recursive: true);
    for (final e in from.listSync()) {
      final name = e.uri.pathSegments.where((x) => x.isNotEmpty).last;
      if (e is Directory) {
        await _copy(e, Directory('${to.path}\\$name'));
      } else if (e is File) {
        try {
          await e.copy('${to.path}\\$name');
        } catch (_) {
          // One file held open (a log): the rest still comes over.
        }
      }
    }
  }
}
