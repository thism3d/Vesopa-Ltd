/// What Vesopa Tap knows about: a venue, its clerks, its menu, its tables and
/// the bills open on them. Money is always whole pence (int), as on the till.
library;

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
  const Clerk({required this.id, required this.name, required this.pin, this.card = '', this.group});
  final int id;
  final String name;
  final String pin;

  /// A staff card's id, upper-case hex (an NFC fob or card), or '' for none.
  final String card;
  final String? group;

  factory Clerk.fromJson(Map<String, dynamic> j) => Clerk(
        id: (j['id'] as num).toInt(),
        name: j['name'] as String? ?? 'Staff',
        pin: '${j['pin'] ?? ''}',
        card: (j['swipe_card'] as String? ?? '').toUpperCase(),
        group: j['permission_group'] as String?,
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
  });
  final String id;
  final String name;
  final int priceMinor;
  final String category;
  final List<String> allergens;

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
  const Choice(this.name, [this.priceMinor = 0]);
  final String name;
  final int priceMinor;
}

enum TableState { free, seated, ordered, mains, bill, paid }

@immutable
class TableInfo {
  const TableInfo({required this.id, required this.name, required this.area, this.seats = 4});
  final String id;
  final String name;
  final String area;
  final int seats;
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
    this.paidQuantity = 0,
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

  /// How many of [quantity] are already paid for (split by item).
  final int paidQuantity;

  int get unitMinor => product.priceMinor + choices.fold(0, (s, c) => s + c.priceMinor);
  int get totalMinor => unitMinor * quantity;
  int get unpaidQuantity => quantity - paidQuantity;

  BillLine copyWith({int? quantity, bool? sent, int? paidQuantity, String? note, int? seat}) => BillLine(
        id: id,
        product: product,
        quantity: quantity ?? this.quantity,
        choices: choices,
        note: note ?? this.note,
        seat: seat ?? this.seat,
        sent: sent ?? this.sent,
        paidQuantity: paidQuantity ?? this.paidQuantity,
      );
}

/// Money taken towards a bill. Only a server-confirmed tender counts.
@immutable
class Tender {
  const Tender({required this.id, required this.amountMinor, this.tipMinor = 0, required this.kind, required this.at, this.clerk = ''});
  final String id;
  final int amountMinor;
  final int tipMinor;

  /// `tap` (phone NFC), `card_machine`, `cash`, `voucher`.
  final String kind;
  final DateTime at;
  final String clerk;
}

/// An open bill: a table's, or a tab's.
@immutable
class Bill {
  const Bill({
    required this.id,
    required this.name,
    this.tableId,
    this.covers = 0,
    this.lines = const [],
    this.tenders = const [],
    this.heldBy,
    this.clerk = '',
    this.serviceChargePercent = 0,
  });
  final String id;
  final String name;
  final String? tableId;
  final int covers;
  final List<BillLine> lines;
  final List<Tender> tenders;

  /// Another terminal holding it (till bill sync): it must be claimed first.
  final String? heldBy;
  final String clerk;
  final double serviceChargePercent;

  int get subtotalMinor => lines.fold(0, (s, l) => s + l.totalMinor);
  int get serviceMinor => (subtotalMinor * serviceChargePercent / 100).round();
  int get totalMinor => subtotalMinor + serviceMinor;
  int get paidMinor => tenders.fold(0, (s, t) => s + t.amountMinor);
  int get dueMinor => totalMinor - paidMinor;
  bool get hasUnsent => lines.any((l) => !l.sent);

  Bill copyWith({List<BillLine>? lines, List<Tender>? tenders, int? covers, String? heldBy, double? serviceChargePercent}) => Bill(
        id: id,
        name: name,
        tableId: tableId,
        covers: covers ?? this.covers,
        lines: lines ?? this.lines,
        tenders: tenders ?? this.tenders,
        heldBy: heldBy ?? this.heldBy,
        clerk: clerk,
        serviceChargePercent: serviceChargePercent ?? this.serviceChargePercent,
      );
}
