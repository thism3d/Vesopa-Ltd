import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_go/payments/payment_service.dart';

/// Dojo's Tap to Pay on Pocket answers (docs.dojo.tech/tap-to-pay-on-pocket/
/// intent-integration), as MainActivity.kt hands them over: each extra by its
/// short name.
void main() {
  test('AUTHORISED is paid, and the transaction id is the reference', () {
    final o = pocketOutcome({'transaction_result': 'AUTHORISED', 'transaction_id': 'tx-9', 'auth_code': 'A1'});
    expect(o.result, PayResult.paid);
    expect(o.paymentId, 'pocket:tx-9');
  });

  test('DECLINED and FAILED take nothing; CANCELLED is the clerk or customer', () {
    expect(pocketOutcome({'transaction_result': 'DECLINED'}).result, PayResult.declined);
    expect(pocketOutcome({'transaction_result': 'FAILED'}).result, PayResult.declined);
    expect(pocketOutcome({'transaction_result': 'CANCELLED'}).result, PayResult.cancelled);
  });

  test('no verdict is uncertain, never paid', () {
    expect(pocketOutcome({'sale_status': 'OK'}).result, PayResult.uncertain);
    expect(pocketOutcome(null).result, PayResult.uncertain);
  });
}
