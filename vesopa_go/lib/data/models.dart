/// What Vesopa Go knows about: a venue, its clerks, its menu, its tables and
/// the bills open on them. Money is always whole pence (int), as on the till.
library;

import 'mix_match_engine.dart';
import 'mix_match_types.dart';
import 'till_permissions.dart';

export 'mix_match_engine.dart';
export 'till_permissions.dart';
import 'package:flutter/foundation.dart';

/// "£12.50" from 1250.
String money(int minor) {
  final sign = minor < 0 ? '-' : '';
  final v = minor.abs();
  return '$sign£${v ~/ 100}.${(v % 100).toString().padLeft(2, '0')}';
}

/// How this phone is used.
///
///   connected   beside Vesopa EPOS tills: the same tables, bills, menu and
///               kitchen, a terminal among terminals
///   standalone  the venue's only terminals are Tap phones: a small menu or a
///               typed amount, the back office still keeps every sale
enum VenueMode { connected, standalone }

@immutable
class Venue {
  const Venue({required this.name, required this.office, required this.mode, this.site});
  final String name;
  final String office;
  final VenueMode mode;
  final String? site;

  Map<String, Object?> toJson() => {'name': name, 'office': office, 'mode': mode.name, 'site': site};
  factory Venue.fromJson(Map<String, dynamic> j) => Venue(
        name: j['name'] as String? ?? 'Venue',
        office: j['office'] as String? ?? '',
        mode: VenueMode.values.byName(j['mode'] as String? ?? 'connected'),
        site: j['site'] as String?,
      );
}

/// A member of staff, as /api/till/staff sends them: the same PIN and staff
/// card as on every till, set in the back office.
@immutable
class Clerk {
  const Clerk({required this.id, required this.name, required this.pin, this.card = '', this.group, this.permissions = ''});
  final int id;
  final String name;
  final String pin;

  /// A staff card's id, upper-case hex (an NFC fob or card), or '' for none.
  final String card;
  final String? group;

  /// The till's keys for this member of staff (till_permissions.dart): the
  /// group's switches as the till stores them, '' for no group (every key).
  final String permissions;

  bool can(TillPermission p) => TillPermissions.parse(permissions).can(p);

  /// May approve [p] for somebody else: holds it, or is a manager.
  bool canApprove(TillPermission p) => can(p) || can(TillPermission.isManager);

  factory Clerk.fromJson(Map<String, dynamic> j) => Clerk(
        id: (j['id'] as num).toInt(),
        name: j['name'] as String? ?? 'Staff',
        pin: '${j['pin'] ?? ''}',
        card: (j['swipe_card'] as String? ?? '').toUpperCase(),
        group: j['permission_group'] as String?,
        // Kept on the device as `perms` (already encoded); from /till/staff as
        // the group's switches, exactly as the till reads them.
        permissions: j['perms'] is String
            ? j['perms'] as String
            : TillPermissions.encode(j['permissions'], grouped: j['permission_group_id'] != null),
      );
}

@immutable
class MenuCategory {
  const MenuCategory({required this.id, required this.name, required this.colour});
  final String id;
  final String name;
  final int colour;
}

@immutable
class Product {
  const Product({
    required this.id,
    required this.name,
    required this.priceMinor,
    required this.category,
    this.allergens = const [],
    this.course = 0,
    this.outOfStock = false,
    this.options = const [],
    this.plu,
    this.taxPercent = 0,
    this.stations = const [],
    this.imageUrl = '',
  });
  final String id;
  final String name;
  final int priceMinor;

  /// The product's photo from the back office, the online menu's own; '' for none.
  final String imageUrl;
  final String category;
  final List<String> allergens;

  /// The back office's PLU: what the sale and the stock movement are filed under.
  final int? plu;
  final double taxPercent;

  /// Kitchen and bar stations it is made at (`kp1`..`kp6`, the product's
  /// printer routes). None: it is not sent to a kitchen.
  final List<String> stations;

