import 'dart:io' show File, Platform, exit;

import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:window_manager/window_manager.dart';

import '../config/constants.dart';
import '../data/fonts.dart';
import '../data/terminal_identity.dart';
import '../main.dart';
import '../payments/connect_pac.dart';
import '../payments/dojo_config.dart';
import '../payments/payment_provider.dart';
import '../printing/printer_transport.dart';
import 'card_diagnostics_page.dart';
import 'layout.dart';
import 'nav_panel_controller.dart';
import 'printers_page.dart';
import 'theme.dart';
import 'theme_controller.dart';
import 'till_actions.dart';
import 'widgets/pos_message.dart';

/// Terminal settings. Anything that belongs to the venue lives in the back
/// office; what is here is specific to *this* screen — chiefly how it looks in
/// the room it stands in.
class SettingsPage extends ConsumerWidget {
  const SettingsPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final mode = ref.watch(themeControllerProvider).value ?? ThemeMode.dark;
    final navMode =
        ref.watch(navPanelControllerProvider).value ?? NavPanelMode.auto;
    final office = ref.watch(officeProvider);
    final api = ref.watch(apiBaseProvider);

    return ListView(
      padding: const EdgeInsets.all(24),
      children: [
        const Text(
          'Settings',
          style: TextStyle(fontSize: 24, fontWeight: FontWeight.w700),
        ),
        const SizedBox(height: 24),

        const _SectionTitle('Appearance'),
        Card(
          margin: EdgeInsets.zero,
          child: RadioGroup<ThemeMode>(
            groupValue: mode,
            onChanged: (value) {
              if (value != null) {
                ref.read(themeControllerProvider.notifier).set(value);
              }
            },
            child: Column(
              children: [
                for (final option in const [
                  (
                    ThemeMode.light,
                    'Day',
                    Icons.light_mode,
                    'Bright rooms and daylight',
                  ),
                  (
                    ThemeMode.dark,
                    'Night',
                    Icons.dark_mode,
                    'Dim bars and evening service',
                  ),
                  (
                    ThemeMode.system,
                    'System',
                    Icons.brightness_auto,
                    'Follow the device setting',
                  ),
                ])
                  RadioListTile<ThemeMode>(
                    value: option.$1,
                    secondary: Icon(option.$3, color: Pos.brandDeep),
                    title: Text(option.$2),
                    subtitle: Text(
                      option.$4,
                      style: const TextStyle(fontSize: 12.5),
                    ),
                  ),
              ],
            ),
          ),
        ),

        const SizedBox(height: 28),
        const SizedBox(height: 24),
        const _FontsCard(),

        const _SectionTitle('Side menu'),
        Card(
          margin: EdgeInsets.zero,
          child: RadioGroup<NavPanelMode>(
            groupValue: navMode,
            onChanged: (value) {
              if (value != null) {
                ref.read(navPanelControllerProvider.notifier).set(value);
              }
            },
            child: Column(
              children: [
                for (final option in NavPanelMode.values)
                  RadioListTile<NavPanelMode>(
                    value: option,
                    secondary: Icon(switch (option) {
                      NavPanelMode.auto => Icons.auto_awesome_mosaic,
                      NavPanelMode.fixed => Icons.view_sidebar,
                      NavPanelMode.hidden => Icons.menu_open,
                    }, color: Pos.brandDeep),
                    title: Text(option.label),
                    subtitle: Text(
                      option.blurb,
                      style: const TextStyle(fontSize: 12.5),
                    ),
                  ),
                // Said here rather than left as a surprise: "Always show" on a
                // phone still opens from the menu key, because 208px of
                // navigation on a phone leaves no room to take a sale.
                if (context.isPhone && navMode == NavPanelMode.fixed)
                  const Padding(
                    padding: EdgeInsets.fromLTRB(16, 0, 16, 14),
                    child: Text(
                      'This screen is too narrow to keep the menu on show, so '
                      'it opens from the menu key here. It will stay on show '
                      'on a tablet or a desktop till.',
                      style: TextStyle(fontSize: 12.5),
                    ),
                  ),
              ],
            ),
          ),
        ),

        const SizedBox(height: 28),
        const _SectionTitle('Idle screen'),
        const _IdleImageCard(),

        const SizedBox(height: 28),
        const _SectionTitle('This terminal'),
        Card(
          margin: EdgeInsets.zero,
          child: Column(
            children: [
              _Row(icon: Icons.storefront, label: 'Office', value: office),
              const Divider(height: 1),
              // What this machine calls itself, which matters the moment a
              // venue has two of them: it names the terminal a bill is open
              // on, the one a clerk is signed on to, and the one a shift was
              // clocked in at. Defaults to the computer's own host name,
              // because that is already different on the two machines.
              const _TerminalNameRow(),
              const Divider(height: 1),
              // Names the environment as well as the URL: on a live till this
              // is the fastest way to confirm the sale you just took went to
              // the real server and not a developer's laptop.
              _Row(
                icon: Api.isLive ? Icons.cloud_done : Icons.cloud_outlined,
                label: 'Server (${server.name})',
                value: api,
              ),
              const Divider(height: 1),
              _Row(
                icon: Icons.sync,
                // "Catalogue" named the data; staff asking for this key ask
                // for the thing it does. It pulls products, deals, departments
                // and staff, so the old name was also only a third true.
                label: 'Refresh Data',
                value: 'Products, deals and staff from the back office',
                trailing: TextButton(
                  onPressed: () => TillActions.refreshData(context, ref),
                  child: const Text('Refresh'),
                ),
              ),
            ],
          ),
        ),

        const SizedBox(height: 28),
        const _SectionTitle('Card payments'),
        _DojoCard(),
        const SizedBox(height: 8),
        Card(
          margin: EdgeInsets.zero,
          child: ListTile(
            leading: const Icon(Icons.troubleshoot, color: Pos.brandDeep),
            title: const Text('Card diagnostics'),
            subtitle: const Text(
              'Test the connection, list machines, and see exactly what the '
              'card platform returns.',
              style: TextStyle(fontSize: 12.5),
            ),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => const CardDiagnosticsPage(),
              ),
            ),
          ),
        ),

