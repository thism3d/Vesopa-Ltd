// A Wallet NFC reader that types the card number (Google Smart Tap, Apple
// VAS readers over USB or Bluetooth) is read by the card sheet like a tap
// (owner, 2026-11-19: "hold near reader" for the club's Wallet cards).
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_go/nfc/card_read_sheet.dart';

void main() {
  test('a typed burst is a card only when it looks like one', () {
    expect(readerCode(' 999800001 '), '999800001');
    expect(readerCode('12'), isNull);
    expect(readerCode('a b c d'), isNull);
  });

  testWidgets('the card sheet answers with what the reader typed', (tester) async {
    String? got = 'none';
    await tester.pumpWidget(MaterialApp(
      home: Builder(
        builder: (context) => TextButton(
          onPressed: () async => got = await readCard(context, title: 'Scan or tap their card'),
          child: const Text('go'),
        ),
      ),
    ));
    await tester.tap(find.text('go'));
    await tester.pumpAndSettle(const Duration(milliseconds: 100), EnginePhase.sendSemanticsUpdate, const Duration(seconds: 2));
    expect(find.text('Scan or tap their card'), findsOneWidget);
    for (final d in '999800001'.split('')) {
      await tester.sendKeyEvent(LogicalKeyboardKey(0x30 + int.parse(d)), character: d);
    }
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump(const Duration(seconds: 1));
    expect(got, '999800001');
  });
}
