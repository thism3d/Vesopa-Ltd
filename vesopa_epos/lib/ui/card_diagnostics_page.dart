import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../main.dart';
import '../payments/connect_pac.dart';
import '../payments/connect_ws.dart';
import '../payments/dojo_config.dart';
import '../payments/payment_provider.dart';
import 'card_checkout_page.dart';
import 'widgets/pos_message.dart';

/// One line in the diagnostics log.
class _Entry {
  _Entry(this.label, this.detail, {this.ok});
  final String label;
  final String detail;

  /// null while running.
  final bool? ok;
  final DateTime at = DateTime.now();
}

/// Card payment diagnostics.
///
/// Exists because every card fault so far has been invisible from the till: an
/// empty terminal list that looked like a bug, a client secret that was never
/// requested, a socket that opened and then answered nothing. Each of those
/// took a laptop and curl to find. This screen runs the same calls from the
/// device that actually has the problem, and shows what came back verbatim —
/// including the failures, which is the whole point.
///
/// Nothing here takes real money except the buttons that say they do.
class CardDiagnosticsPage extends ConsumerStatefulWidget {
  const CardDiagnosticsPage({super.key});

  @override
  ConsumerState<CardDiagnosticsPage> createState() =>
      _CardDiagnosticsPageState();
}

class _CardDiagnosticsPageState extends ConsumerState<CardDiagnosticsPage> {
  final _log = <_Entry>[];
  bool _busy = false;

  void _add(String label, String detail, {bool? ok}) {
    if (!mounted) return;
    setState(() => _log.insert(0, _Entry(label, detail, ok: ok)));
  }

