/// What the till does when a card is swiped.
///
/// One movement, three outcomes, decided by the prefix on the front of the
/// number before anything is looked up:
///
///   * **a staff card** signs that person on, here, taking their bill with them
///     if they left one on another terminal;
///   * **a loyalty card** puts the member on the bill with their standing
///     discount — and where the card belongs to nobody, offers to enrol whoever
///     is holding it, which is the venue's own request;
///   * **a gift card** shows what is on it.
///
/// WHERE EACH ANSWER COMES FROM, AND WHY IT DIFFERS
///
/// The classification is local: the till caches the venue's prefixes, so it
/// knows 9999 means a staff card with the broadband down.
///
/// A staff card is then resolved locally too, against the same cached staff
/// list PIN sign-on uses. That is not an optimisation — a till that cannot sign
/// anybody on when the network drops is a till that cannot open, and the lock
/// screen is up at precisely the moment nobody can afford to be locked out.
///
/// A loyalty or gift card goes to the server, because that is where the balance
/// is. Points are money-adjacent and the same member can be at two tills at
/// once, so an offline till says so and rings the sale up without them rather
/// than awarding points from a stale cache another terminal has already spent.
///
/// EVERY OUTCOME SAYS SOMETHING
///
/// Including the ones that are not this venue's cards at all. A hotel key or
/// another shop's loyalty card swiped at the counter produces "that is not a
/// card this venue uses", with the number, rather than silence — because
/// silence is indistinguishable from a reader that has stopped working, and
/// that is the support call nobody can answer over the phone.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/commerce.dart';
import '../data/staff_session.dart';
import '../data/swipe_cards.dart';
import '../data/terminal_identity.dart';
import '../main.dart';
import 'cards_page.dart' show lastCardReadProvider;
import 'staff_handover.dart';
import 'widgets/pos_message.dart';

/// Deal with [card].
///
/// [orderId] is the bill on screen, or null where there is not one — the till
/// locked, or sitting on a page that has no basket. A loyalty card swiped with
/// no bill open still says who the member is; it simply has nothing to attach
/// them to, and says that too.
Future<void> handleSwipedCard(
  BuildContext context,
  WidgetRef ref,
  SwipedCard card, {
  String? orderId,
}) async {
  // Recorded before anything is decided, and recorded even for cards this
  // venue has never heard of. The reader test on the Cards page reads this, and
  // its whole value is showing what actually arrived — a screen that only ever
  // displayed cards the till understood could not tell a dead reader from a
  // prefix that does not match, which is the support call it exists to answer.
  ref.read(lastCardReadProvider.notifier).saw(card);

  final settings = ref.read(cardRepositoryProvider).settings;
  if (!settings.enabled) return;

  switch (settings.classify(card.number)) {
    case CardKind.clerk:
      await _signOnWithCard(context, ref, card);
    case CardKind.loyalty:
      await _loyaltyCard(context, ref, card, orderId: orderId);
    case CardKind.gift:
      await _giftCard(context, ref, card);
    case CardKind.membership:
      // The same lookup as loyalty — a membership card names a customer, and a
      // customer is one row whether they hold points, a membership, or both.
      // What differs is what the till says about them, which _loyaltyCard
      // decides from the row it gets back.
      await _loyaltyCard(context, ref, card, orderId: orderId);
    case null:
      if (!context.mounted) return;
      await _explain(
        context,
        title: 'Not a card this venue uses',
        message:
            'That card reads ${card.number}, which does not start with any of '
            'this venue\'s prefixes. The reader is working — the card belongs '
            'to somewhere else.\n\nPrefixes are set in the back office, under '
            'Cards.',
      );
  }
}

// -----------------------------------------------------------------------------
// Staff
// -----------------------------------------------------------------------------

