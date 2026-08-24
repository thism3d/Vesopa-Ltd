import 'dart:io';

import 'package:drift/drift.dart';
import 'package:drift/native.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

part 'database.g.dart';

/// Catalogue mirrored from the back office. Read-mostly on the terminal:
/// the server owns this data, the till holds a local copy so it can sell
/// while offline. Columns track `bo_products` in vesopa_eposdb.
class Products extends Table {
  IntColumn get pluId => integer()();
  TextColumn get name => text()();
  TextColumn get departmentName => text().nullable()();
  TextColumn get groupName => text().nullable()();
  TextColumn get accountingCode => text().nullable()();

  /// Minor units (pence). Money is never stored as a double.
  IntColumn get priceMinor => integer()();
  RealColumn get taxPercentage => real().withDefault(const Constant(0))();
  RealColumn get stockQuantity => real().withDefault(const Constant(0))();

  /// Where this product sits on the till grid. Null means "unassigned" — it
  /// still appears, just after the positioned ones.
  IntColumn get buttonPosition => integer().nullable()();

  /// Overrides the department colour for this one button.
  TextColumn get buttonColor => text().nullable()();

  /// Which kitchen printers this item routes to, comma-separated station keys
  /// ("kp1,kp3"). Empty or null means it is not sent to a kitchen at all.
  ///
  /// A list rather than one station because a single dish routinely belongs to
  /// two of them — the grill cooks it and the pass plates it, and both need the
  /// ticket. Stored as text because the till only ever reads the whole set.
  TextColumn get printerRoutes => text().nullable()();

  /// Whether this item appears on the customer's receipt.
  ///
  /// Defaults to true, which is what all but a handful of items want. The
  /// exceptions are real though: a kitchen instruction rung up as a product
  /// ("allergy - table 4") belongs on the ticket and nowhere near the bill.
  BoolColumn get printToReceipt =>
      boolean().withDefault(const Constant(true))();

  /// An emoji shown large on the till button, and an optional uploaded image
  /// which takes precedence over the emoji when present.
  TextColumn get emoji => text().nullable()();
  TextColumn get imageUrl => text().nullable()();

  @override
  Set<Column> get primaryKey => {pluId};
}

/// How a category button should look on the till's right-hand rail.
///
/// The category *list* is still derived from the products themselves, so the
/// rail works even before this has ever synced — this only decorates it. That
/// keeps a failed departments pull from emptying the rail and stopping the till
/// selling, which is the whole point of the offline-first design.
class Departments extends Table {
  TextColumn get name => text()();
  TextColumn get emoji => text().nullable()();
  TextColumn get imageUrl => text().nullable()();

  /// Overrides the till's built-in per-name colour.
  TextColumn get buttonColor => text().nullable()();
  IntColumn get sortOrder => integer().withDefault(const Constant(0))();

  @override
  Set<Column> get primaryKey => {name};
}

/// A "buy N of these for £X" deal, defined in the back office and applied to
/// the basket here so the discount shows before the customer pays.
class MixMatchDeals extends Table {
  IntColumn get id => integer()();
  TextColumn get name => text()();
  IntColumn get triggerQty => integer().withDefault(const Constant(2))();
  IntColumn get dealPriceMinor => integer()();
  BoolColumn get active => boolean().withDefault(const Constant(true))();

  @override
  Set<Column> get primaryKey => {id};
}

/// Which products qualify for a deal.
class MixMatchProducts extends Table {
  IntColumn get dealId => integer()();
  IntColumn get pluId => integer()();

  @override
  Set<Column> get primaryKey => {dealId, pluId};
}

/// A trading period. A Z report closes one and opens the next; an X report
/// reads the open one without touching it. Totals are always derived from the
/// orders inside the session rather than from a running counter, so a crash
/// cannot corrupt the day's takings.
class TillSessions extends Table {
  TextColumn get id => text()();
  DateTimeColumn get openedAt => dateTime().withDefault(currentDateAndTime)();
  DateTimeColumn get closedAt => dateTime().nullable()();

  /// Sequential Z number, assigned when the session is closed.
  IntColumn get zNumber => integer().nullable()();

  /// Cash counted into the drawer at open.
  IntColumn get openingFloatMinor => integer().withDefault(const Constant(0))();

  @override
  Set<Column> get primaryKey => {id};
}

/// Restaurant tables. A table holds at most one open order at a time.
class DiningTables extends Table {
  IntColumn get number => integer()();
  TextColumn get label => text().nullable()();

  @override
  Set<Column> get primaryKey => {number};
}

/// A loyalty/membership account. Points are stored as an integer balance;
/// membership expiry is null for a non-member.
class Customers extends Table {
  TextColumn get id => text()();
  TextColumn get name => text()();
  TextColumn get phone => text().nullable()();
  TextColumn get email => text().nullable()();

