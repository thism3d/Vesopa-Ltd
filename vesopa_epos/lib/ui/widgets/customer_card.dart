/// Who the bill is for, on the bill.
///
/// A customer could be attached to a sale, and their discount would come off
/// the total, and the only sign of any of it was a name in small grey type on
/// the payment screen. The venue asked to be able to *see* it — and to change
/// it without going hunting for the key that set it.
///
/// Two rules govern what this shows, and they are a pair rather than two
/// separate decisions:
///
///   * **The clerk's check shows the full record** — name, discount, points,
///     phone, email. All of it is useful at the counter: the discount explains
///     the total, the balance is what a clerk offers to spend, and the phone
///     number is how a venue taking a collection order confirms it is the right
///     Jones.
///   * **The customer-facing display shows none of it.** That screen faces a
///     queue. A name is fine, a phone number read by the next four people is
///     not, and the pair only works because the detailed half is the half
///     nobody but staff can see. See `vesopa_epos_display` — it deliberately
///     has no equivalent of this widget.
///
/// Nothing is drawn at all when no customer is attached. The ordinary walk-in
/// sale looks exactly as it did.
library;

import 'package:flutter/material.dart';

import '../../data/local/database.dart';

/// Everything the check knows about the person the bill is for.
///
/// Read from the order, which carries all of it — see `Orders.customerPhone`
/// for why the contact details are copied down rather than looked up. The
/// short version is that there is nothing to look them up *from*: customers
/// live on the server, the server offers search and create and nothing by id,
/// and the till keeps no cache. A bill parked at seven o'clock has to be able
/// to say who it is for at nine, on a line that may by then be down.
///
/// The points balance is the exception and comes in separately, because a
/// balance moves. It is passed only where the till has it live — the payment
/// screen's loyalty flow — and is absent everywhere else rather than quoted
/// from a figure frozen onto a parked bill.
class BillCustomer {
  const BillCustomer({
    required this.name,
    this.id,
    this.phone,
    this.email,
    this.cardNumber,
    this.pointsBalance = 0,
    this.membershipExpiry,
    this.discountType = 'none',
    this.discountValue = 0,
  });

  /// The customer on an order, or null when there is not one.
  ///
  /// Null is the ordinary walk-in sale, and the check then looks exactly as it
  /// did before any of this existed.
  ///
  /// [pointsBalance] is supplied by the caller when the till has a live figure
  /// in hand; it is never read off the order. See the note above.
  static BillCustomer? of(Order? order, {int pointsBalance = 0}) {
    if (order == null) return null;
    final label = (order.customerName ?? '').trim();
    if (label.isEmpty) return null;

    return BillCustomer(
      id: order.customerId,
      name: label,
      phone: order.customerPhone,
      email: order.customerEmail,
      cardNumber: order.customerCardNumber,
      pointsBalance: pointsBalance,
      discountType: order.customerDiscountType,
      discountValue: order.customerDiscountValue,
    );
  }

  final String? id;
  final String name;
  final String? phone;
  final String? email;
  final String? cardNumber;
  final int pointsBalance;
  final DateTime? membershipExpiry;
  final String discountType;
  final int discountValue;

  bool get hasDiscount => discountType != 'none' && discountValue > 0;

  String get discountLabel => switch (discountType) {
        'percent' => '$discountValue% off',
        'amount' => '£${(discountValue / 100).toStringAsFixed(2)} off',
        _ => '',
      };

  bool get isMember => membershipExpiry != null;

  /// Whether the membership has run out. A lapsed member is worth saying,
  /// because the discount on the bill is still theirs and somebody has to
  /// decide whether it should be.
  bool get membershipLapsed {
    final expiry = membershipExpiry;
    return expiry != null && expiry.isBefore(DateTime.now());
  }

  /// Up to two initials, for the disc. "Nicky Tidball" is NT; a one-word name
  /// is its first letter; anything unnameable falls back to a person glyph
  /// rather than an empty circle.
  String get initials {
    final parts = name
        .split(RegExp('[ ]+'))
        .where((p) => p.trim().isNotEmpty)
        .toList();
    if (parts.isEmpty) return '';
    if (parts.length == 1) return parts.first.substring(0, 1).toUpperCase();
    return (parts.first.substring(0, 1) + parts.last.substring(0, 1))
        .toUpperCase();
  }

  /// The contact line, as much of it as there is.
  String get contact => [
        if (phone?.trim().isNotEmpty ?? false) phone!.trim(),
        if (email?.trim().isNotEmpty ?? false) email!.trim(),
        if (cardNumber?.trim().isNotEmpty ?? false) 'Card ${cardNumber!.trim()}',
      ].join('  ·  ');
}

