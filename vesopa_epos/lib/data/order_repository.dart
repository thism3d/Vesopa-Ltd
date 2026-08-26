import 'dart:convert';

import 'package:drift/drift.dart';
import 'package:uuid/uuid.dart';

import 'local/database.dart';
import 'mix_match_engine.dart';
import 'modifier_layout.dart';

/// Owns the sale lifecycle. Every write lands in the local database first and
/// is queued for the server second, both inside one transaction: the till is
/// authoritative for its own sales and never blocks on the network.
class OrderRepository {
  OrderRepository(this._db);

  final AppDatabase _db;
  static const _uuid = Uuid();

  Future<String> openOrder({
    int? tableNumber,
    int? roomId,
    String? clerkPin,
  }) async {
    final id = _uuid.v4();
    await _db.into(_db.orders).insert(
          OrdersCompanion.insert(
            id: id,
            tableNumber: Value(tableNumber),
            roomId: Value(roomId),
            clerkPin: Value(clerkPin),
          ),
        );
    return id;
  }

  /// Ring an item. Tapping the same product again bumps the quantity of the
  /// existing line rather than adding a second one, which is what the receipt
  /// is expected to show ("2x - £2.4").
  ///
  /// [addedBy] is the member of staff signed on at the time. A repeat tap that
  /// merges into an existing line does *not* reassign it: the line belongs to
  /// whoever first put it on the bill, and a colleague adding a second round to
  /// somebody else's line should not take the whole line's authorship with it.
  /// Where that matters — a table two people served — the second round lands on
  /// its own line anyway, because the merge only fires within one visit to the
  /// screen.
  ///
  /// [modifiers] are the answers the operator gave to the questions this
  /// product asks — the mixer with the gin, how the steak is cooked. Each one
  /// goes in as its own order line pointing back at this one, so it prices,
  /// taxes, prints and reports as what it is. A product carrying answers is
  /// never merged into an existing line; see below.
  /// See OrderLines.parentLineId.
  Future<void> addLine(
    String orderId,
    Product product, {
    double qty = 1,
    String? addedBy,
    List<Product> modifiers = const [],
  }) async {
    await _db.transaction(() async {
      final now = DateTime.now();

      // A product with answers on it is never merged into an existing line.
      // Two gins are one line at quantity 2; a gin with coke and a gin with
      // tonic are two different things that happen to share a PLU, and adding
      // the second to the first would quietly change what the first customer
      // ordered.
      final line = modifiers.isEmpty
          ? await _mergeableLine(orderId, product.pluId)
          : null;

      if (line != null) {
        await (_db.update(_db.orderLines)..where((l) => l.id.equals(line.id)))
            .write(OrderLinesCompanion(quantity: Value(line.quantity + qty)));
        await recalculate(orderId);
        return;
      }

      final parentId = _uuid.v4();
      await _db.into(_db.orderLines).insert(
            OrderLinesCompanion.insert(
              id: parentId,
              orderId: orderId,
              pluId: product.pluId,
              name: product.name,
              quantity: Value(qty),
              // Snapshot the price: a later back-office edit must not restate
              // takings that have already been rung up.
              unitPriceMinor: product.priceMinor,
              taxPercentage: Value(product.taxPercentage),
              // Who rang it and when. Null on a venue that does not use staff
              // sign-on, and the check view simply shows no header for it.
              addedBy: Value(addedBy),
              addedAt: Value(now),
            ),
          );

      for (final choice in modifiers) {
        await _db.into(_db.orderLines).insert(
              OrderLinesCompanion.insert(
                id: _uuid.v4(),
                orderId: orderId,
                pluId: choice.pluId,
                name: choice.name,
                // One per parent unit: two double gins want two dashes of coke,
                // and a kitchen reading "2 Steak / 1 Rare" cannot tell which
                // steak is which.
                quantity: Value(qty),
                unitPriceMinor: choice.priceMinor,
                taxPercentage: Value(choice.taxPercentage),
                parentLineId: Value(parentId),
                addedBy: Value(addedBy),
                addedAt: Value(now),
              ),
            );
      }

      await recalculate(orderId);
    });
  }

  /// The line this product could be added to, or null if it must start a new
  /// one.
  ///
  /// Only ever a line of its own — never a modifier — and never one that
  /// already carries answers, for the reason given in [addLine].
  Future<OrderLine?> _mergeableLine(String orderId, int pluId) async {
    final candidates = await (_db.select(_db.orderLines)
          ..where((l) =>
              l.orderId.equals(orderId) &
              l.pluId.equals(pluId) &
              l.parentLineId.isNull()))
        .get();
    if (candidates.isEmpty) return null;

    final parents = await _linesWithChildren(orderId);
    for (final line in candidates) {
      if (!parents.contains(line.id)) return line;
    }
    return null;
  }

