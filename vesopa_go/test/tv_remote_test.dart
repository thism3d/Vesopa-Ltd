import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_go/ui/tv.dart';

/// The TV remote (owner, 2026-11-18: "left right up down button not working").
void main() {
  testWidgets('an Android TV box that says it is a tablet turns the remote on at its first key', (tester) async {
    GoDevice.debugTv = false;
    expect(GoDevice.remote.value, isFalse);
    await GoDevice.load();
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: Text('x'))));
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    expect(GoDevice.remote.value, isTrue);
  });

  testWidgets('a tile that was only a tap is reached by the arrows and pressed with OK', (tester) async {
    var pressed = 0;
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: Column(children: [
          ElevatedButton(autofocus: true, onPressed: () {}, child: const Text('Above')),
          TvTap(onTap: () => pressed++, child: const SizedBox(width: 200, height: 60, child: Text('Board'))),
        ]),
      ),
    ));
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.select);
    await tester.pump();
    expect(pressed, 1);
  });
}