        const SizedBox(height: 28),
        const _SectionTitle('Printing'),
        Card(
          margin: EdgeInsets.zero,
          child: Column(
            children: [
              const Padding(
                padding: EdgeInsets.fromLTRB(16, 16, 16, 8),
                child: Row(
                  children: [
                    Icon(Icons.print, color: Pos.brandDeep),
                    SizedBox(width: 14),
                    Expanded(
                      child: Text(
                        'Printers belong to this terminal, because they are '
                        'plugged into it. Every document can go to its own '
                        'printer, and a USB printer is driven directly, '
                        'without the Windows spooler.',
                        style: TextStyle(fontSize: 13, height: 1.4),
                      ),
                    ),
                  ],
                ),
              ),
              // Live summary of what is actually configured, so a missing
              // kitchen printer is visible without opening the page.
              Consumer(
                builder: (context, ref, _) {
                  final settings = ref.watch(printerSettingsProvider).value;
                  final receipt = settings?.receiptPrinter;
                  // Named individually rather than counted: "2 kitchen
                  // printers" does not tell a manager whether the one they
                  // just routed a product to is the one that is missing.
                  final kitchen = [
                    for (final target in PrintTarget.kitchenStations)
                      if (settings?.deviceFor(target) != null) target.label,
                  ];
                  return ListTile(
                    leading: const Icon(Icons.settings_outlined),
                    title: const Text('Set up printers'),
                    subtitle: Text(
                      [
                        receipt == null
                            ? 'No receipt printer'
                            : 'Receipt: ${receipt.name} '
                                  '(${receipt.paperWidthMm}mm, '
                                  '${receipt.isDirect ? 'direct' : 'spooled'})',
                        kitchen.isEmpty
                            ? 'No kitchen printers'
                            : kitchen.join(', '),
                      ].join('  ·  '),
                    ),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: () => Navigator.of(context).push(
                      MaterialPageRoute<void>(
                        builder: (_) => Scaffold(
                          appBar: AppBar(title: const Text('Printers')),
                          body: const PrintersPage(),
                        ),
                      ),
                    ),
                  );
                },
              ),
            ],
          ),
        ),

        // ---- Closing the till ------------------------------------------
        //
        // The window has no X and no minimise button (see _lockWindowToKiosk
        // in main.dart): a till a customer can minimise from across the
        // counter, or close outright, stops taking money. That leaves this as
        // the only way out, so it has to be here and it has to be findable.
        if (_canQuit) ...[
          const SizedBox(height: 28),
          const _SectionTitle('Close the till'),
          Card(
            margin: EdgeInsets.zero,
            child: ListTile(
              leading: const Icon(Icons.power_settings_new, color: Pos.red),
              title: const Text('Exit application'),
              subtitle: const Text(
                'Shuts the till down completely. Cash up first — any bill left '
                'open stays open and will be waiting when you start again.',
                style: TextStyle(fontSize: 12.5),
              ),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => _confirmExit(context),
            ),
          ),
        ],
        const SizedBox(height: 24),
      ],
    );
  }

  /// Only desktop has a window to close. On Android and iOS the OS owns the
  /// app's lifecycle and a self-quit button is both unnecessary and, on iOS,
  /// grounds for rejection.
  bool get _canQuit => Platform.isWindows || Platform.isMacOS || Platform.isLinux;

  /// Ask before quitting.
  ///
  /// This is one tap away from ending service, and the same finger that reaches
  /// for Printing is inches from it — so the confirmation is not ceremony, it
  /// is the thing standing between a mis-tap and a dark till.
  Future<void> _confirmExit(BuildContext context) async {
    final quit = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        icon: const Icon(Icons.power_settings_new, size: 30, color: Pos.red),
        title: const Text('Exit Vesopa EPOS?'),
        content: const Text(
          'The till will close and stop taking sales until someone starts it '
          'again.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Stay open'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            style: FilledButton.styleFrom(backgroundColor: Pos.red),
            child: const Text('Exit'),
          ),
        ],
      ),
    );

    if (quit != true) return;

    // destroy(), not close(): the window was made unclosable at startup, and a
    // close request against it is simply ignored. destroy() tears it down
    // regardless, and exit(0) is the backstop if the platform channel is not
    // there for any reason.
    try {
      await windowManager.destroy();
    } catch (_) {
      exit(0);
    }
  }
}

/// Card payment configuration. Shows whether cards are set up on this terminal
/// and lets the operator enter or change the credentials on the device.
class _DojoCard extends ConsumerWidget {
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final config = ref.watch(dojoConfigProvider).value ?? const DojoConfig();
    final configured = config.configured;