  /// The ids of lines on this order that have modifiers hanging off them.
  Future<Set<String>> _linesWithChildren(String orderId) async {
    final rows = await (_db.select(_db.orderLines)
          ..where((l) => l.orderId.equals(orderId) & l.parentLineId.isNotNull()))
        .get();
    final ids = <String>{};
    for (final row in rows) {
      final id = row.parentLineId;
      if (id != null) ids.add(id);
    }
    return ids;
  }

  /// Every line id that must go when [lineIds] go: the lines themselves, plus
  /// the modifiers hanging off them.
  ///
  /// A modifier without its parent is a line reading "Dash Coke £0.50" that
  /// nobody can account for, and — worse — one the kitchen would still be told
  /// about. Anything that removes a line goes through here.
  Future<Set<String>> _withModifiers(String orderId, Set<String> lineIds) async {
    if (lineIds.isEmpty) return lineIds;
    final rows = await (_db.select(_db.orderLines)
          ..where((l) => l.orderId.equals(orderId) & l.parentLineId.isNotNull()))
        .get();
    return {
      ...lineIds,
      for (final row in rows)
        if (lineIds.contains(row.parentLineId)) row.id,
    };
  }

  /// Note that the drawer was opened without a sale — the No Sale key.
  ///
  /// Counted rather than valued: the amount is always zero, and the number of
  /// times it happened is the whole point. Beside the void count on the Z
  /// report because they are read together and for the same reason.
  Future<void> logNoSale({required String sessionId, String? staffName}) =>
      _logEvent(kind: 'no_sale', sessionId: sessionId, staffName: staffName);

  /// Record something that is not a sale but belongs on the Z report.
  ///
  /// Kept locally and never deleted by the sync, unlike the outbox entry beside
  /// it — see TillEvents for why that mattered.
  Future<void> _logEvent({
    required String kind,
    required String sessionId,
    int amountMinor = 0,
    String? note,
    String? staffName,
  }) async {
    await _db.into(_db.tillEvents).insert(
          TillEventsCompanion.insert(
            id: _uuid.v4(),
            sessionId: sessionId,
            kind: kind,
            amountMinor: Value(amountMinor),
            note: Value(note),
            staffName: Value(staffName),
          ),
        );
  }

  /// Void selected lines off an open check, leaving the rest of the sale alone.
  ///
  /// This is the everyday correction — a mis-rung item — as distinct from
  /// [voidOrder], which cancels the whole check. It is audited just as tightly:
  /// a clerk who can quietly remove one £40 line from a bill is a clerk who can
  /// pocket £40, so the reason, the amount and *which items* are logged.
  ///
  /// Returns the value removed, in pence.
  Future<int> voidLines(
    String orderId, {
    required Set<String> lineIds,
    required String reason,
  }) async {
    if (lineIds.isEmpty) return 0;

    return _db.transaction(() async {
      final order =
          await (_db.select(_db.orders)..where((o) => o.id.equals(orderId)))
              .getSingle();
      // A modifier cannot survive the item it modifies: "Dash Coke" left on a
      // bill whose gin was voided is a line nobody can account for, and one the
      // kitchen would still be told about. Valued with the rest, so the void
      // log shows what the bill actually lost.
      final doomed = await _withModifiers(orderId, lineIds);
      final lines = await (_db.select(_db.orderLines)
            ..where((l) => l.orderId.equals(orderId) & l.id.isIn(doomed)))
          .get();
      if (lines.isEmpty) return 0;

      // Value the lines *before* deleting them — afterwards the figure is gone,
      // which is the same reason voidOrder logs first and clears second.
      var amount = 0;
      for (final line in lines) {
        amount += (line.unitPriceMinor * line.quantity).round() -
            line.lineDiscountMinor;
      }

      // A short human summary, so the void log reads "2x Flat White" rather
      // than a bare amount a manager cannot investigate.
      final summary = lines
          .map((l) => '${_qtyLabel(l.quantity)}x ${l.name}')
          .join(', ');

      await _db.into(_db.outboxEntries).insert(
            OutboxEntriesCompanion.insert(
              id: _uuid.v4(),
              entity: 'void',
              entityId: orderId,
              payload: jsonEncode({
                'id': _uuid.v4(),
                'order_id': orderId,
                'clerk_pin': order.clerkPin,
                'reason': reason,
                'items': summary.length > 500
                    ? '${summary.substring(0, 497)}...'
                    : summary,
                'scope': 'item',
                'amount_minor': amount,
                'voided_at': DateTime.now().toIso8601String(),
              }),
            ),
          );

      // Counted on the Z report. The outbox row beside this one is deleted the
      // moment the server takes it, so it cannot be the thing a manager's
      // end-of-day void figure is read from.
      await _logEvent(
        kind: 'void',
        sessionId: order.sessionId ?? '',
        amountMinor: amount,
        note: '$reason — $summary',
        staffName: order.staffName,
      );

      await (_db.delete(_db.orderLines)..where((l) => l.id.isIn(doomed))).go();
      await recalculate(orderId);
      return amount;
    });
  }