  /// Card/fob number swiped at the till.
  TextColumn get cardNumber => text().nullable()();

  IntColumn get pointsBalance => integer().withDefault(const Constant(0))();
  DateTimeColumn get membershipExpiry => dateTime().nullable()();
  DateTimeColumn get syncedAt => dateTime().nullable()();

  @override
  Set<Column> get primaryKey => {id};
}

/// Every movement of points, so a balance can always be explained. The balance
/// on Customers is a cache of the sum of these.
class LoyaltyEntries extends Table {
  TextColumn get id => text()();
  TextColumn get customerId => text().references(Customers, #id)();
  TextColumn get orderId => text().nullable()();

  /// Positive when earned, negative when redeemed.
  IntColumn get points => integer()();
  TextColumn get reason => text()();
  DateTimeColumn get createdAt => dateTime().withDefault(currentDateAndTime)();

  @override
  Set<Column> get primaryKey => {id};
}

/// A sale. Created locally and immediately durable; `syncedAt` stays null
/// until the outbox has pushed it to the server.
class Orders extends Table {
  /// UUID, generated on the terminal. Doubles as the server-side idempotency
  /// key so a retried push can never book the same sale twice.
  TextColumn get id => text()();

  /// open | closed | void | parked (saved to a table)
  TextColumn get status => text().withDefault(const Constant('open'))();
  IntColumn get tableNumber => integer().nullable()();
  TextColumn get clerkPin => text().nullable()();

  /// Who settled the sale. Stamped at settlement rather than at open, for the
  /// same reason [sessionId] is: a bill parked across a shift change belongs to
  /// whoever actually took the money for it.
  ///
  /// The name is stored alongside the id because a receipt reprinted next year
  /// should still say who served it, even if that person has since been removed
  /// from the staff list.
  IntColumn get staffId => integer().nullable()();
  TextColumn get staffName => text().nullable()();

  /// The trading period this sale belongs to. Fixed at settlement so a Z
  /// report can never be changed by a later sale.
  TextColumn get sessionId => text().nullable()();

  TextColumn get customerId => text().nullable()();

  /// Set when this order was split off another; both halves keep the link so
  /// the original bill can still be reconstructed.
  TextColumn get splitFromOrderId => text().nullable()();

  IntColumn get subtotalMinor => integer().withDefault(const Constant(0))();

  /// What the clerk keyed in by hand. Held separately from [discountMinor],
  /// which is the total including automatic mix & match savings — if the two
  /// shared a column, every recalculation would fold the deal saving back in on
  /// top of itself and the discount would grow without limit.
  IntColumn get manualDiscountMinor =>
      integer().withDefault(const Constant(0))();

  /// Manual discount plus any mix & match savings. This is what the receipt and
  /// the reports show.
  IntColumn get discountMinor => integer().withDefault(const Constant(0))();

  IntColumn get taxMinor => integer().withDefault(const Constant(0))();
  IntColumn get totalMinor => integer().withDefault(const Constant(0))();

  /// Number of diners. Shown as "Covers" on the action bar.
  IntColumn get covers => integer().nullable()();
  TextColumn get notes => text().nullable()();
  TextColumn get customerName => text().nullable()();

  /// The attached customer's standing discount, copied onto the order so it can
  /// fold into the total. 'none' | 'percent' | 'amount'; value is whole percent
  /// or pence depending on the type.
  TextColumn get customerDiscountType =>
      text().withDefault(const Constant('none'))();
  IntColumn get customerDiscountValue =>
      integer().withDefault(const Constant(0))();

  DateTimeColumn get createdAt => dateTime().withDefault(currentDateAndTime)();
  DateTimeColumn get closedAt => dateTime().nullable()();
  DateTimeColumn get syncedAt => dateTime().nullable()();

