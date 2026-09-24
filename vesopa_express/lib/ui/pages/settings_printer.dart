/// Staff only: the kiosk's receipt printer.
///
/// Chosen here, on the kiosk, because a printer is plugged into this machine
/// and nobody else's. Whether a ticket is printed at all -- always, when the
/// customer asks, or never -- is the venue's choice in the back office, and is
/// shown here so nobody wonders why a printer that works prints nothing.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/receipts.dart';
import '../../data/session.dart';
import '../../printing/ticket_printer.dart';
import '../theme.dart';

class TicketPrinterCard extends ConsumerStatefulWidget {
  const TicketPrinterCard({super.key});

  @override
  ConsumerState<TicketPrinterCard> createState() => _TicketPrinterCardState();
}

class _TicketPrinterCardState extends ConsumerState<TicketPrinterCard> {
  bool _busy = false;
  String? _said;
  bool _ok = true;

  Future<void> _test(TicketPrinter printer) async {
    setState(() {
      _busy = true;
      _said = null;
    });
    try {
      await printTestTicket(printer: printer, config: ref.read(kioskSessionProvider).config);
      _ok = true;
      _said = 'Sent to ${printer.summary}. Check the ticket: the pound sign should read £12.50.';
    } catch (e) {
      _ok = false;
      _said = 'It did not print: $e';
    }
    if (mounted) setState(() => _busy = false);
  }

  Future<void> _choose(TicketPrinter? current) async {
    final chosen = await showDialog<TicketPrinter>(
      context: context,
      builder: (_) => _PrinterPicker(current: current),
    );
    if (chosen == null) return;
    await ref.read(ticketPrinterProvider.notifier).choose(chosen);
    if (mounted) setState(() => _said = null);
  }

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final printer = ref.watch(ticketPrinterProvider).value;
    final face = ref.watch(kioskSessionProvider.select((s) => s.config?.receipt));
    final venue = switch (face?.mode) {
      'always' => 'The venue prints a ticket for every order.',
      'never' => 'The venue has tickets turned off: nothing prints, printer or not.',
      _ => 'The venue offers a ticket: "Print a receipt" on the number screen.',
    };

    return Container(
      padding: const EdgeInsets.all(22),
      decoration: BoxDecoration(color: Xp.card, borderRadius: BorderRadius.circular(Xp.radius)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Receipt printer', style: text.headlineSmall),
          const SizedBox(height: 6),
          Text(venue, style: text.bodyLarge?.copyWith(color: Xp.muted)),
          const SizedBox(height: 14),
          Text(
            printer == null
                ? 'No printer chosen: this kiosk prints nothing.'
                : '${printer.kind.label}: ${printer.summary}  (${printer.paperWidthMm} mm roll)',
            style: text.titleMedium?.copyWith(fontWeight: FontWeight.w700),
          ),
          if (_said != null) ...[
            const SizedBox(height: 8),
            Text(_said!, style: TextStyle(color: _ok ? Xp.limeDeep : Xp.danger, fontWeight: FontWeight.w700)),
          ],
          const SizedBox(height: 16),
          Wrap(spacing: 12, runSpacing: 12, children: [
            FilledButton.icon(
              icon: const Icon(Icons.print_rounded),
              label: Text(printer == null ? 'Choose a printer' : 'Change printer'),
              onPressed: _busy ? null : () => _choose(printer),
            ),
            if (printer != null) ...[
              OutlinedButton.icon(
                icon: _busy
                    ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
                    : const Icon(Icons.receipt_long_rounded),
                label: const Text('Print a test ticket'),
                onPressed: _busy ? null : () => _test(printer),
              ),
              OutlinedButton(
                onPressed: _busy
                    ? null
                    : () => ref
                        .read(ticketPrinterProvider.notifier)
                        .choose(printer.copyWith(paperWidthMm: printer.paperWidthMm == 80 ? 58 : 80)),
                child: Text('Roll: ${printer.paperWidthMm} mm (change)'),
              ),
              OutlinedButton(
                onPressed: _busy ? null : () => ref.read(ticketPrinterProvider.notifier).forget(),
                child: const Text('No printer'),
              ),
            ],
          ]),
        ],
      ),
    );
  }
}

/// Which printer: the USB ones plugged in now, the ones Windows knows, or one
/// on the network by its address.
class _PrinterPicker extends StatefulWidget {
  const _PrinterPicker({this.current});
  final TicketPrinter? current;

  @override
  State<_PrinterPicker> createState() => _PrinterPickerState();
}