  static String _qtyLabel(double q) =>
      q % 1 == 0 ? q.toStringAsFixed(0) : q.toStringAsFixed(2);

  /// Clear the sale without taking money. Nothing is queued for the server:
  /// a voided order was never a sale.
  ///
  /// A [reason] is required and logged to the server via the outbox, so a void
  /// is always explainable after the fact — otherwise it is a way to make
  /// takings vanish without a trace.
  Future<void> voidOrder(String orderId, {required String reason}) async {
    await _db.transaction(() async {
      final order =
          await (_db.select(_db.orders)..where((o) => o.id.equals(orderId)))
              .getSingle();

      // Queue the audit record first, with the amount that was on the bill —
      // after we zero it, that figure is gone. Only a bill that had something
      // on it is worth logging.
      if (order.totalMinor > 0) {
        await _db.into(_db.outboxEntries).insert(
              OutboxEntriesCompanion.insert(
                id: _uuid.v4(),
                entity: 'void',
                entityId: orderId,
                payload: jsonEncode({
                  'id': _uuid.v4(),
                  'order_id': orderId,
                  'clerk_pin': order.clerkPin,
                  'reason': reason,
                  'scope': 'sale',
                  'amount_minor': order.totalMinor,
                  'voided_at': DateTime.now().toIso8601String(),
                }),
              ),
            );

        // And durably, for the Z report — the outbox entry above does not
        // survive its own delivery.
        await _logEvent(
          kind: 'void',
          sessionId: order.sessionId ?? '',
          amountMinor: order.totalMinor,
          note: '$reason — whole bill',
          staffName: order.staffName,
        );
      }

      await (_db.delete(_db.orderLines)..where((l) => l.orderId.equals(orderId)))
          .go();
      await (_db.update(_db.orders)..where((o) => o.id.equals(orderId))).write(
        const OrdersCompanion(
          status: Value('void'),
          subtotalMinor: Value(0),
          manualDiscountMinor: Value(0),
          discountMinor: Value(0),
          taxMinor: Value(0),
          totalMinor: Value(0),
        ),
      );
    });
  }

  /// The deals defined in the back office, with the products that qualify.
  Future<MixMatchEngine> mixMatch() async {
    final deals = await (_db.select(_db.mixMatchDeals)
          ..where((d) => d.active.equals(true)))
        .get();
    if (deals.isEmpty) return const MixMatchEngine([], {});

    final links = await _db.select(_db.mixMatchProducts).get();
    final membership = <int, Set<int>>{};
    for (final link in links) {
      membership.putIfAbsent(link.dealId, () => {}).add(link.pluId);
    }
    return MixMatchEngine(deals, membership);
  }

  /// What the deals are saving on this bill, for the basket to show.
  Future<MixMatchResult> dealsOn(String orderId) async {
    final lines = await (_db.select(_db.orderLines)
          ..where((l) => l.orderId.equals(orderId)))
        .get();
    return (await mixMatch()).apply(lines);
  }

  /// A discount keyed in by the clerk. Recorded separately from the automatic
  /// deal savings so the two never compound.
  Future<void> applyDiscount(String orderId, int discountMinor) async {
    await _db.transaction(() async {
      await (_db.update(_db.orders)..where((o) => o.id.equals(orderId)))
          .write(OrdersCompanion(manualDiscountMinor: Value(discountMinor)));
      await recalculate(orderId);
    });
  }

  Future<void> setCovers(String orderId, int covers) =>
      (_db.update(_db.orders)..where((o) => o.id.equals(orderId)))
          .write(OrdersCompanion(covers: Value(covers)));

