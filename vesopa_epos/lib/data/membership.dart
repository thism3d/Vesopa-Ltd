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
  );
}

/// Whether any of a bill's lines is a membership renewal.
///
/// Matched on the name as well as the PLU, because a venue that has named its
/// own product for the fee rings that product's own PLU — so the marker cannot
/// be the number alone. [plu] is the venue's setting, read from the same
/// loyalty settings the fee came from.
bool billRenewsMembership(Iterable<OrderLine> lines, {int? plu}) => lines.any(
  (l) =>
      l.pluId == membershipRenewalPlu ||
      (plu != null && plu > 0 && l.pluId == plu),
);