    return Card(
      margin: EdgeInsets.zero,
      child: Column(
        children: [
          ListTile(
            leading: Icon(
              configured ? Icons.credit_card : Icons.credit_card_off,
              color: configured ? Pos.green : Theme.of(context).hintColor,
            ),
            title: Text(
              configured
                  ? '${config.platform.label} card payments on'
                  : 'Card not set up',
            ),
            subtitle: Text(
              configured
                  ? '${config.sandbox ? 'Sandbox' : 'Live'} · '
                        '${Uri.tryParse(config.normalisedBaseUrl)?.host ?? config.baseUrl}\n'
                        'Key ${_masked(config.apiKey)}\n'
                        '${_howCardsAreTaken(config)}'
                  : 'Enter your card API URL and key to take card payments on '
                        'this till.',
              style: const TextStyle(fontSize: 12.5),
            ),
            isThreeLine: configured,
            trailing: TextButton(
              onPressed: () => _edit(context, ref, config),
              child: Text(configured ? 'Edit' : 'Set up'),
            ),
          ),
        ],
      ),
    );
  }

  /// Spell out how this terminal will actually present a card, because it
  /// differs by acquirer, by platform and by what has been filled in — and a
  /// clerk who does not know which route is live cannot tell a
  /// misconfiguration from a decline.
  static String _howCardsAreTaken(DojoConfig config) {
    final hasTerminal = config.terminalId.trim().isNotEmpty;
    final wallet = config.walletEnabled ? ' Google Pay is on.' : '';

    if (config.platform == CardPlatform.connect) {
      // Connect runs everything on the PDQ, so a missing TID is fatal to both
      // buttons rather than a fallback to something else.
      return hasTerminal
          ? 'Card and manual card both run on PDQ ${config.terminalId} — '
                'manual opens its keypad.'
          : 'No PDQ set. Connect takes every card on the machine, so nothing '
                'can be charged until one is chosen.';
    }

    final hasPartnerIds =
        config.softwareHouseId.trim().isNotEmpty &&
        config.resellerId.trim().isNotEmpty;

    if (hasTerminal && hasPartnerIds) {
      return 'Card: pay at counter on machine ${config.terminalId}. '
          '${_keyedRoute()}$wallet';
    }
    if (hasTerminal) {
      // The ids are not optional: Dojo refuses the terminal call without both,
      // so say so here rather than letting it fail at the moment of payment.
      return 'Card machine set, but the software-house / reseller ids are '
          'incomplete — every card will be keyed instead.';
    }
    return 'No card machine, so Card falls back to keyed entry. '
        '${_keyedRoute()}$wallet';
  }

  static String _keyedRoute() => Platform.isAndroid
      ? 'Manual card: card entry on this device (Dojo drop-in).'
      : 'Manual card: Dojo checkout inside the till.';

  /// Never show the full key back — enough to recognise it, no more.
  static String _masked(String key) {
    final k = key.trim();
    if (k.length <= 6) return '••••';
    return '${k.substring(0, 4)}…${k.substring(k.length - 2)}';
  }

  Future<void> _edit(
    BuildContext context,
    WidgetRef ref,
    DojoConfig current,
  ) async {
    final saved = await showDialog<DojoConfig>(
      context: context,
      builder: (_) => _DojoEditor(current: current),
    );
    if (saved == null) return;
    await ref.read(dojoConfigProvider.notifier).save(saved);
    if (context.mounted) {
      PosMessenger.success(
        context,
        saved.configured
            ? 'Card payments configured.'
            : 'Card payments turned off.',
      );
    }
  }
}

class _DojoEditor extends StatefulWidget {
  const _DojoEditor({required this.current});

  final DojoConfig current;

  @override
  State<_DojoEditor> createState() => _DojoEditorState();
}

/// One card machine as the picker shows it, whichever acquirer it came from.
typedef _Reader = ({String id, String label, String status});

class _DojoEditorState extends State<_DojoEditor> {
  late final _url = TextEditingController(text: widget.current.baseUrl);
  late final _key = TextEditingController(text: widget.current.apiKey);
  late final _terminal = TextEditingController(text: widget.current.terminalId);
  late final _softwareHouse = TextEditingController(
    text: widget.current.softwareHouseId,
  );
  late final _reseller = TextEditingController(text: widget.current.resellerId);
  late final _walletName = TextEditingController(
    text: widget.current.walletMerchantName,
  );
  late final _walletMerchant = TextEditingController(
    text: widget.current.walletMerchantId,
  );
  late final _walletGateway = TextEditingController(
    text: widget.current.walletGatewayMerchantId,
  );
  late bool _sandbox = widget.current.sandbox;

  /// Which acquirer this till talks to — an explicit choice, not guessed from
  /// the URL. Switching it swaps in that platform's preset URL and key and
  /// relabels the partner-id fields, which mean different things to each.
  late CardPlatform _platform = widget.current.platform;

  /// Readers found on the account, so the clerk picks one instead of copying an
  /// opaque id out of a portal.
  List<_Reader>? _terminals;
  bool _loadingTerminals = false;
  String? _terminalError;

  bool get _isConnect => _platform == CardPlatform.connect;

  /// Whether the URL in the box belongs to the chosen platform. A Dojo platform
  /// with a Connect host (or the reverse) will fail every call, so the dialog
  /// warns rather than letting it be saved silently.
  bool get _urlMismatch =>
      _url.text.trim().isNotEmpty &&
      CardPlatform.forUrl(_url.text) != _platform;

  @override
  void dispose() {
    _url.dispose();
    _key.dispose();
    _terminal.dispose();
    _softwareHouse.dispose();
    _reseller.dispose();
    _walletName.dispose();
    _walletMerchant.dispose();
    _walletGateway.dispose();
    super.dispose();
  }