  Future<void> setNotes(String orderId, String notes) =>
      (_db.update(_db.orders)..where((o) => o.id.equals(orderId)))
          .write(OrdersCompanion(notes: Value(notes)));

  /// Attach a customer to the sale, carrying their standing discount so it
  /// applies to the total automatically.
  Future<void> attachCustomer(
    String orderId, {
    required String? id,
    required String name,
    String discountType = 'none',
    int discountValue = 0,
  }) async {
    await _db.transaction(() async {
      await (_db.update(_db.orders)..where((o) => o.id.equals(orderId))).write(
        OrdersCompanion(
          customerId: Value(id),
          customerName: Value(name),
          customerDiscountType: Value(discountType),
          customerDiscountValue: Value(discountValue),
        ),
      );
      await recalculate(orderId);
    });
  }

  /// Remove the attached customer and their discount.
  Future<void> clearCustomer(String orderId) async {
    await _db.transaction(() async {
      await (_db.update(_db.orders)..where((o) => o.id.equals(orderId))).write(
        const OrdersCompanion(
          customerId: Value(null),
          customerName: Value(null),
          customerDiscountType: Value('none'),
          customerDiscountValue: Value(0),
        ),
      );
      await recalculate(orderId);
    });
  }

  /// Move a bill onto a table. [roomId] is which room that table is in — see
  /// Orders.roomId, without which two rooms' Table 1 share one bill.
  Future<void> setTable(String orderId, int tableNumber, {int? roomId}) =>
      (_db.update(_db.orders)..where((o) => o.id.equals(orderId)))
          .write(OrdersCompanion(
            tableNumber: Value(tableNumber),
            roomId: Value(roomId),
          ));

  Future<void> removeLine(String orderId, String lineId) async {
    await _db.transaction(() async {
      final doomed = await _withModifiers(orderId, {lineId});
      await (_db.delete(_db.orderLines)..where((l) => l.id.isIn(doomed))).go();
      await recalculate(orderId);
    });
  }

  /// Set an exact quantity on a line. Zero removes it, so the clerk can clear a
  /// line by keying 0 rather than hunting for a delete.
  Future<void> setLineQuantity(
    String orderId,
    String lineId,
    double quantity,
  ) async {
    await _db.transaction(() async {
      if (quantity <= 0) {
        final doomed = await _withModifiers(orderId, {lineId});
        await (_db.delete(_db.orderLines)..where((l) => l.id.isIn(doomed))).go();
      } else {
        // The parent and everything hanging off it. A modifier is one per unit
        // of what it modifies, so three steaks are three "rare" — a kitchen
        // reading "3 Steak / 1 Rare" cannot tell which steak is which.
        final family = await _withModifiers(orderId, {lineId});
        await (_db.update(_db.orderLines)..where((l) => l.id.isIn(family)))
            .write(OrderLinesCompanion(quantity: Value(quantity)));
      }
      await recalculate(orderId);
    });
  }

  /// Nudge a line up or down by one. Removing the last one clears the line.
  Future<void> stepLineQuantity(
    String orderId,
    String lineId,
    double delta,
  ) async {
    final line =
        await (_db.select(_db.orderLines)..where((l) => l.id.equals(lineId)))
            .getSingle();
    await setLineQuantity(orderId, lineId, line.quantity + delta);
  }

  Future<void> setLineNote(String lineId, String? note) =>
      (_db.update(_db.orderLines)..where((l) => l.id.equals(lineId)))
          .write(OrderLinesCompanion(notes: Value(note)));

  Future<void> setLineDiscount(String orderId, String lineId, int minor) async {
    await _db.transaction(() async {
      await (_db.update(_db.orderLines)..where((l) => l.id.equals(lineId)))
          .write(OrderLinesCompanion(lineDiscountMinor: Value(minor)));
      await recalculate(orderId);
    });
  }

  /// What the attached customer's standing discount comes to on [grossMinor].
  ///
  /// Public and static because three places need the same answer — the stored
  /// totals, the sale screen's receipt, and the payment screen's tender maths.
  /// When they each worked it out for themselves, two of them worked it out as
  /// zero and the customer was charged the undiscounted bill.
  static int customerDiscountOn(Order order, int grossMinor) =>
      switch (order.customerDiscountType) {
        'percent' => (grossMinor * order.customerDiscountValue / 100).round(),
        'amount' => order.customerDiscountValue,
        _ => 0,
      };

