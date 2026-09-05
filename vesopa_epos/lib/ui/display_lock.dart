/// Locking the customer screen from the till, in one press.
///
/// WHY THIS IS NOT ONLY A SWITCH IN SETTINGS
///
/// It is a switch in Settings as well — see `customer_display_page.dart` — and
/// that is the right place to find it the first time. But it is pressed in
/// pairs, at the counter, in the two moments a clerk is furthest from anything
/// with a settings page in it: a family arriving with children at hand height,
/// and a cloth going over the screen at the end of the night. Three taps into a
/// menu for something that happens twice an evening is three taps nobody takes,
/// and the feature would go unused.
///
/// So it is also a key a venue can put on a bar or on the sale grid, and this
/// is what that key runs.
///
/// A TOGGLE, NOT TWO KEYS
///
/// Because it is always undone. A venue should not have to find room for both
/// halves of one thought on a bar that is already full, and a key whose face
/// says what pressing it will do next is clearer than two keys where one of
/// them is always the wrong one.
library;

import 'package:flutter/material.dart';

import '../data/customer_display_control.dart';
import 'widgets/pos_message.dart';

/// Turn the lock on, or off, and say which happened.
///
/// Reads the current settings before writing rather than holding a copy: this
/// key can be pressed from a bar on any section, minutes after the settings
/// page was last open, and a stale copy written back would quietly undo
/// whatever a manager changed in between.
Future<void> toggleCustomerScreenLock(BuildContext context) async {
  final current = await readDisplayControl();
  final next = !current.childLock;

  final wrote = await writeDisplayControl(current.copyWith(childLock: next));
  if (!context.mounted) return;

  if (!wrote) {
    // The commonest cause by far is that there is no customer display on this
    // machine at all, so the message says that rather than "write failed".
    PosMessenger.error(
      context,
      'There is no customer screen connected to this till to lock.',
    );
    return;
  }

  PosMessenger.success(
    context,
    next
        ? 'Customer screen locked. It carries on showing the bill and ignores '
              'being touched.'
        : 'Customer screen unlocked.',
  );
}