  /// 0 drinks / no course, 1 starter, 2 main, 3 dessert: what "send" and
  /// "fire" act on.
  final int course;
  final bool outOfStock;

  /// A choice the clerk must make (cooking, side), as the till's modifiers.
  final List<OptionGroup> options;
}

@immutable
class OptionGroup {
  const OptionGroup({required this.name, required this.choices, this.required = true});
  final String name;
  final List<Choice> choices;
  final bool required;
}

@immutable
class Choice {
  const Choice(this.name, [this.priceMinor = 0, this.plu]);
  final String name;
  final int priceMinor;

  /// A modifier that is a product of its own in the back office.
  final int? plu;
}

enum TableState { free, seated, ordered, mains, bill, paid }

@immutable
class TableInfo {
  const TableInfo({required this.id, required this.name, required this.area, this.seats = 4, this.number, this.roomId,
      this.x = 0, this.y = 0, this.width = 2, this.height = 2, this.round = false});
  final String id;
  final String name;
  final String area;
  final int seats;

  /// The table number the till, the kitchen and the receipts use.
  final int? number;
  final int? roomId;

  /// Where the back office's floor designer put it, in grid squares.
  final int x;
  final int y;
  final int width;
  final int height;
  final bool round;
}

/// One line on a bill.
@immutable
class BillLine {
  const BillLine({
    required this.id,
    required this.product,
    this.quantity = 1,
    this.choices = const [],
    this.note = '',
    this.seat = 0,
    this.sent = false,
    this.held = false,
    this.paidQuantity = 0,
    this.addedBy = '',
    this.addedAt,
  });
  final String id;
  final Product product;
  final int quantity;
  final List<Choice> choices;
  final String note;

  /// Seat number (1..), or 0 for the table: by-seat ordering and splitting.
  final int seat;

  /// Sent to the kitchen or bar. Sent lines can be voided only with a reason.
  final bool sent;

  /// Held back (a main course waiting for the starters to clear): Send leaves
  /// it, Fire sends it.
  final bool held;

  /// How many of [quantity] are already paid for (split by item).
  final int paidQuantity;
  final String addedBy;
  final DateTime? addedAt;

  int get unitMinor => product.priceMinor + choices.fold(0, (s, c) => s + c.priceMinor);
  int get totalMinor => unitMinor * quantity;
  int get unpaidQuantity => quantity - paidQuantity;

  /// Whether another tap of [p] belongs on this line: the same item, choices,
  /// note and seat, still unsent and unpaid, so raising it changes nothing the
  /// kitchen or a split has already seen.
  bool sameAs(Product p, {List<Choice> choices = const [], String note = '', int seat = 0, bool held = false}) =>
      !sent &&
      paidQuantity == 0 &&
      product.id == p.id &&
      this.note == note &&
      this.seat == seat &&
      this.held == held &&
      this.choices.length == choices.length &&
      [for (var i = 0; i < choices.length; i++) this.choices[i].name == choices[i].name && this.choices[i].priceMinor == choices[i].priceMinor].every((x) => x);

  BillLine copyWith({int? quantity, bool? sent, bool? held, int? paidQuantity, String? note, int? seat}) => BillLine(
        id: id,
        product: product,
        quantity: quantity ?? this.quantity,
        choices: choices,
        note: note ?? this.note,
        seat: seat ?? this.seat,
        sent: sent ?? this.sent,
        held: held ?? this.held,
        paidQuantity: paidQuantity ?? this.paidQuantity,
        addedBy: addedBy,
        addedAt: addedAt,
      );
}

/// Money taken towards a bill. Only a server-confirmed tender counts.
@immutable
class Tender {
  const Tender({
    required this.id,
    required this.amountMinor,
    this.tipMinor = 0,
    required this.kind,
    required this.at,
    this.clerk = '',
    this.reference,
  });
  final String id;

  /// Towards the bill (the tip is on top, in [tipMinor]).
  final int amountMinor;
  final int tipMinor;