  @override
  Set<Column> get primaryKey => {id};
}

/// Line items. Price is copied from the catalogue at the moment of sale so a
/// later price change in the back office cannot rewrite historical takings.
class OrderLines extends Table {
  TextColumn get id => text()();
  TextColumn get orderId => text().references(Orders, #id)();
  IntColumn get pluId => integer()();
  TextColumn get name => text()();
  RealColumn get quantity => real().withDefault(const Constant(1))();
  IntColumn get unitPriceMinor => integer()();
  RealColumn get taxPercentage => real().withDefault(const Constant(0))();
  TextColumn get notes => text().nullable()();

  /// A discount on this single line, keyed in by the clerk, in pence off the
  /// line total. Separate from the order-level discount.
  IntColumn get lineDiscountMinor => integer().withDefault(const Constant(0))();

  /// Who put this item on the bill, and when.
  ///
  /// A bill parked on a table and added to across a shift has no single author,
  /// so "who rang this up?" cannot be answered at the order level. The check
  /// view groups by these two and prints a `Sam · 19:42` header above each run
  /// of items.
  ///
  /// Nullable: lines already in the database, and any rung up before staff
  /// sign-on was switched on at the venue, simply have no attribution and are
  /// shown without a header.
  TextColumn get addedBy => text().nullable()();
  DateTimeColumn get addedAt => dateTime().nullable()();

  /// When this line was last sent to a kitchen printer, or null if it never
  /// has been.
  ///
  /// This is what stops a table being re-fired every time it is saved. A bill
  /// added to four times across a service would otherwise hand the kitchen the
  /// first course four times, and a kitchen that has learned to ignore
  /// duplicate tickets is a kitchen that will eventually ignore a real one.
  DateTimeColumn get kitchenPrintedAt => dateTime().nullable()();

  @override
  Set<Column> get primaryKey => {id};
}

/// Tenders. Split payments are supported by allowing many rows per order.
class Payments extends Table {
  TextColumn get id => text()();
  TextColumn get orderId => text().references(Orders, #id)();

  /// cash | card | voucher
  TextColumn get method => text()();
  IntColumn get amountMinor => integer()();
  DateTimeColumn get takenAt => dateTime().withDefault(currentDateAndTime)();

  /// The notes and coins actually handed over, when the clerk counted them in
  /// on the cash keys — e.g. `2000x2,500x1` for two twenties and a five.
  ///
  /// Kept as a compact string rather than a related table: it is written once,
  /// read back only to reprint the same receipt, and never queried across
  /// sales. Null for card, and for cash simply keyed as an amount.
  TextColumn get cashBreakdown => text().nullable()();

  /// The acquirer's own id for this payment — Dojo's `paymentIntentId`.
  ///
  /// Without it a card sale cannot be tied back to the acquirer at all: no
  /// matched refund, no way for a Dojo webhook to find the sale it is talking
  /// about, and nothing to quote when a customer disputes a charge. Null for
  /// cash and for anything taken on a platform that does not issue one.
  TextColumn get reference => text().nullable()();

  /// The tip inside [amountMinor], so the takings report can separate what the
  /// business earned from what belongs to the staff.
  IntColumn get gratuityMinor => integer().withDefault(const Constant(0))();

  /// How the card was captured: `terminal` | `manual` | `hosted` | `native`.
  ///
  /// A keyed card carries different interchange and different liability from
  /// one dipped in a reader, so the two must not be reported as the same thing.
  /// Null for cash.
  TextColumn get entryMode => text().nullable()();

  @override
  Set<Column> get primaryKey => {id};
}

/// The durable outbox: the single mechanism by which local work reaches the
/// server. Every mutation is appended here in the same transaction that writes
/// the business row, so a crash can never leave a sale that is committed
/// locally but invisible to sync.
class OutboxEntries extends Table {
  TextColumn get id => text()();

  /// order | payment
  TextColumn get entity => text()();
  TextColumn get entityId => text()();
  TextColumn get payload => text()();
  IntColumn get attempts => integer().withDefault(const Constant(0))();
  TextColumn get lastError => text().nullable()();
  DateTimeColumn get createdAt => dateTime().withDefault(currentDateAndTime)();

  @override
  Set<Column> get primaryKey => {id};
}

/// A note (or coin) key on the cash screen, synced from the back office.
///
/// Cached locally like the catalogue, because taking cash is the one thing a
/// till must be able to do with the network down — and a clerk cannot count
/// notes into a screen whose buttons failed to load.
class CashDenominations extends Table {
  /// Pence. £20 is 2000; the value doubles as the key, since two keys for the
  /// same amount would only be a way to miscount the drawer.
  IntColumn get valueMinor => integer()();

  /// What the key says when the picture is missing.
  TextColumn get label => text()();

  /// Absolute URL of the note artwork, resolved against the server at sync
  /// time so the widget does not have to know where the server lives.
  TextColumn get imageUrl => text().nullable()();

  IntColumn get sortOrder => integer().withDefault(const Constant(0))();

  @override
  Set<Column> get primaryKey => {valueMinor};
}

/// The venue's staff, cached for PIN sign-on.
///
/// Held locally because the till has to unlock with the network down. A
/// terminal that could not check a PIN offline would be a terminal that stops
/// selling the moment the broadband drops — a worse failure than caching four
/// digits on a machine already trusted with the catalogue and the takings.
///
/// Pulled over an authenticated terminal-token route (`/till/staff`), never the
/// public `?office=` endpoints the rest of the sync uses.
class Staff extends Table {
  /// bo_clarks.id from the back office. The stable key a report groups by.
  IntColumn get id => integer()();

