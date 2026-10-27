import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_go/data/models.dart';
import 'package:vesopa_go/counter/ui/receipt_print.dart';
import 'package:vesopa_go/data/session.dart';

void main() {
  const coke = Product(id: 'p1', plu: 1, name: 'Coca-Cola', priceMinor: 250, category: 'drinks');
  const line = BillLine(id: 'l1', product: coke);

  test('the same item, choices and note stack; sent, paid or different ones do not', () {
    expect(line.sameAs(coke), isTrue);
    expect(line.sameAs(coke, note: 'No ice'), isFalse);
    expect(line.sameAs(coke, choices: const [Choice('Large', 50)]), isFalse);
    expect(line.copyWith(sent: true).sameAs(coke), isFalse);
    expect(line.copyWith(paidQuantity: 1).sameAs(coke), isFalse);
  });

  test('stacking follows the till unless Go says otherwise', () {
    expect(TapConfig.fromJson(const {}).stacks, isTrue);
    expect(TapConfig.fromJson(const {'till': {'consolidate_lines': 0}}).stacks, isFalse);
    expect(TapConfig.fromJson(const {'till': {'consolidate_lines': 0}, 'go': {'stack_lines': 'on'}}).stacks, isTrue);
    expect(TapConfig.fromJson(const {'go': {'stack_lines': 'off'}}).stacks, isFalse);
  });

  test('the licence and the options read from the config', () {
    expect(TapConfig.fromJson(const {}).licensed, isTrue);
    expect(TapConfig.fromJson(const {'go_licensed': false}).licensed, isFalse);
    final go = TapConfig.fromJson(const {'go': {'order_mode': 'send_to_till', 'sound_add': 0, 'note_chips': 'No ice, ,Well done'}}).go;
    expect(go.sendToTill, isTrue);
    expect(go.volume(GoSound.add), 0);
    expect(go.noteChips, ['No ice', 'Well done']);
  });

  test('a printed line fits 42 columns, and the pound is code page 437 0x9C', () {
    expect(const PrintLine('Fish & Chips', '£14.50').text().length, 42);
    expect(const PrintLine('TOTAL', '£41.40').text(), endsWith('£41.40'));
    final bytes = escPos(const [PrintLine('£1')]);
    expect(bytes.contains(0x9C), isTrue);
    expect(bytes.sublist(bytes.length - 3), [0x56, 0x42, 0x00]);
  });
}
