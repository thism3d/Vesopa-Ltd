/// Connected devices (2026-11-02): for Vesopa support, on the till.
///
/// The owner: from the till show the connected devices, locally, over the
/// internet and otherwise, with their addresses and how they are connected,
/// what is on and what is not, and buttons to test each one. Hidden from the
/// venue: a long press on Settings > Local network > Network setup asks for
/// the day's support code, which a Vesopa admin reads off the back office
/// (Devices > Local network). The till works the code out from the venue key,
/// so this opens with the internet down, which is when it is wanted.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/lan/lan_link.dart';
import '../data/lan/lan_service.dart';
import '../payments/dojo_config.dart';
import '../printing/printer_transport.dart';
import 'printers_page.dart' show printerSettingsProvider;
import 'theme.dart';
import 'widgets/pos_text_field.dart';
import 'widgets/on_screen_keyboard.dart' show PosKeyboardMode;

/// Ask for the day's code, then open the page.
Future<void> openConnectedDevices(BuildContext context) async {
  final code = TextEditingController();
  final ok = await showDialog<bool>(
    context: context,
    builder: (context) => AlertDialog(
      title: const Text('Vesopa support'),
      content: SizedBox(
        width: 360,
        child: PosTextField(
          controller: code,
          autofocus: true,
          mode: PosKeyboardMode.number,
          decoration: const InputDecoration(labelText: "Today's support code"),
          onSubmitted: (_) => Navigator.pop(context, true),
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
        FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Open')),
      ],
    ),
  );
  if (ok != true || !context.mounted) return;
  if (!LanService.instance.checkSupportCode(code.text)) {
    await showDialog<void>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('That code is not right'),
        content: const Text('Support codes change every day.'),
        actions: [TextButton(onPressed: () => Navigator.pop(context), child: const Text('OK'))],
      ),
    );
    return;
  }
  await Navigator.of(context).push(
    MaterialPageRoute<void>(builder: (_) => const ConnectedDevicesPage()),
  );
}

/// Whether a network printer answers, and how fast. Others are on this PC.
Future<Map<String, Object?>> testPrinter(PrinterConfig p) async {
  final row = <String, Object?>{'name': p.name, 'kind': p.kind.name, 'where': p.connectionSummary};
  if (p.kind != PrinterKind.network) return {...row, 'ok': null, 'note': 'Not on the network'};
  final clock = Stopwatch()..start();
  try {
    final s = await Socket.connect(p.host, p.port, timeout: const Duration(seconds: 3));
    s.destroy();
    return {...row, 'ok': true, 'ms': clock.elapsedMilliseconds};
  } catch (_) {
    return {...row, 'ok': false};
  }
}

String _ms(Object? v) => v is num ? '${v.toStringAsFixed(v < 10 ? 1 : 0)} ms' : '?';

/// Plain words for a test's answer.
String describeResult(String action, Object? r) {
  if (r is! Map) return 'Done.';
  switch (action) {
    case 'ping':
      if (r['ok'] != true) return 'No answer (${r['sent']} tried).';
      return 'Reached over the encrypted link: ${_ms(r['avg_ms'])} on average, '
          '${_ms(r['min_ms'])} best, ${_ms(r['max_ms'])} worst, ${r['lost']} of ${r['sent']} lost.';
    case 'speed':
      final up = (r['up_mbps'] as num?) ?? 0, down = (r['down_mbps'] as num?) ?? 0;
      final rate = (up < down ? up : down) >= 5 ? 'Good' : ((up < down ? up : down) >= 1 ? 'Slow' : 'Poor');
      return '$rate: ${up.toStringAsFixed(1)} Mbit/s sending, ${down.toStringAsFixed(1)} Mbit/s receiving.';
    default:
      return r['error'] != null ? '${r['error']}' : 'Done.';
  }
}

class ConnectedDevicesPage extends ConsumerStatefulWidget {
  const ConnectedDevicesPage({super.key});

  @override
  ConsumerState<ConnectedDevicesPage> createState() => _ConnectedDevicesPageState();
}

class _ConnectedDevicesPageState extends ConsumerState<ConnectedDevicesPage> {
  List<Map<String, dynamic>> _known = const [];
  int? _internetMs;
  bool _loaded = false;
  StreamSubscription<void>? _changes;

  /// What the last test on each device said.
  final Map<String, String> _results = {};
  final Set<String> _running = {};
  Map<String, Object?>? _full;
  bool _checking = false;