Future<void> _signOnWithCard(
  BuildContext context,
  WidgetRef ref,
  SwipedCard card,
) async {
  final staff = await ref.read(staffRepositoryProvider).byCard(card.number);
  if (!context.mounted) return;

  if (staff == null) {
    await _explain(
      context,
      title: 'That staff card was not recognised',
      message:
          'Card ${card.number} does not belong to anybody on this venue\'s '
          'staff list. It may have been issued to somebody who has since been '
          'removed, or it may not have reached this terminal yet.\n\nSigning '
          'on with a PIN still works.',
    );
    return;
  }

  // Not `signOn` directly, for the same reason the PIN pad does not: where a
  // venue runs more than one till this also moves the clerk's session off
  // whichever terminal they were on, and offers to bring the bill they left
  // there. On a one-till venue it does nothing beyond signing them on.
  await signOnHere(context, ref, staff);
}

// -----------------------------------------------------------------------------
// Loyalty
// -----------------------------------------------------------------------------

Future<void> _loyaltyCard(
  BuildContext context,
  WidgetRef ref,
  SwipedCard card, {
  required String? orderId,
}) async {
  final commerce = ref.read(commerceRepositoryProvider);

  final LoyaltyCustomer? member;
  try {
    member = await commerce.loyaltyByCard(card.number);
  } on Object catch (e) {
    if (!context.mounted) return;
    // Deliberately *not* "no member holds this card". The two are completely
    // different things to say to a clerk, and offering to enrol a member of
    // three years standing because the broadband dropped would be the worse
    // half of the mix-up.
    await _explain(
      context,
      title: 'Could not look that card up',
      message:
          'The till could not reach the back office, so it cannot say who holds '
          'card ${card.number}. Ring the sale up as normal — the points can be '
          'added afterwards.\n\n$e',
    );
    return;
  }

  if (!context.mounted) return;

  if (member == null) {
    await _offerToEnrol(context, ref, card, orderId: orderId);
    return;
  }

  if (orderId == null) {
    await _explain(
      context,
      title: member.name,
      message:
          '${member.pointsBalance} point'
          '${member.pointsBalance == 1 ? '' : 's'}'
          '${member.pointsValueMinor > 0 ? ', worth '
              '${_money(member.pointsValueMinor)}' : ''}.'
          '\n\nOpen a bill and swipe again to put them on it.',
    );
    return;
  }

  await ref
      .read(orderRepositoryProvider)
      .attachCustomer(
        orderId,
        id: member.id,
        name: member.name,
        // Their standing discount comes with them, which is the whole reason a
        // card is worth swiping before the round is rung rather than after.
        discountType: member.discountType,
        discountValue: member.discountValue,
      );

  if (!context.mounted) return;
  // PosMessenger rather than a SnackBar. A bar rises from the bottom of the
  // screen, which on this till is where PAY and the action strip are — see
  // widgets/pos_message.dart for the tap it swallowed.
  PosMessenger.success(
    context,
    '${member.name} is on this bill — '
    '${member.pointsBalance} point'
    '${member.pointsBalance == 1 ? '' : 's'}'
    '${member.discountType != 'none' && member.discountValue > 0
        ? ', ${_discount(member)}'
        : ''}.',
  );
}