  /// `tap` (phone NFC), `machine` (Dojo card machine), `cash`.
  final String kind;
  final DateTime at;
  final String clerk;

  /// Dojo's payment intent for a card payment.
  final String? reference;
}

/// A sent line taken off a bill: who, why, and who approved it.
@immutable
class VoidRecord {
  const VoidRecord({required this.name, required this.quantity, required this.amountMinor, required this.reason, required this.by, required this.approvedBy});
  final String name;
  final int quantity;
  final int amountMinor;
  final String reason;
  final String by;
  final String approvedBy;

  @override
  String toString() => 'Void $quantity× $name (${money(amountMinor)}): $reason. By $by, approved by $approvedBy';
}

/// An open bill: a table's, or a tab's.
@immutable
class Bill {
  const Bill({
    required this.id,
    required this.name,
    this.tableId,
    this.tableNumber,
    this.roomId,
    this.covers = 0,
    this.lines = const [],
    this.tenders = const [],
    this.voids = const [],
    this.tickets = const [],
    this.heldBy,
    this.clerk = '',
    this.staffId,
    this.serviceChargePercent = 0,
    this.openedAt,
    this.member,
    this.voucherCode,
    this.voucherMinor = 0,
    this.discountPercent = 0,
    this.discountFixedMinor = 0,
    this.discountReason = '',
  });
  final String id;
  final String name;
  final String? tableId;
  final int? tableNumber;
  final int? roomId;
  final int covers;
  final List<BillLine> lines;
  final List<Tender> tenders;
  final List<VoidRecord> voids;

  /// Kitchen tickets sent for this bill, to tell the clerk when food is ready.
  final List<String> tickets;

  /// Another terminal holding it (till bill sync): it must be claimed first.
  final String? heldBy;
  final String clerk;
  final int? staffId;
  final double serviceChargePercent;
  final DateTime? openedAt;

  /// A Vesopa Loyalty member on the bill: their standing discount, and the
  /// points the sale earns them.
  final Member? member;

  /// A voucher taken off the bill (checked by the back office).
  final String? voucherCode;
  final int voucherMinor;

  /// A discount the clerk gave on the whole sale: a percentage, or pence off.
  final double discountPercent;
  final int discountFixedMinor;
  final String discountReason;

  int get subtotalMinor => lines.fold(0, (s, l) => s + l.totalMinor);

  /// The member's standing discount, any voucher and the clerk's discount,
  /// never more than the bill.
  int get discountMinor => (dealMinor + memberDiscountMinor + voucherMinor + manualDiscountMinor).clamp(0, subtotalMinor);

  /// The venue's mix & match deals (back office), worked out by the till's own
  /// engine. Set once the menu loads; none until then.
  static MixMatchEngine deals = const MixMatchEngine([], {});

  /// The deals this bill earns, and what they take off.
  MixMatchResult get dealsApplied => deals.apply([
        for (final l in lines)
          if (l.product.plu != null) OrderLine(pluId: l.product.plu!, quantity: l.quantity.toDouble(), unitPriceMinor: l.unitMinor),
      ]);
  int get dealMinor => dealsApplied.totalSavingMinor;
  int get memberDiscountMinor => member?.discountOn(subtotalMinor) ?? 0;
  int get manualDiscountMinor =>
      ((subtotalMinor * discountPercent / 100).round() + discountFixedMinor).clamp(0, subtotalMinor);

  /// Service charge on what is left after the discount.
  int get serviceMinor => ((subtotalMinor - discountMinor) * serviceChargePercent / 100).round();
  int get totalMinor => subtotalMinor - discountMinor + serviceMinor;
  int get paidMinor => tenders.fold(0, (s, t) => s + t.amountMinor);
  int get tipsMinor => tenders.fold(0, (s, t) => s + t.tipMinor);
  int get dueMinor => totalMinor - paidMinor;
  bool get hasUnsent => lines.any((l) => !l.sent && !l.held);
  bool get hasHeld => lines.any((l) => l.held && !l.sent);

