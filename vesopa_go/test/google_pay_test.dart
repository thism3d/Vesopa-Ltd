import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_go/payments/google_pay.dart';

void main() {
  test('test mode needs no merchant id and names the venue\'s Stripe account', () {
    final c = jsonDecode(googlePayConfiguration(environment: 'TEST', publishableKey: 'pk_test_x', account: 'acct_1', venue: 'Kitchen')) as Map;
    final data = c['data'] as Map;
    expect(c['provider'], 'google_pay');
    expect(data['environment'], 'TEST');
    expect((data['merchantInfo'] as Map).containsKey('merchantId'), isFalse);
    final spec = ((data['allowedPaymentMethods'] as List).first as Map)['tokenizationSpecification'] as Map;
    expect((spec['parameters'] as Map)['gateway'], 'stripe');
    expect((spec['parameters'] as Map)['stripe:publishableKey'], 'pk_test_x/acct_1');
  });

  test('production carries Google\'s merchant id', () {
    final c = jsonDecode(googlePayConfiguration(environment: 'PRODUCTION', publishableKey: 'pk', account: 'a', venue: 'V', merchantId: 'BCR2')) as Map;
    expect(((c['data'] as Map)['merchantInfo'] as Map)['merchantId'], 'BCR2');
  });

  test('Stripe\'s token is read out of what Google hands back', () {
    final token = googlePayToken({
      'paymentMethodData': {
        'tokenizationData': {'type': 'PAYMENT_GATEWAY', 'token': '{"id":"tok_abc","object":"token"}'},
      },
    });
    expect(token, 'tok_abc');
  });
}
