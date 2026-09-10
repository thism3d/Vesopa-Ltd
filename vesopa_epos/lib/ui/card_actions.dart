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
///   * **a gift card** shows what is on it;
///   * **a gym card** signs a member in at the door, or back out again, and
///     says so without asking anybody anything.
///
/// THE GYM CARD IS THE ONE THAT MAY NOT ASK
///
/// Every other branch here is allowed to open something, because every other
/// branch happens in front of a member of staff. The gym till is unmanned --
/// "they use this as a self service where no one mans the till" -- so a dialog
/// there is a screen frozen on one member's name until somebody walks over from
/// the other end of the building, with the next four people through the door
/// getting nothing at all. See ui/gym_greeting.dart, which is a layer rather
/// than a dialog for exactly that reason.
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
import '../data/membership.dart';
import '../data/staff_session.dart';
import '../data/local/database.dart';
import '../data/swipe_cards.dart';
import 'barcode_actions.dart';
import 'gym_greeting.dart';
import 'printers_page.dart' show printerSettingsProvider;
import '../data/terminal_identity.dart';
import '../main.dart';
import '../printing/print_service.dart';
import '../printing/receipt_builder.dart';
import 'cards_page.dart' show lastCardReadProvider;
import 'membership_gate.dart';
import 'membership_prompt.dart';
import 'staff_admin.dart' show StaffCardCapture;
import 'staff_handover.dart';
import 'manager_approval.dart';
import 'widgets/pos_message.dart';
import 'widgets/on_screen_keyboard.dart';
import 'widgets/pos_text_field.dart';

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
  /// How to ring a product a scan found.
  ///
  /// Passed in rather than done here, because ringing an item is the sale
  /// screen's own `ring` — it asks a product's modifier questions and honours
  /// the venue's consolidation setting, and a second path that did neither
  /// would be a scanner that behaves differently from a key.
  ///
  /// Null on a screen with no bill in front of the clerk.
  Future<void> Function(Product product)? onScannedProduct,
}) async {
  // Recorded before anything is decided, and recorded even for cards this
  // venue has never heard of. The reader test on the Cards page reads this, and
  // its whole value is showing what actually arrived — a screen that only ever
  // displayed cards the till understood could not tell a dead reader from a
  // prefix that does not match, which is the support call it exists to answer.
  ref.read(lastCardReadProvider.notifier).saw(card);

  // An approval waiting for a card takes it before anything else looks at it.
  //
  // Without this, a manager swiping to approve a void would be signed *on* by
  // the clerk branch below — throwing the clerk off their own bill mid-sale,
  // which is precisely what the approval flow exists to avoid. The card is
  // still recorded above first, so the reader test on the Cards page sees every
  // swipe either way.
  if (ManagerCardCapture.offer(card)) return;

  // And the staff sheet, when it is waiting to hand a card to somebody. Second,
  // so a manager approving something over the top of it still wins — and for
  // the same reason as the manager's: without this, swiping a new card to give
  // to a starter would sign whoever last held it on to this terminal.
  if (StaffCardCapture.offer(card)) return;

  final settings = ref.read(cardRepositoryProvider).settings;
  if (!settings.enabled) return;

  // The door, before anything that could open a dialog.
  //
  // Taken out of the switch below rather than added to it, because it is the
  // one branch whose answer is "and the gym is switched on for this venue".
  // classify() knows only about prefixes: a venue that switched the gym off
  // and left a prefix behind would otherwise have every gym card in the
  // building fall into a branch that does nothing, and silence at a card
  // reader is indistinguishable from a reader that has stopped working.
  //
  // With the gym off the card falls through to the switch, where it matches no
  // prefix it is allowed to match and is offered as a barcode -- exactly what
  // happens to any other card this venue does not run.
  final gym = ref.read(gymRepositoryProvider);
  if (gym.isGymCard(card.number)) {
    await _gymCard(context, ref, card);
    return;
  }

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
    case CardKind.gym:
      // Only reachable with the gym switched OFF and a prefix left behind --
      // the live case returned above. Treated as a card this venue does not
      // run, which is what it now is.
      if (!context.mounted) return;
      await _explain(
        context,
        title: 'The gym is switched off',
        message:
            'Card ${card.number} is a gym card, but this venue does not '
            'currently run a gym.\n\nSwitch it on in the back office under '
            'Gym, or clear the gym prefix under Cards so these cards stop '
            'being recognised.',
      );
    case null:
      // Not one of the venue's cards. Before saying so, look for a product:
      // the same reader reads a bottle as reads a loyalty card, and "not a
      // card this venue uses" is true and useless when the thing in the
      // clerk's hand is a bottle. See ui/barcode_actions.dart.
      if (!context.mounted) return;
      final product = await handleScannedBarcode(context, ref, card.number);
      if (product != null) {
        final ring = onScannedProduct;
        if (ring != null) {
          await ring(product);
        } else if (context.mounted) {
          // Scanned from a screen with no bill on it — Reports, Settings. The
          // product is real and was found; there is simply nothing to put it
          // on, and saying so beats a scan that appears to do nothing.
          PosMessenger.info(
            context,
            '${product.name} — go to the sale screen to ring it up.',
          );
        }
        return;
      }
      // handleScannedBarcode has already had its say wherever it offered to
      // create the product. Only a scan that is neither a card nor a product,
      // and that the clerk declined to add, reaches here.
      if (!context.mounted) return;
      await _explain(
        context,
        title: 'Not a card or a product',
        message:
            'That reads ${card.number}. It does not start with any of this '
            'venue\'s card prefixes and no product carries it as a barcode. '
            'The reader is working.\n\nCard prefixes are set in the back '
            'office under Cards; a barcode is set on the product itself.',
      );
  }
}

