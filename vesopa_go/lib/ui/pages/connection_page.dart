/// Network and hardware, as Go sees it (owner, 2026-11-03: the till controls
/// the hotspot, adapters, Bluetooth and USB; Go shows). iPhone and iPad let no
/// app switch Wi-Fi or Bluetooth, and Android very little, so this page reads
/// and warns; the switches are on the Windows till (Settings > Network and
/// hardware), including the hotspot this device can join.
library;

import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;
import 'package:url_launcher/url_launcher.dart';

import '../../config/constants.dart' show apiBase;
import '../../counter/ui/receipt_print.dart' show receiptPrinter;
import '../../data/lan/lan_service.dart';
import '../../data/session.dart';
import '../theme.dart';

class ConnectionPage extends ConsumerStatefulWidget {
  const ConnectionPage({super.key});
  @override
  ConsumerState<ConnectionPage> createState() => _ConnectionPageState();
}

class _Net {
  _Net(this.name, this.kind, this.addresses);
  final String name;

  /// wifi, cellular, vpn or other.
  final String kind;
  final List<String> addresses;
}

class _ConnectionPageState extends ConsumerState<ConnectionPage> {
  Timer? _timer;
  StreamSubscription<void>? _lan;
  List<_Net> _nets = const [];
  final List<int> _pings = [];
  bool? _reachable;
  String? _reader;
  String _printer = '';

