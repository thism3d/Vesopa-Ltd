import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/terminal_sync.dart';

void main() {
  test('a JSON setting becomes one row per field', () {
    final rows = settingsFrom({
      'vesopa_printers': jsonEncode({
        'printers': [{'id': 'a'}],
        'assignments': {'kp1': 'a'},
      }),
    });
    expect(rows.map((r) => r.name), [
      'vesopa_printers#printers',
      'vesopa_printers#assignments',
    ]);
    expect(rows.first.category, 'Printers');
  });

  test('plain values stay whole, and unset ones are left out', () {
    final rows = settingsFrom({'theme_mode': 'dark', 'till.order_chime': true, 'terminal_name': null});
    expect({for (final r in rows) r.name: r.value}, {'theme_mode': 'dark', 'till.order_chime': true});
  });

  test('a preference that is not a setting is never sent', () {
    expect(settingsFrom({'session': '{"token":"x"}', 'staff_held_bills': '[]'}), isEmpty);
  });

  test('a field that looks like a credential is never sent', () {
    final rows = settingsFrom({
      'dojo_config': jsonEncode({'url': 'https://x', 'apiKey': 'sk', 'terminalId': 't1'}),
    });
    expect(rows.map((r) => r.name), contains('dojo_config#url'));
    expect(rows.map((r) => r.name), isNot(contains('dojo_config#apiKey')));
  });

  test('a restored field joins what is stored, keeping the secret here', () {
    final out = preferencesFrom(
      [const TerminalSetting('CardMachine', 'dojo_config#terminalId', 't2')],
      {'dojo_config': jsonEncode({'apiKey': 'sk', 'terminalId': 't1'})},
    );
    expect(jsonDecode(out['dojo_config']! as String), {'apiKey': 'sk', 'terminalId': 't2'});
  });

  test('rows can restore a reinstalled till from nothing', () {
    final rows = settingsFrom({
      'vesopa_printers': jsonEncode({'assignments': {'kp1': 'a'}}),
      'theme_mode': 'dark',
    });
    final out = preferencesFrom(rows, {});
    expect(out['theme_mode'], 'dark');
    expect(jsonDecode(out['vesopa_printers']! as String), {'assignments': {'kp1': 'a'}});
  });

  test('a row can never write a preference that is not a setting', () {
    final out = preferencesFrom([
      const TerminalSetting('X', 'session', 'stolen'),
      const TerminalSetting('X', 'dojo_config#apiKey', 'replaced'),
    ], {});
    expect(out, isEmpty);
  });

  test('only what changed since the last send goes up', () {
    final rows = [
      const TerminalSetting('A', 'theme_mode', 'dark'),
      const TerminalSetting('A', 'nav_panel_mode', 'open'),
    ];
    final changed = changedSince(rows, {'theme_mode': jsonEncode('dark')});
    expect(changed.map((r) => r.name), ['nav_panel_mode']);
  });
}
