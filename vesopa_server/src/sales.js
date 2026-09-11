/**
 * Writing a completed sale.
 *
 * One function, used by the till's upload (`POST /till/orders` in server.js)
 * and by Vesopa Express when a kiosk payment is captured. A kiosk sale is not a
 * different kind of sale: it is the same order row, the same lines, the same
 * stock movement and the same payment row, so the Z report, the card report,
 * the product report and the Dojo webhook reconciliation all read it from the
 * place they already read everything else. A second writer with its own idea
 * of which columns matter would be a second set of takings.
 *
 * The caller owns the transaction. This writes on the connection it is given
 * and never commits, so a caller that also has to raise a kitchen ticket can
 * make the sale and the ticket one atomic change.
 *
 * Returns { duplicate: true } when the sale is already held -- the order id is
 * the primary key and the insert is IGNORE, so a retried upload changes nothing
 * -- and the caller should roll back and say so.
 */
async function recordSale(conn, order) {
  const [result] = await conn.execute(
    `INSERT IGNORE INTO epos_orders
       (id, email, table_number, clerk_pin, subtotal_minor, discount_minor,
        tax_minor, total_minor, covers, notes, customer_name, session_id,
        closed_at, voucher_code, voucher_minor, service_minor, points_earned,
        points_balance, clerk_name, order_note, gratuity_minor, gratuity_bp,
        gift_card_minor, gift_card_code, deposit_minor, deposit_reference,
        points_redeemed, points_value_minor, promo_minor, customer_id,
        customer_phone, split_group, split_index, split_count, staff_id,
        room_id, terminal)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      order.id,
      order.email || 'default',
      order.table_number ?? null,
      order.clerk_pin ?? null,
      order.subtotal_minor ?? 0,
      order.discount_minor ?? 0,
      order.tax_minor ?? 0,
      order.total_minor ?? 0,
      order.covers ?? null,
      order.notes ?? null,
      order.customer_name ?? null,
      order.session_id ?? null,
      order.closed_at ? new Date(order.closed_at) : null,
      // Receipt context. Older tills do not send these; the defaults keep
      // their sales inserting exactly as before.
      order.voucher_code ?? null,
      order.voucher_minor ?? 0,
      // `service_minor` was the earlier name for the same money; accept both
      // so a till on either version records its service charge.
      order.service_minor ?? order.gratuity_minor ?? 0,
      order.points_earned ?? 0,
      order.points_balance ?? null,
      order.clerk_name ?? null,
      order.order_note ?? null,
      // Commerce: gratuity, held money redeemed, points spent, offers, and
      // which share of a split bill this is.
      order.gratuity_minor ?? 0,
      order.gratuity_bp ?? 0,
      order.gift_card_minor ?? 0,
      order.gift_card_code ?? null,
      order.deposit_minor ?? 0,
      order.deposit_reference ?? null,
      order.points_redeemed ?? 0,
      order.points_value_minor ?? 0,
      order.promo_minor ?? 0,
      order.customer_id ?? null,
      order.customer_phone ?? null,
      order.split_group ?? null,
      order.split_index ?? 0,
      order.split_count ?? 0,
      // Which member of staff was signed on. Grouped by id in reports rather
      // than by clerk_name, which can be edited or duplicated.
      order.staff_id ?? null,
      // Which room the table is in. A table number is only unique within one,
      // so without this two rooms' Table 1 are the same table in every report
      // that groups by it.
      order.room_id ?? null,
      // Which machine took the money. Null from a till on an older build,
      // and left null rather than guessed -- reports show those as Unknown,
      // which is the truth about a sale nobody recorded a terminal for.
      order.terminal ?? null,
    ]
  );

  // Zero rows means we already hold this sale. Report it as a duplicate and do
  // NOT re-insert the lines, or a retry would double the takings.
  if (result.affectedRows === 0) return { duplicate: true };

  // Indexed, so the bill keeps the order it was rung in. The id is a UUID
  // primary key and there is nothing else to sort by -- see
  // schema_screens_modifiers_lines.sql.
  for (const [lineNo, line] of (order.lines || []).entries()) {
    await conn.execute(
      `INSERT INTO epos_order_lines
         (id, order_id, plu_id, name, quantity, unit_price_minor,
          tax_percentage, note, discount_minor, promotion_id, promotion_name,
          added_by, added_at, is_modifier, line_no)
       VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        order.id,
        line.plu_id,
        line.name,
        line.quantity ?? 1,
        line.unit_price_minor,
        line.tax_percentage ?? 0,
        line.note ?? null,
        // What an offer took off this line, so the receipt and the promotion
        // report can both explain the discount.
        line.discount_minor ?? 0,
        line.promotion_id ?? null,
        line.promotion_name ?? null,
        // Who put this item on the bill and when. Null from a till on the
        // previous version, and from any line rung up before staff sign-on was
        // switched on at that venue.
        line.added_by ?? null,
        line.added_at ? new Date(line.added_at) : null,
        // Whether this line hangs off the one above it. A till on the previous
        // version sends neither field, and every one of its lines is an item in
        // its own right -- which is what the defaults say.
        line.is_modifier ? 1 : 0,
        lineNo,
      ]
    );
  }

  // --------------------------------------------------------------------------
  // Take what was sold off the shelf
  // --------------------------------------------------------------------------
  //
  // Nothing did this. `stock_quantity` was written by the product editor and by
  // the importer, read by the reports, and never moved by a sale -- so a venue
  // counting stock in and then selling all week saw the same number it typed on
  // Monday. Reported as "order completed, stock should decrease. Why not
  // decreasing?", and the answer was that no code anywhere did it.
  //
  // WHY IT IS HERE
  //
  // Inside the same transaction as the lines, and after the duplicate check
  // above. That check returns early on a sale we already hold, so a till
  // retrying a sync cannot take the same items off twice -- which is the one way
  // an automatic stock movement does real damage.
  //
  // WHAT IT LEAVES ALONE
  //
  //   * Products with a NULL stock_quantity. Null means "not counted" and is the
  //     default for most of a catalogue: a pub does not track pints of lager as
  //     units. Only a product somebody has actually put a number on is moved.
  //   * Modifier lines. "Extra sausage" is a line on the bill and generally not
  //     a product with its own shelf; when it is, it has its own PLU and is rung
  //     as an item.
  //
  // It is allowed to go negative rather than clamping at zero. A negative count
  // is how a venue finds out the shelf was wrong, and silently stopping at zero
  // hides exactly the discrepancy this exists to surface.
  //
  // The same account the sale was filed under. `order.email` is the venue, and
  // 'default' is what a till on an older build sends -- both are already used
  // for the order row above, and stock has to be scoped identically or one
  // venue's sale moves another venue's shelf.
  const stockOwner = order.email || 'default';
  for (const line of order.lines || []) {
    if (line.is_modifier) continue;
    const qty = Number(line.quantity ?? 1);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    await conn.execute(
      `UPDATE bo_products
          SET stock_quantity = stock_quantity - ?
        WHERE email = ? AND pluid = ? AND stock_quantity IS NOT NULL`,
      [qty, stockOwner, line.plu_id]
    );
  }

  for (const payment of order.payments || []) {
    await conn.execute(
      `INSERT INTO epos_payments
         (id, order_id, method, amount_minor, cash_breakdown,
          reference, gratuity_minor, entry_mode)
       VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?)`,
      [
        order.id,
        payment.method,
        payment.amount_minor,
        // Which notes were handed over, when the clerk counted them in on the
        // till's cash keys. Null for card and for keyed-in cash.
        payment.cash_breakdown ?? null,
        // The acquirer's own id for this payment -- Dojo's paymentIntentId. The
        // column has existed since schema_commerce.sql but nothing ever wrote
        // it, which left every card sale unlinkable to the acquirer: no matched
        // refund, and no way for a Dojo webhook to find the sale it is talking
        // about. Null for cash.
        payment.reference ?? null,
        payment.gratuity_minor ?? 0,
        // 'terminal' | 'manual' | 'hosted' | 'native' -- a keyed card carries
        // different interchange and different liability from a dipped one, and
        // the card report has to be able to tell them apart.
        payment.entry_mode ?? null,
      ]
    );
  }

  return { duplicate: false };
}

module.exports = { recordSale };
