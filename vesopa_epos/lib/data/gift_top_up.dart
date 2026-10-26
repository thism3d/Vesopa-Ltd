/// Selling and topping up a gift card at the till (2026-10-26).
///
/// Pontardawe RFC keeps a rack of printed swipe gift cards. Swiping one that
/// has never been sold used to say "No such gift card". Now the till offers to
/// make it and asks how much; the money is a line on the bill, and once the
/// bill is paid the card is created (if new) and loaded on the server. An
/// existing card can be topped up the same way.
///
/// The line is not a catalogue product: a gift card is money held for later,
/// outside the scope of VAT, so it carries 0% and its own sentinel PLU. Which
/// card it is for travels in the line's note, like a membership plan does, so
/// a bill parked and paid on another terminal still knows.
library;

import 'local/database.dart';

/// Negative, so no catalogue product can have it (see membershipRenewalPlu).
const giftTopUpPlu = -4;

const giftTopUpName = 'Gift card top-up';

/// The note a top-up line carries: `Gift card 98780012 [gift 98780012]`.
String giftTopUpNote(String code) => 'Gift card $code [gift $code]';

final _note = RegExp(r'\[gift ([0-9A-Za-z-]+)\]$');

/// The card a line tops up, or null for every other line.
String? giftTopUpCode(OrderLine line) =>
    line.pluId == giftTopUpPlu ? _note.firstMatch((line.notes ?? '').trim())?.group(1) : null;

/// The line, as a product the bill can carry.
Product giftTopUpProduct(int amountMinor) => Product(
      pluId: giftTopUpPlu,
      name: giftTopUpName,
      priceMinor: amountMinor,
      taxPercentage: 0,
      stockQuantity: 0,
      printToReceipt: true,
      isModifier: false,
      renewsMembership: false,
    );
