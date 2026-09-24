/// Taking a membership fee at the till, and moving the date on afterwards.
///
/// WHY THE FEE IS A LINE ON THE BILL AND NOT A SEPARATE PAYMENT
///
/// "We should be allowed to renew and take their membership fee at the till."
/// Ten pounds taken outside the sale is ten pounds the Z report has never heard
/// of: no VAT treatment, no department, nothing to reconcile the drawer
/// against. So it is rung up like anything else and goes through tendering with
/// the rest of the bill.
///
/// WHY THE DATE MOVES ONLY ONCE THE BILL IS PAID
///
/// A renewal recorded when the clerk presses the key is a renewal a voided bill
/// leaves behind: the member walks away, the sale is cancelled, and the card
/// works for another year. It is posted from the settle path instead, beside
/// the loyalty points, which is the same rule for the same reason.
///
/// HOW THE BILL REMEMBERS
///
/// By the line itself, carrying [membershipRenewalPlu]. Not by a variable held
/// somewhere: a bill can be parked on a table, picked up on a second terminal
/// and paid an hour later, and anything held in memory would have been the
/// money taken and the membership silently not renewed.
library;

import 'local/database.dart';

/// The PLU a membership renewal is rung up under when the venue has not named
/// a product for it.
///
/// Negative, so it cannot collide with a catalogue PLU — those are positive
/// everywhere, and the back office will not accept one that is not.
const membershipRenewalPlu = -1;

/// What a renewal line is called when it is not a real product.
const membershipRenewalName = 'Membership renewal';

/// The product a renewal is rung up as.
///
/// A venue that names a PLU in the back office gets that product, with its own
/// VAT rate, its own department and its own line in the Z report — which is the
/// answer, because a membership fee's VAT treatment is the venue's to decide
/// and cannot be guessed from an amount.
///
/// A venue that names nothing gets a plain line at the configured fee with no
/// VAT on it. That is stated on the settings page rather than left to be
/// discovered, and it is deliberately not a guess at 20%: a till that invents a
/// VAT rate is a till that misstates a return.
Product membershipProduct({
  required int feeMinor,
  int? plu,
  Product? named,
}) {
  if (named != null) return named;
  return Product(
    pluId: plu != null && plu > 0 ? plu : membershipRenewalPlu,
    name: membershipRenewalName,
    priceMinor: feeMinor,
    taxPercentage: 0,
    stockQuantity: 0,
    printToReceipt: true,
    isModifier: false,
    // True, and it matters: this line IS the renewal when a venue has ticked
    // no product of its own, so the settle path has to be able to recognise it
    // on a bill picked up an hour later on another terminal.
    renewsMembership: true,
  );
}

/// The PLUs that renew a membership when they are paid for.
///
/// "Set a check box on a product (Renews membership)." Built from the till's
/// own catalogue, which carries the flag from 1.6.9.0 onward, plus two things
/// that are not in it:
///
///   * [membershipRenewalPlu], the sentinel a plain fee line is rung under
///     when the venue has named no product at all;
///   * [legacyPlu], the single PLU the loyalty settings used to name. A till
///     talking to a back office that has not been updated yet still gets that
///     setting and nothing else, and must go on renewing on it.
///
/// A set rather than one number, which is the whole change: a club sells full,
/// concession, junior and social memberships, and those are four products with
/// four prices, four VAT treatments and one meaning.
Set<int> renewingPlus(Iterable<Product> catalogue, {int? legacyPlu}) => {
  membershipRenewalPlu,
  if (legacyPlu != null && legacyPlu > 0) legacyPlu,
  for (final p in catalogue)
    if (p.renewsMembership) p.pluId,
};

/// Whether any of a bill's lines renews a membership.
///
/// [renewing] is what [renewingPlus] built. Read off the LINES rather than off
/// anything held in memory, because a bill can be started on one terminal,
/// parked on a table, picked up on another and paid an hour later — and a
/// variable on a page does not travel with it.
bool billRenewsMembership(
  Iterable<OrderLine> lines, {
  required Set<int> renewing,
}) => lines.any((l) => renewing.contains(l.pluId));
