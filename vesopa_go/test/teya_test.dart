import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_go/counter/data/lite_state.dart';
import 'package:vesopa_go/data/session.dart';
import 'package:vesopa_go/payments/payment_service.dart';
import 'package:vesopa_go/payments/teya_machine.dart';

void main() {
  test('the venue settings from the till route: on, its machines, the machine the back office chose', () {
    final t = TeyaSettings.fromJson({
      'enabled': true,
      'environment': 'sandbox',
      'store_name': 'The Vesopa Kitchen',
      'assigned_terminal_id': null,
      'default_terminal_id': 'trm_1',
      'terminals': [
        {'id': 'trm_1', 'name': 'Bar', 'serial': 'S1'},
        {'id': 'trm_2', 'name': 'Patio', 'serial': 'S2'},
      ],
    });
    expect(t.enabled, isTrue);
    expect(t.machineId, 'trm_1');
    expect(t.terminals, hasLength(2));
    expect(TeyaSettings.fromJson(null).enabled, isFalse);
  });

  test('a paid Teya payment is known by its gateway id, which refunds go back through', () {
    final paid = teyaOutcome({'id': 'pr_9', 'final': true, 'outcome': 'approved', 'gateway_payment_id': 'gw_42'});
    expect(paid.result, PayResult.paid);
    expect(paid.paymentId, 'teya:gw_42');
    expect(teyaOutcome({'id': 'pr_9', 'outcome': 'declined', 'message': 'Declined by the bank'}).message, 'Declined by the bank');
    expect(teyaOutcome({'id': 'pr_9', 'outcome': 'cancelled'}).result, PayResult.cancelled);
    expect(teyaOutcome({'id': 'pr_9', 'outcome': 'failed'}).result, PayResult.declined);
  });

  test('a Teya venue pays on its card machine, whatever the device would choose', () {
    final config = TapConfig.fromJson(const {'teya': {'enabled': true, 'default_terminal_id': 'trm_1'}});
    expect(cardVia(const LiteSettings(cardVia: 'tap'), config), 'machine');
    expect(cardVia(const LiteSettings(cardVia: 'tap'), TapConfig.fromJson(const {})), 'tap');
  });
}
