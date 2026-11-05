import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vesopa_go/display/data/display_options.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('a display nobody has set up does everything', () async {
    SharedPreferences.setMockInitialValues({});
    final o = await DisplayOptions.load();
    expect(o.touch, isTrue);
    expect(o.sound, isTrue);
    expect(o.showQr, isTrue);
    expect(o.thanksSeconds, 0);
  });

  test('what a manager chose comes back', () async {
    SharedPreferences.setMockInitialValues({});
    await const DisplayOptions().copyWith(touch: false, sound: false, showQr: false, thanksSeconds: 5, textScale: 1.3).save();
    final o = await DisplayOptions.load();
    expect(o.touch, isFalse);
    expect(o.sound, isFalse);
    expect(o.showQr, isFalse);
    expect(o.showAmount, isTrue);
    expect(o.thanksSeconds, 5);
    expect(o.textScale, 1.3);
  });

  test('a silly text size from the back office is brought back in range', () async {
    SharedPreferences.setMockInitialValues({'go_display_text_scale': 9.0});
    expect((await DisplayOptions.load()).textScale, 1.6);
  });
}
