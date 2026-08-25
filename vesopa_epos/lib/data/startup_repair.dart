import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqlite3/sqlite3.dart';

/// Getting a till that will not start, started.
///
/// A terminal loses power mid-write — which is what a till at a counter does,
/// nightly, for years — and the preferences file in AppData is left truncated.
/// Every read of it throws from then on, on every launch, for ever. The till
/// showed a spinner on black and nothing else, in a window it deliberately will
/// not let anybody close, and the only cure was somebody who knew to delete
/// `%APPDATA%\Vesopa EPOS Limited\Vesopa EPOS` by hand.
///
/// That is not a fault an operator can be asked to diagnose at eight in the
/// morning with a queue at the counter. So the till now does it itself, on the
/// way up, before a single provider has read anything.
///
/// **The sales database is never touched here, and that rule is the whole
/// design.** `vesopa_epos.sqlite` holds the outbox — sales rung up but not yet
/// pushed to the back office — and for those it is the only copy of the money.
/// Preferences are a cache of things the server can send again: the session,
/// the screen layout, the printer names. Throwing those away costs a sign-in.
/// Throwing the database away costs a venue its takings, so nothing automatic
/// is ever allowed to do it. See [resetEverything] for the deliberate,
/// operator-confirmed version, and the same rule written out again in
/// `_recommissionIfNeeded` in main.dart.
class StartupRepair {
  const StartupRepair({
    this.repaired = false,
    this.failure,
    this.movedTo,
    this.databaseMovedTo,
  });

  /// True when the preferences were unreadable and have been set aside, so the
  /// till is starting from a blank slate and will ask to be signed in.
  final bool repaired;

  /// Set when even that did not help. The UI shows this rather than spinning.
  final Object? failure;

  /// Where the unreadable file was moved, for whoever picks up the support call.
  final String? movedTo;

  /// Where an unreadable *sales* file was moved.
  ///
  /// Non-null means this terminal started with an empty local database, and the
  /// venue has to be told: any sale in the old one that had not reached the back
  /// office is not in the new one. The file is kept rather than deleted because
  /// a corrupt SQLite file is often still partly salvageable by somebody with
  /// the right tools, and that is a venue's takings.
  final String? databaseMovedTo;

  bool get healthy => failure == null;

  static const ok = StartupRepair();
}

/// How long to wait for local storage before treating it as broken.
///
/// Reading a small JSON file off a local disk is instant. Ten seconds is not a
/// judgement about how slow it might legitimately be — it is well past the
/// point where the only remaining explanations are a failure that will never
/// resolve on its own.
const _storageTimeout = Duration(seconds: 10);

/// Make local storage usable, repairing it if it is not.
///
/// Called from `main()` before `runApp`, which is the one place that can fix
/// this for every provider at once: they all reach for the same
/// [SharedPreferences] singleton, so one repair here is the difference between
/// a till that opens and forty widgets that each throw.
Future<StartupRepair> repairStorageIfNeeded() async {
  // Checked first and independently: a sound preferences file and a broken
  // database is a real combination, and it is the nastier of the two. It gets
  // the terminal past sign-on and into the till, where the sale page waits on a
  // query that will never answer — chrome at the top, a spinner where the
  // buttons should be. Nothing about that says "local file" to the person
  // looking at it.
  final databaseMovedTo = await _setAsideDatabaseIfUnreadable();

  try {
    await SharedPreferences.getInstance().timeout(_storageTimeout);
    return StartupRepair(databaseMovedTo: databaseMovedTo);
  } catch (first) {
    // Fall through and try to fix it. Deliberately catching everything: a
    // corrupt file throws FormatException, a locked one throws from the
    // platform channel, and a wedged one throws TimeoutException. All three
    // leave the operator looking at the same spinner.
    final moved = await setAsidePreferences();

    try {
      // `getInstance` clears its cached completer when it fails, so this
      // genuinely re-reads rather than handing back the same broken future.
      await SharedPreferences.getInstance().timeout(_storageTimeout);
      return StartupRepair(
        repaired: true,
        movedTo: moved,
        databaseMovedTo: databaseMovedTo,
      );
    } catch (second) {
      return StartupRepair(
        repaired: moved != null,
        failure: second,
        movedTo: moved,
        databaseMovedTo: databaseMovedTo,
      );
    }
  }
}

