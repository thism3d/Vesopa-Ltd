/// Signing a clerk on, when the venue has more than one till.
///
/// Two things happen that did not before, and they are the same round trip:
///
///   1. **The session moves.** A clerk is signed on to one terminal at a time.
///      Signing on here takes them off wherever they were, because a PIN live
///      on two machines means two baskets, and the second one they walk away
///      from is a round of drinks nobody is charged for.
///   2. **Their items follow them.** If they were part-way through a bill on
///      the other terminal, this till offers to bring it with them — which is
///      the whole point of moving the session rather than merely refusing it.
///
/// The offer is an offer, not an automatic action. A clerk who has walked to
/// the second till to start something new should not find somebody's half-rung
/// round on the screen, so the till asks, names the terminal it came from and
/// says what is on it.
///
/// **Offline this does nothing at all and the sign-on still works.** A till
/// that refused to let somebody on because the broadband was down would be a
/// till that cannot sell, which is a far worse fault than a clerk being live in
/// two places for the length of an outage. See TerminalService.claimClerk.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/local/database.dart';
import '../data/staff_session.dart';
import '../data/terminal_service.dart';
import '../main.dart';
import 'widgets/basket_panel.dart' show money;
import 'widgets/pos_message.dart';

/// Sign [who] on here, and offer to bring what they were holding.
///
/// Returns the id of the bill the till should switch to, or null to carry on
/// with whatever is on screen. The sign-on itself has already happened by the
/// time this returns either way: it is local, it is instant, and nothing about
/// the network is allowed to stand between a member of staff and a working
/// till.
Future<String?> signOnHere(
  BuildContext context,
  WidgetRef ref,
  StaffData who,
) async {
  // Local first, and unconditionally. Everything below is a courtesy.
  ref.read(staffSessionProvider.notifier).signOn(who);

  final terminals = ref.read(terminalServiceProvider);
  if (!terminals.canShare) return null;

  final claim = await terminals.claimClerk(
    staffId: who.id,
    staffName: who.name,
  );

  final basket = claim.basket;
  if (basket == null || basket.lineCount == 0) return null;
  if (!context.mounted) return null;

  final where = claim.previousTerminal;
  final take = await showDialog<bool>(
    context: context,
    builder: (dialogContext) => AlertDialog(
      title: Text('Bring your bill with you, ${who.name}?'),
      content: Text(
        where == null
            ? 'You were part-way through a bill: '
                  '${basket.lineCount} item${basket.lineCount == 1 ? '' : 's'}, '
                  '${money(basket.totalMinor)}.'
            : 'You left a bill on $where — '
                  '${basket.lineCount} item${basket.lineCount == 1 ? '' : 's'}, '
                  '${money(basket.totalMinor)}.'
                  '\n\nBringing it here takes it off that terminal.',
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(dialogContext).pop(false),
          child: const Text('Leave it there'),
        ),
        FilledButton(
          onPressed: () => Navigator.of(dialogContext).pop(true),
          child: const Text('Bring it here'),
        ),
      ],
    ),
  );

  if (take != true) return null;

  try {
    await ref.read(billSyncProvider).claim(basket.id);
    // Published as well as returned. The shell is the only thing that can
    // change which bill is on screen, and sign-on happens in three places —
    // this is what lets all three of them do it without a callback threaded
    // through each.
    ref.read(broughtBasketProvider.notifier).offer(basket.id);
    return basket.id;
  } on TerminalUnavailable catch (e) {
    // Settled or cancelled on the other terminal between the offer and the
    // answer, or the link went while the dialog was open. Said plainly: a
    // clerk who pressed "Bring it here" and got nothing would go looking for
    // the bill on this screen.
    if (context.mounted) PosMessenger.error(context, e.message);
    return null;
  }
}

/// Tell the venue what this clerk has in hand, so it can follow them next time.
///
/// Called when the bill on screen changes and when a sale completes — a null
/// [basketId] being "they are holding nothing", which is what settling leaves
/// behind.
Future<void> rememberBasket(
  WidgetRef ref, {
  required int? staffId,
  required String? basketId,
}) async {
  if (staffId == null) return;
  await ref
      .read(terminalServiceProvider)
      .setClerkBasket(staffId: staffId, basketId: basketId);
}
