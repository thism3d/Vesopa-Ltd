/// The one place an expired membership is stopped.
///
/// WHY THERE IS ONE OF THESE RATHER THAN A CHECK IN EACH DOOR
///
/// "Customer Expiry not working. If a customer has expired, they can still use
/// the loyalty card on the till."
///
/// The check existed. It was in `card_actions.dart`, on the magnetic-stripe
/// path, and nowhere else — so swiping the card stopped you and picking the
/// same person off the Customer key did not. There are four doors onto a bill:
///
///   * a swipe (`ui/card_actions.dart`)
///   * a scan, which lands in the same place when the number matches a card
///     programme
///   * the Customer function key (`ui/sale_page.dart`)
///   * the Customer key on the payment board (`ui/payment_page.dart`)
///
/// Four checks would be four chances to forget, and the fifth door somebody
/// adds next year would be back where we started. So there is one function,
/// every door calls it, and `OrderRepository.attachCustomer` refuses outright
/// if it is bypassed — see the assertion there.
///
/// IT REFUSES BY OFFERING
///
/// The useful thing to do with somebody at the counter holding a card that ran
/// out in March is to take the membership fee off them. Declining leaves
/// nobody on the bill, which is the refusal the venue asked for.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/local/database.dart';
import '../data/membership.dart';
import '../main.dart';
import 'membership_prompt.dart';
// The catalogue as the sale screen watches it, rather than a second stream of
// the same table: the flagged products this reads are the same rows the clerk
// is looking at, and two providers over one query would be two answers during
// a sync.
import 'sale_page.dart' show productsProvider;
import 'widgets/pos_message.dart';

/// What happened at the gate.
enum MembershipGate {
  /// Nothing was wrong: no membership, or one that still runs.
  current,

  /// It had expired and the clerk chose to renew. The fee, if the venue
  /// charges one, is on the bill.
  renewing,

  /// It had expired and the clerk declined. Nobody goes on the bill.
  refused,
}

/// Let this member onto the bill, or refuse them.
///
/// [orderId] is the bill in front of the clerk. Returns what happened, so the
/// caller can say the right thing afterwards — the wording differs between a
/// card swipe and a name picked off a list, and this function is not the place
/// to know which.
///
/// The caller attaches the customer when the answer is anything but
/// [MembershipGate.refused].
Future<MembershipGate> checkMembership(
  BuildContext context,
  WidgetRef ref, {
  required String orderId,
  required ExpiredMember member,
}) async {
  if (!member.membershipExpired) return MembershipGate.current;

  final orders = ref.read(orderRepositoryProvider);
  final catalogue = ref.read(productsProvider).value ?? const <Product>[];

  // The venue's settings. Cached for the life of the till session, and it
  // answers its defaults when the back office cannot be reached — a till that
  // refused to serve a member because it could not read a setting would be a
  // till that stops working when the broadband does.
  final settings =
      await ref.read(commerceRepositoryProvider).membershipSettings();
  if (!context.mounted) return MembershipGate.refused;

  final renewing = renewingPlus(catalogue, legacyPlu: settings.plu);
  final lines = await orders.watchLines(orderId).first;
  if (!context.mounted) return MembershipGate.refused;

  /*
   * THE PRODUCT IS ALREADY ON THE BILL.
   *
   * "If this product is on the check view and expired card is swiped this
   * allows the expired card to pay for the membership for the year and will
   * renew at the till."
   *
   * That is the order a counter actually works in: the clerk rings up the
   * membership, then asks for the card. Asking "would you like to renew?" over
   * a bill that already has the renewal on it would be the till failing to
   * read its own screen — and pressing Renew would put a second fee on.
   *
   * So the swipe simply goes through, and the renewal is posted when the bill
   * settles like any other.
   */
  if (billRenewsMembership(lines, renewing: renewing)) {
    return MembershipGate.renewing;
  }

  final choice = await showExpiredMembership(
    context,
    member: member,
    apiBase: ref.read(apiBaseProvider),
  );
  if (!context.mounted) return MembershipGate.refused;
  if (choice != MembershipChoice.renew) return MembershipGate.refused;

  /*
   * Ring the fee up.
   *
   * A product the venue has ticked, where there is one: the fee then carries
   * that product's VAT rate, its department and its own line in the Z report,
   * and none of those three can be guessed from an amount. Where a venue has
   * ticked nothing, a plain line at the configured fee with no VAT on it —
   * which is stated on the settings page rather than left to be discovered,
   * and is deliberately not a guess at 20%. A till that invents a VAT rate is
   * a till that misstates a return.
   *
   * The cheapest one, when a venue has ticked several. A club with full,
   * concession and junior memberships is choosing between them by price, and
   * the clerk can change the line if this member is not the cheapest sort. The
   * alternative — asking which — is a second dialog in the middle of a queue.
   */
  final flagged = [
    for (final p in catalogue)
      if (p.renewsMembership) p,
  ]..sort((a, b) => a.priceMinor.compareTo(b.priceMinor));

  final product = flagged.isNotEmpty
      ? flagged.first
      : membershipProduct(feeMinor: member.membershipFeeMinor);

  if (product.priceMinor > 0 || flagged.isNotEmpty) {
    await orders.addLine(orderId, product, addedBy: ref.read(servedByProvider));
    if (!context.mounted) return MembershipGate.refused;
  }

  return MembershipGate.renewing;
}

/// Say what happened, in the words that fit where it happened.
///
/// Kept beside the gate so the four doors cannot drift into saying four
/// different things about the same event.
void sayMembership(
  BuildContext context,
  MembershipGate outcome, {
  required ExpiredMember member,
}) {
  switch (outcome) {
    case MembershipGate.refused:
      PosMessenger.info(
        context,
        '${member.name} was not put on this bill — their membership has run '
        'out.',
      );
    case MembershipGate.renewing:
      PosMessenger.success(
        context,
        '${member.name} is on this bill. Their membership '
        '${member.runsToPhrase} once this is paid.',
      );
    case MembershipGate.current:
      break;
  }
}