  /// Run a named check, catching everything: a diagnostics screen that can
  /// itself throw is no use at all.
  Future<void> _run(String label, Future<String> Function() body) async {
    if (_busy) return;
    setState(() => _busy = true);
    _add(label, 'running…');
    try {
      final detail = await body();
      if (mounted) {
        setState(() {
          _log.removeAt(0);
          _log.insert(0, _Entry(label, detail, ok: true));
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _log.removeAt(0);
          _log.insert(0, _Entry(label, '$e', ok: false));
        });
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  DojoConfig get _config =>
      ref.read(dojoConfigProvider).value ?? const DojoConfig();

  ConnectPacProvider? get _connect {
    final p = ref.read(dojoProvider);
    return p is ConnectPacProvider ? p : null;
  }

  DojoProvider? get _dojoRest {
    final p = ref.read(manualCardProvider);
    if (p is DojoProvider) return p;
    // The keyed providers wrap a REST client; reach the one they share.
    final card = ref.read(dojoProvider);
    if (card is DojoProvider) return card;
    return null;
  }

  // ---- Checks --------------------------------------------------------------

  Future<String> _checkTerminals() async {
    final connect = _connect;
    if (connect == null) {
      final dojo = _dojoRest;
      if (dojo == null) return 'No card provider configured.';
      final found = await dojo.listTerminals();
      return found.isEmpty
          ? 'No card machines available on this Dojo account.'
          : found.map((t) => '${t.label} — ${t.status}').join('\n');
    }
    final found = await connect.listTerminals();
    return found.isEmpty
        ? 'HTTP 200, but the list is empty.\n\n'
            'Auth and the account are fine — there is simply no PDQ paired and '
            'online. A card cannot be taken until one is.'
        : found.map((t) => 'TID ${t.tid} — ${t.status} (${t.currency})').join('\n');
  }

  /// Open the socket and ask it something, so a failure is attributable to the
  /// handshake rather than to a payment.
  Future<String> _checkSocket() async {
    final config = _config;
    if (config.platform != CardPlatform.connect) {
      return 'Not applicable: the WebSocket interface is Paymentsense Connect '
          'only. This till is on Dojo.';
    }

    final traffic = <String>[];
    final socket = ConnectSocket(
      baseUrl: config.normalisedBaseUrl,
      apiKey: config.apiKey.trim(),
      softwareHouseId: config.softwareHouseId.trim(),
      installerId: config.resellerId.trim(),
    )..onTraffic = (dir, msg) =>
        traffic.add('$dir ${msg.length > 300 ? '${msg.substring(0, 300)}…' : msg}');

    try {
      await socket.connect();
      final terminals = await socket.connectedTerminals();
      return 'Socket open: ${socket.uri.host}${socket.uri.path}\n'
          'api-version=${config.platform == CardPlatform.connect ? 'v1' : '—'}\n\n'
          '${terminals.isEmpty ? 'connectedTerminals → [] (no PDQ online)' : terminals.map((t) => 'TID ${t.tid} — ${t.status}').join('\n')}'
          '\n\n${traffic.join('\n')}';
    } finally {
      await socket.dispose();
    }
  }

  /// The two-call sequence the Android drop-in needs. Creates a real intent —
  /// harmless, since an intent with no card presented against it simply
  /// expires.
  Future<String> _checkClientSecret() async {
    final dojo = _dojoRest;
    if (dojo == null) {
      return 'Not applicable: this till is on Paymentsense Connect, which has '
          'no payment intents. Card entry happens on the PDQ.';
    }
    final intent = await dojo.createIntent(
      100,
      orderId: 'diagnostic',
      withClientSecret: true,
      cardHolderNotPresent: true,
    );
    final secret = intent.clientSecret;
    return 'Intent: ${intent.id}\n'
        'Client secret: ${secret == null ? 'MISSING — the drop-in cannot open' : '${secret.substring(0, 12)}… (${secret.length} chars)'}\n'
        'Checkout link: ${intent.paymentLink ?? '—'}';
  }

  Future<String> _openCheckout() async {
    final dojo = _dojoRest;
    if (dojo == null) return 'Not applicable on Connect.';
    final intent = await dojo.createIntent(
      100,
      orderId: 'diagnostic',
      cardHolderNotPresent: true,
    );
    final link = intent.paymentLink;
    if (link == null) return 'Dojo returned no checkout link for ${intent.id}.';
    if (!mounted) return link;
    unawaited(
      CardCheckoutPage.show(context, url: link, amountLabel: '£1.00 (test)'),
    );
    return 'Opened ${intent.id} in the in-app checkout.\n$link';
  }

  Future<String> _runReport(ConnectReport report) async {
    final connect = _connect;
    if (connect == null) {
      return 'Not applicable: PDQ reports are a Paymentsense Connect feature.';
    }
    final result = await connect.runReport(report);
    if (!result.finished) {
      return result.message ?? 'The report did not finish.';
    }
    return result.lines.isEmpty
        ? 'Finished, but the reader returned no printable lines.'
        : result.lines.join('\n');
  }

  // ---- UI ------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final config = _config;
    final isConnect = config.platform == CardPlatform.connect;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Card diagnostics'),
        actions: [
          IconButton(
            tooltip: 'Copy the log',
            icon: const Icon(Icons.copy_all),
            onPressed: _log.isEmpty
                ? null
                : () {
                    Clipboard.setData(ClipboardData(
                      text: _log
                          .map((e) => '${e.label}\n${e.detail}\n')
                          .join('\n'),
                    ));
                    PosMessenger.info(context, 'Log copied.');
                  },
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          // What this till is actually configured to talk to. Half of every
          // card fault turns out to be the wrong URL or the wrong environment.
          Card(
            margin: EdgeInsets.zero,
            child: Padding(
              padding: const EdgeInsets.all(14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('This terminal', style: theme.textTheme.titleSmall),
                  const SizedBox(height: 8),
                  _Fact('Platform', config.platform.label),
                  _Fact('Environment', config.sandbox ? 'Sandbox' : 'LIVE'),
                  _Fact('API URL', config.normalisedBaseUrl),
                  _Fact('Key', _masked(config.apiKey)),
                  _Fact('Card machine', config.terminalId.isEmpty
                      ? 'none set'
                      : config.terminalId),
                  _Fact('Software-house id', config.softwareHouseId),
                  _Fact(isConnect ? 'Installer id' : 'Reseller id',
                      config.resellerId),
                  _Fact('Google Pay',
                      config.walletEnabled ? 'configured' : 'off'),
                ],
              ),
            ),
          ),
          const SizedBox(height: 16),

          Text('Checks', style: theme.textTheme.titleSmall),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              _Check('List card machines', Icons.point_of_sale,
                  () => _run('List card machines', _checkTerminals)),
              if (isConnect)
                _Check('WebSocket connection', Icons.bolt,
                    () => _run('WebSocket connection', _checkSocket)),
              if (!isConnect) ...[
                _Check('Intent + client secret', Icons.vpn_key,
                    () => _run('Intent + client secret', _checkClientSecret)),
                _Check('Open checkout page', Icons.open_in_browser,
                    () => _run('Open checkout page', _openCheckout)),
              ],
              if (isConnect)
                for (final report in ConnectReport.values)
                  _Check(report.label, Icons.summarize_outlined,
                      () => _run(report.label, () => _runReport(report))),
            ],
          ),

          if (!config.sandbox) ...[
            const SizedBox(height: 12),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: theme.colorScheme.errorContainer,
                borderRadius: BorderRadius.circular(9),
              ),
              child: Row(
                children: [
                  const Icon(Icons.warning_amber, size: 18),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      'This terminal is on LIVE. The checks above only read '
                      'state, but a report closes the machine\'s real banking '
                      'day.',
                      style: theme.textTheme.bodySmall,
                    ),
                  ),
                ],
              ),
            ),
          ],

          const SizedBox(height: 20),
          if (_log.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 30),
              child: Center(
                child: Text(
                  'Run a check to see what the card platform actually says.',
                  style: theme.textTheme.bodySmall,
                ),
              ),
            )
          else
            for (final entry in _log) _LogTile(entry),
        ],
      ),
    );
  }

  static String _masked(String key) {
    final k = key.trim();
    if (k.isEmpty) return 'not set';
    if (k.length <= 8) return '••••';
    return '${k.substring(0, 6)}…${k.substring(k.length - 4)}';
  }
}

