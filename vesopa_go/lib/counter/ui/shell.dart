/// Signed on: one app for the counter and the table, from a drawer so the sale
/// screen keeps the whole height of a small terminal.
///
///   Sell        the counter: categories, item keys, View Sale / Pay
///   Tables      with Vesopa EPOS tills: the floor, seat, order, send, fire
///   Bills       every open bill and tab, this phone's and the tills'
///   Quick sale  a typed amount
///   Sales       today's receipts, email, refunds
///   Reports     the day, and End of day
///   Card payments  today's card payments and their refunds, staff cards
///   Settings
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:vesopa_go/data/models.dart';
import 'package:vesopa_go/data/session.dart';
import 'package:vesopa_go/ui/pages/bill.dart';
import 'package:vesopa_go/ui/pages/more.dart';
import 'package:vesopa_go/ui/pages/tables.dart';
import 'package:vesopa_go/ui/clerk_chip.dart';
import 'package:vesopa_go/ui/go_frame.dart';
import 'package:vesopa_go/ui/pages/card_machine_page.dart';
import 'package:vesopa_go/ui/pages/customers_page.dart';
import 'package:vesopa_go/ui/product_photo.dart';
import 'package:vesopa_go/ui/sounds.dart';

import '../data/lite_state.dart';
import 'brand.dart';
import 'quick_sale_page.dart';
import 'receipt_print.dart';
import 'reports_page.dart';
import 'sales_page.dart';
import 'sell_page.dart';

class Shell extends ConsumerStatefulWidget {
  const Shell({super.key});
  @override
  ConsumerState<Shell> createState() => _ShellState();
}

class _ShellState extends ConsumerState<Shell> {
  int _page = 0;

  /// The pages this venue uses: tables and shared bills only beside tills.
  List<(IconData, String, Widget Function())> _pagesFor(TapState s) => [
        (Icons.point_of_sale_rounded, 'Sell', () => const SellPage()),
        if (s.venue?.mode != VenueMode.standalone) ...[
          (Icons.table_restaurant_rounded, 'Tables', () => const TablesPage()),
          (Icons.receipt_rounded, 'Bills', () => const BillsPage()),
        ],
        (Icons.dialpad_rounded, 'Quick sale', () => QuickSalePage(onAdded: () => setState(() => _page = 0))),
        (Icons.people_alt_rounded, 'Customers', () => const CustomersPage()),
        (Icons.receipt_long_rounded, 'Sales', () => const SalesPage()),
        (Icons.insights_rounded, 'Reports', () => const ReportsPage()),
        (Icons.credit_card_rounded, 'Card payments', () => const MorePage()),
        (Icons.point_of_sale_rounded, 'Card machine', () => const CardMachinePage()),
        (Icons.settings_rounded, 'Settings', () => const SettingsPage()),
      ];

  @override
  Widget build(BuildContext context) {
    final s = ref.watch(tapProvider);
    // New menu from the back office: its photos into the cache now.
    ref.listen(tapProvider.select((s) => s.products), (_, products) => warmPhotos(context, products));
    final pages = _pagesFor(s);
    final i = _page.clamp(0, pages.length - 1);
    final body = pages[i].$3();
    return Scaffold(
      appBar: AppBar(
        titleSpacing: 0,
        title: i == 0 ? const GoWordmark(size: 17) : Text(pages[i].$2),
        actions: [
          if (s.demo) const Padding(padding: EdgeInsets.only(right: 4), child: Chip(label: Text('Demo'), visualDensity: VisualDensity.compact)),
          const StatusChips(),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8),
            child: const ClerkChip(),
          ),
        ],
      ),
      drawer: NavigationDrawer(
        selectedIndex: i,
        onDestinationSelected: (i) {
          Navigator.pop(context);
          setState(() => _page = i);
        },
        children: [
          Padding(padding: const EdgeInsets.fromLTRB(24, 20, 16, 4), child: const GoWordmark(size: 18)),
          Padding(
            padding: const EdgeInsets.fromLTRB(28, 4, 16, 16),
            child: Text(s.venue?.name ?? '', style: Theme.of(context).textTheme.bodySmall),
          ),
          for (final p in pages) NavigationDrawerDestination(icon: Icon(p.$1), label: Text(p.$2)),
        ],
      ),
      body: body,
    );
  }
}

