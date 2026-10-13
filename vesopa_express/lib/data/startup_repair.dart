import 'dart:async';
import 'dart:io';

import 'package:shared_preferences/shared_preferences.dart';

/// Getting a screen that will not start, started.
///
/// A kitchen screen loses power mid-write and the preferences file in AppData
/// is left truncated or full of zeros. Every read of it throws from then on,
/// on every launch: Pontardawe RFC's kitchen sat on a spinner over
/// "FormatException: Unexpected character (at character 1)", through updates
/// and restarts (2026-10-13). The till has repaired this on the way up since
/// it first happened there; this is the same repair.
///
/// Preferences here are the session and the screen's own settings, all of
/// which the back office can send again: throwing them away costs a sign-in.
const _storageTimeout = Duration(seconds: 10);

/// Make the preferences readable, setting an unreadable file aside if not.
///
/// [dataFolder] is the app's folder under `%APPDATA%`, the same one
/// `Handover.adopt` is given. Returns where the bad file went, or null when
/// nothing was wrong (or nothing could be done).
Future<String?> repairPreferencesIfNeeded(String dataFolder) async {
  try {
    await SharedPreferences.getInstance().timeout(_storageTimeout);
    return null;
  } catch (_) {
    // Corrupt (FormatException), locked, or wedged: all leave a spinner.
  }
  final moved = setAsidePreferences(dataFolder);
  try {
    // getInstance forgets a failed read, so this really reads again.
    await SharedPreferences.getInstance().timeout(_storageTimeout);
  } catch (_) {
    // Reported by the session screen as before; nothing more to do here.
  }
  return moved;
}

/// Rename the preferences file out of the way, keeping it for support.
String? setAsidePreferences(String dataFolder, {String? root}) {
  final base = root ?? Platform.environment['APPDATA'];
  if (base == null) return null;
  final stamp = DateTime.now().toIso8601String().replaceAll(':', '-');
  String? moved;
  for (final name in const ['shared_preferences.json', 'shared_preferences.dat']) {
    final file = File('$base\\$dataFolder\\$name');
    if (!file.existsSync()) continue;
    final target = '${file.path}.unreadable-$stamp';
    try {
      file.renameSync(target);
      moved = target;
    } catch (_) {
      // Held open: an empty object is the blank slate we want anyway.
      try {
        file.writeAsStringSync('{}');
        moved = file.path;
      } catch (_) {}
    }
  }
  return moved;
}
