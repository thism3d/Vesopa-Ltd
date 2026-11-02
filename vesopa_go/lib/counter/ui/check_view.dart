/// The payment page's Check tab, as the till's (vesopa_epos PayCheckPanel):
/// the bill read out to the customer, set large, with who it is for, the
/// table and covers, every line with its choices, everything that changes
/// the money (offers, discounts, voucher, service, gratuity) only when it is
/// not nothing, what has been taken and how, and what is left as a headline.
/// Beside it on an iPad, under it on a phone, the bill's own keys (owner,
/// 2026-11-02: "add features, options in this page properly like the till",
/// and no empty half-screen).
library;

import 'package:flutter/material.dart';

import '../../data/models.dart';
import '../../ui/theme.dart';
import 'till_pay_board.dart' show PayPalette;

/// One key on the Check tab.
typedef CheckAction = ({IconData icon, String label, VoidCallback? onTap});

String tenderLabel(String kind) => switch (kind) {
      'cash' => 'Cash',
      'machine' => 'Card machine',
      'tap' => 'Tap to Pay',
      'qr' => 'QR Pay',
      'giftcard' => 'Gift card',
      'deposit' => 'Deposit',
      'points' => 'Points',
      'voucher' => 'Voucher',
      _ => 'Card',
    };

class CheckView extends StatelessWidget {
  const CheckView({super.key, required this.bill, required this.actions, this.presetTipMinor = 0, this.onRemoveMember});
  final Bill bill;
  final List<CheckAction> actions;
  final int presetTipMinor;
  final VoidCallback? onRemoveMember;

  @override
  Widget build(BuildContext context) {
    final wide = MediaQuery.sizeOf(context).width >= 900;
    final keys = _Keys(actions: actions, wide: wide);
    if (!wide) {
      return ListView(padding: const EdgeInsets.all(14), children: [
        _Paper(bill: bill, presetTipMinor: presetTipMinor, onRemoveMember: onRemoveMember, fill: false),
        const SizedBox(height: 14),
        keys,
      ]);
    }
    // The bill fills its side, lines scrolling, the money pinned at the foot.
    final paper = _Paper(bill: bill, presetTipMinor: presetTipMinor, onRemoveMember: onRemoveMember, fill: true);
    return Padding(
      padding: const EdgeInsets.all(16),
      child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Expanded(flex: 3, child: paper),
        const SizedBox(width: 18),
        Expanded(flex: 2, child: keys),
      ]),
    );
  }
}

class _Paper extends StatelessWidget {
  const _Paper({required this.bill, required this.presetTipMinor, required this.fill, this.onRemoveMember});
  final Bill bill;
  final int presetTipMinor;
  final VoidCallback? onRemoveMember;

  /// Fill the height given (iPad): the lines scroll, the money stays put.
  final bool fill;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final pal = PayPalette.of(context);
    final member = bill.member;
    final opened = bill.openedAt;
    String two(int n) => n.toString().padLeft(2, '0');
    final chips = [
      if (bill.tableNumber != null) (Icons.table_restaurant_rounded, 'Table ${bill.tableNumber}'),
      if (bill.covers > 0) (Icons.people_alt_rounded, '${bill.covers} covers'),
      if (bill.clerk.trim().isNotEmpty) (Icons.badge_rounded, bill.clerk.trim()),
      if (opened != null) (Icons.schedule_rounded, 'Opened ${two(opened.hour)}:${two(opened.minute)}'),
      (Icons.receipt_long_rounded, '${bill.lines.fold<int>(0, (s, l) => s + l.quantity)} items'),
    ];

    Widget sum(String label, int minor, {Color? colour, bool big = false}) => Padding(
          padding: EdgeInsets.symmetric(vertical: big ? 6 : 3),
          child: Row(children: [
            Expanded(child: Text(label, style: (big ? t.headlineSmall : t.titleMedium)?.copyWith(fontWeight: big ? FontWeight.w900 : FontWeight.w500, color: colour))),
            Text(money(minor), style: (big ? t.headlineMedium : t.titleMedium)?.copyWith(fontWeight: big ? FontWeight.w900 : FontWeight.w600, color: colour, fontFeatures: Tp.tabular)),
          ]),
        );