/// Nobody holds this card. Offer to make it somebody's.
///
/// The venue asked for this in as many words: "if no member is found it would
/// ask, would you like to create a new member for the card that's been swiped".
/// It is behind a setting because a venue that issues cards only from the back
/// office wants the till to say "not a member" rather than open a form at the
/// counter with a queue behind it.
Future<void> _offerToEnrol(
  BuildContext context,
  WidgetRef ref,
  SwipedCard card, {
  required String? orderId,
}) async {
  final settings = ref.read(cardRepositoryProvider).settings;

  if (!settings.autoEnrol) {
    await _explain(
      context,
      title: 'Not a member',
      message:
          'Card ${card.number} is a loyalty card, but nobody holds it yet. It '
          'can be given to a member in the back office.',
    );
    return;
  }

  final enrol = await showDialog<bool>(
    context: context,
    builder: (context) => AlertDialog(
      title: const Text('New member for this card?'),
      content: Text(
        'Nobody holds card ${card.number}.\n\n'
        'Would you like to create a member for it now?',
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(false),
          child: const Text('Not now'),
        ),
        FilledButton(
          onPressed: () => Navigator.of(context).pop(true),
          child: const Text('Create a member'),
        ),
      ],
    ),
  );
  if (!(enrol ?? false) || !context.mounted) return;

  final details = await _askForMember(context);
  if (details == null || !context.mounted) return;

  final commerce = ref.read(commerceRepositoryProvider);
  final cards = ref.read(cardRepositoryProvider);

  try {
    // Enrolled first, then the card attached to them. Two calls rather than
    // one, because enrolling is an existing route that a phone number already
    // goes through and a second way in would be a second set of rules about
    // what a member is.
    final member = await commerce.enrol(
      phone: details.phone,
      name: details.name,
    );
    await cards.assign(
      cardNumber: card.number,
      subjectId: member.id,
      subjectName: member.name,
      issuedBy: ref.read(staffSessionProvider).name,
      terminal: ref.read(terminalNameProvider),
    );

    if (orderId != null) {
      await ref
          .read(orderRepositoryProvider)
          .attachCustomer(orderId, id: member.id, name: member.name);
    }

    if (!context.mounted) return;
    PosMessenger.success(
      context,
      '${member.name} is a member, and card ${card.number} is theirs.',
    );
  } on Object catch (e) {
    if (!context.mounted) return;
    await _explain(
      context,
      title: 'Could not create that member',
      message: '$e',
    );
  }
}

/// The two things a member needs: a name and a number to be found by.
///
/// Deliberately short. This runs at a counter with somebody waiting, and a form
/// with six fields on it is a form a clerk skips by typing "x" into all of
/// them.
Future<({String name, String phone})?> _askForMember(BuildContext context) {
  final name = TextEditingController();
  final phone = TextEditingController();

  return showDialog<({String name, String phone})>(
    context: context,
    builder: (context) => AlertDialog(
      title: const Text('New member'),
      content: SizedBox(
        width: 340,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
              controller: name,
              autofocus: true,
              textCapitalization: TextCapitalization.words,
              decoration: const InputDecoration(labelText: 'Name'),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: phone,
              keyboardType: TextInputType.phone,
              decoration: const InputDecoration(
                labelText: 'Phone',
                helperText: 'How they are found if they forget the card.',
              ),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: () {
            final n = name.text.trim();
            final p = phone.text.trim();
            if (n.isEmpty || p.isEmpty) return;
            Navigator.of(context).pop((name: n, phone: p));
          },
          child: const Text('Create'),
        ),
      ],
    ),
  );
}

// -----------------------------------------------------------------------------
// Gift
// -----------------------------------------------------------------------------

Future<void> _giftCard(
  BuildContext context,
  WidgetRef ref,
  SwipedCard card,
) async {
  try {
    final gift = await ref.read(commerceRepositoryProvider).giftCard(card.number);
    if (!context.mounted) return;

    await _explain(
      context,
      title: 'Gift card ${card.number}',
      message:
          '${_money(gift.balanceMinor)} on the card.\n\n'
          'To spend it, take the payment and choose Gift card.',
    );
  } on Object catch (e) {
    if (!context.mounted) return;
    await _explain(
      context,
      title: 'Could not read that gift card',
      message: '$e',
    );
  }
}

// -----------------------------------------------------------------------------

/// Something the clerk has to read and act on, rather than a message that
/// fades.
///
/// [PosMessenger] is the right tool for "done" and the wrong one for "this card
/// belongs to nobody, here is what to do about it": it is gone in a second and a
/// half, deliberately, and a clerk who looked away misses it entirely.
Future<void> _explain(
  BuildContext context, {
  required String title,
  required String message,
}) => showDialog<void>(
  context: context,
  builder: (context) => AlertDialog(
    title: Text(title),
    content: Text(message),
    actions: [
      FilledButton(
        onPressed: () => Navigator.of(context).pop(),
        child: const Text('OK'),
      ),
    ],
  ),
);

String _money(int minor) => '£${(minor / 100).toStringAsFixed(2)}';

String _discount(LoyaltyCustomer member) => switch (member.discountType) {
  'percent' => '${member.discountValue}% off',
  'amount' => '${_money(member.discountValue)} off',
  _ => '',
};
