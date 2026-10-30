/// Serving: the tabs a clerk moves between.
///
///   With Vesopa EPOS   Tables · Bills · Quick sale · More
///   On its own         Sell · Bills · More
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/models.dart';
import '../../data/session.dart';
import '../theme.dart';
import 'bill.dart';
import 'more.dart';
import 'order.dart';
import 'quick_sale.dart';
import 'tables.dart';

class HomePage extends ConsumerStatefulWidget {
  const HomePage({super.key});
  @override
  ConsumerState<HomePage> createState() => _HomePageState();
}

class _HomePageState extends ConsumerState<HomePage> {
  int _tab = 0;

  @override
  Widget build(BuildContext context) {
    final s = ref.watch(tapProvider);
    final connected = s.venue?.mode != VenueMode.standalone;
    final tabs = <(IconData, String, Widget)>[
      if (connected) (Icons.table_restaurant_rounded, 'Tables', const TablesPage()) else (Icons.point_of_sale_rounded, 'Sell', const SellPage()),
      (Icons.receipt_long_rounded, 'Bills', const BillsPage()),
      if (connected) (Icons.dialpad_rounded, 'Quick sale', const QuickSalePage()),
      (Icons.more_horiz_rounded, 'More', const MorePage()),
    ];
    final i = _tab.clamp(0, tabs.length - 1);
    return Scaffold(
      appBar: AppBar(
        title: Text(tabs[i].$2),
        actions: [
          if (!s.online) const Padding(padding: EdgeInsets.only(right: 8), child: Icon(Icons.cloud_off_rounded, color: Tp.amber)),
          Padding(
            padding: const EdgeInsets.only(right: 12),
            child: ActionChip(
              avatar: const Icon(Icons.person_rounded, size: 18),
              label: Text(s.clerk?.name ?? ''),
              onPressed: () => ref.read(tapProvider.notifier).lock(),
              tooltip: 'Sign off',
            ),
          ),
        ],
      ),
      body: Column(children: [
        // "Table 4: food ready" from the kitchen screens, until the clerk clears it.
        if (s.alerts.isNotEmpty)
          MaterialBanner(
            backgroundColor: Tp.lime.withValues(alpha: 0.18),
            leading: Icon(Icons.room_service_rounded, color: context.goLimeInk),
            content: Text(s.alerts.join('\n'), style: const TextStyle(fontWeight: FontWeight.w700)),
            actions: [TextButton(onPressed: () => ref.read(tapProvider.notifier).clearAlerts(), child: const Text('Got it'))],
          ),
        Expanded(child: tabs[i].$3),
      ]),
      bottomNavigationBar: NavigationBar(
        selectedIndex: i,
        onDestinationSelected: (v) => setState(() => _tab = v),
        destinations: [for (final t in tabs) NavigationDestination(icon: Icon(t.$1), label: t.$2)],
      ),
    );
  }
}

/// Standalone selling: straight onto the menu, for a new tab each time.
class SellPage extends ConsumerWidget {
  const SellPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = ref.watch(tapProvider);
    if (s.products.isEmpty) return const QuickSalePage();
    return Padding(
      padding: const EdgeInsets.all(16),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        FilledButton.icon(
          icon: const Icon(Icons.add_rounded),
          label: const Text('New sale'),
          onPressed: () {
            final bill = ref.read(tapProvider.notifier).openTab('Sale ${s.bills.length + 1}');
            Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => OrderPage(billId: bill.id)));
          },
        ),
        const SizedBox(height: 12),
        OutlinedButton.icon(
          icon: const Icon(Icons.dialpad_rounded),
          label: const Text('Type an amount'),
          onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const Scaffold(body: SafeArea(child: QuickSalePage())))),
        ),
        const SizedBox(height: 24),
        const Expanded(child: BillsPage()),
      ]),
    );
  }
}
