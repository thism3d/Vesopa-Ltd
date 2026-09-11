import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'staff_session.dart';

export 'receipt_repository.dart' show trainingReceiptLine;

/// Training mode.
///
/// "Create a staff account on the back office specifically for Training Mode.
/// Sales made in Training Mode should not be sent to the back office and should
/// not count towards the sales figures on the till."
///
/// A training account is a member of staff the back office has marked as one
/// (`Staff.training`). While one is signed on, the till is in training mode:
///
///  * every bill opened is a **practice bill** (`Orders.training`), and a
///    practice bill is never queued for the server, never shared with another
///    till, never sent to the kitchen, never charged to a card or a gift card,
///    prints as TRAINING, and is left out of the X and Z;
///  * the till wears an amber TRAINING bar so nobody mistakes it for the real
///    thing;
///  * a practice bill never becomes a real one and a real one never becomes
///    practice -- see the shell, which only lets training start on an empty bill
///    and clears the practice bill when training ends.
///
/// The server refuses to record a practice sale too (src/training.js), and never
/// gives a training account to a till older than this one.
final trainingModeProvider = Provider<bool>(
  (ref) => ref.watch(staffSessionProvider).staff?.training ?? false,
);

/// What a practice card payment says instead of asking the card machine.
const trainingCardMessage = 'Training: no card was charged.';

/// Said when a trainee tries something that moves real value.
const trainingRefusal =
    'Not in training mode. Gift cards, vouchers, deposits and points belong to '
    'real customers, so practice cannot use them.';
