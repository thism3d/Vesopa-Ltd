/// Telling a swipe from somebody typing.
///
/// Everything here runs against [SwipeBuffer] directly, with the times supplied
/// rather than measured — a state machine whose behaviour depends on a real
/// clock is one whose tests are flaky on a busy machine, and every interesting
/// rule in this file is about timing.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/swipe_cards.dart';

void main() {
  late SwipeBuffer buffer;
  late DateTime clock;

  setUp(() {
    buffer = SwipeBuffer();
    clock = DateTime(2026, 9, 2, 12);
  });

  /// Type [text] at [gap] between characters, the way a reader does.
  ///
  /// Returns the verdicts, one per character, so a test can assert not only
  /// what was read but that the keystrokes were swallowed on the way.
  List<SwipeVerdict> type(
    String text, {
    Duration gap = const Duration(milliseconds: 8),
    bool thenEnter = false,
  }) {
    final verdicts = <SwipeVerdict>[];
    for (final character in text.split('')) {
      clock = clock.add(gap);
      verdicts.add(buffer.offer(character, at: clock));
    }
    if (thenEnter) {
      clock = clock.add(gap);
      verdicts.add(buffer.offer(null, at: clock, isEnter: true));
    }
    return verdicts;
  }

  // ---------------------------------------------------------------------------
  // A card
  // ---------------------------------------------------------------------------

  test('the venue s own card reads as its number', () {
    // The exact string the client's reader sends. If nothing else in this file
    // passes, this must.
    final verdicts = type(';999800001?');

    expect(verdicts.last, SwipeVerdict.complete);
    expect(buffer.card!.number, '999800001');
    expect(buffer.card!.raw, ';999800001?');
  });

  test('every keystroke of a swipe is swallowed', () {
    // The point of the whole exercise. A card swiped while the discount dialog
    // is open must not type 999800001 into the amount box.
    final verdicts = type(';999800001?');
    expect(verdicts.every((v) => v != SwipeVerdict.ignore), isTrue);
  });

  test('a reader that sends Return instead of a sentinel still works', () {
    final verdicts = type(';999800001', thenEnter: true);
    expect(verdicts.last, SwipeVerdict.complete);
    expect(buffer.card!.number, '999800001');
  });

  test('a track 1 reader is read the same way', () {
    // `%` opens it and `B` is the format code, neither of which is card data.
    type('%B999800001?');
    expect(buffer.card!.number, '999800001');
  });

  test('service data after a separator is not part of the number', () {
    // A card programmed for a bank carries an expiry after `=`. Appending those
    // digits would produce a number that matches nothing — and the failure
    // would look like "this member does not exist" rather than like a parsing
    // bug, which is the worst way for it to present.
    type(';999800001=26121010000?');
    expect(buffer.card!.number, '999800001');
  });

  test('a name field after a separator is dropped, not typed', () {
    final verdicts = type(r';999800001^SMITH/J^?');
    expect(buffer.card!.number, '999800001');
    // Consumed, not ignored: those letters must not reach a text field either.
    expect(verdicts.every((v) => v != SwipeVerdict.ignore), isTrue);
  });

  // ---------------------------------------------------------------------------
  // Not a card
  // ---------------------------------------------------------------------------

  test('typing a number is left alone', () {
    final verdicts = type('12345', gap: const Duration(milliseconds: 200));
    expect(verdicts.every((v) => v == SwipeVerdict.ignore), isTrue);
    expect(buffer.card, isNull);
  });

  test('a person typing slowly after a stray semicolon gets their keys back', () {
    // The cost of swallowing, and its bound. The `;` is lost; everything after
    // the gap is not.
    expect(buffer.offer(';', at: clock), SwipeVerdict.consume);

    clock = clock.add(const Duration(seconds: 1));
    expect(buffer.offer('5', at: clock), SwipeVerdict.ignore);
    expect(buffer.card, isNull);
  });

  test('a swipe broken in half is not silently glued together', () {
    type(';9998');
    // A gap no reader produces. Whatever arrives now is a fresh start.
    clock = clock.add(const Duration(seconds: 1));
    type('00001?');

    // The half that arrives after the gap is fast enough to be a scanner, so it
    // is read on its own terms — as card 00001, which matches no prefix and
    // produces "not a card this venue uses".
    //
    // What must never happen is the two halves being joined. 999800001 is a
    // real member's card, and reporting one because a swipe stalled would put
    // the wrong person on somebody's bill — which is the failure this test
    // exists for, and it is asserted rather than the incidental null.
    expect(buffer.card?.number, isNot('999800001'));
  });

  test('a steady typist cannot be swallowed indefinitely', () {
    // The backstop for the case the gap rule cannot catch: three characters a
    // second, for ever, after a stray sentinel.
    buffer.offer(';', at: clock);
    var lastVerdict = SwipeVerdict.consume;
    for (var i = 0; i < 40; i++) {
      clock = clock.add(const Duration(milliseconds: 250));
      lastVerdict = buffer.offer('1', at: clock);
    }
    expect(lastVerdict, SwipeVerdict.ignore);
  });

  test('a letter in the middle of a swipe abandons it', () {
    final verdicts = type(';9998x0001?');
    // The `x` is handed back, because whoever typed it should get it.
    expect(verdicts[5], SwipeVerdict.ignore);
    expect(buffer.card, isNull);
  });

  test('too short to be a card is not reported as one', () {
    // Leaning on a keyboard should not put "unknown card" in front of a clerk.
    type(';99?');
    expect(buffer.card, isNull);
  });

  test('an absurdly long stream is dropped rather than read', () {
    type(';${'1' * 80}?');
    expect(buffer.card, isNull);
  });

  test('two cards in a row both read', () {
    type(';999800001?');
    expect(buffer.card!.number, '999800001');

    clock = clock.add(const Duration(seconds: 3));
    type(';999800002?');
    expect(buffer.card!.number, '999800002');
  });

  test('the card is cleared once it has been handed over', () {
    type(';999800001?');
    expect(buffer.card, isNotNull);

    // Otherwise the next keystroke anywhere in the till would re-deliver the
    // last card swiped.
    buffer.offer('5', at: clock.add(const Duration(seconds: 1)));
    expect(buffer.card, isNull);
  });

  // ---------------------------------------------------------------------------
  // Scanned rather than swiped: a wallet pass on a phone, or an NFC tag
  // ---------------------------------------------------------------------------

  test('a scanned card reads, with no sentinels at all', () {
    // What a QR on a customer's phone sends: the bare number and a Return. The
    // barcode on a wallet pass carries the card number precisely so that this
    // and a swipe end in the same place.
    type('999800001', thenEnter: true);

    expect(buffer.card, isNotNull);
    expect(buffer.card!.number, '999800001');
    expect(buffer.card!.via, ReadVia.scan);
  });

  test('a swipe still says it was a swipe', () {
    // Worth being able to tell apart: when a venue rings up to say cards have
    // stopped working, the first useful question is which reader went quiet.
    type(';999800001?');
    expect(buffer.card!.via, ReadVia.swipe);
  });

  test('a scan is swallowed from its second character', () {
    final verdicts = type('999800001', thenEnter: true);

    // The first digit leaks — there is nothing yet to tell a scanner from a
    // person — and this is the documented cost of reading a scanner that sends
    // no sentinel. Everything after it is claimed.
    expect(verdicts.first, SwipeVerdict.ignore);
    expect(verdicts.skip(1).every((v) => v != SwipeVerdict.ignore), isTrue);
  });

  test('somebody typing a number and pressing Return is not a scan', () {
    // The rule that makes the whole thing safe. A clerk typing a quantity into
    // a box must not have it read as a card.
    type('999800001', gap: const Duration(milliseconds: 200), thenEnter: true);
    expect(buffer.card, isNull);
  });

  test('a scanner prefixed with a semicolon leaks nothing', () {
    // Most scanners can be given a prefix character, and `;` makes a scan
    // exactly as clean as a swipe. Worth doing on a counter where the scanner
    // is used mid-sale with dialogs open.
    final verdicts = type(';999800001', thenEnter: true);
    expect(verdicts.every((v) => v != SwipeVerdict.ignore), isTrue);
    expect(buffer.card!.number, '999800001');
  });

  test('a scan too short to be a card is not reported', () {
    type('99', thenEnter: true);
    expect(buffer.card, isNull);
  });

  test('a scan and then a swipe both read', () {
    type('999800001', thenEnter: true);
    expect(buffer.card!.via, ReadVia.scan);

    clock = clock.add(const Duration(seconds: 3));
    type(';999900007?');
    expect(buffer.card!.number, '999900007');
    expect(buffer.card!.via, ReadVia.swipe);
  });

  // ---------------------------------------------------------------------------
  // Which programme
  // ---------------------------------------------------------------------------

  group('classify', () {
    const settings = CardSettings();

    test('the venue s three prefixes are the ones from their old system', () {
      // Read off the screenshot the client sent. Every card in every wallet in
      // the town depends on these being right on day one.
      expect(settings.clerkPrefix, '9999');
      expect(settings.loyaltyPrefix, '9998');
      expect(settings.giftPrefix, '9878');
    });

    test('each prefix finds its own programme', () {
      expect(settings.classify('999900001'), CardKind.clerk);
      expect(settings.classify('999800001'), CardKind.loyalty);
      expect(settings.classify('987800001'), CardKind.gift);
    });

    test('a card from somewhere else belongs to nothing', () {
      // A hotel key, a bank card, another shop's loyalty card. The till says
      // what it was and that nothing here uses that prefix, which is far more
      // use to a clerk than "not found".
      expect(settings.classify('123400001'), isNull);
      expect(settings.classify(''), isNull);
    });

    test('a switched-off programme does not claim every card', () {
      // `startsWith('')` is true for everything. Without the guard, clearing the
      // gift prefix would make every card in the building a gift card.
      const noGift = CardSettings(giftPrefix: '');
      expect(noGift.classify('123400001'), isNull);
      expect(noGift.classify('999800001'), CardKind.loyalty);
    });

    test('the more specific prefix wins', () {
      const overlapping = CardSettings(loyaltyPrefix: '9998', giftPrefix: '99980');
      expect(overlapping.classify('999801234'), CardKind.gift);
      expect(overlapping.classify('999812345'), CardKind.loyalty);
    });
  });

  // ---------------------------------------------------------------------------
  // Writing one
  // ---------------------------------------------------------------------------

  group('issuing', () {
    test('member 1 is 00001, the way the venue programmes them', () {
      const settings = CardSettings();
      expect(settings.numberFor(CardKind.loyalty, 1), '999800001');
      expect(CardSettings.trackFor(settings.numberFor(CardKind.loyalty, 1)),
          ';999800001?');
    });

    test('a venue can widen its numbers', () {
      const settings = CardSettings(numberDigits: 7);
      expect(settings.numberFor(CardKind.loyalty, 42), '99980000042');
    });

    test('a stored number never carries the sentinels', () {
      // They belong to the reader, not the card. The same number has to work on
      // a stripe, in a QR code and on a phone, and only one of those three has
      // any use for a `;`.
      const settings = CardSettings();
      final number = settings.numberFor(CardKind.clerk, 7);
      expect(number.contains(';'), isFalse);
      expect(number.contains('?'), isFalse);
    });
  });

  // ---------------------------------------------------------------------------
  // Reading the settings back off the wire
  // ---------------------------------------------------------------------------

  group('settings from the back office', () {
    test('a row with everything in it is read', () {
      final settings = CardSettings.fromJson({
        'enabled': 1,
        'clerk_prefix': '7777',
        'loyalty_prefix': '7778',
        'gift_prefix': '7779',
        'number_digits': 6,
        'auto_enrol': 0,
      });
      expect(settings.clerkPrefix, '7777');
      expect(settings.numberDigits, 6);
      expect(settings.autoEnrol, isFalse);
    });

    test('a cleared prefix stays cleared', () {
      // It is the venue's answer — "we do not run gift cards" — and quietly
      // restoring the default would switch a programme back on under them.
      expect(CardSettings.fromJson({'gift_prefix': ''}).giftPrefix, '');
    });

    test('a missing field falls back to the venue s number', () {
      expect(CardSettings.fromJson({}).giftPrefix, '9878');
    });

    test('one bad field does not lose the other five', () {
      // A cast would take the whole object with it, and a till that fell back
      // to no prefixes stops recognising every card in the venue.
      final settings = CardSettings.fromJson({
        'clerk_prefix': '7777',
        'number_digits': 'not a number',
      });
      expect(settings.clerkPrefix, '7777');
      expect(settings.numberDigits, 5);
    });

    test('rubbish is the defaults, not a crash', () {
      expect(CardSettings.fromJson(null).loyaltyPrefix, '9998');
      expect(CardSettings.fromJson('nonsense').loyaltyPrefix, '9998');
    });
  });

  group('what the counter is offered', () {
    test('the venue can switch either button off on its own', () {
      // Two switches rather than one, because they fail apart: a venue with no
      // card printer wants the first and not the second.
      final noPrinter = CardSettings.fromJson({
        'till_wallet_button': 1,
        'till_print_button': 0,
      });
      expect(noPrinter.tillWalletButton, isTrue);
      expect(noPrinter.tillPrintButton, isFalse);

      final noWallet = CardSettings.fromJson({
        'till_wallet_button': 0,
        'till_print_button': 1,
      });
      expect(noWallet.tillWalletButton, isFalse);
      expect(noWallet.tillPrintButton, isTrue);
    });

    test('a server that predates the columns leaves both buttons on', () {
      // The failure this guards against is a till deployed ahead of its server:
      // an absent field reading as "off" would take both buttons away from
      // every venue on that server at once, and look like the release broke
      // them.
      final old = CardSettings.fromJson({'clerk_prefix': '9999'});
      expect(old.tillWalletButton, isTrue);
      expect(old.tillPrintButton, isTrue);
      expect(old.walletOnDisplay, isTrue);
    });

    test('the code goes to the customer screen unless the venue says not to', () {
      expect(CardSettings.fromJson({'wallet_on_display': 0}).walletOnDisplay,
          isFalse);
      expect(CardSettings.fromJson({'wallet_on_display': true}).walletOnDisplay,
          isTrue);
    });

    test('the three switches survive a round trip through JSON', () {
      // toJson is what the terminal stores between runs, so a field it forgets
      // is a setting that resets itself every time the till is switched on.
      const settings = CardSettings(
        tillWalletButton: false,
        tillPrintButton: false,
        walletOnDisplay: false,
      );
      final back = CardSettings.fromJson(settings.toJson());
      expect(back.tillWalletButton, isFalse);
      expect(back.tillPrintButton, isFalse);
      expect(back.walletOnDisplay, isFalse);
    });
  });
}
