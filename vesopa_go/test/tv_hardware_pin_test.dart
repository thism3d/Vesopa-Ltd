// The TV without a touchscreen, camera or NFC (owner, 2026-11-19): the PIN
// from the remote's own keys, keys sent from a phone, and only the buttons
// the device can use.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_go/modes/mode_settings.dart';
import 'package:vesopa_go/remote/go_remote.dart';
import 'package:vesopa_go/ui/tv.dart';

Future<String?> _pin(WidgetTester tester, Future<void> Function() keys) async {
  String? got = 'none';
  await tester.pumpWidget(MaterialApp(
    home: Builder(
      builder: (c) => TextButton(
        onPressed: () async => got = await showDialog<String>(context: c, builder: (_) => const RemotePinDialog(title: 'Settings')),
        child: const Text('open'),
      ),
    ),
  ));
  await tester.tap(find.text('open'));
  await tester.pumpAndSettle();
  await keys();
  await tester.pumpAndSettle();
  return got;
}

void main() {
  testWidgets('the remote\'s number buttons type the PIN and OK unlocks', (tester) async {
    final got = await _pin(tester, () async {
      for (final k in [LogicalKeyboardKey.digit1, LogicalKeyboardKey.digit2, LogicalKeyboardKey.digit3, LogicalKeyboardKey.digit4]) {
        await tester.sendKeyEvent(k);
      }
      await tester.sendKeyEvent(LogicalKeyboardKey.select);
    });
    expect(got, '1234');
  });

  testWidgets('a remote with no numbers: Up and Down choose, Right adds, Left deletes', (tester) async {
    final got = await _pin(tester, () async {
      Future<void> k(LogicalKeyboardKey key, [int times = 1]) async {
        for (var i = 0; i < times; i++) {
          await tester.sendKeyEvent(key);
        }
      }
      await k(LogicalKeyboardKey.arrowUp, 5); // 5
      await k(LogicalKeyboardKey.arrowRight);
      await k(LogicalKeyboardKey.arrowDown, 2); // 3
      await k(LogicalKeyboardKey.arrowRight);
      await k(LogicalKeyboardKey.arrowRight); // 3 again
      await k(LogicalKeyboardKey.arrowLeft); // deleted
      await k(LogicalKeyboardKey.arrowDown); // 2
      await k(LogicalKeyboardKey.select); // OK adds it: 532
      await k(LogicalKeyboardKey.arrowUp); // 3
      await k(LogicalKeyboardKey.select); // 5323
      await k(LogicalKeyboardKey.select); // four digits: unlock
    });
    expect(got, '5323');
  });

  testWidgets('Back cancels', (tester) async {
    final got = await _pin(tester, () => tester.sendKeyEvent(LogicalKeyboardKey.escape));
    expect(got, isNull);
  });

  testWidgets('a key from the phone reaches the page that listens, else moves the focus', (tester) async {
    final heard = <String>[];
    bool page(String key) {
      if (key != 'next') return false;
      heard.add(key);
      return true;
    }

    GoRemote.listen(page);
    final first = FocusNode();
    final second = FocusNode();
    var pressed = 0;
    await tester.pumpWidget(MaterialApp(
      home: Column(children: [
        TextButton(focusNode: first, onPressed: () {}, child: const Text('one')),
        TextButton(focusNode: second, onPressed: () => pressed++, child: const Text('two')),
      ]),
    ));
    first.requestFocus();
    await tester.pump();
    GoRemote.press('next');
    expect(heard, ['next']);
    GoRemote.press('down');
    await tester.pump();
    expect(second.hasFocus, isTrue);
    GoRemote.press('ok');
    await tester.pump();
    expect(pressed, 1);
    GoRemote.forget(page);
  });

  test('a TV says what it has; a phone keeps everything', () {
    GoDevice.debugHardware(camera: false, nfc: false, touch: false);
    expect(GoDevice.hasCamera || GoDevice.hasNfc || GoDevice.hasTouch, isFalse);
    GoDevice.debugHardware();
    expect(GoDevice.hasCamera && GoDevice.hasNfc && GoDevice.hasTouch, isTrue);
  });
}