  @override
  void initState() {
    super.initState();
    _check();
    _timer = Timer.periodic(const Duration(seconds: 3), (_) => _check());
    _lan = LanService.instance.changes.listen((_) {
      if (mounted) setState(() {});
    });
    ref.read(paymentsProvider).whyUnavailable().then((why) {
      if (mounted) setState(() => _reader = why ?? 'Ready');
    });
    receiptPrinter().then((p) {
      if (mounted) setState(() => _printer = p);
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    _lan?.cancel();
    super.dispose();
  }

  static String _kindOf(String name) {
    final n = name.toLowerCase();
    if (n == 'en0' || n.startsWith('wlan') || n.startsWith('wifi')) return 'wifi';
    if (n.startsWith('pdp_ip') || n.startsWith('rmnet') || n.startsWith('ccmni') || n.startsWith('seth')) return 'cellular';
    if (n.startsWith('utun') || n.startsWith('tun') || n.startsWith('ipsec') || n.startsWith('ppp')) return 'vpn';
    return 'other';
  }

  Future<void> _check() async {
    try {
      final list = await NetworkInterface.list(type: InternetAddressType.IPv4);
      _nets = [
        for (final i in list)
          if (i.addresses.isNotEmpty) _Net(i.name, _kindOf(i.name), [for (final a in i.addresses) a.address]),
      ];
    } catch (_) {}
    final watch = Stopwatch()..start();
    try {
      final r = await http.get(Uri.parse('$apiBase/health')).timeout(const Duration(seconds: 5));
      _reachable = r.statusCode == 200;
      if (_reachable!) {
        _pings.add(watch.elapsedMilliseconds);
        if (_pings.length > 20) _pings.removeAt(0);
      }
    } catch (_) {
      _reachable = false;
    }
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final s = ref.watch(tapProvider);
    final notifier = ref.read(tapProvider.notifier);
    final lan = LanService.instance;
    final node = lan.node;
    final wifi = _nets.where((n) => n.kind == 'wifi').toList();
    final cell = _nets.where((n) => n.kind == 'cellular').toList();
    final vpn = _nets.where((n) => n.kind == 'vpn').toList();
    final ping = _pings.isEmpty ? null : _pings.last;
    final avg = _pings.isEmpty ? null : _pings.reduce((a, b) => a + b) ~/ _pings.length;
    final peers = node?.peers.values.toList() ?? const [];
    final myIps = {for (final n in wifi) ...n.addresses};
    String subnet(String ip) => ip.split('.').take(3).join('.');
    final sameNet = peers.where((p) => myIps.any((ip) => subnet(ip) == subnet(p.address.address))).length;

    final warnings = <String>[
      if (_reachable == false) 'The back office cannot be reached. Orders wait on this device and send when it is back.',
      if (wifi.isEmpty && cell.isNotEmpty) 'On mobile data, not Wi-Fi: the tills on the venue network cannot see this device. Join the venue Wi-Fi, or the till\'s hotspot.',
      if (wifi.isEmpty && cell.isEmpty) 'No network at all. Turn Wi-Fi on in this device\'s Settings.',
      if (avg != null && avg > 600) 'The connection is slow (${avg}ms on average). Card payments may take longer to confirm.',
      if (peers.isNotEmpty && wifi.isNotEmpty && sameNet == 0)
        'This device is on a different network (${subnet(wifi.first.addresses.first)}.x) from the tills. Join the same Wi-Fi, or the till\'s hotspot (Settings > Network and hardware on the till).',
      if (vpn.isNotEmpty) 'A VPN is on. It can keep this device away from the tills on the venue network.',
      if (s.pendingSync > 0) '${s.pendingSync} waiting to send to the back office.',
    ];

    return Scaffold(
      appBar: AppBar(title: const Text('Network and hardware')),
      body: RefreshIndicator(
        onRefresh: _check,
        child: ListView(padding: const EdgeInsets.all(16), children: [
          if (warnings.isEmpty)
            _banner(Icons.check_circle_rounded, Tp.lime, 'All connected', 'Back office, live updates and the venue network are working.')
          else
            for (final w in warnings) _banner(Icons.warning_amber_rounded, const Color(0xFFF0A23B), null, w),
          _title('This device'),
          _card([
            _row(Icons.wifi_rounded, 'Wi-Fi', wifi.isEmpty ? 'Not connected' : wifi.map((n) => n.addresses.join(', ')).join(' · '), wifi.isNotEmpty),
            _row(Icons.signal_cellular_alt_rounded, 'Mobile data', cell.isEmpty ? 'Not in use' : cell.map((n) => n.addresses.join(', ')).join(' · '), cell.isNotEmpty, neutral: true),
            if (vpn.isNotEmpty) _row(Icons.vpn_lock_rounded, 'VPN', vpn.map((n) => n.name).join(', '), false),
            _row(Icons.smartphone_rounded, 'Name', notifier.terminalName, true, neutral: true),
          ]),
          _title('Back office'),
          _card([
            _row(Icons.cloud_done_rounded, 'Back office', _reachable == null ? 'Checking…' : _reachable! ? 'Reachable' : 'Cannot be reached', _reachable ?? false),
            _pingRow(ping, avg),
            _row(Icons.bolt_rounded, 'Live updates', notifier.live
                ? 'Connected · ${notifier.liveHeard} heard${notifier.liveHeardAt == null ? '' : ', last ${_ago(notifier.liveHeardAt!)}'}'
                : 'Reconnecting', notifier.live),
            _row(Icons.outbox_rounded, 'Waiting to send', s.pendingSync == 0 ? 'Nothing' : '${s.pendingSync}', s.pendingSync == 0),
          ]),
          _title('Venue network'),
          _card([
            _row(Icons.lan_rounded, 'Local link', node == null
                ? 'Not started'
                : lan.isHub
                    ? 'Leading the tills · ${node.clientCount} connected'
                    : lan.linked
                        ? 'Linked to the main till'
                        : 'Looking for the main till', lan.linked),
            for (final p in peers)
              _row(p.claimsHub ? Icons.star_rounded : Icons.point_of_sale_rounded, p.name, '${p.role} · ${p.address.address}', true, neutral: true),
          ]),
          _title('Hardware'),
          _card([
            _row(Icons.contactless_rounded, 'Card reader', _reader ?? 'Checking…', _reader == 'Ready'),
            _row(Icons.print_rounded, 'Receipt printer', _printer.isEmpty ? 'None set' : _printer, _printer.isNotEmpty, neutral: _printer.isEmpty),
          ]),
          const SizedBox(height: 16),
          Text(
            Platform.isIOS
                ? 'iPhone and iPad do not let apps switch Wi-Fi or Bluetooth. Change them in Settings; the till can share its network as a hotspot for this device.'
                : 'Change Wi-Fi and Bluetooth in this device\'s Settings; the till can share its network as a hotspot for this device.',
            style: Theme.of(context).textTheme.bodySmall?.copyWith(color: context.goMuted),
          ),
          const SizedBox(height: 10),
          if (Platform.isIOS)
          OutlinedButton.icon(
            onPressed: () => launchUrl(Uri.parse('app-settings:')),
            icon: const Icon(Icons.settings_rounded),
            label: const Text('Open Settings'),
          ),
        ]),
      ),
    );
  }

  String _ago(DateTime at) {
    final s = DateTime.now().difference(at).inSeconds;
    return s < 60 ? '${s}s ago' : '${s ~/ 60} min ago';
  }

  Widget _banner(IconData icon, Color colour, String? title, String body) => Container(
        margin: const EdgeInsets.only(bottom: 10),
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: colour.withValues(alpha: 0.12),
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: colour.withValues(alpha: 0.45)),
        ),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Icon(icon, color: colour),
          const SizedBox(width: 10),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              if (title != null) Text(title, style: const TextStyle(fontWeight: FontWeight.w800)),
              Text(body),
            ]),
          ),
        ]),
      );

  Widget _title(String t) => Padding(
        padding: const EdgeInsets.only(top: 18, bottom: 8, left: 4),
        child: Text(t.toUpperCase(), style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, letterSpacing: 1.1, color: context.goMuted)),
      );

  Widget _card(List<Widget> rows) => Card(
        margin: EdgeInsets.zero,
        child: Column(children: [
          for (var i = 0; i < rows.length; i++) ...[if (i > 0) const Divider(height: 1), rows[i]],
        ]),
      );

  Widget _row(IconData icon, String label, String value, bool ok, {bool neutral = false}) => ListTile(
        leading: Icon(icon),
        title: Text(label),
        subtitle: Text(value),
        trailing: neutral
            ? null
            : AnimatedContainer(
                duration: const Duration(milliseconds: 400),
                width: 12,
                height: 12,
                decoration: BoxDecoration(shape: BoxShape.circle, color: ok ? Tp.lime : const Color(0xFFF0A23B)),
              ),
      );

  /// The last answer time, with the last twenty as bars.
  Widget _pingRow(int? ping, int? avg) => ListTile(
        leading: const Icon(Icons.speed_rounded),
        title: const Text('Response time'),
        subtitle: Text(ping == null ? 'Measuring…' : '${ping}ms now · ${avg}ms average'),
        trailing: SizedBox(
          width: 110,
          height: 30,
          child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
            for (final p in _pings)
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 1),
                  child: AnimatedContainer(
                    duration: const Duration(milliseconds: 300),
                    height: 4 + 26 * (p.clamp(0, 800) / 800),
                    decoration: BoxDecoration(
                      color: p < 250 ? Tp.lime : p < 600 ? const Color(0xFFF0A23B) : Tp.danger,
                      borderRadius: BorderRadius.circular(2),
                    ),
                  ),
                ),
              ),
          ]),
        ),
      );
}