// -----------------------------------------------------------------------------
// The gym door
// -----------------------------------------------------------------------------

/// A gym card was swiped.
///
/// Three things happen and none of them waits for anybody: the door is told,
/// the answer is painted, and an expired membership prints a slip.
///
/// NOTHING IN HERE MAY THROW OR BLOCK. There is no member of staff at this
/// till to read an exception, and a member standing at a door in front of a
/// screen that says nothing will swipe again, and again, and then go and find
/// somebody. `GymRepository.swipe` is written not to throw; the print below is
/// wrapped because a printer is a piece of hardware that fails, and a jammed
/// roll must never be the reason a paying member cannot get into the gym.
Future<void> _gymCard(
  BuildContext context,
  WidgetRef ref,
  SwipedCard card,
) async {
  final gym = ref.read(gymRepositoryProvider);
  final answer = await gym.swipe(card.number);
  if (!answer.speaks) return;

  // Painted first, before the printer is touched. A slip takes a second or two
  // to come out of an 80mm printer and the member is standing there now.
  ref
      .read(gymGreetingProvider.notifier)
      .show(answer, seconds: gym.settings.greetingSeconds);

  if (!answer.printSlip) return;
  if (!context.mounted) return;

  try {
    final printers = await ref.read(printerSettingsProvider.future);
    final branding = ref.read(brandingProvider);
    final service = PrintService(
      await ReceiptBuilder.create(paperWidthMm: printers.receiptWidthMm),
      PrinterSetup(
        printers: printers,
        shopName: branding.venueName.isNotEmpty
            ? branding.venueName
            : ref.read(sessionProvider).venueName,
        footer: branding.footerMessage,
        logo: branding.showLogo ? branding.logoBytes : null,
      ),
    );
    await service.printGymExpirySlip(
      memberName: answer.memberName ?? 'Unknown member',
      memberNumber: answer.memberNo?.toString(),
      cardNumber: card.number,
      expiredOn: answer.membershipExpiry,
      daysAgo: answer.expiredDays,
      refused: answer.refused,
    );
  } on Object catch (_) {
    // Swallowed, and this is the one place in this file where that is right.
    // The member has already been let in and their visit recorded; a printer
    // with no paper in it has cost the venue a notification, not the door. The
    // same expiry is on the Gym page and in the back office, which is where
    // somebody looks when the slips stop appearing.
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

  final apiBase = ref.read(apiBaseProvider);

  // The same person, in the shape the membership dialogs and the gate read.
  // Named `profile` rather than `card`, because `card` in this function is the
  // piece of plastic that was swiped.
  final profile = ExpiredMember.fromLoyalty(member);

  if (orderId == null) {
    // The face, even with no bill open. A clerk swiping a card at a locked
    // till is usually answering "is this yours?", and the photograph is the
    // whole answer.
    await showMemberOnBill(
      context,
      member: profile,
      apiBase: apiBase,
      footnote: profile.membershipExpired
          ? 'This membership has run out. Open a bill and swipe again to '
                'renew it.'
          : 'Open a bill and swipe again to put them on it.',
    );
    return;
  }

  // ---- An expired card cannot be used ------------------------------------
  //
  // Through the shared gate, which is where the whole of this used to live.
  // "If a customer has expired, they can still use the loyalty card on the
  // till" was true because the check was HERE and only here: a clerk who
  // picked the same person off the Customer key met nothing at all. See
  // ui/membership_gate.dart.
  final gate = await checkMembership(
    context,
    ref,
    orderId: orderId,
    member: profile,
  );
  if (!context.mounted) return;
  if (gate == MembershipGate.refused) {
    sayMembership(context, gate, member: profile);
    return;
  }

  await ref
      .read(orderRepositoryProvider)
      .attachCustomer(
        orderId,
        id: member.id,
        name: member.name,
        // Renewing is happening on this bill, so the expiry it currently
        // carries is the one being replaced. Passing it would have the
        // repository refuse the very attach the clerk has just paid for.
        membershipExpiry: gate == MembershipGate.renewing
            ? null
            : member.membershipExpiry,
        // Their standing discount comes with them, which is the whole reason a
        // card is worth swiping before the round is rung rather than after.
        discountType: member.discountType,
        discountValue: member.discountValue,
        pointsBalance: member.pointsBalance,
      );

  if (!context.mounted) return;

  if (gate == MembershipGate.renewing) {
    sayMembership(context, gate, member: profile);
    return;
  }
  // PosMessenger rather than a SnackBar. A bar rises from the bottom of the
  // screen, which on this till is where PAY and the action strip are — see
  // widgets/pos_message.dart for the tap it swallowed.
  // A face, where the venue has taken one.
  //
  // "Ability to upload a photo of a customer that would display on the till
  // when scanned to confirm it's the right person." Shown as a card the clerk
  // dismisses rather than a toast that fades, because the whole point is that
  // somebody looks at it and decides — a photograph that has gone by the time
  // you have looked up has confirmed nothing.
  //
  // Only where there IS one. A venue that has photographed nobody gets exactly
  // what it got before: a line along the bottom and no interruption. Uploading
  // a photograph is how a venue opts into being asked to check.
  if (member.photoUrl != null) {
    await showMemberOnBill(
      context,
      member: profile,
      apiBase: apiBase,
      footnote:
          'On this bill'
          '${member.discountType != 'none' && member.discountValue > 0
              ? ' with ${_discount(member)}'
              : ''}.',
    );
    return;
  }

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
          .attachCustomer(
            orderId,
            id: member.id,
            name: member.name,
            // Just enrolled, so there is no membership to have run out.
            membershipExpiry: null,
          );
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
            PosTextField(
              controller: name,
              autofocus: true,
              textCapitalization: TextCapitalization.words,
              decoration: const InputDecoration(labelText: 'Name'),
              submitLabel: 'Next',
            ),
            const SizedBox(height: 12),
            PosTextField(
              controller: phone,
              // Digits, because a phone number is digits and a QWERTY under one
              // is four rows of keys nobody is going to press.
              mode: PosKeyboardMode.number,
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
      title: 'Gift Card ${card.number}',
      message:
          '${_money(gift.balanceMinor)} on the card.\n\n'
          'To spend it, take the payment and choose Gift Card.',
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
