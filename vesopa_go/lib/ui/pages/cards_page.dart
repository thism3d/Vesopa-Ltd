/// Every card in one place (owner, 2026-10-30): payment cards and the card
/// machine, staff cards, membership and loyalty cards, and gift cards.
/// A card can be tapped on the device (NFC) or its number typed.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/api.dart';
import '../../data/models.dart';
import '../../data/session.dart';
import '../../nfc/staff_card.dart';
import '../theme.dart';
import 'card_machine_page.dart';
import 'more.dart';

class CardsPage extends ConsumerWidget {
  const CardsPage({super.key});

  void _open(BuildContext context, String title, Widget page) => Navigator.of(context).push(MaterialPageRoute<void>(
        builder: (_) => Scaffold(appBar: AppBar(title: Text(title)), body: page),
      ));

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = Theme.of(context).textTheme;
    Widget group(String title, List<Widget> rows) => Padding(
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 0),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 0, 12, 6),
              child: Text(title.toUpperCase(), style: t.labelSmall?.copyWith(letterSpacing: 0.6, color: context.goMuted)),
            ),
            Card(margin: EdgeInsets.zero, clipBehavior: Clip.antiAlias, child: Column(children: rows)),
          ]),
        );
    return ListView(padding: const EdgeInsets.only(bottom: 24), children: [
      group('Payment cards', [
        ListTile(
          leading: const Icon(Icons.point_of_sale_rounded),
          title: const Text('Card machine'),
          trailing: const Icon(Icons.chevron_right_rounded),
          onTap: () => _open(context, 'Card machine', const CardMachinePage()),
        ),
        ListTile(
          leading: const Icon(Icons.credit_card_rounded),
          title: const Text('Card payments and refunds'),
          trailing: const Icon(Icons.chevron_right_rounded),
          onTap: () => _open(context, 'Card payments', const MorePage()),
        ),
      ]),
      group('Staff cards', [
        ListTile(
          leading: const Icon(Icons.badge_rounded),
          title: const Text('Read a staff card'),
          trailing: const Icon(Icons.contactless_rounded),
          onTap: () async {
            final id = await StaffCardReader.readOnce();
            if (!context.mounted) return;
            ScaffoldMessenger.of(context).showSnackBar(SnackBar(
              content: Text(id == null ? 'No card read' : 'Card $id: put this under the person\'s Staff card in the back office.'),
            ));
          },
        ),
      ]),
      group('Membership and loyalty cards', [
        ListTile(
          leading: const Icon(Icons.card_membership_rounded),
          title: const Text('Check a member\'s card'),
          trailing: const Icon(Icons.chevron_right_rounded),
          onTap: () => _lookup(context, ref, member: true),
        ),
      ]),
      group('Gift cards', [
        ListTile(
          leading: const Icon(Icons.card_giftcard_rounded),
          title: const Text('Check a gift card\'s balance'),
          trailing: const Icon(Icons.chevron_right_rounded),
          onTap: () => _lookup(context, ref, member: false),
        ),
      ]),
    ]);
  }

  /// A card's number, tapped (NFC) or typed, then what it holds.
  Future<void> _lookup(BuildContext context, WidgetRef ref, {required bool member}) async {
    final ctl = TextEditingController();
    final number = await showDialog<String>(
      context: context,
      builder: (c) => AlertDialog(
        scrollable: true,
        title: Text(member ? 'Member\'s card' : 'Gift card'),
        content: TextField(
          controller: ctl,
          autofocus: true,
          decoration: InputDecoration(
            labelText: 'Card number',
            suffixIcon: IconButton(
              tooltip: 'Tap the card',
              icon: const Icon(Icons.contactless_rounded),
              onPressed: () async {
                final id = await StaffCardReader.readOnce();
                if (id != null) ctl.text = id;
              },
            ),
          ),
          onSubmitted: (v) => Navigator.pop(c, v.trim()),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(c, ctl.text.trim()), child: const Text('Look up')),
        ],
      ),
    );
    if (number == null || number.isEmpty || !context.mounted) return;
    String title;
    String body;
    try {
      if (member) {
        final m = await ref.read(apiProvider).member(number);
        title = m.name;
        final pts = m.pointsBalance % 1 == 0 ? m.pointsBalance.toInt().toString() : m.pointsBalance.toStringAsFixed(2);
        body = '${m.number.isEmpty ? '' : 'Member ${m.number}\n'}$pts points, worth ${money(m.balanceWorthMinor)}';
      } else {
        final g = await ref.read(apiProvider).giftCard(number);
        num n(Object? v) => v is num ? v : num.tryParse('${v ?? ''}') ?? 0;
        title = 'Gift card ${g['code'] ?? number}';
        body = '${money(n(g['available_minor'] ?? g['balance_minor']).toInt())} on the card'
            '${g['expired'] == true ? '\nExpired' : ''}';
      }
    } on TapApiError catch (e) {
      title = 'Not found';
      body = e.message;
    }
    if (!context.mounted) return;
    await showDialog<void>(
      context: context,
      builder: (c) => AlertDialog(title: Text(title), content: Text(body), actions: [TextButton(onPressed: () => Navigator.pop(c), child: const Text('Done'))]),
    );
  }
}