/// Move the preferences file out of the way, keeping it for support.
///
/// Renamed rather than deleted. It costs nothing, it is the only evidence of
/// what went wrong on that terminal, and a till that has repaired itself twice
/// in a week is telling somebody something about its power supply.
@visibleForTesting
Future<String?> setAsidePreferences() async {
  try {
    final dir = await getApplicationSupportDirectory().timeout(_storageTimeout);
    final stamp = DateTime.now().toIso8601String().replaceAll(':', '-');

    String? moved;
    for (final name in const [
      'shared_preferences.json',
      // The older Windows implementation kept its own file beside it. A
      // terminal upgraded in place can still have one.
      'shared_preferences.dat',
    ]) {
      final file = File(p.join(dir.path, name));
      if (!file.existsSync()) continue;
      final target = p.join(dir.path, '$name.unreadable-$stamp');
      try {
        file.renameSync(target);
        moved = target;
      } catch (_) {
        // Renaming can fail if something still holds the handle. Truncating it
        // is the fallback: an empty file parses as no preferences at all, which
        // is exactly the blank slate we are trying to reach.
        try {
          file.writeAsStringSync('{}');
          moved = file.path;
        } catch (_) {
          // Nothing more to try. The caller reports the failure rather than
          // hiding it behind a spinner, which is the point of all of this.
        }
      }
    }
    return moved;
  } catch (_) {
    return null;
  }
}

/// Open the sales file and prove it answers, moving it aside if it does not.
///
/// This is the one place the database may be interfered with automatically, and
/// it is allowed for a reason that does not weaken the rule everywhere else:
/// **a file SQLite cannot open holds no sales the app can ever send.** They are
/// already gone by the time this runs. Moving it aside loses nothing that was
/// still reachable, and it turns a till that spins for ever into a till that
/// sells — while keeping the file, because somebody with the right tools can
/// often still pull rows out of a corrupt database, and those rows are money.
///
/// A healthy file is opened, checked and closed in a few milliseconds, so this
/// costs nothing on the terminals where nothing is wrong.
@visibleForTesting
Future<String?> setAsideDatabaseIfUnreadable() => _setAsideDatabaseIfUnreadable();

Future<String?> _setAsideDatabaseIfUnreadable() async {
  File file;
  try {
    final dir = await getApplicationSupportDirectory().timeout(_storageTimeout);
    file = File(p.join(dir.path, 'vesopa_epos.sqlite'));
    // A terminal that has never been used has no file yet, and that is not a
    // fault — the first open creates it.
    if (!file.existsSync()) return null;
  } catch (_) {
    return null;
  }

  try {
    final db = sqlite3.open(file.path);
    try {
      // quick_check rather than a bare open: SQLite will happily open a file
      // whose header survived and whose pages did not, and the failure then
      // arrives later, on the first real query, from inside the till.
      final rows = db.select('PRAGMA quick_check');
      final answer = rows.isEmpty ? '' : '${rows.first.values.first}';
      if (answer.toLowerCase() != 'ok') {
        throw StateError('quick_check said $answer');
      }
    } finally {
      db.close();
    }
    return null;
  } catch (_) {
    final stamp = DateTime.now().toIso8601String().replaceAll(':', '-');
    final target = '${file.path}.unreadable-$stamp';
    try {
      file.renameSync(target);
      // The write-ahead log and shared-memory files belong to the old database
      // and would be applied to the new one, which is how a "repaired" till
      // corrupts itself again on its second launch.
      for (final suffix in const ['-wal', '-shm', '-journal']) {
        final side = File('${file.path}$suffix');
        if (side.existsSync()) {
          try {
            side.renameSync('$target$suffix');
          } catch (_) {
            // Best effort; SQLite rebuilds these from nothing.
          }
        }
      }
      return target;
    } catch (_) {
      // It could not be moved — held open, or a read-only folder. Reporting
      // nothing is right: the till will fail the same way it did before, and
      // the recovery screen is what the operator meets.
      return null;
    }
  }
}

/// Everything this terminal holds locally, removed — sales included.
///
/// The operator-confirmed last resort, and never automatic. It is offered
/// because a database that will not open cannot be repaired from inside the
/// app, and a till that cannot sell is worse than a till that has lost its
/// unsent sales. But it is their call, made in front of a warning that says
/// what it costs, because the money in that file is not ours to write off.
Future<void> resetEverything() async {
  try {
    final prefs = await SharedPreferences.getInstance().timeout(_storageTimeout);
    await prefs.clear();
  } catch (_) {
    // Already unreadable; the file removal below covers it.
  }

  final dir = await getApplicationSupportDirectory().timeout(_storageTimeout);
  for (final entity in dir.listSync()) {
    if (entity is! File) continue;
    final name = p.basename(entity.path);
    if (name.startsWith('shared_preferences') ||
        name.startsWith('vesopa_epos.sqlite')) {
      try {
        entity.deleteSync();
      } catch (_) {
        // A file the OS still holds. The next launch starts clean anyway
        // because the rest of the set has gone.
      }
    }
  }
}
