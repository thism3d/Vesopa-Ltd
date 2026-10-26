/// Signed on: Sell, Sales, Reports and Settings, from a drawer so the sale
/// screen keeps the whole height of a small terminal.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:vesopa_tap/data/session.dart';
import 'package:vesopa_tap/ui/theme.dart';

import '../data/lite_state.dart';
import 'brand.dart';
import 'quick_sale_page.dart';
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

  static const _pages = <(IconData, String)>[
    (Icons.point_of_sale_rounded, 'Sell'),
    (Icons.dialpad_rounded, 'Quick sale'),
    (Icons.receipt_long_rounded, 'Sales'),
    (Icons.insights_rounded, 'Reports'),
    (Icons.settings_rounded, 'Settings'),
  ];

  @override
  Widget build(BuildContext context) {
    final s = ref.watch(tapProvider);
    final body = switch (_page) {
      0 => const SellPage(),
      1 => QuickSalePage(onAdded: () => setState(() => _page = 0)),
      2 => const SalesPage(),
      3 => const ReportsPage(),
      _ => const SettingsPage(),
    };
    return Scaffold(
      appBar: AppBar(
        titleSpacing: 0,
        title: _page == 0 ? const LiteWordmark(size: 17) : Text(_pages[_page].$2),
        actions: [
          if (s.demo) const Padding(padding: EdgeInsets.only(right: 4), child: Chip(label: Text('Demo'), visualDensity: VisualDensity.compact)),
          if (!s.online)
            const Tooltip(message: 'Offline: sales are kept here and sent when the signal is back', child: Icon(Icons.cloud_off_rounded, color: Tp.amber)),
          if (s.pendingSync > 0)
            Padding(
              padding: const EdgeInsets.only(left: 6),
              child: Tooltip(message: '${s.pendingSync} waiting to reach the back office', child: Badge.count(count: s.pendingSync, child: const Icon(Icons.cloud_upload_rounded))),
            ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8),
            child: ActionChip(
              avatar: const Icon(Icons.person_rounded, size: 18),
              label: Text(s.clerk?.name ?? ''),
              tooltip: 'Sign off',
              onPressed: () => ref.read(tapProvider.notifier).lock(),
            ),
          ),
        ],
      ),
      drawer: NavigationDrawer(
        selectedIndex: _page,
        onDestinationSelected: (i) {
          Navigator.pop(context);
          setState(() => _page = i);
        },
        children: [
          Padding(padding: const EdgeInsets.fromLTRB(24, 20, 16, 4), child: const LiteWordmark(size: 18)),
          Padding(
            padding: const EdgeInsets.fromLTRB(28, 4, 16, 16),
            child: Text(s.venue?.name ?? '', style: Theme.of(context).textTheme.bodySmall),
          ),
          for (final p in _pages) NavigationDrawerDestination(icon: Icon(p.$1), label: Text(p.$2)),
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
      const Divider(),
      Padding(padding: const EdgeInsets.fromLTRB(16, 8, 16, 4), child: Text('Card payments', style: t.titleSmall)),
      RadioGroup<String>(
        groupValue: settings.cardVia,
        onChanged: (v) => store.set(cardVia: v),
        child: const Column(children: [
          RadioListTile(value: 'tap', title: Text('On this device'), subtitle: Text('A phone\'s Tap to Pay, or a Dojo handheld terminal')),
          RadioListTile(value: 'machine', title: Text('On the card machine'), subtitle: Text('The venue\'s Dojo card machine, beside the till')),
        ]),
      ),
      const Divider(),
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
