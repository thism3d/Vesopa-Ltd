import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_go/data/mix_match_types.dart';
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

  test('staff keys follow the till: no group is every key, a group only what it grants', () {
    final none = Clerk.fromJson(const {'id': 1, 'name': 'Old', 'pin': '1234'});
    expect(none.can(TillPermission.refund), isTrue);
    final staff = Clerk.fromJson(const {'id': 2, 'name': 'Alex', 'pin': '2222', 'permission_group_id': 4, 'permissions': {'can_void': true}});
    expect(staff.can(TillPermission.voidLine), isTrue);
    expect(staff.can(TillPermission.refund), isFalse);
    expect(staff.canApprove(TillPermission.refund), isFalse);
    final manager = Clerk.fromJson(const {'id': 3, 'name': 'Sam', 'pin': '1111', 'permission_group_id': 5, 'permissions': {'is_manager': true}});
    expect(manager.canApprove(TillPermission.refund), isTrue);
    // As the device keeps them, and back.
    expect(Clerk.fromJson({'id': 2, 'name': 'Alex', 'pin': '2222', 'perms': staff.permissions}).can(TillPermission.refund), isFalse);
  });

  test('mix and match: any two of the deal for its price, the dearest first, never more than the shelf price', () {
    Bill.deals = const MixMatchEngine([MixMatchDeal(id: 1, name: 'Any 2 sides', triggerQty: 2, dealPriceMinor: 500)], {1: {11, 12}});
    const chips = Product(id: 'plu11', plu: 11, name: 'Chips', priceMinor: 350, category: 'sides');
    const rings = Product(id: 'plu12', plu: 12, name: 'Onion rings', priceMinor: 400, category: 'sides');
    final bill = Bill(id: 'b', name: 'Sale', clerk: 'Sam', openedAt: DateTime(2026), lines: const [
      BillLine(id: 'a', product: chips),
      BillLine(id: 'b', product: rings, quantity: 2),
    ]);
    // 1150 of sides: one pair (400 + 400) for 500 saves 300, the chips alone stay full price.
    expect(bill.dealMinor, 300);
    expect(bill.totalMinor, 1150 - 300);
    Bill.deals = const MixMatchEngine([], {});
  });
}
