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

import 'package:flutter/foundation.dart' show defaultTargetPlatform, kIsWeb, TargetPlatform;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:vesopa_go/data/models.dart';
import 'package:vesopa_go/data/session.dart';
import 'package:vesopa_go/ui/pages/bill.dart';
import 'package:vesopa_go/ui/pages/more.dart';
import 'package:vesopa_go/ui/pages/tables.dart';
import 'package:vesopa_go/ui/clerk_chip.dart';
import 'package:vesopa_go/payments/payment_service.dart';
import 'package:vesopa_go/ui/appearance.dart';
import 'package:vesopa_go/ui/device_prefs.dart';
import 'package:vesopa_go/ui/go_frame.dart';
import 'package:vesopa_go/ui/theme.dart';
import 'package:vesopa_go/ui/pages/card_machine_page.dart';
import 'package:vesopa_go/ui/pages/customers_page.dart';
import 'package:vesopa_go/ui/pages/module_gates.dart';
import 'package:vesopa_go/ui/product_photo.dart';
import 'package:vesopa_go/ui/sounds.dart';

import '../data/lite_state.dart';
import 'brand.dart';
import 'cash_page.dart';
import 'quick_sale_page.dart';
import 'printer_scan.dart';
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

  @override
  void initState() {
    super.initState();
    // Tap to Pay on iPhone, readied as the app opens (Apple's guidance), so
    // the first customer is not kept waiting on "Getting ready".
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || kIsWeb || defaultTargetPlatform != TargetPlatform.iOS) return;
      final s = ref.read(tapProvider);
      final tablet = MediaQuery.sizeOf(context).shortestSide >= 600;
      final pay = ref.read(paymentsProvider);
      if (pay is DojoTapToPay && cardVia(ref.read(liteSettingsProvider), s.config, tablet: tablet) == 'tap') pay.prepare();
    });
  }

  /// The pages this venue uses: tables and shared bills only beside tills.
  List<(IconData, String, Widget Function())> _pagesFor(TapState s) => [
        (Icons.point_of_sale_rounded, 'Sell', () => const SellPage()),
        if (s.venue?.mode != VenueMode.standalone) ...[
          (Icons.table_restaurant_rounded, 'Tables', () => const TablesPage()),
          (Icons.receipt_rounded, 'Bills', () => const BillsPage()),
        ],
        (Icons.people_alt_rounded, 'Customers', () => const CustomersPage()),
        (Icons.payments_rounded, 'Cash & stock', () => const CashPage()),
        // The venue's choice (back office): every clerk, managers, or not on Go.
        // Only what the venue has switched on (back office, Modules), and
        // the venue's choice of who may use it on Go.
        if (s.config.moduleOn('memberships') && s.config.go.membershipsAccess != 'off')
          (Icons.card_membership_rounded, 'Memberships', () => const MembershipsGate()),
        if (s.config.moduleOn('events') && s.config.go.eventsAccess != 'off')
          (Icons.confirmation_number_rounded, 'Events & tickets', () => const EventsGate()),
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
        title: i == 0 ? const GoLockup(size: 22) : Text(pages[i].$2),
        actions: [
          if (s.demo) const Padding(padding: EdgeInsets.only(right: 4), child: Chip(label: Text('Demo'), visualDensity: VisualDensity.compact)),
          // Quick sale on the sale screen itself (owner, 2026-10-28).
          if (i == 0)
            IconButton(
              tooltip: 'Quick sale',
              icon: const Icon(Icons.dialpad_rounded),
              onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(
                builder: (c) => Scaffold(
                  appBar: AppBar(title: const Text('Quick sale')),
                  body: QuickSalePage(onAdded: () => Navigator.of(c).pop()),
                ),
              )),
            ),
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

class SettingsPage extends ConsumerStatefulWidget {
  const SettingsPage({super.key});
  @override
  ConsumerState<SettingsPage> createState() => _SettingsPageState();
}

/// Settings, grouped and short, the way iOS lays its own out (owner,
/// 2026-10-28: "too much text in the settings").
class _SettingsPageState extends ConsumerState<SettingsPage> {
  String? _nfc;
  bool? _battery;

  @override
  void initState() {
    super.initState();
    _check();
  }

  Future<void> _check() async {
    final nfc = await nfcProblem();
    final battery = await DevicePrefs.batteryUnrestricted();
    if (mounted) {
      setState(() {
        _nfc = nfc;
        _battery = battery;
      });
    }
  }

  Widget _group(String title, List<Widget> rows) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 6),
            child: Text(title.toUpperCase(), style: Theme.of(context).textTheme.labelSmall?.copyWith(letterSpacing: 0.6, color: context.goMuted)),
          ),
          Card(margin: EdgeInsets.zero, clipBehavior: Clip.antiAlias, child: Column(children: rows)),
        ]),
      );

  @override
  Widget build(BuildContext context) {
    final settings = ref.watch(liteSettingsProvider);
    final s = ref.watch(tapProvider);
    final store = ref.read(liteSettingsProvider.notifier);
    final t = Theme.of(context).textTheme;
    final tablet = MediaQuery.sizeOf(context).shortestSide >= 600;
    final via = cardVia(settings, s.config, tablet: tablet);
    final android = defaultTargetPlatform == TargetPlatform.android;
    return ListView(padding: const EdgeInsets.only(bottom: 24), children: [
      _group('Sale', [
        SwitchListTile(title: const Text('Allergen alerts'), value: settings.allergenAlerts, onChanged: (v) => store.set(allergenAlerts: v)),
        SwitchListTile(
          title: const Text('Sounds'),
          value: !GoSounds.muted,
          onChanged: (v) async {
            await GoSounds.setMuted(!v);
            setState(() {});
            if (v) GoSounds.play(s.config.go, GoSound.approved);
          },
        ),
      ]),
      _group('Card payments', [
        if (s.config.teya.enabled)
          const ListTile(leading: Icon(Icons.point_of_sale_rounded), title: Text('Teya card machine'), subtitle: Text('Chosen on the Card machine page'))
        else
          RadioGroup<String>(
            groupValue: settings.cardVia,
            onChanged: (v) => store.set(cardVia: v),
            child: Column(children: [
              RadioListTile(
                value: '',
                title: const Text('The venue\'s choice'),
                subtitle: Text(cardVia(const LiteSettings(), s.config, tablet: tablet) == 'tap' ? 'Tap to Pay' : 'Card machine'),
              ),
              const RadioListTile(value: 'tap', title: Text('Tap to Pay on this device')),
              const RadioListTile(value: 'machine', title: Text('The card machine')),
            ]),
          ),
        // Tap to Pay needs NFC: when it is off or missing, say so and why.
        if (via == 'tap' && _nfc != null)
          ListTile(
            leading: const Icon(Icons.warning_amber_rounded, color: Tp.amber),
            title: const Text('Tap to Pay is unavailable'),
            subtitle: Text(_nfc!),
            trailing: android ? TextButton(onPressed: () => DevicePrefs.openNfcSettings().then((_) => _check()), child: const Text('NFC settings')) : null,
          ),
        if (!s.config.teya.enabled && s.config.softwareHouseId.isNotEmpty)
          ListTile(
            dense: true,
            title: Text('Dojo · ${s.config.environment == 'live' ? 'Live' : 'Sandbox'}'),
            subtitle: Text('Software house ${s.config.softwareHouseId} · Reseller ${s.config.resellerId}'),
          ),
      ]),
      _group('Printing', const [_ReceiptPrinterTile()]),
      _group('Appearance', [
        Padding(
          padding: const EdgeInsets.all(12),
          child: SegmentedButton<ThemeMode>(
            showSelectedIcon: false,
            segments: const [
              ButtonSegment(value: ThemeMode.system, icon: Icon(Icons.brightness_auto_rounded), label: Text('Automatic')),
              ButtonSegment(value: ThemeMode.light, icon: Icon(Icons.light_mode_rounded), label: Text('Light')),
              ButtonSegment(value: ThemeMode.dark, icon: Icon(Icons.dark_mode_rounded), label: Text('Dark')),
            ],
            selected: {ref.watch(appearanceProvider)},
            onSelectionChanged: (v) => ref.read(appearanceProvider.notifier).set(v.first),
          ),
        ),
      ]),
      _group('This device', [
        SwitchListTile(
          title: const Text('Keep the screen on'),
          value: DevicePrefs.keepAwake,
          onChanged: (v) => DevicePrefs.set(awake: v).then((_) => setState(() {})),
        ),
        SwitchListTile(
          title: const Text('Full screen'),
          value: DevicePrefs.fullScreen,
          onChanged: (v) => DevicePrefs.set(full: v).then((_) => setState(() {})),
        ),
        if (android)
          ListTile(
            title: const Text('Battery saving'),
            subtitle: Text(_battery == true ? 'Off for Vesopa Go' : 'On: Android may stop Vesopa Go in the background'),
            trailing: Icon(_battery == true ? Icons.check_circle_rounded : Icons.chevron_right_rounded, color: _battery == true ? Tp.green : null),
            onTap: () => DevicePrefs.openBatterySettings().then((_) => _check()),
          ),
      ]),
      _group('Venue', [
        ListTile(
          leading: const Icon(Icons.sync_rounded),
          title: const Text('Refresh the menu and staff'),
          onTap: s.demo ? null : () => ref.read(tapProvider.notifier).refresh(),
        ),
        ListTile(
          leading: const Icon(Icons.logout_rounded, color: Tp.danger),
          title: Text(s.demo ? 'Leave the demo' : 'Forget this device'),
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
      ]),
      const SizedBox(height: 16),
      Center(child: Text('$appName · ${ref.read(tapProvider.notifier).terminalName}', style: t.bodySmall)),
    ]);
  }
}

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
        // Find it on the Wi-Fi, as the till's printers page does.
        trailing: kIsWeb
            ? null
            : OutlinedButton.icon(
                onPressed: () async {
                  final ip = await pickPrinter(context);
                  if (ip == null) return;
                  await setReceiptPrinter(ip);
                  if (mounted) setState(() => _target = ip);
                },
                icon: const Icon(Icons.wifi_find_rounded),
                label: const Text('Scan'),
              ),
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
