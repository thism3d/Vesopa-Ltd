/// Hearing the card reader, wherever the till happens to be.
///
/// Wrapped around the whole signed-in till rather than fitted to one screen,
/// because a card is swiped whenever a customer holds one out — with a sale on
/// screen, with the payment page up, with a dialog open, or with the till
/// locked and the idle picture showing. A listener attached to the sale screen
/// would be a reader that works only when nobody needed it to do anything
/// interesting.
///
/// SWALLOWING THE KEYSTROKES IS THE POINT
///
/// A stripe reader is a keyboard (see `data/swipe_cards.dart`) and it types
/// into whatever has focus. A loyalty card swiped while the discount dialog is
/// open would otherwise enter `999800001` in the amount box and press Return.
///
/// Returning true from a [HardwareKeyboard] handler is what prevents that. On
/// Windows the embedder offers each key to the framework first and only passes
/// the character on to the text input plugin if nothing claimed it — so a
/// handled key never reaches the focused field at all. That ordering is what
/// this depends on, and it is worth knowing that it is the thing that would
/// break if a swipe ever started appearing in text boxes.
///
/// A SWIPE MUST ASK FOR A FRAME
///
/// The work is deferred to a post-frame callback so it never runs inside the
/// key handler. That deferral is only half of it: `addPostFrameCallback` adds
/// to a queue and does not schedule a frame, and a till showing a still sale
/// screen has no frame coming. Without an explicit [SchedulerBinding.scheduleFrame]
/// the callback waits for whatever repaints next, which at a counter means the
/// next time somebody touches the screen.
///
/// ONE CARD AT A TIME
///
/// A swipe that arrives while the last one is still being dealt with is
/// dropped. Two cards cannot be in front of one clerk at once, and the
/// alternative — stacking dialogs on top of each other — turns a double swipe
/// by a customer who was not sure it worked into two overlapping prompts.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../data/mock_card_reader.dart';
import '../data/swipe_cards.dart';

class SwipeCardListener extends StatefulWidget {
  const SwipeCardListener({
    required this.onCard,
    required this.child,
    this.enabled = true,
    super.key,
  });

  /// What to do with a card. Returning a future is what makes "one at a time"
  /// mean anything: the next swipe is ignored until this one has settled.
  final Future<void> Function(SwipedCard card) onCard;

  /// Whether to listen at all. False for a venue that has no reader, so that a
  /// barcode scanner or a stray keyboard cannot start signing people on.
  final bool enabled;

  final Widget child;

  @override
  State<SwipeCardListener> createState() => _SwipeCardListenerState();
}

class _SwipeCardListenerState extends State<SwipeCardListener> {
  final _buffer = SwipeBuffer();
  bool _busy = false;

  /// A card from [MockCardReader], on a build that has one. Null otherwise, and
  /// on every build that has ever gone to a venue.
  StreamSubscription<SwipedCard>? _mock;

  @override
  void initState() {
    super.initState();
    HardwareKeyboard.instance.addHandler(_onKey);
    if (mockCardReaderEnabled) {
      // Into [_deliver], not into `onCard` — the mock must take the same route
      // a real swipe takes, or it stops being able to catch anything that route
      // gets wrong. It was a fault in that very code that this exists for.
      _mock = MockCardReader.instance.cards.listen(_deliver);
    }
  }

  @override
  void dispose() {
    HardwareKeyboard.instance.removeHandler(_onKey);
    _mock?.cancel();
    super.dispose();
  }

  /// Hand one card to the till, off this frame and no more than one at a time.
  ///
  /// Both readers end here — the one on the counter and the mock — so there is
  /// a single place where "what happens when a card is read" is decided.
  void _deliver(SwipedCard card) {
    if (_busy || !widget.enabled) return;
    _busy = true;

    // Off this frame. `onCard` opens dialogs and touches providers, and doing
    // that from inside a key handler runs it during the build the keystroke
    // arrived in.
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      try {
        await widget.onCard(card);
      } finally {
        _busy = false;
      }
    });

    // And then ask for that frame, which is the part that was missing.
    //
    // `addPostFrameCallback` appends to a list. It does not request a frame,
    // and nothing else here does either — a keystroke is not a repaint, so an
    // idle till has no frame coming. The callback sat in the queue until
    // something unrelated scheduled one, and on a counter the only thing that
    // does is a finger on the glass.
    //
    // That is exactly what the venue reported: swipe a card, nothing; touch the
    // screen anywhere, and the member prompt appears. The read was never the
    // problem — the card had been decoded correctly all along and was waiting
    // for a frame nobody had asked for.
    WidgetsBinding.instance.scheduleFrame();
  }

  bool _onKey(KeyEvent event) {
    if (!widget.enabled) return false;

    // Key-ups and repeats are not card data. A repeat in particular would be a
    // key somebody is holding down, which no reader does.
    if (event is! KeyDownEvent) return false;

    final isEnter =
        event.logicalKey == LogicalKeyboardKey.enter ||
        event.logicalKey == LogicalKeyboardKey.numpadEnter;

    final verdict = _buffer.offer(
      event.character,
      at: DateTime.now(),
      isEnter: isEnter,
    );

    switch (verdict) {
      case SwipeVerdict.ignore:
        return false;

      case SwipeVerdict.consume:
        return true;

      case SwipeVerdict.complete:
        final card = _buffer.card;
        if (card != null) _deliver(card);
        // Claimed either way. A swipe dropped because the till was busy with the
        // last one still must not type itself into a price box.
        return true;
    }
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
