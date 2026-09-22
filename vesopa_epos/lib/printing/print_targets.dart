/// What the till prints, as distinct from what it prints *on*.
///
/// A printer is a piece of hardware; a target is a job. Keeping them apart is
/// the whole point of this file: a venue that wants the customer's copy on the
/// counter printer and their own copy on the one in the office has two targets
/// and two devices, and neither is a property of the other. The till used to
/// bake the job into the device — a printer *was* "the receipt printer" — which
/// made "print my copy somewhere else" unexpressible.
///
/// Declaration order is display order, everywhere the till and the back office
/// list these. The kitchen stations come first because they are what a venue
/// sets up most of, and the receipt targets come last, which is where they were
/// asked for.
enum PrintTarget {
  kp1('KP 1', 'kp1', station: 'kp1'),
  kp2('KP 2', 'kp2', station: 'kp2'),
  kp3('KP 3', 'kp3', station: 'kp3'),
  kp4('KP 4', 'kp4', station: 'kp4'),
  kp5('KP 5', 'kp5', station: 'kp5'),
  kp6('KP 6', 'kp6', station: 'kp6'),

  /// The customer's copy — the tax receipt, and the one target every venue has.
  /// It doubles as a routing station: a product routed to "Receipt" prints a
  /// ticket at the counter as well as reaching the kitchen.
  customerReceipt('Receipt printer', 'customer_receipt', station: 'receipt'),

  /// The venue's own copy of the same sale. Unset means "same printer as the
  /// customer's copy", which is how a till behaves before anybody configures
  /// this.
  merchantCopy('Merchant copy', 'merchant_copy'),

  /// The bill handed over *before* payment. Often the same printer as the
  /// receipt; separable because a venue with a waiter station may want it
  /// there instead of at the counter.
  bill('Bill (before payment)', 'bill'),

  tillReport('X / Z report', 'till_report'),

  /// Not a document: the drawer is a solenoid wired into a printer's RJ11
  /// socket, so opening it means sending a pulse to whichever printer it is
  /// plugged into — which is not necessarily the one printing receipts.
  cashDrawer('Cash drawer', 'cash_drawer');

  const PrintTarget(this.label, this.key, {this.station});

  final String label;

  /// The key this assignment is stored under. Kept separate from [name] so the
  /// enum can be renamed without invalidating every terminal's saved setup.
  final String key;

  /// The key the back office routes products to, for the targets that can be a
  /// routing destination. Null for the targets that only the till decides —
  /// nobody routes a product to "the X report".
  final String? station;

  /// What to fall back to when this target has no printer of its own.
  ///
  /// This is what keeps an existing till behaving exactly as it did: before
  /// there were targets, the drawer, the bill and the reports all came out of
  /// the one receipt printer, and a venue that never opens this screen should
  /// never notice the model changed underneath them.
  ///
  /// The kitchen stations deliberately have no fallback. Food routed to KP 3
  /// with no KP 3 set up must be *reported*, not quietly printed at the
  /// counter where nobody in the kitchen will ever see it.
  PrintTarget? get fallback => switch (this) {
    merchantCopy || bill || tillReport || cashDrawer => customerReceipt,
    _ => null,
  };

  /// Whether a product can be routed here from the back office.
  bool get isRoutable => station != null;

  bool get isKitchenStation => this != customerReceipt && isRoutable;

  /// The six numbered kitchen stations, in order.
  static List<PrintTarget> get kitchenStations =>
      values.where((t) => t.isKitchenStation).toList();

  /// Every routing destination the back office may offer, kitchen first and the
  /// receipt printer last.
  static List<PrintTarget> get routable =>
      values.where((t) => t.isRoutable).toList();

  /// The target a stored assignment key belongs to, or null.
  static PrintTarget? fromKey(String? key) {
    if (key == null || key.isEmpty) return null;
    final k = key.trim().toLowerCase();
    for (final target in values) {
      if (target.key == k || target.name.toLowerCase() == k) return target;
    }
    return null;
  }

