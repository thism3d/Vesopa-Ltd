import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vesopa_epos/ui/widgets/pos_text_field.dart';

/// Pontardawe RFC, 2026-10-26: in the New member box the first key pressed
/// on the till's own keyboard closed it, and the name stayed empty. On Windows
/// a text field lets go of its focus at any touch outside it, and the board is
/// drawn in an overlay of its own.
void main() {
  testWidgets('typing on the till keyboard keeps it open and types', (tester) async {
    SharedPreferences.setMockInitialValues({});
    debugDefaultTargetPlatformOverride = TargetPlatform.windows;
    final name = TextEditingController();
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: Builder(
          builder: (context) => Center(
            child: TextButton(
              onPressed: () => showDialog<void>(
                context: context,
                builder: (_) => AlertDialog(
                  content: PosTextField(controller: name, autofocus: true),
                ),
              ),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    ));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    for (final key in ['m', 'a', 'x']) {
      // A capital starts the box, as on an iPad: either case is the key.
      await tester.tap(find.byWidgetPredicate((w) => w is Text && w.data?.toLowerCase() == key).last);
      await tester.pumpAndSettle();
    }

    expect(name.text.toLowerCase(), 'max');
    expect(name.text, 'Max', reason: 'a capital to start the name');
    expect(find.text('q'), findsWidgets, reason: 'the keyboard is still up');
    debugDefaultTargetPlatformOverride = null;
  });
}
