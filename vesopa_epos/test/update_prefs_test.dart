import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vesopa_epos/config/constants.dart';
import 'package:vesopa_epos/data/app_update.dart';
import 'package:vesopa_epos/data/update_prefs.dart';

/// Settings, Updates (2026-11-07).
void main() {
  test('every release says what is new, so nobody ships a version without notes', () {
    expect(whatsNewByVersion[VesopaBrand.appVersion], isNotEmpty);
  });

  test('the notes show once after an update, never on a first install', () async {
    SharedPreferences.setMockInitialValues({});
    expect(await whatsNewToShow(), isNull, reason: 'first install');
    SharedPreferences.setMockInitialValues({'vesopa_whats_new_seen': '1.16.40'});
    expect(await whatsNewToShow(), isNotEmpty);
    expect(await whatsNewToShow(), isNull, reason: 'already shown');
  });

  test('a till that updates by itself installs as admin would say Install now', () {
    const offered = AppUpdate(version: '1.16.60', url: 'https://x/setup.exe', sha256: 'abc', force: true);
    final now = offered.asNow();
    expect(now.permitted, isTrue);
    expect(now.due, isTrue);
    expect(now.force, isTrue);
    expect(now.version, '1.16.60');
  });

  test('defaults: on, asking, with notes, not automatic', () {
    const p = UpdatePrefs();
    expect([p.enabled, p.ask, p.whatsNew, p.automatic], [true, true, true, false]);
  });
}