    return Container(
      padding: const EdgeInsets.fromLTRB(24, 20, 24, 20),
      decoration: BoxDecoration(color: pal.panel, borderRadius: BorderRadius.circular(18), border: Border.all(color: pal.panelLine)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Text(bill.name, style: t.headlineSmall?.copyWith(fontWeight: FontWeight.w900)),
        const SizedBox(height: 10),
        Wrap(spacing: 8, runSpacing: 8, children: [
          for (final (icon, label) in chips)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              decoration: BoxDecoration(color: pal.keyFill, borderRadius: BorderRadius.circular(99), border: Border.all(color: pal.keyLine)),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                Icon(icon, size: 16, color: pal.inkMuted),
                const SizedBox(width: 6),
                Text(label, style: t.bodyMedium),
              ]),
            ),
        ]),
        if (member != null) ...[
          const SizedBox(height: 14),
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(color: pal.accentFill, borderRadius: BorderRadius.circular(14)),
            child: Row(children: [
              CircleAvatar(
                radius: 20,
                backgroundColor: Tp.lime,
                child: Text(member.name.trim().isEmpty ? '?' : member.name.trim()[0].toUpperCase(), style: const TextStyle(color: Tp.onLime, fontWeight: FontWeight.w900)),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(member.name, style: t.titleMedium?.copyWith(fontWeight: FontWeight.w800)),
                  Text([
                    if (member.number.isNotEmpty) 'Member ${member.number}',
                    '${member.pointsBalance.floor()} points',
                  ].join(' · '), style: t.bodySmall?.copyWith(color: pal.inkMuted)),
                ]),
              ),
              if (onRemoveMember != null && bill.paidMinor == 0)
                IconButton(tooltip: 'Take the customer off', onPressed: onRemoveMember, icon: const Icon(Icons.person_remove_rounded)),
            ]),
          ),
        ],
        Divider(height: 30, color: pal.panelLine),
        ..._wrapLines(fill, [
        for (final l in bill.lines)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 6),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Container(
                width: 40,
                padding: const EdgeInsets.symmetric(vertical: 3),
                alignment: Alignment.center,
                decoration: BoxDecoration(color: pal.accentFill, borderRadius: BorderRadius.circular(8)),
                child: Text('${l.quantity}', style: t.titleMedium?.copyWith(fontWeight: FontWeight.w800, color: context.goLimeInk, fontFeatures: Tp.tabular)),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(l.product.name, style: t.titleMedium?.copyWith(fontSize: 19)),
                  for (final c in l.choices) Text('+ ${c.name}', style: t.bodyMedium?.copyWith(color: pal.inkMuted)),
                  if (l.note.isNotEmpty) Text(l.note, style: t.bodyMedium?.copyWith(color: Tp.blue)),
                ]),
              ),
              Text(money(l.totalMinor), style: t.titleMedium?.copyWith(fontSize: 19, fontFeatures: Tp.tabular)),
            ]),
          ),
        if (bill.lines.isEmpty) Padding(padding: const EdgeInsets.symmetric(vertical: 12), child: Text('Nothing on the bill yet.', style: t.bodyLarge?.copyWith(color: pal.inkMuted))),
        ]),
        Divider(height: 30, color: pal.panelLine),
        if (bill.discountMinor > 0 || bill.serviceMinor > 0) sum('Subtotal', bill.subtotalMinor),
        if (bill.dealMinor > 0) sum('Offers', -bill.dealMinor, colour: context.goLimeInk),
        if (bill.memberDiscountMinor > 0) sum('Member discount', -bill.memberDiscountMinor, colour: context.goLimeInk),
        if (bill.voucherMinor > 0) sum('Voucher${(bill.voucherCode ?? '').isNotEmpty ? ' ${bill.voucherCode}' : ''}', -bill.voucherMinor, colour: context.goLimeInk),
        if (bill.manualDiscountMinor > 0) sum(bill.discountReason.isNotEmpty ? 'Discount · ${bill.discountReason}' : 'Discount', -bill.manualDiscountMinor, colour: context.goLimeInk),
        if (bill.serviceMinor > 0) sum('Service ${bill.serviceChargePercent % 1 == 0 ? bill.serviceChargePercent.toStringAsFixed(0) : bill.serviceChargePercent}%', bill.serviceMinor),
        sum('Total', bill.totalMinor, big: bill.paidMinor == 0),
        for (final x in bill.tenders) sum('${tenderLabel(x.kind)}${x.tipMinor > 0 ? ' (tip ${money(x.tipMinor)})' : ''}', -x.amountMinor, colour: pal.inkMuted),
        if (presetTipMinor > 0) sum('Gratuity on the next card', presetTipMinor, colour: context.goLimeInk),
        if (bill.paidMinor > 0) sum('Left to pay', bill.dueMinor, big: true, colour: context.goDark ? Tp.lime : Tp.limeDeep),
      ]),
    );
  }
}

/// The lines in a scrolling list that takes the room left (iPad), or as
/// they are (phone, inside the page's own list).
List<Widget> _wrapLines(bool fill, List<Widget> lines) =>
    fill ? [Expanded(child: ListView(padding: EdgeInsets.zero, children: lines))] : lines;

class _Keys extends StatelessWidget {
  const _Keys({required this.actions, required this.wide});
  final List<CheckAction> actions;
  final bool wide;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final pal = PayPalette.of(context);
    Widget key(CheckAction a) => Material(
          color: pal.keyFill,
          borderRadius: BorderRadius.circular(16),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: a.onTap,
            child: DecoratedBox(
              decoration: BoxDecoration(borderRadius: BorderRadius.circular(16), border: Border.all(color: pal.keyLine)),
              child: Padding(
                padding: const EdgeInsets.all(14),
                child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
                  Icon(a.icon, size: 30, color: a.onTap == null ? pal.inkMuted : context.goLimeInk),
                  const SizedBox(height: 8),
                  Text(a.label, textAlign: TextAlign.center, maxLines: 2, style: t.titleMedium?.copyWith(fontWeight: FontWeight.w700, color: a.onTap == null ? pal.inkMuted : null)),
                ]),
              ),
            ),
          ),
        );
    final heading = Text('BILL', style: t.labelMedium?.copyWith(letterSpacing: 1.2, color: pal.inkMuted, fontWeight: FontWeight.w700));
    if (!wide) {
      return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        heading,
        const SizedBox(height: 8),
        GridView.count(
          crossAxisCount: 3,
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          mainAxisSpacing: 10,
          crossAxisSpacing: 10,
          childAspectRatio: 1.1,
          children: [for (final a in actions) key(a)],
        ),
      ]);
    }
    // The keys share the full height, two to a row, as the till's board.
    final rows = <List<CheckAction>>[];
    for (var i = 0; i < actions.length; i += 2) {
      rows.add(actions.sublist(i, (i + 2).clamp(0, actions.length)));
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      heading,
      const SizedBox(height: 8),
      for (final r in rows)
        Expanded(
          child: Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              for (var i = 0; i < 2; i++) ...[
                if (i > 0) const SizedBox(width: 10),
                Expanded(child: i < r.length ? key(r[i]) : const SizedBox.shrink()),
              ],
            ]),
          ),
        ),
    ]);
  }
}