  /// [heldBy] and [clearHeldBy]: a claimed bill is this phone's again.
  Bill copyWith({
    List<BillLine>? lines,
    List<Tender>? tenders,
    List<VoidRecord>? voids,
    List<String>? tickets,
    int? covers,
    String? heldBy,
    bool clearHeldBy = false,
    double? serviceChargePercent,
    Member? member,
    bool clearMember = false,
    String? voucherCode,
    int? voucherMinor,
    double? discountPercent,
    int? discountFixedMinor,
    String? discountReason,
  }) =>
      Bill(
        id: id,
        name: name,
        tableId: tableId,
        tableNumber: tableNumber,
        roomId: roomId,
        covers: covers ?? this.covers,
        lines: lines ?? this.lines,
        tenders: tenders ?? this.tenders,
        voids: voids ?? this.voids,
        tickets: tickets ?? this.tickets,
        heldBy: clearHeldBy ? null : (heldBy ?? this.heldBy),
        clerk: clerk,
        staffId: staffId,
        serviceChargePercent: serviceChargePercent ?? this.serviceChargePercent,
        openedAt: openedAt,
        member: clearMember ? null : (member ?? this.member),
        voucherCode: voucherCode ?? this.voucherCode,
        voucherMinor: voucherMinor ?? this.voucherMinor,
        discountPercent: discountPercent ?? this.discountPercent,
        discountFixedMinor: discountFixedMinor ?? this.discountFixedMinor,
        discountReason: discountReason ?? this.discountReason,
      );
}

/// A Vesopa Loyalty member, as /api/loyalty/card answers (vesopa_server/src/commerce.js).
@immutable
class Member {
  const Member({
    required this.id,
    required this.name,
    this.number = '',
    this.pointsBalance = 0,
    this.discountType = 'none',
    this.discountValue = 0,
    this.earns = false,
    this.pointsPerPound = 0,
    this.minSpendMinor = 0,
    this.multiplier = 1,
  });
  final int id;
  final String name;
  final String number;
  final double pointsBalance;

  /// `percent` (whole percent), `amount` (pence off) or `none`.
  final String discountType;
  final int discountValue;
  final bool earns;
  final double pointsPerPound;
  final int minSpendMinor;
  final double multiplier;

  int discountOn(int subtotalMinor) => switch (discountType) {
        'percent' => (subtotalMinor * discountValue / 100).round(),
        'amount' => discountValue.clamp(0, subtotalMinor),
        _ => 0,
      };

  /// Points a spend earns: the till's own rule (vesopa_epos commerce.dart pointsFor).
  int pointsFor(int spendMinor) {
    if (!earns || spendMinor < minSpendMinor) return 0;
    return ((spendMinor ~/ 100) * pointsPerPound * multiplier).round();
  }

  static double _d(Object? v, double d) => v is num ? v.toDouble() : double.tryParse('${v ?? ''}') ?? d;

  factory Member.fromJson(Map<String, dynamic> j) {
    final s = (j['settings'] as Map?)?.cast<String, dynamic>() ?? const {};
    final first = '${j['first_name'] ?? ''}'.trim();
    final last = '${j['last_name'] ?? ''}'.trim();
    final name = '${j['name'] ?? '$first $last'}'.trim();
    return Member(
      id: (j['id'] as num).toInt(),
      name: name.isEmpty ? 'Member' : name,
      number: '${j['member_number'] ?? j['card_number'] ?? ''}',
      pointsBalance: _d(j['points_balance'], 0),
      discountType: '${j['discount_type'] ?? 'none'}',
      discountValue: (j['discount_value'] as num?)?.toInt() ?? 0,
      earns: s['earn_points'] == true || s['earn_points'] == 1,
      pointsPerPound: _d(s['points_per_pound'], 0),
      minSpendMinor: (s['min_spend_minor'] as num?)?.toInt() ?? 0,
      multiplier: _d(j['tier_multiplier'], 1),
    );
  }
}
