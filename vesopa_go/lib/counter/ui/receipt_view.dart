/// A sale as its receipt reads, on screen; and emailing it, as the back
/// office's own receipt PDF.
library;

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:vesopa_go/config/constants.dart' show apiBase;
import 'package:vesopa_go/data/api.dart';
import 'package:vesopa_go/data/models.dart' show money, TillPermission;
import 'package:vesopa_go/data/session.dart';
import 'package:vesopa_go/ui/theme.dart';

import '../data/journal.dart';

String hhmm(DateTime d) => '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
String ddmmyy(DateTime d) => '${d.day.toString().padLeft(2, '0')}/${d.month.toString().padLeft(2, '0')}/${d.year % 100}';

String payKind(String kind) => switch (kind) {
      'cash' => 'Cash',
      'machine' => 'Card (card machine)',
      _ => 'Card',
    };

/// A sale's receipt as the till prints it (vesopa_epos receipt_builder.dart):
/// the venue's logo, name, address, phone and VAT number from the back
/// office's receipt settings, the header note, each line with its choices
/// underneath, the totals, the VAT breakdown, how it was paid, and the footer.
/// Drawn on white paper in a fixed-width face, at a receipt's width.
class ReceiptView extends ConsumerWidget {
  const ReceiptView({super.key, required this.sale});
  final SaleRecord sale;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = ref.watch(tapProvider);
    final b = s.config.branding;
    String str(String k) => '${b[k] ?? ''}'.trim();
    bool on(String k, {bool byDefault = false}) => b[k] == null ? byDefault : (b[k] == 1 || b[k] == true || b[k] == '1');
    final venue = str('venue_name').isNotEmpty ? str('venue_name') : (s.venue?.name ?? '');
    final address = [str('address_line1'), str('address_line2'), [str('city'), str('postcode')].where((x) => x.isNotEmpty).join(' ')]
        .where((x) => x.isNotEmpty)
        .toList();
    final logo = str('logo_url');
    final logoUrl = logo.isEmpty ? null : (logo.startsWith('http') ? logo : '$apiBase${logo.startsWith('/') ? '' : '/'}$logo');
    const ink = Color(0xFF111111);
    const mono = TextStyle(fontFamily: 'Menlo', fontFamilyFallback: ['Courier New', 'RobotoMono', 'monospace'], fontSize: 13, height: 1.35, color: ink);
    final bold = mono.copyWith(fontWeight: FontWeight.w700);
    Widget centre(String text, [TextStyle? style]) => Text(text, textAlign: TextAlign.center, style: style ?? mono);
    Widget pair(String left, String right, [TextStyle? style]) => Padding(
          padding: const EdgeInsets.symmetric(vertical: 1),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Expanded(child: Text(left, style: style ?? mono)),
            const SizedBox(width: 8),
            Text(right, style: (style ?? mono).copyWith(fontFeatures: Tp.tabular)),
          ]),
        );
    const dashes = Padding(padding: EdgeInsets.symmetric(vertical: 6), child: Text('- - - - - - - - - - - - - - - - - - - -', maxLines: 1, overflow: TextOverflow.clip, style: TextStyle(color: Color(0xFF777777), fontSize: 13)));

    // VAT in the prices, by rate, as the till's breakdown.
    final byRate = <double, int>{};
    for (final l in sale.lines) {
      if (l.taxPercent > 0) byRate.update(l.taxPercent, (v) => v + l.totalMinor, ifAbsent: () => l.totalMinor);
    }
    final vatLines = [
      for (final e in byRate.entries)
        pair('VAT ${e.key % 1 == 0 ? e.key.toStringAsFixed(0) : e.key}%', money((e.value * e.key / (100 + e.key)).round())),
    ];

    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 380),
        child: Container(
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(6),
            boxShadow: const [BoxShadow(color: Color(0x55000000), blurRadius: 18, offset: Offset(0, 6))],
          ),
          padding: const EdgeInsets.fromLTRB(20, 22, 20, 22),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            if (logoUrl != null && on('show_logo'))
              Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: SizedBox(height: 64, child: CachedNetworkImage(imageUrl: logoUrl, fit: BoxFit.contain, errorWidget: (_, _, _) => const SizedBox.shrink())),
              ),
            centre(venue, bold.copyWith(fontSize: 16)),
            for (final a in address) centre(a),
            if (str('phone').isNotEmpty) centre('Tel ${str('phone')}'),
            if (str('website').isNotEmpty) centre(str('website')),
            if (str('vat_number').isNotEmpty) centre('VAT No. ${str('vat_number')}'),
            if (str('company_number').isNotEmpty) centre('Company No. ${str('company_number')}'),
            if (str('header_note').isNotEmpty) ...[const SizedBox(height: 6), centre(str('header_note'))],
            dashes,
            pair('Receipt ${sale.number}', '${ddmmyy(sale.at)} ${hhmm(sale.at)}'),
            if (sale.place.isNotEmpty) pair(sale.place, ''),
            if (on('show_served_by', byDefault: true) && sale.clerk.isNotEmpty) pair('Served by ${sale.clerk}', ''),
            dashes,
            for (final l in sale.lines) ...[
              pair('${l.quantity} ${l.name}', money(l.totalMinor)),
              if (l.detail.isNotEmpty)
                for (final d in l.detail.split(' · ')) Padding(padding: const EdgeInsets.only(left: 18), child: Text('- $d', style: mono.copyWith(color: const Color(0xFF444444)))),
            ],
            dashes,
            if (sale.discountMinor > 0) ...[pair('Subtotal', money(sale.subtotalMinor)), pair('Discount', '-${money(sale.discountMinor)}')],
            pair('TOTAL', money(sale.totalMinor), bold.copyWith(fontSize: 17)),
            const SizedBox(height: 6),
            for (final p in sale.payments) pair(payKind(p.kind), money(p.amountMinor + p.tipMinor)),
            if (sale.tipsMinor > 0) pair('  of which tip', money(sale.tipsMinor)),
            if (sale.changeMinor > 0) pair('Change', money(sale.changeMinor), bold),
            for (final r in sale.refunds) pair('Refund ${hhmm(r.at)} ${r.reason}', '-${money(r.amountMinor)}', mono.copyWith(color: Tp.danger)),
            if (on('show_vat_breakdown', byDefault: true) && vatLines.isNotEmpty) ...[dashes, ...vatLines],
            dashes,
            centre(str('footer_message').isNotEmpty ? str('footer_message') : 'Thank you for your custom', bold),
            if (str('footer_note').isNotEmpty) centre(str('footer_note')),
            if (str('social_line').isNotEmpty) centre(str('social_line')),
            if (on('show_powered_by', byDefault: true)) ...[const SizedBox(height: 8), centre('Powered by Vesopa EPOS', mono.copyWith(fontSize: 11, color: const Color(0xFF777777)))],
          ]),
        ),
      ),
    );
  }
}

