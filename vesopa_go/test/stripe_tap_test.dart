import 'package:flutter_test/flutter_test.dart';
import 'package:mek_stripe_terminal/mek_stripe_terminal.dart';
import 'package:vesopa_go/payments/payment_service.dart';
import 'package:vesopa_go/payments/stripe_tap.dart';

void main() {
  test('only the server saying succeeded is a sale', () {
    expect(stripeResult('succeeded'), PayResult.paid);
    expect(stripeResult('canceled'), PayResult.cancelled);
    expect(stripeResult('requires_payment_method'), PayResult.declined);
    expect(stripeResult('processing'), PayResult.uncertain);
    expect(stripeResult(null), PayResult.uncertain);
  });

  test('a decline and a cancel are told apart', () {
    TerminalException failure(TerminalExceptionCode code) =>
        TerminalException(code: code, message: 'x', stackTrace: null, paymentIntent: null, apiError: null);
    expect(stripeFailure(failure(TerminalExceptionCode.declinedByReader)).result, PayResult.declined);
    expect(stripeFailure(failure(TerminalExceptionCode.declinedByStripeApi)).result, PayResult.declined);
    expect(stripeFailure(failure(TerminalExceptionCode.canceled)).result, PayResult.cancelled);
  });

  test('anything else stays uncertain: the card may have been charged', () {
    final e = TerminalException(
      code: TerminalExceptionCode.unknown,
      message: 'lost',
      stackTrace: null,
      paymentIntent: null,
      apiError: null,
    );
    final out = stripeFailure(e, paymentId: 'pi_1');
    expect(out.result, PayResult.uncertain);
    expect(out.paymentId, 'pi_1');
  });

  // 2026-11-09, the Kitchen's Android phone: an iPhone's Apple Pay timed out,
  // then broke off, and Go only showed Stripe's own sentence.
  test('a wallet not read in time, or moved away, says what to do', () {
    TerminalException e(TerminalExceptionCode code, [String m = '']) =>
        TerminalException(code: code, message: m, stackTrace: null, paymentIntent: null, apiError: null);
    final late = tapProblemWords(e(TerminalExceptionCode.cardReadTimedOut, 'Collection timed out.'));
    expect(late, contains('No card or phone was read in time'));
    expect(late, contains('double-click the side button'));
    expect(late, contains('Nothing was taken'));
    final moved = tapProblemWords(e(
      TerminalExceptionCode.unexpectedSdkError,
      "Collection failed java.lang.IllegalStateException: App Error: SERVER_ERROR 'Transaction failed with unexpected reader failure.'",
    ));
    expect(moved, contains('moved away before it was read'));
    expect(tapProblemWords(e(TerminalExceptionCode.tapToPayPinUnavailable)), contains('PIN'));
    expect(tapProblemWords(e(TerminalExceptionCode.nfcDisabled)), contains('NFC is off'));
    expect(tapProblemWords(e(TerminalExceptionCode.unknown, '')), contains('Nothing was taken'));
  });
}
