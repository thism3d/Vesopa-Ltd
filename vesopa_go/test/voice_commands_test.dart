import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_go/remote/voice.dart';

List<String> keys(String said, String mode) => [for (final s in VoiceCommands.parse(said, mode: mode).steps) s.toString()];

void main() {
  test('kitchen', () {
    expect(keys('Show the last order and mark it done', 'kitchen'), ['expand_last', 'done_shown']);
    expect(keys('expand the oldest ticket', 'kitchen'), ['expand_first']);
    expect(keys("it's ready", 'kitchen'), ['done_shown']);
    expect(keys('bump', 'kitchen'), ['done_shown']);
    expect(keys('recall', 'kitchen'), ['recall']);
    expect(keys('show closed', 'kitchen'), ['finished']);
    expect(keys('show phone orders', 'kitchen'), ['orders']);
    expect(keys('pop up new orders for fifteen seconds', 'kitchen'), ['popup:15']);
    expect(keys('pop up off', 'kitchen'), ['popup:0']);
  });

  test('customer display', () {
    expect(keys('next advert', 'display'), ['next']);
    expect(keys('change the advert', 'display'), ['next']);
    expect(keys('keep this advert for 5 minutes', 'display'), ['hold:5']);
    expect(keys('hold it for two hours', 'display'), ['hold:120']);
    expect(keys('resume adverts', 'display'), ['hold:0']);
    expect(keys('previous advert', 'display'), ['previous']);
  });

  test('any screen', () {
    expect(keys('switch to kitchen', 'display'), ['mode:kitchen']);
    expect(keys('make it a customer display', 'kitchen'), ['mode:display']);
    expect(keys('volume up', 'kitchen'), ['volume_up', 'volume_up']);
    expect(keys('mute', 'display'), ['mute']);
    expect(keys('screen off', 'display'), ['power']);
    expect(keys('colour pink', 'kitchen'), ['theme:pink']);
    expect(keys('dark mode', 'kitchen'), ['appearance:dark']);
    expect(keys('type Pass two', 'kitchen'), ['text "pass two"', 'submit']);
    expect(keys('go home', 'kitchen'), ['home']);
    expect(keys('down', 'kitchen'), ['down']);
    expect(VoiceCommands.parse('make me a sandwich', mode: 'kitchen').understood, isFalse);
  });
}
