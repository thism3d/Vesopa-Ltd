import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider_platform_interface/path_provider_platform_interface.dart';
import 'package:plugin_platform_interface/plugin_platform_interface.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqlite3/sqlite3.dart';
import 'package:vesopa_epos/data/startup_repair.dart';

/// A till that will not start.
///
/// The failure this guards is one an operator met and could do nothing about: a
/// terminal loses power mid-write, the preferences file in AppData is left
/// truncated, every read of it throws from then on, and the app shows a spinner
/// on black for ever — in a window it deliberately will not let anybody close.
/// The only cure was somebody who knew to delete a folder by hand.
///
/// Two rules are held here, and the second matters more than the first:
///
///   1. an unreadable preferences file is set aside rather than left to throw;
///   2. **the sales database is never taken with it.** It holds sales rung up
///      but not yet pushed to the back office, and for those it is the only
///      copy of the money. A start-up fix that quietly wipes a venue's takings
///      would be a worse bug than the one it fixes.
class _FakePathProvider extends PathProviderPlatform
    with MockPlatformInterfaceMixin {
  _FakePathProvider(this.root);

  final String root;

  @override
  Future<String?> getApplicationSupportPath() async => root;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Directory dir;

  setUp(() {
    dir = Directory.systemTemp.createTempSync('vesopa-startup-');
    PathProviderPlatform.instance = _FakePathProvider(dir.path);
  });

  tearDown(() {
    try {
      dir.deleteSync(recursive: true);
    } catch (_) {
      // Windows can still hold a handle for a moment after a test.
    }
  });

  /// The outbox: a real database, holding a sale the server has not seen.
  ///
  /// A real one rather than a text file with a plausible name, because the
  /// start-up check opens it and asks SQLite whether it is sound — and a
  /// fixture that cannot pass that check proves nothing about a till that can.
  File sales() {
    final path = p.join(dir.path, 'vesopa_epos.sqlite');
    final db = sqlite3.open(path);
    db.execute('CREATE TABLE outbox (id TEXT)');
    db.execute("INSERT INTO outbox VALUES ('a sale on its way to the server')");
    db.close();
    return File(path);
  }

  File preferences(String contents) {
    final file = File(p.join(dir.path, 'shared_preferences.json'));
    file.writeAsStringSync(contents);
    return file;
  }

  test('a terminal that reads fine is left exactly as it is', () async {
    SharedPreferences.setMockInitialValues({'session': '{"office":"a@b.c"}'});
    final till = sales();
    final prefsFile = preferences('{"flutter.session":"{}"}');

    final result = await repairStorageIfNeeded();

    expect(result.healthy, isTrue);
    expect(result.repaired, isFalse, reason: 'it repaired a terminal that was fine');
    expect(result.movedTo, isNull);
    expect(prefsFile.existsSync(), isTrue, reason: 'it moved a readable file');
    expect(till.existsSync(), isTrue);
  });

  // The file a power cut leaves behind: valid JSON up to the point the lights
  // went out, and nothing after it.
  test('an unreadable preferences file is set aside, not left to throw', () async {
    final prefsFile = preferences('{"flutter.session":"{\\"email\\":\\"man');
    final till = sales();

    final moved = await setAsidePreferences();

    expect(moved, isNotNull, reason: 'the unreadable file was left where it is read from');
    expect(prefsFile.existsSync(), isFalse, reason: 'the next launch will read it again');
    expect(File(moved!).existsSync(), isTrue, reason: 'the evidence was thrown away');
    expect(
      File(moved).readAsStringSync(),
      contains('flutter.session'),
      reason: 'what was kept is not what was found',
    );

    // The rule that matters.
    expect(till.existsSync(), isTrue, reason: 'the repair took the sales with it');
  });

  test('a terminal with nothing stored yet has nothing to set aside', () async {
    final moved = await setAsidePreferences();
    expect(moved, isNull);
  });

  // Not automatic, ever — this is the operator's decision, taken in front of a
  // warning that says what it costs.
  test('a full reset is the one thing that does remove the sales', () async {
    SharedPreferences.setMockInitialValues({'session': 'x'});
    final till = sales();
    final prefsFile = preferences('{}');

    await resetEverything();

    expect(till.existsSync(), isFalse);
    expect(prefsFile.existsSync(), isFalse);
  });

  test('a full reset does not take the rest of the folder with it', () async {
    SharedPreferences.setMockInitialValues({});
    final logo = File(p.join(dir.path, 'receipt-logo.png'));
    logo.writeAsStringSync('a venue logo somebody uploaded');

    await resetEverything();

    expect(logo.existsSync(), isTrue);
  });

  // The second way a till hangs, and the nastier one: preferences read fine, so
  // the terminal gets past sign-on and into the shell — and then the sale page
  // waits on a query that will never answer. Chrome at the top, a spinner where
  // the buttons should be, and nothing about that says "local file" to whoever
  // is looking at it.
  group('the sales file', () {
    test('a healthy database is left alone', () async {
      final db = sqlite3.open(p.join(dir.path, 'vesopa_epos.sqlite'));
      db.execute('CREATE TABLE orders (id TEXT)');
      db.execute("INSERT INTO orders VALUES ('a sale on its way to the server')");
      db.close();

      final moved = await setAsideDatabaseIfUnreadable();

      expect(moved, isNull, reason: 'it set aside a database that was fine');
      expect(
        File(p.join(dir.path, 'vesopa_epos.sqlite')).existsSync(),
        isTrue,
      );
    });

    test('a terminal that has never sold anything has nothing to check', () async {
      expect(await setAsideDatabaseIfUnreadable(), isNull);
    });

    // Allowed to move this one, and only this one, because a file SQLite cannot
    // open holds no sale the till could ever have sent: they are gone before
    // this runs. It is moved rather than deleted — a corrupt database is often
    // still partly salvageable, and those rows are money.
    test('an unreadable database is moved aside so the till can sell', () async {
      final file = File(p.join(dir.path, 'vesopa_epos.sqlite'));
      file.writeAsStringSync('not a database at all');

      final moved = await setAsideDatabaseIfUnreadable();

      expect(moved, isNotNull, reason: 'the till would spin on this for ever');
      expect(file.existsSync(), isFalse, reason: 'the next launch reads it again');
      expect(
        File(moved!).existsSync(),
        isTrue,
        reason: 'a venue was not even left the wreckage to salvage',
      );
      expect(File(moved).readAsStringSync(), 'not a database at all');
    });

    // A write-ahead log belonging to the old database, replayed into the new
    // one, is how a till that has just repaired itself corrupts itself again on
    // its second launch.
    test('the write-ahead log goes with it', () async {
      final file = File(p.join(dir.path, 'vesopa_epos.sqlite'));
      file.writeAsStringSync('rubble');
      File('${file.path}-wal').writeAsStringSync('half a transaction');
      File('${file.path}-shm').writeAsStringSync('shared memory');

      final moved = await setAsideDatabaseIfUnreadable();

      expect(moved, isNotNull);
      // Gone from beside the *new* database, which is the whole requirement.
      // Whether they were moved or swept up by SQLite closing the handle is its
      // business; what must not happen is a fresh database starting life with
      // half a transaction from the broken one waiting to be replayed into it.
      expect(File('${file.path}-wal').existsSync(), isFalse);
      expect(File('${file.path}-shm').existsSync(), isFalse);
    });
  });
}
