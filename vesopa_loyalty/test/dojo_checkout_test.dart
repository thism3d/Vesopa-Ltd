import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_loyalty/platform/dojo.dart';

void main() {
  test('the intent comes from intent_id, or from the checkout address', () {
    expect(DojoCheckout.intentOf({'intent_id': 'pi_abc', 'url': 'https://pay.dojo.tech/checkout/pi_xyz'}), 'pi_abc');
    expect(DojoCheckout.intentOf({'url': 'https://pay.dojo.tech/checkout/pi_xyz'}), 'pi_xyz');
    expect(DojoCheckout.intentOf({'url': 'https://example.com/other/pi'}), isNull);
    expect(DojoCheckout.intentOf({}), isNull);
  });
}
