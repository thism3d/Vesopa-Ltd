import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos_kitchen/data/startup_repair.dart';

/// A preferences file a power cut filled with zeros (Pontardawe RFC's kitchen,
/// 2026-10-13: "FormatException: Unexpected character (at character 1)").
void main() {
  test('an unreadable preferences file is set aside, not left to stop the app', () {
    final root = Directory.systemTemp.createTempSync('prefs');
    addTearDown(() => root.deleteSync(recursive: true));
    final folder = Directory('${root.path}\\Co\\App')..createSync(recursive: true);
    final bad = File('${folder.path}\\shared_preferences.json')
      ..writeAsBytesSync(List.filled(64, 0));

    final moved = setAsidePreferences(r'Co\App', root: root.path);

    expect(moved, isNotNull);
    expect(bad.existsSync(), isFalse);
    expect(File(moved!).readAsBytesSync(), List.filled(64, 0));
  });

  test('nothing to move when there is no file', () {
    final root = Directory.systemTemp.createTempSync('prefs');
    addTearDown(() => root.deleteSync(recursive: true));
    expect(setAsidePreferences(r'Co\App', root: root.path), isNull);
  });
}