  /// Recompute the stored totals from the lines. Totals are derived once and
  /// stored, so a reprint or an end-of-day report never disagrees with what the
  /// customer was actually charged. Public because splitting and merging bills
  /// move lines between orders and must restate both.
  Future<void> recalculate(String orderId) async {
    final lines = await (_db.select(_db.orderLines)
          ..where((l) => l.orderId.equals(orderId)))
        .get();
    final order =
        await (_db.select(_db.orders)..where((o) => o.id.equals(orderId)))
            .getSingle();

    // Gross is what the customer is asked for; the mockup's "Subtotal" is that
    // figure, with VAT shown as the portion already inside it.
    var gross = 0;
    var lineDiscounts = 0;
    for (final line in lines) {
      gross += (line.unitPriceMinor * line.quantity).round();
      // A per-line discount can never exceed that line's own value.
      final lineTotal = (line.unitPriceMinor * line.quantity).round();
      lineDiscounts += line.lineDiscountMinor.clamp(0, lineTotal);
    }

    // Mix & match deals from the back office. These are a discount the till
    // works out, on top of the per-line and order-level ones the clerk keyed.
    final dealSaving = (await mixMatch()).apply(lines).totalSavingMinor;

    // The attached customer's standing discount, on the gross.
    final customerDiscount = customerDiscountOn(order, gross);

    // A discount can never take the bill below zero.
    final discount = (order.manualDiscountMinor +
            dealSaving +
            lineDiscounts +
            customerDiscount)
        .clamp(0, gross);
    final payable = gross - discount;

    // Prices are tax-inclusive, so back the VAT out of the discounted total
    // rather than adding it on top — otherwise the customer is charged twice,
    // and the tax must follow the amount actually taken, not the pre-discount
    // figure, or the VAT return overstates what was collected.
    var tax = 0;
    for (final line in lines) {
      final lineGross = (line.unitPriceMinor * line.quantity).round();
      final share = gross == 0 ? 0.0 : lineGross / gross;
      final lineNet = payable * share;
      tax += (lineNet - lineNet / (1 + line.taxPercentage / 100)).round();
    }

    await (_db.update(_db.orders)..where((o) => o.id.equals(orderId))).write(
      OrdersCompanion(
        subtotalMinor: Value(gross),
        discountMinor: Value(discount),
        taxMinor: Value(tax),
        totalMinor: Value(payable),
      ),
    );
  }

  /// Total taken against an order so far, across all tenders.
  Future<int> amountPaid(String orderId) async {
    final rows = await (_db.select(_db.payments)
          ..where((p) => p.orderId.equals(orderId)))
        .get();
    return rows.fold<int>(0, (sum, p) => sum + p.amountMinor);
  }

  /// The tenders taken against an order — for printing the receipt.
  Future<List<Payment>> paymentsFor(String orderId) =>
      (_db.select(_db.payments)..where((p) => p.orderId.equals(orderId))).get();

  /// Record a tender. The sale only closes — and is only queued for the server
  /// — once it is fully paid, so a split payment does not book a half-paid
  /// order as complete.
  ///
  /// [sessionId] is the trading period the takings fall into; it is stamped at
  /// settlement rather than at open, so a bill parked across a Z report counts
  /// in the session where it was actually paid.
  ///
  /// [staffId] and [staffName] are the member of staff who took the money, for
  /// the same reason and stamped at the same moment.
  /// [reference] is the acquirer's own id for a card payment — Dojo's
  /// `paymentIntentId`. It is what makes a refund, a webhook and a chargeback
  /// enquiry all able to find this sale, so a card tender that arrives without
  /// one is worth noticing rather than quietly accepting.
  Future<void> settle(
    String orderId,
    String method,
    int amountMinor, {
    String? sessionId,
    String? cashBreakdown,
    int? staffId,
    String? staffName,
    String? reference,
    int gratuityMinor = 0,
    String? entryMode,
  }) async {
    await _db.transaction(() async {
      await _db.into(_db.payments).insert(
            PaymentsCompanion.insert(
              id: _uuid.v4(),
              orderId: orderId,
              method: method,
              amountMinor: amountMinor,
              // Which notes were handed over, when the clerk counted them in
              // on the cash keys. Null for everything else.
              cashBreakdown: Value(cashBreakdown),
              // The acquirer's id for this payment, and how the card was
              // taken. Null for cash, which has neither.
              reference: Value(reference),
              gratuityMinor: Value(gratuityMinor),
              entryMode: Value(entryMode),
            ),
          );

      final order =
          await (_db.select(_db.orders)..where((o) => o.id.equals(orderId)))
              .getSingle();
      final paid = await amountPaid(orderId);
      if (paid < order.totalMinor) return;

      await (_db.update(_db.orders)..where((o) => o.id.equals(orderId))).write(
        OrdersCompanion(
          status: const Value('closed'),
          closedAt: Value(DateTime.now()),
          sessionId: Value(sessionId),
          staffId: Value(staffId),
          staffName: Value(staffName),
        ),
      );

      await _enqueue(orderId);
    });
  }