  DojoConfig get _asConfig => DojoConfig(
    baseUrl: _url.text.trim(),
    apiKey: _key.text.trim(),
    platform: _platform,
    terminalId: _terminal.text.trim(),
    softwareHouseId: _softwareHouse.text.trim(),
    resellerId: _reseller.text.trim(),
    sandbox: _sandbox,
    walletMerchantName: _walletName.text.trim(),
    walletMerchantId: _walletMerchant.text.trim(),
    walletGatewayMerchantId: _walletGateway.text.trim(),
  );

  /// Load the shipped preset for the chosen platform in an environment. URL and
  /// key move together: a live key against a sandbox host (or the reverse)
  /// authenticates against nothing, and half-switching is the easiest mistake
  /// to make here.
  void _usePreset({required bool sandbox}) =>
      _loadPreset(platform: _platform, sandbox: sandbox);

  /// Switch the acquirer. The URL and key are replaced with that platform's
  /// preset so the two never disagree, and the reader is cleared because a Dojo
  /// terminal id is meaningless to Connect and vice versa.
  void _usePlatform(CardPlatform platform) =>
      _loadPreset(platform: platform, sandbox: _sandbox);

  void _loadPreset({required CardPlatform platform, required bool sandbox}) {
    final preset = widget.current.withPreset(
      platform: platform,
      sandbox: sandbox,
    );
    setState(() {
      _platform = platform;
      _sandbox = sandbox;
      _url.text = preset.baseUrl;
      _key.text = preset.apiKey;
      _terminal.clear();
      _terminals = null;
      _terminalError = null;
    });
  }