/// The card at the top of the check.
///
/// Tapping it anywhere opens [onChange] — the whole card, not a small pencil,
/// because on a counter the thing being pressed is the thing being looked at.
class CustomerCard extends StatelessWidget {
  const CustomerCard({
    super.key,
    required this.customer,
    this.onChange,
    this.onRemove,
    this.scale = 1,
  });

  final BillCustomer customer;

  /// Pick a different customer. Null while the bill may no longer be amended —
  /// after money has been taken, who it was for is a fact rather than a choice.
  final VoidCallback? onChange;

  /// Take the customer off the bill, and their discount with it.
  final VoidCallback? onRemove;

  /// The payment screen draws everything from a design width; this lets the
  /// card come along rather than sitting at a fixed size inside a scaled panel.
  final double scale;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final s = scale;
    final contact = customer.contact;

    return Material(
      color: scheme.primaryContainer,
      borderRadius: BorderRadius.circular(10 * s),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onChange,
        child: Padding(
          padding: EdgeInsets.fromLTRB(10 * s, 9 * s, 8 * s, 9 * s),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _Disc(initials: customer.initials, scale: s),
              SizedBox(width: 10 * s),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      customer.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 15 * s,
                        fontWeight: FontWeight.w700,
                        color: scheme.onPrimaryContainer,
                      ),
                    ),
                    if (customer.hasDiscount ||
                        customer.pointsBalance > 0 ||
                        customer.isMember) ...[
                      SizedBox(height: 5 * s),
                      Wrap(
                        spacing: 6 * s,
                        runSpacing: 4 * s,
                        children: [
                          if (customer.hasDiscount)
                            _Chip(
                              label: customer.discountLabel,
                              scale: s,
                              emphasis: true,
                            ),
                          if (customer.pointsBalance > 0)
                            _Chip(
                              label: '${customer.pointsBalance} points',
                              scale: s,
                            ),
                          if (customer.membershipLapsed)
                            _Chip(label: 'Membership lapsed', scale: s),
                        ],
                      ),
                    ],
                    if (contact.isNotEmpty) ...[
                      SizedBox(height: 5 * s),
                      Text(
                        contact,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 11.5 * s,
                          height: 1.3,
                          color: scheme.onPrimaryContainer.withValues(
                            alpha: 0.78,
                          ),
                        ),
                      ),
                    ],
                  ],
                ),
              ),
              if (onChange != null || onRemove != null)
                Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (onChange != null)
                      IconButton(
                        onPressed: onChange,
                        visualDensity: VisualDensity.compact,
                        tooltip: 'Change customer',
                        iconSize: 18 * s,
                        icon: Icon(
                          Icons.swap_horiz,
                          color: scheme.onPrimaryContainer,
                        ),
                      ),
                    if (onRemove != null)
                      IconButton(
                        onPressed: onRemove,
                        visualDensity: VisualDensity.compact,
                        tooltip: 'Take off the bill',
                        iconSize: 18 * s,
                        icon: Icon(
                          Icons.person_remove_outlined,
                          color: scheme.onPrimaryContainer,
                        ),
                      ),
                  ],
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Disc extends StatelessWidget {
  const _Disc({required this.initials, required this.scale});

  final String initials;
  final double scale;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;

    return Container(
      width: 34 * scale,
      height: 34 * scale,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: scheme.primary,
        shape: BoxShape.circle,
      ),
      child: initials.isEmpty
          ? Icon(Icons.person, size: 18 * scale, color: scheme.onPrimary)
          : Text(
              initials,
              style: TextStyle(
                fontSize: 13 * scale,
                fontWeight: FontWeight.w700,
                color: scheme.onPrimary,
              ),
            ),
    );
  }
}

class _Chip extends StatelessWidget {
  const _Chip({required this.label, required this.scale, this.emphasis = false});

  final String label;
  final double scale;

  /// The discount gets the solid treatment, because it is the one thing on the
  /// card that changed the number at the bottom of the bill.
  final bool emphasis;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;

    return Container(
      padding: EdgeInsets.symmetric(horizontal: 7 * scale, vertical: 2 * scale),
      decoration: BoxDecoration(
        color: emphasis
            ? scheme.primary
            : scheme.onPrimaryContainer.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(20),
      ),
      child: Text(
        label,
        style: TextStyle(
          fontSize: 11 * scale,
          fontWeight: FontWeight.w700,
          color: emphasis ? scheme.onPrimary : scheme.onPrimaryContainer,
        ),
      ),
    );
  }
}
