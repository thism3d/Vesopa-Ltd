// ignore_for_file: avoid_print
//
// What a till's local sales file actually holds, for when it will not open one.
//
//     dart run tool/inspect_db.dart [path]
//
// Worth keeping rather than throwing away: it is what told us that a terminal
// stuck on a loading spinner had a database `PRAGMA quick_check` calls
// perfectly sound. Its stored `user_version` had simply fallen behind the
// columns already in it, so the migration re-ran and failed on every launch,
// for ever. Three lines of output separated "this file is broken" from "our
// migration is" — and the difference between them was a venue's unsent sales.
import 'dart:io';

import 'package:sqlite3/sqlite3.dart';

void main(List<String> args) {
  final appData = Platform.environment['APPDATA'] ?? '';
  final path = args.isNotEmpty
      ? args.first
      : [appData, 'Vesopa EPOS Limited', 'Vesopa EPOS', 'vesopa_epos.sqlite']
            .join(Platform.pathSeparator);

  final db = sqlite3.open(path);
  print('file         $path');
  print('user_version ${db.select('PRAGMA user_version').first.values.first}');
  print('quick_check  ${db.select('PRAGMA quick_check').first.values.first}');
  for (final table in ['payments', 'orders', 'order_lines']) {
    final cols = db
        .select('PRAGMA table_info("$table")')
        .map((r) => r['name'])
        .toList();
    if (cols.isNotEmpty) print('$table: $cols');
  }
  db.close();
}
