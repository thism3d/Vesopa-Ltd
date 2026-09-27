// The shared activity logger (lib/data/activity_log.dart, synced from
// shared/activity-log). What matters: the label of what was pressed is
// recorded, a PIN pad key never is, and secrets never reach a line.
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/activity_log.dart';

List<Map<String, dynamic>> _lines(Directory dir) {
  final files = dir.listSync().whereType<File>().toList();
  if (files.isEmpty) return [];
  return files.first
      .readAsLinesSync()
      .where((l) => l.trim().isNotEmpty)
      .map((l) => jsonDecode(l) as Map<String, dynamic>)
      .toList();
}

void main() {
  test('secret keys are redacted and card numbers masked', () {
    final out = ActivityLog.redact({
      'name': 'Coke',
      'pin': '1234',
      'staffPin': '1234',
      'password': 'x',
      'cardNumber': '4111111111111111',
      'note': 'card 4111 1111 1111 1111',
      'nested': {'access_token': 't', 'qty': 2},
    }) as Map<String, Object?>;
    expect(out['name'], 'Coke');
    expect(out['pin'], '[redacted]');
    expect(out['staffPin'], '[redacted]');
    expect(out['password'], '[redacted]');
    expect(out['cardNumber'], '[redacted]');
    expect(out['note'], 'card [card ••••1111]');
    expect(out['nested'], {'access_token': '[redacted]', 'qty': 2});
  });

  testWidgets('a tap records the button label, and a PIN key only as "number key"', (tester) async {
    final dir = Directory.systemTemp.createTempSync('activity-test-');
    await tester.runAsync(() async {
      ActivityLog.instance.configure(app: 'test', appVersion: '0', directory: dir);
    });

    await tester.pumpWidget(
      MaterialApp(
        builder: (context, child) => ActivityLog.instance.wrap(child!),
        home: Scaffold(
          body: Column(
            children: [
              ElevatedButton(onPressed: () {}, child: const Text('Cash')),
              ElevatedButton(onPressed: () {}, child: const Text('7')),
            ],
          ),
        ),
      ),
    );

    await tester.tap(find.text('Cash'));
    await tester.tap(find.text('7'));
    await tester.pump();
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 200)));

    final taps = _lines(dir).where((l) => l['action'] == 'tap').map((l) => l['target']).toList();
    expect(taps, ['Cash', 'number key']);
  });
}