  Future<void> _findTerminals() async {
    setState(() {
      _loadingTerminals = true;
      _terminalError = null;
    });
    try {
      final config = _asConfig;
      final found = _isConnect
          ? (await ConnectPacProvider(
                  baseUrl: config.normalisedBaseUrl,
                  apiKey: config.apiKey,
                  softwareHouseId: config.softwareHouseId,
                  installerId: config.resellerId,
                ).listTerminals())
                // Connect identifies a machine by the number printed on it, so
                // there is nothing opaque to hide behind a label.
                .map((t) => (id: t.tid, label: t.tid, status: t.status))
                .toList()
          : (await DojoProvider(
                  baseUrl: config.normalisedBaseUrl,
                  apiKey: config.apiKey,
                  softwareHouseId: config.softwareHouseId,
                  resellerId: config.resellerId,
                ).listTerminals())
                .map((t) => (id: t.id, label: t.label, status: t.status))
                .toList();
      if (mounted) setState(() => _terminals = found);
    } catch (e) {
      if (mounted) setState(() => _terminalError = '$e');
    } finally {
      if (mounted) setState(() => _loadingTerminals = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final hint = Theme.of(context).hintColor;
    final connect = _isConnect;

    return AlertDialog(
      title: const Text('Card payments'),
      // Scrollable so the on-screen keyboard cannot overflow the fields on a
      // phone.
      content: SizedBox(
        width: 440,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Choose the card platform first, then the environment. Each '
                'loads its own URL and key, which you can still edit — a key '
                'only works against the host it was issued for.',
                style: Theme.of(context).textTheme.bodyMedium,
              ),
              const SizedBox(height: 14),

              // The platform is the primary choice: Dojo and Paymentsense
              // Connect are two different APIs, and picking one loads its URL and
              // key rather than the operator guessing the host.
              Text(
                'Card platform',
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                  color: hint,
                ),
              ),
              const SizedBox(height: 6),
              SegmentedButton<CardPlatform>(
                segments: const [
                  ButtonSegment(
                    value: CardPlatform.dojo,
                    icon: Icon(Icons.bolt, size: 17),
                    label: Text('Dojo'),
                  ),
                  ButtonSegment(
                    value: CardPlatform.connect,
                    icon: Icon(Icons.point_of_sale, size: 17),
                    label: Text('Paymentsense'),
                  ),
                ],
                selected: {_platform},
                onSelectionChanged: (s) => _usePlatform(s.first),
              ),
              const SizedBox(height: 6),
              Text(
                connect
                    ? 'Paymentsense Connect: each card runs on the PDQ, over the '
                          'live WebSocket (REST if it will not open).'
                    : 'Dojo: payment intents over the REST API. No card machine '
                          'WebSocket — Dojo has only the one API surface.',
                style: TextStyle(fontSize: 12, color: hint),
              ),
              const SizedBox(height: 14),

              // One tap for each shipped environment, because switching by hand
              // means pasting two values correctly under time pressure.
              SegmentedButton<bool>(
                segments: const [
                  ButtonSegment(
                    value: true,
                    icon: Icon(Icons.science_outlined, size: 17),
                    label: Text('Sandbox'),
                  ),
                  ButtonSegment(
                    value: false,
                    icon: Icon(Icons.verified_outlined, size: 17),
                    label: Text('Live'),
                  ),
                ],
                selected: {_sandbox},
                onSelectionChanged: (s) => _usePreset(sandbox: s.first),
              ),
              const SizedBox(height: 6),
              Text(
                _sandbox
                    ? (connect
                          // Connect has no sandbox host — the merchant account
                          // is live only — so be honest rather than implying a
                          // safe test mode that does not exist here.
                          ? 'Paymentsense Connect has no sandbox account. Test '
                                'on Dojo, or enter a Connect test host and key '
                                'by hand if you have one.'
                          : 'Test money only. Nothing is charged.')
                    : 'Live. Cards taken here are charged for real.',
                style: TextStyle(
                  fontSize: 12,
                  color: _sandbox && !connect ? hint : Pos.red,
                  fontWeight: _sandbox && !connect
                      ? FontWeight.normal
                      : FontWeight.w600,
                ),
              ),
              const SizedBox(height: 14),

              // The URL comes before the key deliberately: it is what the key
              // is scoped to, and reading them in the other order invites
              // pasting a live key against a sandbox host.
              TextField(
                controller: _url,
                autofocus: true,
                keyboardType: TextInputType.url,
                decoration: InputDecoration(
                  labelText: '${_platform.label} API URL',
                  hintText: connect
                      ? 'https://<account>.connect.paymentsense.cloud'
                      : 'https://api.dojo.tech',
                  helperText: _urlMismatch
                      ? 'This looks like a '
                            '${CardPlatform.forUrl(_url.text).label} host, but '
                            '${_platform.label} is selected.'
                      : 'Host for the ${_platform.label} account',
                  helperStyle: _urlMismatch
                      ? const TextStyle(color: Pos.red)
                      : null,
                  helperMaxLines: 3,
                  border: const OutlineInputBorder(),
                ),
                onChanged: (_) => setState(() {
                  // A different host means different machines, and may not match
                  // the chosen platform any more.
                  _terminals = null;
                  _terminalError = null;
                }),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _key,
                decoration: InputDecoration(
                  labelText: 'API key',
                  hintText: connect
                      ? '00000000-0000-0000-0000-000000000000'
                      : 'sk_sandbox_…',
                  border: const OutlineInputBorder(),
                ),
              ),

              const Divider(height: 30),
              Text(
                connect
                    ? 'Connect takes every card on the PDQ — a presented card '
                          'normally, a keyed one with the machine\'s keypad. '
                          'Both ids are issued by Paymentsense.'
                    : 'Card machine (pay at counter). With a machine selected '
                          'the Card key is taken on it; Manual card is always '
                          'keyed. Both partner ids are required — the machine '
                          'list is refused if either is missing.',
                style: TextStyle(fontSize: 12, color: hint),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _softwareHouse,
                decoration: const InputDecoration(
                  labelText: 'Software-house id',
                  border: OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _reseller,
                decoration: InputDecoration(
                  // The same value, under the name each acquirer prints on it.
                  labelText: connect ? 'Installer id' : 'Reseller id',
                  border: const OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _terminal,
                decoration: InputDecoration(
                  labelText: connect
                      ? 'Card machine TID'
                      : 'Card machine (blank = none)',
                  border: const OutlineInputBorder(),
                  helperText: _terminal.text.isEmpty
                      ? (connect
                            ? 'Required: Connect has no other way to take a card.'
                            : 'No machine: every card is keyed instead.')
                      : null,
                  suffixIcon: _terminal.text.isEmpty
                      ? null
                      : IconButton(
                          tooltip: 'Use no card machine',
                          icon: const Icon(Icons.clear),
                          onPressed: () => setState(_terminal.clear),
                        ),
                ),
              ),
              const SizedBox(height: 10),
              Row(
                children: [
                  OutlinedButton.icon(
                    onPressed: _loadingTerminals ? null : _findTerminals,
                    icon: _loadingTerminals
                        ? const SizedBox(
                            width: 14,
                            height: 14,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.search, size: 18),
                    label: const Text('Find card machines'),
                  ),
                ],
              ),
              if (_terminalError != null)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Text(
                    _terminalError!,
                    style: const TextStyle(fontSize: 12, color: Pos.red),
                  ),
                ),
              if (_terminals != null) ...[
                const SizedBox(height: 8),
                if (_terminals!.isEmpty)
                  Text(
                    'No card machines online on this account. A PDQ has to be '
                    'powered up and paired before it appears here.',
                    style: TextStyle(fontSize: 12, color: hint),
                  )
                else
                  // Tap to select — the id goes in the field, so what is saved
                  // is still just the id.
                  for (final t in _terminals!)
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      dense: true,
                      leading: Icon(
                        _terminal.text.trim() == t.id
                            ? Icons.radio_button_checked
                            : Icons.radio_button_unchecked,
                        color: _terminal.text.trim() == t.id ? Pos.brand : hint,
                      ),
                      onTap: () => setState(() => _terminal.text = t.id),
                      title: Text(t.label),
                      subtitle: Text(
                        '${t.status} · ${t.id}',
                        style: const TextStyle(fontSize: 11),
                      ),
                    ),
              ],

              // ---- Google Pay -------------------------------------------
              // Shown on Android in both environments, so the details stay put
              // when the till is switched between sandbox and live rather than
              // appearing to have been lost.
              if (Platform.isAndroid) ...[
                const Divider(height: 30),
                Text(
                  connect
                      // Worth saying plainly: on a Connect account a phone is
                      // just a contactless card at the PDQ, so the wallet needs
                      // no set-up — but the fields stay visible and saved for
                      // whichever environment does use the drop-in.
                      ? 'Google Pay. A Connect card machine accepts a phone as '
                            'an ordinary contactless tap, so nothing here is '
                            'required for it. These details are kept for the '
                            'in-app card screen, which is what renders a Google '
                            'Pay button.'
                      : 'Google Pay. Shown in the card-entry screen once these '
                            'are filled in, and hidden while they are blank. '
                            'The merchant id comes from the Google Pay & Wallet '
                            'Console; the gateway id is how Dojo knows this '
                            'venue.',
                  style: TextStyle(fontSize: 12, color: hint),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: _walletName,
                  decoration: const InputDecoration(
                    labelText: 'Merchant name (shown to the customer)',
                    border: OutlineInputBorder(),
                  ),
                  onChanged: (_) => setState(() {}),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: _walletMerchant,
                  decoration: const InputDecoration(
                    labelText: 'Google Pay merchant id',
                    helperText: 'Only required once live',
                    border: OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: _walletGateway,
                  decoration: const InputDecoration(
                    labelText: 'Dojo gateway merchant id',
                    border: OutlineInputBorder(),
                  ),
                  onChanged: (_) => setState(() {}),
                ),
                const SizedBox(height: 8),
                Text(
                  !_asConfig.walletEnabled
                      ? 'Google Pay is off until the merchant name and gateway '
                            'id are both set.'
                      : connect
                      ? 'Saved. On this card machine a phone is taken as a '
                            'contactless card either way.'
                      : _sandbox
                      ? 'Google Pay will appear, in Google\'s TEST environment '
                            '— no real card is charged.'
                      : 'Google Pay will appear and charge live cards.',
                  style: TextStyle(
                    fontSize: 12,
                    color: _asConfig.walletEnabled ? Pos.green : hint,
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: () => Navigator.pop(context, _asConfig),
          child: const Text('Save'),
        ),
      ],
    );
  }
}

/// The idle-screen background for *this* terminal.
///
/// A per-terminal override of what the back office set, because it is a
/// per-terminal decision: a venue with a screen in the window and one behind the
/// bar may well not want the same picture on both.
///
/// The path is stored, not a copy of the file. If the operator later replaces the
/// image at that path the till follows, which is what someone swapping a seasonal
/// picture actually wants — and it means the till is not quietly accumulating
/// duplicates of every background ever chosen.
class _IdleImageCard extends ConsumerWidget {
  const _IdleImageCard();

  Future<void> _choose(BuildContext context, WidgetRef ref) async {
    // Named the same way the back office names its uploads, so a manager who has
    // seen one recognises the other.
    const images = XTypeGroup(
      label: 'Images',
      extensions: <String>['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif'],
    );

    try {
      final file = await openFile(acceptedTypeGroups: const [images]);
      if (file == null) return;
      await ref.read(idleImageOverrideProvider.notifier).set(file.path);
      if (context.mounted) {
        PosMessenger.success(context, 'This terminal will use that picture.');
      }
    } catch (e) {
      // A file dialog that cannot open is not worth crashing a till over.
      if (context.mounted) {
        PosMessenger.error(context, 'Could not open the file browser.\n\n$e');
      }
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final override = ref.watch(idleImageOverrideProvider).value;
    final settings = ref.watch(tillSettingsProvider);
    final hasOverride = override != null && override.isNotEmpty;
    final missing = hasOverride && !File(override).existsSync();

    return Card(
      margin: EdgeInsets.zero,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ListTile(
            leading: const Icon(Icons.image_outlined, color: Pos.brandDeep),
            title: Text(
              hasOverride ? 'Chosen on this terminal' : 'From the back office',
            ),
            subtitle: Text(
              switch ((hasOverride, missing, settings.idleImageUrl)) {
                // Chosen here, but the file has since moved. Said plainly: the
                // till is showing the back office's picture, not this one.
                (true, true, _) =>
                  'That file is no longer there, so the back office picture is '
                      'being shown instead.\n$override',
                // Non-null whenever hasOverride is true — that is what it tests.
                (true, false, _) => override!,
                (false, _, final url?) =>
                  'Set for the whole venue in the back office.\n$url',
                (false, _, null) =>
                  'No picture set, so the till shows the built-in Vesopa screen.',
              },
              style: const TextStyle(fontSize: 12.5),
            ),
            isThreeLine: hasOverride || settings.idleImageUrl != null,
          ),
          const Divider(height: 1),
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
            child: Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                FilledButton.icon(
                  onPressed: () => _choose(context, ref),
                  icon: const Icon(Icons.folder_open, size: 18),
                  label: Text(
                    hasOverride ? 'Choose another picture' : 'Choose a picture',
                  ),
                ),
                if (hasOverride)
                  OutlinedButton.icon(
                    onPressed: () async {
                      await ref
                          .read(idleImageOverrideProvider.notifier)
                          .set(null);
                      if (context.mounted) {
                        PosMessenger.info(
                          context,
                          'Back to the back office picture.',
                        );
                      }
                    },
                    icon: const Icon(Icons.undo, size: 18),
                    label: const Text('Use the venue picture'),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// The lettering this venue's tills wear, changed from the counter.
///
/// Venue-wide, not per terminal, and that is worth being clear about because
/// every other card on this page under "This terminal" is not. It is on this
/// page anyway for a reason that only makes sense standing at a counter: the
/// question a font has to answer is "can a clerk read that across a bar at
/// half past ten", and that question cannot be answered from an office. A
/// manager who has to walk to a desk, change it, and walk back to look will
/// pick a font once and never revisit it.
///
/// So the picker writes straight through to the back office on a terminal
/// token, and every till in the venue is told. See `PUT /api/till/font`.
class _FontsCard extends ConsumerStatefulWidget {
  const _FontsCard();

  @override
  ConsumerState<_FontsCard> createState() => _FontsCardState();
}

class _FontsCardState extends ConsumerState<_FontsCard> {
  bool _busy = false;

  /// Send a font file from this terminal's disk to the back office.
  ///
  /// Uploaded rather than installed locally, and that is the whole design: a
  /// font installed on one till is a venue lettered two ways. It goes to the
  /// office, the office tells every terminal, and each one downloads it — so
  /// the till it was uploaded from gets it back the same way the others do,
  /// through the ordinary path, rather than through a special case that only
  /// this terminal exercises.
  Future<void> _upload() async {
    const fonts = XTypeGroup(
      label: 'Fonts',
      extensions: <String>['ttf', 'otf'],
    );

    final XFile? file;
    try {
      file = await openFile(acceptedTypeGroups: const [fonts]);
    } catch (e) {
      if (mounted) {
        PosMessenger.error(context, 'Could not open the file browser.\n\n$e');
      }
      return;
    }
    if (file == null || !mounted) return;

    final token = ref.read(sessionProvider).terminalToken;
    if (token == null) {
      PosMessenger.error(
        context,
        'This terminal is not commissioned, so it cannot add a font.',
      );
      return;
    }

    final asked = await _askAboutFile(file.name);
    if (asked == null || !mounted) return;

    setState(() => _busy = true);
    try {
      await ref
          .read(fontsRepositoryProvider)
          .upload(
            terminalToken: token,
            file: File(file.path),
            family: asked.family,
            weight: asked.weight,
          );
      // Not a local refresh: the office pushes to every till including this
      // one, and letting that arrive the ordinary way is what proves it works.
      ref.invalidate(fontsProvider);
      if (mounted) {
        PosMessenger.success(
          context,
          '${asked.family} is now available on every till in this venue.',
        );
      }
    } catch (e) {
      if (mounted) {
        // The server's own words. It is the only thing that can say "a .woff2
        // works in a browser but not on a till".
        PosMessenger.error(context, '$e'.replaceFirst('Exception: ', ''));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// What to call it, and which weight this file is.
  ///
  /// Asked rather than guessed. A foundry ships `BrandSans-Bd_v2_FINAL.ttf`,
  /// and deciding that "Bd" means bold is the kind of cleverness that letters
  /// half a venue's screen in the wrong weight. The filename seeds the box; the
  /// person confirms it.
  Future<({String family, int weight})?> _askAboutFile(String fileName) {
    final stem = fileName.replaceAll(RegExp(r'\.[^.]+$'), '');
    final name = TextEditingController(
      text: stem
          .replaceAll(RegExp(r'[-_]+'), ' ')
          .replaceAll(
            RegExp(
              r'\b(regular|bold|black|light|medium|italic|final|v\d+)\b',
              caseSensitive: false,
            ),
            '',
          )
          .replaceAll(RegExp(r'\s+'), ' ')
          .trim(),
    );
    var weight = RegExp(
      r'bold|black|heavy|semibold',
      caseSensitive: false,
    ).hasMatch(stem)
        ? 700
        : 400;

    return showDialog<({String family, int weight})>(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, setLocal) => AlertDialog(
          title: const Text('Add a font'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              TextField(
                controller: name,
                autofocus: true,
                decoration: const InputDecoration(
                  labelText: 'What to call it',
                  helperText: 'How it will read in the back office',
                ),
              ),
              const SizedBox(height: 16),
              SegmentedButton<int>(
                segments: const [
                  ButtonSegment(value: 400, label: Text('Regular')),
                  ButtonSegment(value: 700, label: Text('Bold')),
                ],
                selected: {weight},
                onSelectionChanged: (s) => setLocal(() => weight = s.first),
              ),
              const SizedBox(height: 12),
              Text(
                'Upload the regular and the bold separately, under the same '
                'name — the till uses both.',
                style: TextStyle(
                  fontSize: 12,
                  color: Theme.of(context).hintColor,
                ),
              ),
              const SizedBox(height: 8),
              Text(
                'Uploading a font is you saying this venue holds a licence to '
                'install it on its tills.',
                style: TextStyle(
                  fontSize: 12,
                  color: Theme.of(context).hintColor,
                ),
              ),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () {
                final family = name.text.trim();
                if (family.isEmpty) return;
                Navigator.pop(context, (family: family, weight: weight));
              },
              child: const Text('Add'),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _choose(String? slug) async {
    final token = ref.read(sessionProvider).terminalToken;
    if (token == null) {
      PosMessenger.error(
        context,
        'This terminal is not commissioned, so it cannot change the font.',
      );
      return;
    }

    setState(() => _busy = true);
    try {
      await ref
          .read(fontsRepositoryProvider)
          .setVenueFont(terminalToken: token, slug: slug);
      ref.invalidate(tillSettingsRefreshProvider);
      if (mounted) PosMessenger.success(context, 'Every till will use it.');
    } catch (e) {
      if (mounted) {
        PosMessenger.error(
          context,
          'That font could not be set. The till is still lettered as it was.'
          '\n\n${'$e'.replaceFirst('Exception: ', '')}',
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final library = ref.watch(fontsProvider);
    final chosen = ref.watch(tillSettingsProvider).fontFamily;

    return Card(
      margin: EdgeInsets.zero,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          switch (library) {
            AsyncData(value: final fonts) => Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                ListTile(
                  leading: const Icon(
                    Icons.text_fields,
                    color: Pos.brandDeep,
                  ),
                  title: const Text('Lettering'),
                  subtitle: Text(
                    switch (chosen) {
                      null => 'Every till in this venue is lettered in the '
                          'app’s own typeface.',
                      final slug when fonts.familyFor(slug) == null =>
                        // Chosen, but not usable here. Said plainly rather than
                        // shown as "none": a manager looking at a till that is
                        // not wearing the font they picked needs to know it is
                        // this terminal and not their choice.
                        'This venue is set to '
                            '“${fonts.bySlug(slug)?.family ?? slug}”, '
                            'which this terminal has not downloaded yet. It '
                            'will appear once the till can reach the office.',
                      final slug =>
                        'Every till in this venue is lettered in '
                            '“${fonts.bySlug(slug)?.family ?? slug}”.',
                    },
                    style: const TextStyle(fontSize: 12.5),
                  ),
                  isThreeLine: chosen != null,
                ),
                const Divider(height: 1),
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
                  child: DropdownButtonFormField<String>(
                    initialValue: fonts.bySlug(chosen) == null ? '' : chosen,
                    decoration: const InputDecoration(
                      labelText: 'Font',
                      border: OutlineInputBorder(),
                    ),
                    items: [
                      const DropdownMenuItem(
                        value: '',
                        child: Text('The app’s own lettering'),
                      ),
                      for (final font in fonts.fonts)
                        DropdownMenuItem(
                          value: font.slug,
                          child: Text(
                            font.family,
                            // In its own face where the till has it, and
                            // plainly where it does not — which is most of
                            // them, because a till downloads the fonts it is
                            // using and not the eighteen it is offered.
                            //
                            // Choosing is the preview: the choice reaches the
                            // office, comes back as a push, and the till
                            // re-letters itself a second later in the real
                            // thing. Which is a better answer than a dropdown
                            // anyway — a font is chosen by whether a clerk can
                            // read a key across a bar, not by whether the name
                            // looks nice in a list.
                            style: TextStyle(
                              fontFamily: fonts.familyFor(font.slug),
                              fontSize: 16,
                            ),
                          ),
                        ),
                    ],
                    onChanged: _busy
                        ? null
                        : (value) =>
                              _choose(value == null || value.isEmpty ? null : value),
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 4, 16, 12),
                  child: Text(
                    'Pick one and the till letters itself in it a moment later, '
                    'once it has fetched the font. Every other till in the '
                    'venue follows.',
                    style: TextStyle(
                      fontSize: 12,
                      color: Theme.of(context).hintColor,
                    ),
                  ),
                ),
              ],
            ),
            AsyncError() => const ListTile(
              leading: Icon(Icons.text_fields, color: Pos.brandDeep),
              title: Text('Lettering'),
              subtitle: Text(
                'The font list could not be read. The till letters everything '
                'in its own typeface until it can.',
                style: TextStyle(fontSize: 12.5),
              ),
              isThreeLine: true,
            ),
            _ => const ListTile(
              leading: SizedBox(
                width: 24,
                height: 24,
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
              title: Text('Lettering'),
              subtitle: Text('Reading the font list…'),
            ),
          },
          const Divider(height: 1),
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
            child: Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                FilledButton.icon(
                  onPressed: _busy ? null : _upload,
                  icon: const Icon(Icons.upload_file, size: 18),
                  label: const Text('Add a font from this terminal'),
                ),
                OutlinedButton.icon(
                  // The manual way out of the one failure this feature has:
                  // the till was offline when the venue picked a font, so the
                  // file never arrived. Nothing is broken and nothing says so —
                  // the keys are simply lettered plainly — so there has to be
                  // something to press.
                  onPressed: _busy
                      ? null
                      : () {
                          ref.invalidate(fontsProvider);
                          PosMessenger.info(
                            context,
                            'Fetching anything this terminal is missing…',
                          );
                        },
                  icon: const Icon(Icons.refresh, size: 18),
                  label: const Text('Check for fonts'),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// The terminal's own name, shown and edited.
class _TerminalNameRow extends ConsumerWidget {
  const _TerminalNameRow();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final name = ref.watch(terminalNameProvider);
    return _Row(
      icon: Icons.point_of_sale,
      label: 'This till is called',
      value: name,
      trailing: TextButton(
        onPressed: () => _rename(context, ref, name),
        child: const Text('Rename'),
      ),
    );
  }

  Future<void> _rename(
    BuildContext context,
    WidgetRef ref,
    String current,
  ) async {
    final controller = TextEditingController(text: current);
    final typed = await showDialog<String>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('What is this till called?'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'Staff see this name when a bill is open on another terminal, '
              'and a manager sees it against the shifts clocked in here. '
              '"Bar", "Door", "Kitchen pass".',
              style: TextStyle(fontSize: 12.5),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: controller,
              autofocus: true,
              maxLength: 40,
              decoration: const InputDecoration(labelText: 'Name'),
              onSubmitted: (v) => Navigator.of(dialogContext).pop(v),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () =>
                Navigator.of(dialogContext).pop(controller.text),
            child: const Text('Save'),
          ),
        ],
      ),
    );
    if (typed == null) return;
    await ref.read(terminalIdentityProvider.notifier).set(typed);
  }
}

class _SectionTitle extends StatelessWidget {
  const _SectionTitle(this.text);
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 10),
    child: Text(
      text.toUpperCase(),
      style: TextStyle(
        fontSize: 11.5,
        fontWeight: FontWeight.w700,
        letterSpacing: 1.1,
        color: Theme.of(context).hintColor,
      ),
    ),
  );
}

class _Row extends StatelessWidget {
  const _Row({
    required this.icon,
    required this.label,
    required this.value,
    this.trailing,
  });

  final IconData icon;
  final String label;
  final String value;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    return ListTile(
      leading: Icon(icon, color: Pos.brandDeep),
      title: Text(label),
      subtitle: Text(value, style: const TextStyle(fontSize: 12.5)),
      trailing: trailing,
    );
  }
}
