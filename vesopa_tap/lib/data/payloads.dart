/// A bill in the shapes the back office already understands, so a phone's
/// bill, ticket and sale are the same rows as a till's:
///
///   open bill   POST /till/open-bills   (vesopa_epos/lib/data/bill_sync.dart)
///   ticket      POST /till/kitchen/tickets (kitchen_screens.dart KitchenTicket)
///   sale        POST /till/orders       (src/sales.js recordSale)
library;

import 'models.dart';

/// The lines as the till sends them: a dish, then each chosen modifier as
/// a line of its own at its own price.
List<Map<String, Object?>> _lines(Bill bill) => [
      for (final l in bill.lines) ...[
        {
          'id': l.id,
          'plu_id': l.product.plu,
          'name': l.product.name,
          'quantity': l.quantity,
          'unit_price_minor': l.product.priceMinor,
          'tax_percentage': l.product.taxPercent,
          if (l.note.isNotEmpty) 'note': l.note,
          'added_by': l.addedBy,
          'added_at': l.addedAt?.toUtc().toIso8601String(),
          if (l.sent) 'kitchen_printed_at': (l.addedAt ?? DateTime.now()).toUtc().toIso8601String(),
          if (l.seat > 0) 'seat': l.seat,
        },
        for (final (i, c) in l.choices.indexed)
          {
            'id': '${l.id}-m$i',
            'plu_id': c.plu,
            'name': c.name,
            'quantity': l.quantity,
            'unit_price_minor': c.priceMinor,
            'tax_percentage': l.product.taxPercent,
            'is_modifier': true,
            'parent_line_id': l.id,
          },
      ],
    ];

/// A bill for the venue's shared plan.
Map<String, Object?> openBillPayload(Bill bill, {required String terminal}) => {
      'id': bill.id,
      'terminal': terminal,
      'table_number': bill.tableNumber,
      'room_id': bill.roomId,
      'covers': bill.covers,
      'staff_id': bill.staffId,
      'clerk_name': bill.clerk,
      'status': 'open',
      'total_minor': bill.totalMinor,
      'line_count': bill.lines.length,
      'payload': {
        'id': bill.id,
        'status': 'open',
        'name': bill.name,
        'table_number': bill.tableNumber,
        'room_id': bill.roomId,
        'covers': bill.covers,
        'staff_id': bill.staffId,
        'staff_name': bill.clerk,
        'subtotal_minor': bill.subtotalMinor,
        'total_minor': bill.totalMinor,
        'service_percent': bill.serviceChargePercent,
        'lines': _lines(bill),
      },
    };

/// The kitchen ticket for [lines] (the ones being sent now), or null when
/// none of them is made at a station.
Map<String, Object?>? kitchenTicket(Bill bill, List<BillLine> lines, {required String id, required String office, String? roomName, String kind = 'sale'}) {
  final out = <Map<String, Object?>>[];
  for (final l in lines) {
    if (l.product.stations.isEmpty) continue;
    out.add({
      'id': l.id,
      'quantity': l.quantity,
      'name': l.product.name + (l.seat > 0 ? ' (seat ${l.seat})' : ''),
      if (l.product.plu != null) 'plu_id': l.product.plu,
      if (l.note.isNotEmpty) 'note': l.note,
      'stations': l.product.stations.join(','),
    });
    for (final (i, c) in l.choices.indexed) {
      out.add({'id': '${l.id}-m$i', 'quantity': l.quantity, 'name': c.name, 'is_modifier': true, 'stations': l.product.stations.join(',')});
    }
  }
  if (out.isEmpty) return null;
  return {
    'id': id,
    'office': office,
    'order_id': bill.id,
    'kind': kind,
    'placed_at': DateTime.now().toUtc().toIso8601String(),
    if (bill.tableNumber != null) 'table_number': bill.tableNumber,
    if (roomName != null) 'room_name': roomName,
    'staff_name': bill.clerk,
    if (bill.covers > 0) 'covers': bill.covers,
    'note': bill.tableNumber == null ? bill.name : null,
    'lines': out,
  };
}

/// The finished sale, once every penny is in.
Map<String, Object?> salePayload(Bill bill, {required String office, required String terminal, String? clerkPin}) {
  final tips = bill.tipsMinor;
  return {
    'id': bill.id,
    'email': office,
    'terminal': terminal,
    'table_number': bill.tableNumber,
    'room_id': bill.roomId,
    'covers': bill.covers > 0 ? bill.covers : null,
    'clerk_pin': clerkPin,
    'clerk_name': bill.clerk,
    'staff_id': bill.staffId,
    'customer_name': bill.member?.name ?? (bill.tableNumber == null ? bill.name : null),
    'customer_id': bill.member?.id,
    // The member's points, by the till's own rule, on what they actually spent.
    'points_earned': bill.member?.pointsFor(bill.totalMinor - bill.serviceMinor) ?? 0,
    'voucher_code': bill.voucherCode,
    'voucher_minor': bill.voucherMinor,
    'subtotal_minor': bill.subtotalMinor,
    'discount_minor': bill.memberDiscountMinor.clamp(0, bill.subtotalMinor),
    'tax_minor': 0,
    'service_minor': bill.serviceMinor,
    'total_minor': bill.totalMinor,
    'gratuity_minor': tips,
    'notes': bill.voids.isEmpty ? null : bill.voids.map((v) => '$v').join('\n'),
    'closed_at': DateTime.now().toUtc().toIso8601String(),
    'lines': _lines(bill),
    'payments': [
      for (final t in bill.tenders)
        {
          'method': t.kind == 'cash' ? 'cash' : 'card',
          'amount_minor': t.amountMinor,
          'gratuity_minor': t.tipMinor,
          'reference': t.reference,
          'entry_mode': t.kind == 'tap' ? 'contactless' : (t.kind == 'machine' ? 'terminal' : null),
        },
    ],
  };
}