  /// The operator number a venue puts on a rota, not a database key.
  IntColumn get pluid => integer().withDefault(const Constant(0))();

  TextColumn get name => text()();

  /// The PIN as the back office holds it. See the class note above.
  TextColumn get pin => text()();

  @override
  Set<Column> get primaryKey => {id};
}

@DriftDatabase(
  tables: [
    Products,
    Orders,
    OrderLines,
    Payments,
    OutboxEntries,
    TillSessions,
    DiningTables,
    Customers,
    LoyaltyEntries,
    MixMatchDeals,
    MixMatchProducts,
    Departments,
    CashDenominations,
    Staff,
  ],
)
class AppDatabase extends _$AppDatabase {
  AppDatabase() : super(_open());

  AppDatabase.forTesting(super.executor);

  @override
  int get schemaVersion => 12;

  @override
  MigrationStrategy get migration => MigrationStrategy(
        onUpgrade: (m, from, to) async {
          if (from < 2) {
            await m.addColumn(orders, orders.discountMinor);
            await m.addColumn(orders, orders.covers);
            await m.addColumn(orders, orders.notes);
            await m.addColumn(orders, orders.customerName);
          }
          if (from < 3) {
            await m.createTable(tillSessions);
            await m.createTable(diningTables);
            await m.createTable(customers);
            await m.createTable(loyaltyEntries);
            await m.addColumn(products, products.buttonPosition);
            await m.addColumn(products, products.buttonColor);
            // Raw SQL because `printer_route` is no longer a column the Dart
            // schema declares — step 11 folds it into `printer_routes`. A
            // migration step is a historical record of what the database looked
            // like at the time, so it has to keep adding the column it added
            // then, or the step-11 transform below has nothing to read.
            await m.database.customStatement(
              'ALTER TABLE products ADD COLUMN printer_route TEXT NULL',
            );
            await m.addColumn(orders, orders.sessionId);
            await m.addColumn(orders, orders.customerId);
            await m.addColumn(orders, orders.splitFromOrderId);
          }
          if (from < 4) {
            await m.createTable(mixMatchDeals);
            await m.createTable(mixMatchProducts);
            await m.addColumn(orders, orders.manualDiscountMinor);
            // Anything already discounted was keyed in by hand, so carry it
            // across rather than silently zeroing open bills.
            await m.database.customStatement(
              'UPDATE orders SET manual_discount_minor = discount_minor',
            );
          }
          if (from < 5) {
            await m.addColumn(orderLines, orderLines.lineDiscountMinor);
          }
          if (from < 6) {
            await m.addColumn(orders, orders.customerDiscountType);
            await m.addColumn(orders, orders.customerDiscountValue);
          }
          if (from < 7) {
            await m.addColumn(products, products.emoji);
            await m.addColumn(products, products.imageUrl);
          }
          if (from < 8) {
            await m.createTable(departments);
          }
          if (from < 9) {
            await m.createTable(cashDenominations);
            await m.addColumn(payments, payments.cashBreakdown);
          }
          if (from < 10) {
            await m.createTable(staff);
            await m.addColumn(orderLines, orderLines.addedBy);
            await m.addColumn(orderLines, orderLines.addedAt);
            await m.addColumn(orders, orders.staffId);
            await m.addColumn(orders, orders.staffName);
          }
          if (from < 11) {
            // One station per product became a set of them. The old value is
            // carried across rather than left to the next sync: a till that
            // opens offline after an update must still route its food, and
            // "printers stopped working after the update" is the one bug a
            // kitchen never forgives.
            //
            // `PrinterRole.fromStation` maps the two old names onto numbered
            // stations at read time, so "kitchen" surviving in this column is
            // correct rather than something to translate here.
            await m.alterTable(
              TableMigration(
                products,
                newColumns: [products.printerRoutes, products.printToReceipt],
                columnTransformer: {
                  products.printerRoutes:
                      const CustomExpression<String>('printer_route'),
                },
              ),
            );
            await m.addColumn(orderLines, orderLines.kitchenPrintedAt);
          }
          if (from < 12) {
            // Card payments gain the acquirer's own id, the tip inside the
            // amount, and how the card was captured. Nullable and defaulted, so
            // every sale already on the till stays valid — they simply carry no
            // acquirer reference, which is true: nothing ever recorded one.
            await m.addColumn(payments, payments.reference);
            await m.addColumn(payments, payments.gratuityMinor);
            await m.addColumn(payments, payments.entryMode);
          }
        },
      );
}

QueryExecutor _open() {
  return LazyDatabase(() async {
    final dir = await getApplicationSupportDirectory();
    final file = File(p.join(dir.path, 'vesopa_epos.sqlite'));

    return NativeDatabase.createInBackground(file);
  });
}
