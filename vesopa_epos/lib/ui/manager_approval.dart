/// Approving one action for somebody else — by PIN, or by swiping a card.
///
/// WHY A CARD AT ALL
///
/// A manager asked to approve a void is standing at somebody else's till, with
/// a customer watching and a queue behind them. Typing four digits in front of
/// an audience is the part of that they will do badly: a PIN typed over
/// somebody's shoulder is a PIN that member of staff now knows, and a manager
/// who has learned that will start giving the keys away rather than walk over.
///
/// The manager already carries a card, and the reader is already on the
/// counter — it is how they sign on. So the same card approves, and the pad
/// stays for whoever left theirs upstairs. Either answers the same question,
/// which is "prove you are a manager, once, for this one action".
///
/// WHY THE DIALOG HAS TO CLAIM THE CARD
///
/// [SwipeCardListener] is wrapped around the whole till, and its handler signs
/// people on. Without this, a manager swiping to approve a void would be signed
/// on *instead* — the clerk would be thrown off their own bill mid-sale, which
/// is the exact thing the approval flow exists to avoid.
///
/// So while this dialog is up it takes the next card first. [ManagerCardCapture]
/// is what the till's own handler consults before doing anything with a swipe:
/// one place to ask, rather than a flag threaded through every screen.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/local/database.dart';
import '../main.dart' show staffRepositoryProvider;
import '../data/swipe_cards.dart';
import 'pin_dialog.dart';

/// Where a swiped card goes while an approval is waiting for one.
///
/// Static because there is one counter and one reader, and because the till's
/// card handler needs to ask this without being handed a reference to whatever
/// dialog happens to be open.
class ManagerCardCapture {
  ManagerCardCapture._();

  static Completer<SwipedCard>? _waiting;

  /// True while an approval prompt is on screen and wants the next card.
  static bool get isWaiting => _waiting != null;

  /// Offer a card to whatever is waiting.
  ///
  /// Returns true when it was taken, which tells the caller not to do its own
  /// thing with it. False when nothing is waiting, which is every ordinary
  /// swipe.
  static bool offer(SwipedCard card) {
    final waiting = _waiting;
    if (waiting == null || waiting.isCompleted) return false;
    _waiting = null;
    waiting.complete(card);
    return true;
  }

  /// Wait for the next card. Only [_ManagerPrompt] calls this.
  static Future<SwipedCard?> _next() {
    // A second prompt cannot open over the first, but if it somehow did, the
    // older one is released rather than left waiting for ever.
    _waiting?.complete(SwipedCard(number: '', raw: '', via: ReadVia.swipe));
    final completer = Completer<SwipedCard>();
    _waiting = completer;
    return completer.future;
  }

  /// Stop waiting, because the prompt has gone.
  static void _stop() {
    _waiting = null;
  }

  /// The two above, reachable from a test.
  ///
  /// Named `debug` rather than made public outright: who gets a swipe is the
  /// property worth guarding here, and it can be checked without standing up a
  /// till and a reader — but nothing outside this file should be arranging to
  /// intercept cards.
  @visibleForTesting
  static Future<SwipedCard?> debugWaitForCard() => _next();

  @visibleForTesting
  static void debugStop() => _stop();
}

/// How an approval was proved, for the message afterwards.
enum ApprovedBy { pin, card }

/// A manager, and how they identified themselves.
@immutable
class ManagerApproval {
  const ManagerApproval({required this.staff, required this.by});

  final StaffData staff;
  final ApprovedBy by;
}

/// Ask a manager to approve, and let them answer with a PIN or a card.
///
/// Resolves null if it was dismissed, or if what was offered did not name
/// anybody — the caller reports that, because only it knows what was refused.
Future<ManagerApproval?> askAManagerToApprove(
  BuildContext context,
  WidgetRef ref, {
  required String title,
}) async {
  final answer = await showDialog<_Answer>(
    context: context,
    barrierDismissible: false,
    builder: (_) => _ManagerPrompt(title: title),
  );
  if (answer == null || !context.mounted) return null;

  final repository = ref.read(staffRepositoryProvider);
  final staff = answer.card != null
      ? await repository.byCard(answer.card!)
      : await repository.byPin(answer.pin!);
  if (staff == null) return null;

  return ManagerApproval(
    staff: staff,
    by: answer.card != null ? ApprovedBy.card : ApprovedBy.pin,
  );
}

/// Either four digits or a card number, whichever arrived first.
class _Answer {
  const _Answer.pin(this.pin) : card = null;
  const _Answer.card(this.card) : pin = null;

  final String? pin;
  final String? card;
}

class _ManagerPrompt extends StatefulWidget {
  const _ManagerPrompt({required this.title});

  final String title;

  @override
  State<_ManagerPrompt> createState() => _ManagerPromptState();
}

class _ManagerPromptState extends State<_ManagerPrompt> {
  String _pin = '';

  @override
  void initState() {
    super.initState();
    unawaited(_listenForCard());
  }

  Future<void> _listenForCard() async {
    final card = await ManagerCardCapture._next();
    if (!mounted || card == null || card.number.isEmpty) return;
    Navigator.of(context).pop(_Answer.card(card.number));
  }

  @override
  void dispose() {
    // The prompt is going, so the till's own handler gets swipes back. Without
    // this a card swiped after a cancelled approval would vanish into a
    // completer nobody is listening to, and the reader would look broken.
    ManagerCardCapture._stop();
    super.dispose();
  }

  void _key(String key) {
    setState(() {
      if (key == '<') {
        if (_pin.isNotEmpty) _pin = _pin.substring(0, _pin.length - 1);
      } else if (_pin.length < pinLength) {
        _pin += key;
      }
    });
    if (_pin.length == pinLength) {
      Navigator.of(context).pop(_Answer.pin(_pin));
    }
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: Text(widget.title),
    content: SizedBox(
      width: 260,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          PinPad(pin: _pin, onKey: _key),
          const SizedBox(height: 14),
          // Said plainly, and present from the moment the prompt opens: a
          // manager should not have to discover that the reader works here.
          const _WaitingForCard(),
        ],
      ),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.of(context).pop(),
        child: const Text('Cancel'),
      ),
    ],
  );
}

/// The line that tells a manager they can swipe instead of type.
class _WaitingForCard extends StatelessWidget {
  const _WaitingForCard();

  @override
  Widget build(BuildContext context) {
    final ink = Theme.of(context).colorScheme.onSurfaceVariant;
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        SizedBox(
          width: 13,
          height: 13,
          child: CircularProgressIndicator(strokeWidth: 1.6, color: ink),
        ),
        const SizedBox(width: 9),
        Flexible(
          child: Text(
            'or swipe your manager card',
            style: TextStyle(fontSize: 12.5, color: ink),
          ),
        ),
      ],
    );
  }
}