  /// The target a stored routing station belongs to, or null.
  ///
  /// Accepts the names this has had before. A venue that set up "kitchen" and
  /// "bar" before the stations were numbered keeps printing: kitchen becomes
  /// KP 1 and bar becomes KP 2, which is the order they were listed in and so
  /// the order their printers were almost certainly plugged in.
  static PrintTarget? fromStation(String? key) {
    if (key == null || key.isEmpty) return null;
    final k = key.trim().toLowerCase();
    for (final target in values) {
      if (target.station == k) return target;
    }
    return switch (k) {
      'kitchen' => kp1,
      'bar' => kp2,
      // The role key the pre-target settings format used for the one printer
      // it knew how to name.
      'receipt' => customerReceipt,
      _ => null,
    };
  }
}

/// Where a kitchen station's tickets come out.
///
/// The station itself is unchanged — it is still one of the six a product is
/// routed to in the back office — and so is the routing. All this decides is
/// what happens at the far end of it: paper, a screen, or both.
///
/// Venue-wide, and owned by the back office alongside the station *names*, for
/// the same reason those are: "KP 3 is the fryer, and the fryer has a screen" is
/// a fact about the venue. Left on the terminal, two tills in one room could
/// disagree about whether the fryer prints, and the kitchen would get a ticket
/// or not depending on which counter served the customer.
///
/// [printer] is the default everywhere it is absent. That is the whole
/// compatibility story: a venue that upgrades and never opens the kitchen app
/// prints exactly as it did yesterday.
enum KitchenDelivery {
  printer('Printer only', 'printer'),
  screen('Kitchen screen only', 'screen'),

  /// Both — which is what a venue actually runs for the fortnight it spends
  /// trusting the screen enough to unplug the printer.
  both('Printer and screen', 'both');

  const KitchenDelivery(this.label, this.key);

  final String label;
  final String key;

  bool get toPrinter => this != screen;
  bool get toScreen => this != printer;

  /// Unknown values fall back to [printer], deliberately. A till reading a mode
  /// a later release introduced must keep printing rather than route food to
  /// something it does not understand.
  static KitchenDelivery fromKey(String? key) {
    final k = key?.trim().toLowerCase();
    for (final v in values) {
      if (v.key == k) return v;
    }
    return printer;
  }
}

/// When the venue's own copy of a receipt is printed.
///
/// Separate from the printer assignment because they answer different
/// questions: *where* the merchant copy goes, and *whether* one is wanted at
/// all. A venue can assign a printer and still leave this off while they test
/// it.
enum MerchantCopyWhen {
  never('Never', 'never'),

  /// The common case. A card sale is the one a venue is most often asked to
  /// evidence later — a chargeback names a card, not a cash drawer — so this
  /// is the copy worth keeping without keeping all of them.
  cardSales('Card sales', 'card'),

  everySale('Every sale', 'always');

  const MerchantCopyWhen(this.label, this.key);

  final String label;
  final String key;

  static MerchantCopyWhen fromKey(String? key) {
    for (final v in values) {
      if (v.key == key) return v;
    }
    return never;
  }
}

/// Reading and writing the comma-separated station list a product carries.
///
/// One place for it because three layers touch the same string — the sync that
/// stores it, the product editor that sets it, and the print run that reads it
/// — and a routing list that round-trips differently in any of them sends food
/// to the wrong printer.
abstract final class KitchenRouting {
  /// The stations named by a stored routing string, unknown names dropped.
  ///
  /// Unknown rather than invalid: a back office offering KP 7 to a till that
  /// only knows six should route to the six it has, not refuse the product.
  static Set<String> parse(String? raw) {
    if (raw == null || raw.isEmpty) return const {};
    return {
      for (final part in raw.split(','))
        if (PrintTarget.fromStation(part) case final target?) target.station!,
    };
  }

  /// The storable form, in target order. Null for "not routed anywhere", which
  /// is what the column means by empty.
  static String? format(Iterable<String> stations) {
    final targets =
        <PrintTarget>{
          for (final s in stations) ?PrintTarget.fromStation(s),
        }.toList()..sort((a, b) => a.index.compareTo(b.index));
    return targets.isEmpty ? null : targets.map((t) => t.station!).join(',');
  }
}