class _Fact extends StatelessWidget {
  const _Fact(this.label, this.value);
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 2),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 130,
          child: Text(label,
              style: TextStyle(
                fontSize: 12.5,
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              )),
        ),
        Expanded(
          child: SelectableText(
            value.isEmpty ? '—' : value,
            style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600),
          ),
        ),
      ],
    ),
  );
}

class _Check extends StatelessWidget {
  const _Check(this.label, this.icon, this.onTap);
  final String label;
  final IconData icon;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => FilledButton.tonalIcon(
    onPressed: onTap,
    icon: Icon(icon, size: 17),
    label: Text(label),
  );
}

class _LogTile extends StatelessWidget {
  const _LogTile(this.entry);
  final _Entry entry;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final (icon, colour) = switch (entry.ok) {
      true => (Icons.check_circle, Colors.green),
      false => (Icons.error_outline, scheme.error),
      null => (Icons.hourglass_top, scheme.outline),
    };

    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(icon, size: 17, color: colour),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(entry.label,
                      style: const TextStyle(fontWeight: FontWeight.w700)),
                ),
                Text(
                  '${entry.at.hour.toString().padLeft(2, '0')}:'
                  '${entry.at.minute.toString().padLeft(2, '0')}:'
                  '${entry.at.second.toString().padLeft(2, '0')}',
                  style: TextStyle(fontSize: 11, color: scheme.outline),
                ),
              ],
            ),
            const SizedBox(height: 8),
            // Selectable and verbatim: the useful part of a card failure is
            // usually the acquirer's exact wording.
            SelectableText(
              entry.detail,
              style: const TextStyle(
                fontFamily: 'monospace',
                fontSize: 11.5,
                height: 1.45,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
