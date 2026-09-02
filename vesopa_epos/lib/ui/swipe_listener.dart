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
/// ONE CARD AT A TIME
///
/// A swipe that arrives while the last one is still being dealt with is
/// dropped. Two cards cannot be in front of one clerk at once, and the
/// alternative — stacking dialogs on top of each other — turns a double swipe
/// by a customer who was not sure it worked into two overlapping prompts.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

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

  @override
  void initState() {
    super.initState();
    HardwareKeyboard.instance.addHandler(_onKey);
  }

  @override
  void dispose() {
    HardwareKeyboard.instance.removeHandler(_onKey);
    super.dispose();
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
        if (card != null && !_busy) {
          _busy = true;
          // Off this frame. `onCard` opens dialogs and touches providers, and
          // doing that from inside a key handler runs it during the build the
          // keystroke arrived in.
          WidgetsBinding.instance.addPostFrameCallback((_) async {
            try {
              await widget.onCard(card);
            } finally {
              _busy = false;
            }
          });
        }
        // Claimed either way. A swipe dropped because the till was busy with the
        // last one still must not type itself into a price box.
        return true;
    }
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