  /// Queue the finished sale for the server. Written in the caller's
  /// transaction: if this fails, the settlement rolls back with it, so a sale
  /// can never be committed locally yet lost to sync.
  Future<void> _enqueue(String orderId) async {
    final order = await (_db.select(_db.orders)..where((o) => o.id.equals(orderId)))
        .getSingle();
    final lines = await (_db.select(_db.orderLines)
          ..where((l) => l.orderId.equals(orderId)))
        .get();
    final payments = await (_db.select(_db.payments)
          ..where((pay) => pay.orderId.equals(orderId)))
        .get();

    final payload = jsonEncode({
      'id': order.id,
      'table_number': order.tableNumber,
      // Which room that table is in: a number alone is ambiguous in any
      // venue with two floors.
      'room_id': order.roomId,
      'clerk_pin': order.clerkPin,
      'subtotal_minor': order.subtotalMinor,
      // Without these the back office reports the gross as if nothing had been
      // discounted, and the bill report shows no covers.
      'discount_minor': order.discountMinor,
      'tax_minor': order.taxMinor,
      'total_minor': order.totalMinor,
      'covers': order.covers,
      'notes': order.notes,
      'customer_name': order.customerName,
      'customer_id': order.customerId,
      'session_id': order.sessionId,
      'closed_at': order.closedAt?.toIso8601String(),
      // Who served it. The server has had a clerk_name column since the receipt
      // work; the till never filled it, so every sale in the back office was
      // attributed to nobody. staff_id is the stable key a report groups by.
      'clerk_name': order.staffName,
      'staff_id': order.staffId,
      // In reading order, each modifier straight after the item it belongs to.
      // The server stores the position and reads it back that way, so a receipt
      // reprinted from history says what the printed one said.
      'lines': [
        for (final l in orderWithModifiers(
          lines,
          idOf: (l) => l.id,
          parentOf: (l) => l.parentLineId,
        ))
          {
            'plu_id': l.pluId,
            // Whether this line hangs off the one above it, which is all a
            // reprint needs in order to indent it. The parent's identity is a
            // till-local uuid and would mean nothing on the server.
            'is_modifier': l.parentLineId != null,
            'name': l.name,
            'quantity': l.quantity,
            'unit_price_minor': l.unitPriceMinor,
            'tax_percentage': l.taxPercentage,
            // The kitchen instruction taken against this item. The server has
            // always had a column for it; the till simply never sent it, so a
            // receipt reprinted from the back office lost every "no ice".
            'note': l.notes,
            // Who put this item on the bill and when, so the back office can
            // answer "who served this table?" per item rather than per sale.
            'added_by': l.addedBy,
            'added_at': l.addedAt?.toIso8601String(),
          },
      ],
      'payments': [
        for (final pay in payments)
          {
            'method': pay.method,
            'amount_minor': pay.amountMinor,
            // Which notes were handed over, so a reprint can reproduce the
            // same breakdown the customer was given at the counter.
            'cash_breakdown': pay.cashBreakdown,
            // The acquirer's own id for this payment. Without it the back
            // office cannot match a Dojo webhook to this sale, and a manager
            // cannot refund it to the original card.
            'reference': pay.reference,
            'gratuity_minor': pay.gratuityMinor,
            'entry_mode': pay.entryMode,
          },
      ],
    });

    await _db.into(_db.outboxEntries).insert(
          OutboxEntriesCompanion.insert(
            id: _uuid.v4(),
            entity: 'order',
            entityId: orderId,
            payload: payload,
          ),
        );
  }

  Stream<List<OrderLine>> watchLines(String orderId) =>
      (_db.select(_db.orderLines)..where((l) => l.orderId.equals(orderId)))
          .watch();

  Stream<Order> watchOrder(String orderId) =>
      (_db.select(_db.orders)..where((o) => o.id.equals(orderId)))
          .watchSingle();
}
