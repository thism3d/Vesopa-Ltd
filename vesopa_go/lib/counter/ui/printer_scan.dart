/// Finding the receipt printers on the venue's Wi-Fi, as the till's printers
/// page does for its network printers: every address on this device's own
/// network is tried on port 9100 (raw ESC/POS) at once, a few hundred
/// milliseconds each, and the ones that answer are listed with a test print.
library;

import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../ui/theme.dart';
import 'receipt_print.dart';

/// Addresses on this device's IPv4 networks (a /24 each) with port [port] open.
Future<List<String>> scanPrinters({int port = 9100, void Function(double done)? progress}) async {
  final mine = <String>{};
  for (final nic in await NetworkInterface.list(type: InternetAddressType.IPv4)) {
    for (final a in nic.addresses) {
      if (!a.isLoopback && !a.isLinkLocal) mine.add(a.address);
    }
  }
  final prefixes = {for (final ip in mine) ip.substring(0, ip.lastIndexOf('.'))};
  final targets = [for (final p in prefixes) for (var h = 1; h < 255; h++) '$p.$h'];
  final found = <String>[];
  var done = 0;
  // In batches, so a phone does not open a thousand sockets at once.
  for (var i = 0; i < targets.length; i += 64) {
    final batch = targets.sublist(i, (i + 64).clamp(0, targets.length));
    await Future.wait(batch.map((ip) async {
      try {
        final s = await Socket.connect(ip, port, timeout: const Duration(milliseconds: 350));
        found.add(ip);
        s.destroy();
      } catch (_) {}
    }));
    done += batch.length;
    progress?.call(targets.isEmpty ? 1 : done / targets.length);
  }
  found.sort((a, b) => int.parse(a.split('.').last).compareTo(int.parse(b.split('.').last)));
  return found;
}

/// The scan, then a printer to choose. Answers the chosen address.
Future<String?> pickPrinter(BuildContext context) => showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => const _ScanSheet(),
    );

class _ScanSheet extends ConsumerStatefulWidget {
  const _ScanSheet();
  @override
  ConsumerState<_ScanSheet> createState() => _ScanSheetState();
}

class _ScanSheetState extends ConsumerState<_ScanSheet> {
  double _progress = 0;
  List<String>? _found;
  String? _testing;

  @override
  void initState() {
    super.initState();
    scanPrinters(progress: (p) => mounted ? setState(() => _progress = p) : null).then((f) => mounted ? setState(() => _found = f) : null);
  }

  Future<void> _test(String ip) async {
    setState(() => _testing = ip);
    final messenger = ScaffoldMessenger.of(context);
    try {
      final s = await Socket.connect(ip, 9100, timeout: const Duration(seconds: 3));
      s.add(escPos(const [
        PrintLine('Vesopa Go', '', true, true),
        PrintLine('Test print', '', true),
        PrintLine('------------------------------------------'),
        PrintLine('This printer answers on', ''),
        PrintLine('', ''),
      ]));
      await s.flush();
      await s.close();
      messenger.showSnackBar(SnackBar(content: Text('Test print sent to $ip')));
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text('$ip did not take the test print')));
    } finally {
      if (mounted) setState(() => _testing = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final found = _found;
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('Receipt printers on this Wi-Fi', style: t.titleLarge),
          const SizedBox(height: 12),
          if (found == null) ...[
            LinearProgressIndicator(value: _progress == 0 ? null : _progress),
            const SizedBox(height: 8),
            Text('Looking… ${(100 * _progress).round()}%', style: t.bodySmall),
          ] else if (found.isEmpty)
            const Text('No receipt printer answered. Check it is on, on this Wi-Fi, and set to a network (Ethernet or Wi-Fi) address.')
          else
            for (final ip in found)
              Card(
                child: ListTile(
                  leading: Icon(Icons.print_rounded, color: context.goLimeInk),
                  title: Text(ip, style: const TextStyle(fontWeight: FontWeight.w700, fontFeatures: Tp.tabular)),
                  subtitle: const Text('ESC/POS on port 9100'),
                  trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                    TextButton(onPressed: _testing == null ? () => _test(ip) : null, child: Text(_testing == ip ? 'Printing…' : 'Test')),
                    FilledButton(onPressed: () => Navigator.pop(context, ip), child: const Text('Use')),
                  ]),
                ),
              ),
        ]),
      ),
    );
  }
}
