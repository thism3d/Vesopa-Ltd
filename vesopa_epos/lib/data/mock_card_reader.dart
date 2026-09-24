/// A card reader for a till that has not got one.
///
/// WHY THIS EXISTS
///
/// The reader is a keyboard (see `swipe_cards.dart`), so there is no driver to
/// stub and no device to fake. What there is, is a problem of access: the fault
/// that sent this file into being — a swipe that read correctly and then showed
/// nothing until somebody touched the glass — could only be reproduced by a
/// person standing at a counter with a piece of plastic. Every attempt to fix it
/// had to be posted to a venue and tried during service.
///
/// So a swipe can now be produced without one. The same card number, the same
/// [SwipedCard], down the same delivery path the reader's keystrokes end up in —
/// which is the part that matters. A mock that shortcut the delivery would have
/// happily "passed" against the bug it exists to catch.
///
/// WHAT IT DELIBERATELY DOES NOT DO
///
/// It does not synthesise key events. Tests that want the whole pipeline —
/// keystroke, sentinel, buffer, verdict — drive it with `simulateKeyDownEvent`
/// through the real [HardwareKeyboard], and `swipe_listener_test.dart` does
/// exactly that. This is the shorter path: a card, already read, handed to the
/// till. It is for a person at a keyboard with no reader plugged in, and for
/// tests about what happens *after* a card is recognised.
///
/// OFF UNLESS ASKED FOR
///
/// A till on a counter must not have a way to conjure a membership card out of
/// a menu. So this is live in a debug build, and in a release build only when
/// one is compiled for it:
///
///     flutter build windows --dart-define=VESOPA_MOCK_READER=true
///
/// Anything else — including every build that has ever gone to a venue — leaves
/// [enabled] false, and [SwipeCardListener] never subscribes.
library;

import 'dart:async';

import 'package:flutter/foundation.dart';

import 'swipe_cards.dart';

/// Whether a mock reader may be used in this build. See the note above.
const bool mockCardReaderEnabled =
    kDebugMode || bool.fromEnvironment('VESOPA_MOCK_READER');

/// A swipe, produced by something other than a reader.
///
/// One instance, because the till has one counter and the listener that hears
/// the real reader is the thing that has to hear this too. A stream rather than
/// a callback so a test can listen without displacing the till.
class MockCardReader {
  MockCardReader._();

  static final MockCardReader instance = MockCardReader._();

  final _cards = StreamController<SwipedCard>.broadcast();

  /// Cards produced by the mock. Empty for ever in a build where
  /// [mockCardReaderEnabled] is false, because [swipe] refuses to add to it.
  Stream<SwipedCard> get cards => _cards.stream;

  /// Whether anything is listening. Lets a debug menu say "no till is hearing
  /// this" rather than appearing to work.
  bool get hasListener => _cards.hasListener;

  /// Present [number] to the till as though it had been swiped.
  ///
  /// The card is framed the way a real track-2 read arrives — sentinels and all
  /// — so that anything downstream reading [SwipedCard.raw] sees what it would
  /// have seen from the reader on the counter.
  ///
  /// Returns false in a build that has no mock, so a caller can say so.
  bool swipe(String number, {ReadVia via = ReadVia.swipe}) {
    if (!mockCardReaderEnabled) return false;
    final digits = number.replaceAll(RegExp(r'[^0-9]'), '');
    if (digits.isEmpty) return false;

    _cards.add(
      SwipedCard(
        number: digits,
        raw: via == ReadVia.swipe ? ';$digits?' : digits,
        via: via,
      ),
    );
    return true;
  }

  /// Type [number] through [buffer] one character at a time, the way a reader
  /// does, and return the card it read.
  ///
  /// For tests that want the state machine exercised rather than bypassed, but
  /// do not need a widget tree. The gap is well inside the buffer's tolerance,
  /// and supplied rather than measured, so this does not depend on a clock.
  static SwipedCard? typeInto(
    SwipeBuffer buffer, {
    required String number,
    DateTime? at,
    Duration gap = const Duration(milliseconds: 8),
    bool sentinels = true,
    bool thenEnter = false,
  }) {
    var clock = at ?? DateTime(2026, 9, 5, 12);
    final text = sentinels ? ';$number?' : number;

    SwipeVerdict verdict = SwipeVerdict.ignore;
    for (final character in text.split('')) {
      clock = clock.add(gap);
      verdict = buffer.offer(character, at: clock);
    }
    if (thenEnter) {
      clock = clock.add(gap);
      verdict = buffer.offer(null, at: clock, isEnter: true);
    }
    return verdict == SwipeVerdict.complete ? buffer.card : null;
  }

  /// Only for tests that need a reader with nothing attached to it.
  @visibleForTesting
  Future<void> close() => _cards.close();
}
