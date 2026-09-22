import 'dart:io';


import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:sqlite3/sqlite3.dart' as raw;
import 'package:vesopa_epos/data/local/database.dart';

/// The till that would not open a bill.
///
/// Drift decides which migration steps to run from the stored `user_version`,
/// and writes the new number *after* the steps complete. So a terminal killed
/// between the two — a power cut, a Windows update, a kiosk machine switched
/// off at the wall, which is every till — comes back with the new columns
/// already in the table and the version still on the old number.
///
/// The next launch ran the migration again. SQLite refused with "duplicate
/// column name", the open never completed, so the version was never written,
/// so it happened again. And again, on a database `PRAGMA quick_check` calls
/// perfectly sound, holding sales that had not reached the back office.
///
/// What the operator saw was a spinner where the sale buttons go. What fixed it
/// was deleting the file — which threw those sales away. This is the test that
/// says it cannot happen again.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Directory dir;
  late String path;

  setUp(() {
    dir = Directory.systemTemp.createTempSync('vesopa-migration-');
    path = p.join(dir.path, 'vesopa_epos.sqlite');
  });

  tearDown(() {
    try {
      dir.deleteSync(recursive: true);
    } catch (_) {
      // Windows can hold the file for a moment after the connection closes.
    }
  });

  /// A database in the state a real till was found in: the columns of schema 12
  /// present, and `user_version` still saying 11.
  ///
  /// Built by letting drift create the current schema and then winding the
  /// version number back, which is exactly the shape of the file the interrupted
  /// upgrade leaves — rather than a hand-written table that could drift out of
  /// step with the real one.
  Future<void> makeVersionBehindItsColumns() async {
    final db = AppDatabase.forTesting(NativeDatabase(File(path)));
    await db.customSelect('SELECT 1').get();
    await db.close();

    final handle = raw.sqlite3.open(path);
    expect(
      handle.select('PRAGMA table_info("payments")').map((r) => r['name']),
      contains('reference'),
      reason: 'the fixture does not have the columns the migration adds',
    );
    handle.execute('PRAGMA user_version = 11');
    handle.close();
  }

  test('a migration that has already been applied does not fail the open', () async {
    await makeVersionBehindItsColumns();

    final db = AppDatabase.forTesting(NativeDatabase(File(path)));
    // Any query opens the database, which is what runs the migration. This
    // threw SqliteException(1) "duplicate column name: reference", for ever.
    await expectLater(db.customSelect('SELECT 1').get(), completes);
    await db.close();
  });

  test('and the version is then written, so it does not run for ever', () async {
    await makeVersionBehindItsColumns();

    final db = AppDatabase.forTesting(NativeDatabase(File(path)));
    await db.customSelect('SELECT 1').get();
    final version = db.schemaVersion;
    await db.close();

    final handle = raw.sqlite3.open(path);
    final stored = handle.select('PRAGMA user_version').first.values.first;
    handle.close();

    expect(
      stored,
      version,
      reason: 'the till would meet the same migration again on its next launch',
    );
  });

  // The reason the file must never simply be deleted when this happens.
  test('the sales already in it are still there afterwards', () async {
    final db = AppDatabase.forTesting(NativeDatabase(File(path)));
    await db.customSelect('SELECT 1').get();
    await db.customStatement(
      "INSERT INTO orders (id, status, subtotal_minor, manual_discount_minor, "
      "discount_minor, tax_minor, total_minor, created_at) "
      "VALUES ('unsent-sale', 'open', 450, 0, 0, 90, 450, 0)",
    );
    await db.close();

    final handle = raw.sqlite3.open(path);
    handle.execute('PRAGMA user_version = 11');
    handle.close();

    final reopened = AppDatabase.forTesting(NativeDatabase(File(path)));
    final rows = await reopened
        .customSelect("SELECT id FROM orders WHERE id = 'unsent-sale'")
        .get();
    await reopened.close();

    expect(rows, hasLength(1), reason: 'the repair cost the venue a sale');
  });
}
