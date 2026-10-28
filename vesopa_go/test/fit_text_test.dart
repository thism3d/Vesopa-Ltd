import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_go/ui/fit_text.dart';

void main() {
  testWidgets('a long word shrinks to fit its key instead of breaking over two lines', (tester) async {
    const style = TextStyle(fontSize: 20, fontWeight: FontWeight.w700);
    final wide = fitSize('Cheeseburger', style, 400, 100);
    final narrow = fitSize('Cheeseburger', style, 150, 100);
    expect(wide, 20);
    expect(narrow, lessThan(20));
    final word = TextPainter(text: TextSpan(text: 'Cheeseburger', style: style.copyWith(fontSize: narrow)), textDirection: TextDirection.ltr)
      ..layout();
    expect(word.width, lessThanOrEqualTo(150));
  });

  testWidgets('a sentence wraps between words within its lines', (tester) async {
    await tester.pumpWidget(const MaterialApp(
      home: Center(
        child: SizedBox(
          width: 220,
          height: 80,
          child: FitText('Welcome to The Vesopa Kitchen, tap to start', maxLines: 3, style: TextStyle(fontSize: 30)),
        ),
      ),
    ));
    final text = tester.widget<Text>(find.byType(Text));
    expect(text.style!.fontSize, lessThan(30));
    expect(tester.takeException(), isNull);
  });
}