  @override
  void initState() {
    super.initState();
    _changes = LanService.instance.changes.listen((_) {
      if (mounted) setState(() {});
    });
    unawaited(_load());
  }

  @override
  void dispose() {
    _changes?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    final lan = LanService.instance;
    final known = await lan.knownDevices();
    final ms = await lan.testInternet();
    if (!mounted) return;
    setState(() {
      _known = known;
      _internetMs = ms;
      _loaded = true;
    });
  }

  Future<void> _act(String id, String action) async {
    setState(() {
      _running.add('$id|$action');
      _results.remove(id);
    });
    String said;
    try {
      said = describeResult(action, await LanService.instance.runAction(id, action));
    } catch (e) {
      said = '$e';
    }
    if (!mounted) return;
    setState(() {
      _running.remove('$id|$action');
      _results[id] = said;
    });
  }

  Future<void> _confirm(String id, String name, String action, String question) async {
    final yes = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(name),
        content: Text(question),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Yes')),
        ],
      ),
    );
    if (yes == true) await _act(id, action);
  }

  Future<void> _fullCheck() async {
    setState(() {
      _checking = true;
      _full = null;
    });
    try {
      final r = await LanService.instance.fullCheck();
      if (mounted) setState(() => _full = r);
    } catch (e) {
      if (mounted) setState(() => _full = {'error': '$e'});
    }
    if (mounted) setState(() => _checking = false);
  }

  /// The local link's view of every device, with the back office's report.
  List<_Device> _devices(LanNode? node) {
    final out = <String, _Device>{};
    for (final d in _known) {
      final r = (d['report'] as Map?)?.cast<String, dynamic>() ?? const <String, dynamic>{};
      final age = (d['age_s'] as num?)?.toInt() ?? 1 << 30;
      out['${d['device']}'] = _Device(
        id: '${d['device']}',
        name: '${d['name'] ?? d['device']}',
        role: '${d['role'] ?? ''}',
        version: '${d['version'] ?? ''}',
        report: r,
        ageSeconds: age,
        route: age < 180 ? _Route.internet : _Route.offline,
        address: ((r['ips'] as List?) ?? const []).join(', '),
      );
    }
    if (node != null) {
      for (final p in node.peers.values) {
        final d = out[p.id];
        out[p.id] = _Device(
          id: p.id,
          name: p.name,
          role: p.role,
          version: p.version.isEmpty ? (d?.version ?? '') : p.version,
          report: d?.report ?? const {},
          ageSeconds: d?.ageSeconds,
          route: _Route.local,
          address: p.address.address,
          isHub: p.claimsHub,
        );
      }
      for (final c in node.clients) {
        final id = '${c['id']}';
        final d = out[id];
        out[id] = _Device(
          id: id,
          name: '${c['name']}',
          role: '${c['role']}',
          version: d?.version ?? '',
          report: d?.report ?? const {},
          ageSeconds: d?.ageSeconds,
          route: _Route.local,
          address: '${c['address']}',
          connected: true,
        );
      }
      out.remove(node.identity.id);
    }
    return out.values.toList()..sort((a, b) => a.name.compareTo(b.name));
  }

  @override
  Widget build(BuildContext context) {
    final lan = LanService.instance;
    final node = lan.node;
    final devices = _devices(node);
    final local = [for (final d in devices) if (d.route == _Route.local) d];
    final internet = [for (final d in devices) if (d.route == _Route.internet) d];
    final offline = [for (final d in devices) if (d.route == _Route.offline) d];
    return Scaffold(
      appBar: AppBar(
        title: const Text('Connected devices'),
        actions: [IconButton(icon: const Icon(Icons.refresh), tooltip: 'Check again', onPressed: _load)],
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Card(
            margin: EdgeInsets.zero,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                ListTile(
                  leading: Icon(node?.isHub == true ? Icons.star : Icons.lan, color: Pos.brandDeep),
                  title: Text(node == null
                      ? 'Local link not running'
                      : '${node.identity.name}: ${node.isHub ? 'the main till' : (node.linked ? 'linked to the main till' : 'not linked')}'),
                  subtitle: FutureBuilder<List<String>>(
                    future: LanNode.localAddresses(),
                    builder: (context, ips) => Text(
                      'Address ${(ips.data ?? const []).join(', ')}, '
                      'ports TCP ${LanNode.defaultLinkPort} and UDP ${LanNode.defaultDiscoveryPort}\n'
                      'Firewall: ${lan.firewallOpen == null ? 'unknown' : (lan.firewallOpen! ? 'open' : 'closed')}. '
                      'Windows network: ${lan.networkProfile ?? 'unknown'}.\n'
                      'Internet: ${!_loaded ? 'checking' : (_internetMs == null ? 'cannot reach the back office' : 'back office answers in $_internetMs ms')}.',
                    ),
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
                  child: Align(
                    alignment: Alignment.centerLeft,
                    child: FilledButton.icon(
                      icon: const Icon(Icons.checklist),
                      label: Text(_checking ? 'Checking everything…' : 'Full check of everything'),
                      onPressed: _checking ? null : _fullCheck,
                    ),
                  ),
                ),
                if (_full != null)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 0, 16, 14),
                    child: SelectableText(_fullText(_full!)),
                  ),
              ],
            ),
          ),
          _section('On the local link', local, emptyText: 'No other device on the local link right now.'),
          _section('Internet only', internet, emptyText: 'None: nothing is reaching the back office without the local link.'),
          _section('Known, not heard from', offline, emptyText: 'None.'),
          _printers(),
        ],
      ),
    );
  }

  String _fullText(Map<String, Object?> r) {
    if (r['error'] != null) return '${r['error']}';
    final out = <String>[
      r['internet_ms'] == null ? 'Internet: FAILED' : 'Internet: OK, ${r['internet_ms']} ms',
      'Local link: ${r['is_hub'] == true ? 'this is the main till' : (r['linked'] == true ? 'linked' : 'NOT linked')}',
    ];
    for (final d in (r['devices'] as List? ?? const [])) {
      final m = d as Map;
      out.add('${m['name']}: ${describeResult('ping', m['link'])}'
          '${m['speed'] == null ? '' : ' ${describeResult('speed', m['speed'])}'}');
    }
    for (final p in (r['printers'] as List? ?? const [])) {
      final m = p as Map;
      out.add('Printer ${m['name']}: ${m['ok'] == null ? (m['note'] ?? '') : (m['ok'] == true ? 'OK, ${m['ms']} ms' : 'NO ANSWER')} (${m['where']})');
    }
    return out.join('\n');
  }

  Widget _title(String text) => Padding(
        padding: const EdgeInsets.fromLTRB(4, 22, 4, 8),
        child: Text(text, style: Theme.of(context).textTheme.titleMedium),
      );

  Widget _section(String title, List<_Device> list, {required String emptyText}) => Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _title('$title (${list.length})'),
          if (list.isEmpty)
            Padding(padding: const EdgeInsets.symmetric(horizontal: 4), child: Text(emptyText))
          else
            Card(margin: EdgeInsets.zero, child: Column(children: [for (final d in list) _tile(d)])),
        ],
      );

  Widget _tile(_Device d) {
    final r = d.report;
    final node = LanService.instance.node;
    final live = d.route == _Route.local;
    final facts = <String>[
      'Connection: ${switch (d.route) {
        _Route.local => d.connected ? 'local link, connected to this till' : 'local link, heard on the network',
        _Route.internet => 'internet only, not on the local link',
        _Route.offline => 'not heard from',
      }}',
      if (d.address.isNotEmpty) 'Address: ${d.address}',
      if (d.version.isNotEmpty) 'Version: ${d.version}',
      if (d.isHub) 'Main till',
      if ((r['hub'] as Map?)?['direct'] == true) 'Reached directly on TCP (discovery blocked)',
      if (r['firewall'] != null) 'Firewall: ${r['firewall'] == true ? 'open' : 'closed'}',
      if (r['network_profile'] != null) 'Windows network: ${r['network_profile']}',
      if (r['up_s'] is num) 'Running for ${((r['up_s'] as num) / 60).round()} minutes',
      if (d.ageSeconds != null) 'Last reported: ${_ago(d.ageSeconds!)}',
    ];
    Widget action(String label, IconData icon, String key, VoidCallback run) => OutlinedButton.icon(
          icon: Icon(icon, size: 18),
          label: Text(_running.contains('${d.id}|$key') ? 'Working…' : label),
          onPressed: _running.contains('${d.id}|$key') ? null : run,
        );
    return ExpansionTile(
      leading: Icon(
        switch (d.role) {
          'till' => Icons.point_of_sale,
          'kitchen' => Icons.soup_kitchen_outlined,
          'display' => Icons.desktop_windows_outlined,
          _ => Icons.smartphone,
        },
        color: live ? Pos.brandDeep : Pos.graphite,
      ),
      title: Text(d.name),
      subtitle: Text('${_roles[d.role] ?? d.role}${d.address.isEmpty ? '' : ' · ${d.address}'}'),
      childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 14),
      expandedCrossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SelectableText(facts.join('\n')),
        const SizedBox(height: 10),
        if (live)
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              action('Test connection', Icons.network_ping, 'ping', () => _act(d.id, 'ping')),
              action('Test speed', Icons.speed, 'speed', () => _act(d.id, 'speed')),
              action('Identify', Icons.campaign_outlined, 'identify', () => _act(d.id, 'identify')),
              if (d.role == 'till' && node?.hubId != d.id)
                action('Make main till', Icons.star_outline, 'takeover',
                    () => _confirm(d.id, d.name, 'takeover', 'Make this the main till?')),
              action('Restart app', Icons.restart_alt, 'restart',
                  () => _confirm(d.id, d.name, 'restart', 'Restart the Vesopa app on this device? Refused during a sale.')),
              action('Disconnect', Icons.link_off, 'disconnect',
                  () => _confirm(d.id, d.name, 'disconnect', 'Take this device off the local link for a minute?')),
            ],
          )
        else
          const Text('Tests need the device on the local link.'),
        if (_results[d.id] != null)
          Padding(padding: const EdgeInsets.only(top: 10), child: SelectableText(_results[d.id]!)),
      ],
    );
  }

  static const _roles = {'till': 'Till', 'kitchen': 'Kitchen screen', 'display': 'Customer display', 'go': 'Vesopa Go'};

  static String _ago(int s) => s < 90
      ? 'just now'
      : s < 3600
          ? '${s ~/ 60} min ago'
          : s < 86400
              ? '${s ~/ 3600} h ago'
              : '${s ~/ 86400} days ago';

  Widget _printers() {
    final printers = ref.watch(printerSettingsProvider).value?.printers ?? const <PrinterConfig>[];
    final card = ref.watch(dojoConfigProvider).value;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _title('Printers and card machine'),
        Card(
          margin: EdgeInsets.zero,
          child: Column(
            children: [
              for (final p in printers)
                ListTile(
                  leading: const Icon(Icons.print_outlined, color: Pos.graphite),
                  title: Text(p.name),
                  subtitle: Text('${p.kind.name} · ${p.connectionSummary}'
                      '${_results['printer:${p.id}'] == null ? '' : '\n${_results['printer:${p.id}']}'}'),
                  trailing: p.kind == PrinterKind.network
                      ? OutlinedButton(
                          onPressed: () async {
                            final r = await testPrinter(p);
                            if (mounted) {
                              setState(() => _results['printer:${p.id}'] =
                                  r['ok'] == true ? 'Answers in ${r['ms']} ms' : 'No answer');
                            }
                          },
                          child: const Text('Test'),
                        )
                      : null,
                ),
              ListTile(
                leading: const Icon(Icons.credit_card, color: Pos.graphite),
                title: const Text('Card machine'),
                subtitle: Text(card == null || !card.configured
                    ? 'Not set up on this till'
                    : '${card.platform.name}${card.terminalId.isEmpty ? '' : ' · ${card.terminalId}'}'
                        '${card.sandbox ? ' · sandbox' : ' · live'}'),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

enum _Route { local, internet, offline }

class _Device {
  const _Device({
    required this.id,
    required this.name,
    required this.role,
    required this.version,
    required this.report,
    required this.route,
    required this.address,
    this.ageSeconds,
    this.isHub = false,
    this.connected = false,
  });

  final String id;
  final String name;
  final String role;
  final String version;
  final Map<String, dynamic> report;
  final _Route route;
  final String address;
  final int? ageSeconds;
  final bool isHub;
  final bool connected;
}

/// What a till adds to its report: its printers and card machine.
Map<String, Object?> tillEquipment(List<PrinterConfig> printers, DojoConfig? card) => {
      'printers': [
        for (final p in printers) {'name': p.name, 'kind': p.kind.name, 'where': p.connectionSummary},
      ],
      'card': card == null || !card.configured
          ? null
          : {'platform': card.platform.name, 'terminal': card.terminalId, 'sandbox': card.sandbox},
    };

/// For a device's report in a log line.
String prettyReport(Map<String, Object?> r) => const JsonEncoder.withIndent('  ').convert(r);
