import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/hardware.dart';

/// The background report runs all day on the PC taking the money, so a scan
/// Windows never answers must not pile up (Pontardawe's lounge till, 2026-11-05).
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('vesopa/hardware');
  final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;

  tearDown(() => messenger.setMockMethodCallHandler(channel, null));

  test('the light report asks Windows for the light scan and starts no PowerShell', () async {
    Object? args;
    messenger.setMockMethodCallHandler(channel, (call) async {
      args = call.arguments;
      return {'adapters': <Object?>[]};
    });
    final s = await Hardware.instance.snapshot(light: true);
    expect(args, {'light': true});
    expect(s.sharing.files, isNull);
    expect(s.toReport().containsKey('hotspot'), isFalse);
    expect(s.toReport().containsKey('bluetooth'), isFalse);
  });

  test('a scan Windows has not answered blocks the next one', () async {
    final hung = Completer<Map<Object?, Object?>?>();
    var calls = 0;
    messenger.setMockMethodCallHandler(channel, (call) {
      calls += 1;
      return hung.future;
    });
    final first = Hardware.instance.snapshot(light: true);
    await Future<void>.delayed(Duration.zero);
    expect(Hardware.instance.scanning, isTrue);
    await expectLater(Hardware.instance.snapshot(light: true), throwsA(isA<TimeoutException>()));
    expect(calls, 1);

    hung.complete({'adapters': <Object?>[]});
    await first;
    await Future<void>.delayed(Duration.zero);
    expect(Hardware.instance.scanning, isFalse);
  });
}
