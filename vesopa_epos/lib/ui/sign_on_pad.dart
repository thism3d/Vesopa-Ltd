/// Handing the till to somebody else, in one press and four digits.
///
/// The till has always had Sign Off, which locks the screen and puts the idle
/// picture up for the next person to type their PIN into. That is right at the
/// end of a shift and wrong in the middle of service: the common case is a
/// colleague stepping in for one sale while the first clerk is still standing
/// there, and making them lock the till, wait for the screensaver and then type
/// into it is three steps for something that should be one.
///
/// So: a Sign On key. It opens **straight onto a PIN pad**.
///
/// It used to open onto a list of everybody who could take over, and you picked
/// your name before it asked for the PIN. That list is the thing that made the
/// key slow, and it got slower the better the venue did — a pub with twenty
/// staff put a scroll between a clerk and their own till, mid-queue, to collect
/// a fact the PIN was about to establish anyway. The PIN already identifies
/// exactly one person: the back office refuses to issue two people the same
/// one, which is what makes "who typed this" a lookup rather than a guess.
///
/// A miss keeps the pad open. Closing the dialog on a mistyped digit is how a
/// four-digit PIN turns into a dismissal, a re-press and four digits again.
///
/// The bill on screen is left exactly as it is — a handover is a change of who
/// is responsible, not a change of what the customer has ordered.
///
/// Where the venue runs more than one till, this is also where a clerk's items
/// catch up with them: see [signOnHere], which moves their session off whatever
/// terminal they were on and offers to bring the bill they left there.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/local/database.dart';
import '../main.dart';
import 'pin_dialog.dart' show pinLength;
import 'staff_handover.dart';
import 'widgets/pos_message.dart';
import 'widgets/staff_pin_pad.dart';

/// Offer the till to somebody else.
///
/// Returns the id of a bill the caller should switch to — the one the new clerk
/// brought with them from another terminal — or null to leave the screen as it
/// is, which is the ordinary answer.
Future<String?> showSignOnPad(BuildContext context, WidgetRef ref) async {
  // A terminal that cannot check a PIN has nothing to offer here. Said plainly
  // rather than opening a pad that refuses every code typed into it.
  if (!ref.read(canSignOnProvider)) {
    PosMessenger.info(
      context,
      'Nobody is set up to sign on at this venue yet, or this terminal has not '
      'downloaded the staff list. Settings › Staff.',
    );
    return null;
  }

  return showDialog<String>(
    context: context,
    // Transparent, and dimmed harder than the default. The pad is the idle
    // screen's — a dark console meant to sit on a dark ground — so it is given
    // one here rather than being dropped onto a white card where its keys would
    // read as a hole cut in the dialog.
    barrierColor: const Color(0xCC000000),
    builder: (_) => const _SignOnPad(),
  );
}

class _SignOnPad extends ConsumerStatefulWidget {
  const _SignOnPad();

  @override
  ConsumerState<_SignOnPad> createState() => _SignOnPadState();
}

class _SignOnPadState extends ConsumerState<_SignOnPad> {
  String _pin = '';
  String? _error;
  bool _checking = false;

  /// Whether the digits on screen belong to an attempt that has already been
  /// refused. The next digit clears them and starts again — see [_key].
  bool _spent = false;

  /// Bumped on every refusal, so the pad shakes. The lock screen has always
  /// done this; the Sign On dialog did not, and a refusal there was a line of
  /// small text on a screen nobody was reading.
  int _rejections = 0;

  void _key(String key) {
    setState(() {
      if (key == '<') {
        // Backspace corrects; it does not restart. One wrong key out of four
        // is the common miss and retyping all four for it is the annoyance
        // this whole key exists to remove.
        _spent = false;
        _error = null;
        if (_pin.isNotEmpty) _pin = _pin.substring(0, _pin.length - 1);
        return;
      }
      // A digit after a refusal starts the next attempt immediately, which is
      // what somebody who simply mistyped will do. Without this they are stuck
      // on four dots with nothing but backspace to get out.
      if (_spent) {
        _pin = '';
        _spent = false;
        _error = null;
      }
      if (_pin.length < pinLength) _pin += key;
    });

    if (_pin.length == pinLength) _submit();
  }

  Future<void> _submit() async {
    if (_checking) return;
    setState(() => _checking = true);

    final repo = ref.read(staffRepositoryProvider);
    StaffData? who;
    try {
      who = await repo.byPin(_pin);
    } catch (_) {
      who = null;
    }
    if (!mounted) return;

    if (who == null) {
      setState(() {
        _checking = false;
        _spent = true;
        _rejections++;
        _error = 'That PIN was not recognised. Type it again, or correct it.';
      });
      return;
    }

    // Not `signOn` directly. Where a venue runs more than one till this also
    // moves the clerk's session off whichever terminal they were on and offers
    // to bring the bill they left there.
    final bring = await signOnHere(context, ref, who);
    if (!mounted) return;
    Navigator.of(context).pop(bring);
  }

  @override
  Widget build(BuildContext context) {
    // The idle screen's pad, not one that resembles it.
    //
    // The venue asked for these to be identical — "to make it simple for staff"
    // — and they were not: this dialog had a smaller pad with a blank key where
    // Clear belongs and a bare backspace beside it, while the lock screen had
    // big keys with both actions spelled out. Signing on is the most repeated
    // act on the terminal and staff do it without looking, so two layouts meant
    // the muscle memory was wrong half the time.
    //
    // Sharing the widget rather than restyling this one is what stops that
    // coming back the next time either screen is touched.
    return Dialog(
      backgroundColor: Colors.transparent,
      elevation: 0,
      insetPadding: const EdgeInsets.all(24),
      child: SingleChildScrollView(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 380),
          child: StaffPinPad(
            pin: _pin,
            onKey: _key,
            onCancel: _checking ? () {} : () => Navigator.of(context).pop(),
            prompt: 'Type your PIN to take the till',
            error: _error,
            busy: _checking,
            rejections: _rejections,
          ),
        ),
      ),
    );
  }
}