class _PrinterPickerState extends State<_PrinterPicker> {
  List<WindowsPrintQueue>? _queues;
  List<UsbPrinterDevice>? _usb;
  final _host = TextEditingController();
  final _port = TextEditingController(text: '9100');

  @override
  void initState() {
    super.initState();
    final c = widget.current;
    if (c != null && c.kind == TicketPrinterKind.network) {
      _host.text = c.host ?? '';
      _port.text = '${c.port}';
    }
    unawaited(_look());
  }

  @override
  void dispose() {
    _host.dispose();
    _port.dispose();
    super.dispose();
  }

  Future<void> _look() async {
    setState(() {
      _queues = null;
      _usb = null;
    });
    List<WindowsPrintQueue> queues = const [];
    List<UsbPrinterDevice> usb = const [];
    try {
      queues = await findWindowsPrinters();
    } catch (_) {/* none to offer */}
    try {
      usb = await findUsbPrinters();
    } catch (_) {/* none to offer */}
    if (!mounted) return;
    setState(() {
      _queues = queues;
      _usb = usb;
    });
  }

  int get _width => widget.current?.paperWidthMm ?? 80;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    Widget heading(String s) => Padding(
      padding: const EdgeInsets.only(top: 16, bottom: 6),
      child: Text(s, style: text.titleMedium?.copyWith(fontWeight: FontWeight.w800)),
    );
    Widget tile(String title, String? sub, TicketPrinter choice) => ListTile(
      contentPadding: EdgeInsets.zero,
      leading: const Icon(Icons.print_outlined, size: 30),
      title: Text(title, style: const TextStyle(fontWeight: FontWeight.w700)),
      subtitle: sub == null ? null : Text(sub),
      trailing: const Icon(Icons.chevron_right),
      onTap: () => Navigator.pop(context, choice),
    );
    final queues = _queues;
    final usb = _usb;

    return Dialog(
      backgroundColor: Xp.paper,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Xp.radius)),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 640, maxHeight: 760),
        child: Padding(
          padding: const EdgeInsets.all(26),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(children: [
                Expanded(child: Text('Choose the receipt printer', style: text.headlineSmall)),
                IconButton(onPressed: _look, tooltip: 'Look again', icon: const Icon(Icons.refresh)),
              ]),
              Text('A USB printer written to directly is the most reliable on a kiosk.',
                  style: text.bodyMedium?.copyWith(color: Xp.muted)),
              Expanded(
                child: queues == null || usb == null
                    ? const Center(child: CircularProgressIndicator())
                    : ListView(children: [
                        heading('USB printers (direct)'),
                        if (usb.isEmpty) const Text('None plugged in and switched on.'),
                        for (final d in usb)
                          tile(
                            d.label,
                            'Straight to the printer, no Windows spooler',
                            TicketPrinter(
                              kind: TicketPrinterKind.usb,
                              usbPath: d.devicePath,
                              usbLabel: d.label,
                              paperWidthMm: _width,
                            ),
                          ),
                        heading('Windows printers'),
                        if (queues.isEmpty) const Text('Windows has no printers set up.'),
                        for (final q in queues)
                          tile(
                            q.name,
                            q.isShared ? 'Shared from ${q.server}' : 'Sent as a RAW job',
                            TicketPrinter(kind: TicketPrinterKind.windowsQueue, queue: q.name, paperWidthMm: _width),
                          ),
                        heading('Network printer'),
                        Row(children: [
                          Expanded(
                            flex: 3,
                            child: TextField(
                              controller: _host,
                              decoration: const InputDecoration(labelText: 'Address, e.g. 192.168.1.50'),
                            ),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: TextField(
                              controller: _port,
                              keyboardType: TextInputType.number,
                              decoration: const InputDecoration(labelText: 'Port'),
                            ),
                          ),
                          const SizedBox(width: 12),
                          FilledButton(
                            onPressed: () {
                              final host = _host.text.trim();
                              if (host.isEmpty) return;
                              Navigator.pop(
                                context,
                                TicketPrinter(
                                  kind: TicketPrinterKind.network,
                                  host: host,
                                  port: int.tryParse(_port.text.trim()) ?? 9100,
                                  paperWidthMm: _width,
                                ),
                              );
                            },
                            child: const Text('Use it'),
                          ),
                        ]),
                      ]),
              ),
              const SizedBox(height: 12),
              Align(
                alignment: Alignment.centerRight,
                child: TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
