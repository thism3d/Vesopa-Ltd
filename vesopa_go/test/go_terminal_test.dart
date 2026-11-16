// Card terminal mode and scan-and-connect: the parts with no screen.

import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_go/modes/device_mode.dart';
import 'package:vesopa_go/modes/terminal_mode_page.dart';
import 'package:vesopa_go/payments/go_terminal.dart';
import 'package:vesopa_go/payments/payment_service.dart';
import 'package:vesopa_go/ui/pages/link_screen_page.dart';

void main() {
  group('what the terminal tells the till', () {
    test('paid, declined and cancelled are certain', () {
      expect(terminalVerdict(const PaymentOutcome(PayResult.paid)), (status: 'paid', uncertain: false));
      expect(terminalVerdict(const PaymentOutcome(PayResult.declined)), (status: 'declined', uncertain: false));
      expect(terminalVerdict(const PaymentOutcome(PayResult.cancelled)), (status: 'cancelled', uncertain: false));
    });

    test('a payment nobody can vouch for is failed and uncertain, never paid', () {
      expect(terminalVerdict(const PaymentOutcome(PayResult.uncertain)), (status: 'failed', uncertain: true));
      expect(terminalVerdict(const PaymentOutcome(PayResult.unavailable)), (status: 'failed', uncertain: false));
    });
  });

  group('what the till makes of the answer', () {
    test('paid carries the payment id', () {
      final o = terminalOutcome({'status': 'paid', 'payment_id': 'pi_1'});
      expect(o.paid, isTrue);
      expect(o.paymentId, 'pi_1');
    });

    test('expired means nothing was taken', () {
      final o = terminalOutcome({'status': 'expired'});
      expect(o.result, PayResult.unavailable);
      expect(o.message, contains('Nothing was taken'));
    });

    test('failed and uncertain tells the clerk to check before taking it again', () {
      final o = terminalOutcome({'status': 'failed', 'uncertain': true});
      expect(o.result, PayResult.uncertain);
      expect(o.message, contains('Check it'));
    });

    test('failed with a reason shows the reason, and is not paid', () {
      final o = terminalOutcome({'status': 'failed', 'message': 'NFC is off'});
      expect(o.paid, isFalse);
      expect(o.result, PayResult.unavailable);
      expect(o.message, 'NFC is off');
    });

    test('declined and cancelled', () {
      expect(terminalOutcome({'status': 'declined'}).result, PayResult.declined);
      expect(terminalOutcome({'status': 'cancelled'}).result, PayResult.cancelled);
    });
  });

  group('a payment a till sends', () {
    test('needs an id and an amount', () {
      expect(TerminalAsk.fromJson(null), isNull);
      expect(TerminalAsk.fromJson({'id': 'a', 'amount_minor': 0}), isNull);
      final ask = TerminalAsk.fromJson({'id': 'a', 'amount_minor': 1250, 'from': 'Counter', 'cancel': true, 'status': 'started'})!;
      expect(ask.amountMinor, 1250);
      expect(ask.from, 'Counter');
      expect(ask.cancel, isTrue);
      expect(ask.status, 'started');
    });
  });

  group('a screen\'s code', () {
    test('from the QR link, from the letters, with or without the space', () {
      expect(linkCodeFrom('https://go.vesopa.com/link/?c=ABCD2345'), 'ABCD2345');
      expect(linkCodeFrom('abcd 2345'), 'ABCD2345');
      expect(linkCodeFrom('ABCD-2345'), 'ABCD2345');
    });

    test('anything else is not a code', () {
      expect(linkCodeFrom('ABC'), isNull);
      expect(linkCodeFrom('https://example.com/'), isNull);
    });

    test('is read aloud in two groups', () {
      expect(spokenLinkCode('ABCD2345'), 'ABCD 2345');
    });
  });

  test('Card terminal is a mode a device can be given', () {
    expect(DeviceMode.parse('terminal'), DeviceMode.terminal);
    expect(DeviceMode.parse('epos'), DeviceMode.epos);
    expect(DeviceMode.parse('nonsense'), isNull);
    // Every mode a new screen can be let in as is one the device knows.
    for (final (key, _, _, _) in linkModes) {
      expect(DeviceMode.parse(key), isNotNull, reason: key);
    }
  });
}