class SettingsPage extends ConsumerWidget {
  const SettingsPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final settings = ref.watch(liteSettingsProvider);
    final s = ref.watch(tapProvider);
    final store = ref.read(liteSettingsProvider.notifier);
    final t = Theme.of(context).textTheme;
    return ListView(padding: const EdgeInsets.symmetric(vertical: 8), children: [
      SwitchListTile(
        title: const Text('Allergen alerts'),
        subtitle: const Text('Warn when an item with allergens goes on a sale'),
        value: settings.allergenAlerts,
        onChanged: (v) => store.set(allergenAlerts: v),
      ),
      StatefulBuilder(
        builder: (context, set) => SwitchListTile(
          title: const Text('Sounds on this device'),
          subtitle: const Text('Item added, payment approved or declined, kitchen ready, allergens. Volumes are set in the back office.'),
          value: !GoSounds.muted,
          onChanged: (v) async {
            await GoSounds.setMuted(!v);
            set(() {});
            if (v) GoSounds.play(s.config.go, GoSound.approved);
          },
        ),
      ),
      const Divider(),
      Padding(padding: const EdgeInsets.fromLTRB(16, 8, 16, 4), child: Text('Card payments', style: t.titleSmall)),
      RadioGroup<String>(
        groupValue: settings.cardVia,
        onChanged: (v) => store.set(cardVia: v),
        child: Column(children: [
          RadioListTile(
            value: '',
            title: const Text('The venue\'s choice'),
            subtitle: Text('Set in the back office: ${cardVia(const LiteSettings(), s.config, tablet: MediaQuery.sizeOf(context).shortestSide >= 600) == 'tap' ? 'Tap to Pay on this device' : 'the Dojo card machine'}'),
          ),
          const RadioListTile(value: 'tap', title: Text('On this device'), subtitle: Text('A phone\'s Tap to Pay, or a Dojo handheld terminal')),
          const RadioListTile(value: 'machine', title: Text('On the card machine'), subtitle: Text('The venue\'s Dojo card machine, beside the till')),
        ]),
      ),
      const Divider(),
      const _ReceiptPrinterTile(),
      const Divider(),
      if (s.config.softwareHouseId.isNotEmpty) ...[
        Padding(padding: const EdgeInsets.fromLTRB(16, 8, 16, 4), child: Text('Dojo', style: t.titleSmall)),
        ListTile(
          dense: true,
          leading: const Icon(Icons.verified_rounded),
          title: Text('Software house ID  ${s.config.softwareHouseId}'),
          subtitle: Text('Reseller ID  ${s.config.resellerId} · ${s.config.environment == 'live' ? 'Live' : 'Sandbox'}'),
        ),
        const Divider(),
      ],
      ListTile(
        leading: const Icon(Icons.sync_rounded),
        title: const Text('Refresh the menu and staff'),
        subtitle: Text(s.demo ? 'The demo has its own menu' : 'From the Vesopa back office'),
        onTap: s.demo ? null : () => ref.read(tapProvider.notifier).refresh(),
      ),
      ListTile(
        leading: const Icon(Icons.logout_rounded),
        title: Text(s.demo ? 'Leave the demo' : 'Forget this device'),
        subtitle: Text(s.demo ? 'Back to the start' : 'Sign it out of ${s.venue?.name ?? 'the venue'}; the back office keeps its sales'),
        onTap: () async {
          final ok = s.demo ||
              await showDialog<bool>(
                    context: context,
                    builder: (c) => AlertDialog(
                      title: const Text('Forget this device?'),
                      content: Text(s.pendingSync > 0
                          ? '${s.pendingSync} sales have not reached the back office yet. They will be lost.'
                          : 'It will need signing in again to take sales.'),
                      actions: [
                        TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
                        FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Forget it')),
                      ],
                    ),
                  ) ==
                  true;
          if (ok) await ref.read(tapProvider.notifier).forgetPhone();
        },
      ),
      const SizedBox(height: 24),
      Center(child: Text('$appName · ${ref.read(tapProvider.notifier).terminalName}', style: t.bodySmall)),
    ]);
  }
}

/// This device's receipt printer: a network printer's address, as on the till.
class _ReceiptPrinterTile extends StatefulWidget {
  const _ReceiptPrinterTile();
  @override
  State<_ReceiptPrinterTile> createState() => _ReceiptPrinterTileState();
}

class _ReceiptPrinterTileState extends State<_ReceiptPrinterTile> {
  String _target = '';

  @override
  void initState() {
    super.initState();
    receiptPrinter().then((v) => mounted ? setState(() => _target = v) : null);
  }

  @override
  Widget build(BuildContext context) => ListTile(
        leading: const Icon(Icons.print_rounded),
        title: const Text('Receipt printer'),
        subtitle: Text(_target.isEmpty ? 'None: AirPrint or Android printing, if the venue allows it' : 'Network printer at $_target'),
        onTap: () async {
          final ctl = TextEditingController(text: _target);
          final v = await showDialog<String>(
            context: context,
            builder: (c) => AlertDialog(
              title: const Text('Receipt printer'),
              content: TextField(
                controller: ctl,
                autofocus: true,
                keyboardType: TextInputType.url,
                decoration: const InputDecoration(labelText: 'IP address', hintText: '192.168.1.50 or 192.168.1.50:9100', helperText: 'Empty for none'),
              ),
              actions: [
                TextButton(onPressed: () => Navigator.pop(c), child: const Text('Cancel')),
                FilledButton(onPressed: () => Navigator.pop(c, ctl.text.trim()), child: const Text('Save')),
              ],
            ),
          );
          if (v == null) return;
          await setReceiptPrinter(v);
          if (mounted) setState(() => _target = v);
        },
      );
}