/// Ask for an address and email the receipt. The sale reaches the back
/// office through the outbox, so a moment's wait first.
Future<void> emailReceipt(BuildContext context, WidgetRef ref, String saleId) async {
  final email = await showDialog<String>(
    context: context,
    builder: (c) {
      final ctl = TextEditingController();
      return AlertDialog(
        title: const Text('Email the receipt'),
        content: TextField(
          controller: ctl,
          keyboardType: TextInputType.emailAddress,
          autofocus: true,
          decoration: const InputDecoration(labelText: 'Email address'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(c, ctl.text.trim()), child: const Text('Send')),
        ],
      );
    },
  );
  if (email == null || !email.contains('@') || !context.mounted) return;
  final messenger = ScaffoldMessenger.of(context);
  if (ref.read(tapProvider).demo) {
    messenger.showSnackBar(SnackBar(content: Text('Demo: the receipt would go to $email')));
    return;
  }
  try {
    await Future<void>.delayed(const Duration(seconds: 2));
    await ref.read(apiProvider).emailReceipt(saleId, email);
    messenger.showSnackBar(SnackBar(content: Text('Receipt sent to $email')));
  } on TapApiError catch (e) {
    messenger.showSnackBar(SnackBar(content: Text(e.message)));
  }
}

/// May the signed-on clerk do [permission]? If they hold the key, yes, with
/// their name; if not, the till's rule: a manager approves with their PIN.
/// Returns who allowed it, or null.
Future<String?> askManager(BuildContext context, WidgetRef ref, {required String why, TillPermission permission = TillPermission.isManager}) async {
  final s = ref.read(tapProvider);
  if (s.clerk != null && s.clerk!.can(permission)) return s.clerk!.name;
  final pin = await showDialog<String>(
    context: context,
    builder: (c) {
      final ctl = TextEditingController();
      return AlertDialog(
        title: Text(why),
        content: TextField(
          controller: ctl,
          autofocus: true,
          obscureText: true,
          keyboardType: TextInputType.number,
          maxLength: 6,
          decoration: const InputDecoration(labelText: 'A manager\'s PIN', counterText: ''),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(c, ctl.text.trim()), child: const Text('OK')),
        ],
      );
    },
  );
  if (pin == null) return null;
  final manager = ref.read(tapProvider.notifier).managerByPin(pin, permission);
  if (manager == null && context.mounted) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('That PIN cannot ${permission.verb}')));
  }
  return manager?.name;
}
