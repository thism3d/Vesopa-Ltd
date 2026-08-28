import 'dart:io';
import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/printer_settings.dart';
import '../main.dart' show tillSettingsProvider;
import 'kitchen_delivery_card.dart';
// printer_transport re-exports print_targets.dart, where PrintTarget lives.
import '../printing/printer_transport.dart';
import '../printing/receipt_builder.dart';
import '../printing/windows_printing.dart';
import 'theme.dart';
import 'widgets/pos_message.dart';

/// The terminal's printers, loaded once and kept in memory.
final printerSettingsProvider =
    AsyncNotifierProvider<PrinterSettingsController, PrinterSettings>(
      PrinterSettingsController.new,
    );

class PrinterSettingsController extends AsyncNotifier<PrinterSettings> {
  final _store = const PrinterSettingsStore();

  @override
  Future<PrinterSettings> build() => _store.load();

  Future<void> _write(PrinterSettings next) async {
    await _store.save(next);
    state = AsyncData(next);
  }

  PrinterSettings get _current => state.value ?? const PrinterSettings();

  Future<void> save(PrinterConfig printer) => _write(_current.upsert(printer));

  Future<void> remove(String id) => _write(_current.remove(id));

  Future<void> assign(PrintTarget target, String? printerId) =>
      _write(_current.assign(target, printerId));

  Future<void> setMerchantCopyWhen(MerchantCopyWhen when) =>
      _write(_current.copyWith(merchantCopyWhen: when));
}

/// Set up the printers wired to this till, and decide what comes out of each.
///
/// Two lists, in the order the job gets done: the printers themselves, then
/// what each document prints on. They used to be one list — a printer *was*
/// "the receipt printer" — which made the thing a venue most often wants,
/// their copy and the customer's on different paper, impossible to say.
class PrintersPage extends ConsumerWidget {
  const PrintersPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final settings = ref.watch(printerSettingsProvider);

    return settings.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (e, _) =>
          Center(child: Text('Could not read printer settings: $e')),
      data: (data) => ListView(
        padding: const EdgeInsets.all(20),
        children: [
          Text(
            'Printers on this terminal',
            style: Theme.of(context).textTheme.titleLarge,
          ),
          const SizedBox(height: 6),
          Text(
            'Each till keeps its own printers, because they are physically '
            'plugged into it. Set the roll width to match the paper actually '
            'loaded — an 80mm layout on a 58mm roll loses the price column.',
            style: Theme.of(context).textTheme.bodySmall,
          ),
          const SizedBox(height: 16),

          for (final printer in data.printers) ...[
            _PrinterCard(
              printer: printer,
              usedFor: [
                for (final target in PrintTarget.values)
                  if (data.assigned(target)?.id == printer.id) target.label,
              ],
              onEdit: () => _edit(context, ref, printer),
              onRemove: () => _confirmRemove(context, ref, printer),
              onTest: () => _test(context, printer),
            ),
            const SizedBox(height: 10),
          ],

          if (data.printers.isEmpty)
            Card(
              margin: EdgeInsets.zero,
              child: const ListTile(
                leading: Icon(Icons.print_disabled_outlined),
                title: Text('No printers yet'),
                subtitle: Text(
                  'Add the printer plugged into this till to start.',
                  style: TextStyle(fontSize: 12.5),
                ),
              ),
            ),

          const SizedBox(height: 10),
          Align(
            alignment: Alignment.centerLeft,
            child: FilledButton.icon(
              onPressed: () => _edit(context, ref, null),
              icon: const Icon(Icons.add),
              label: const Text('Add a printer'),
            ),
          ),

          const SizedBox(height: 30),
          Text(
            'What prints where',
            style: Theme.of(context).textTheme.titleLarge,
          ),
          const SizedBox(height: 6),
          Text(
            'Every document can go to its own printer. Anything left on '
            '"Same as the receipt printer" follows that one, which is how a '
            'till with a single printer behaves without setting anything here.',
            style: Theme.of(context).textTheme.bodySmall,
          ),
          const SizedBox(height: 14),

          Card(
            margin: EdgeInsets.zero,
            child: Column(
              children: [
                for (final target in PrintTarget.values) ...[
                  if (target != PrintTarget.values.first)
                    const Divider(height: 1),
                  _TargetRow(
                    target: target,
                    settings: data,
                    onChanged: (id) => ref
                        .read(printerSettingsProvider.notifier)
                        .assign(target, id),
                  ),
                ],
              ],
            ),
          ),

          const SizedBox(height: 20),
          _MerchantCopyCard(settings: data),

          const SizedBox(height: 20),
          const KitchenDeliveryCard(),

          const SizedBox(height: 16),
          Text(
            'Products are routed to KP 1 to KP 6 — and to the receipt printer '
            'if you want a counter copy — in the back office. A station with '
            'no printer set up here is reported when something routed to it is '
            'sold, rather than being dropped quietly.',
            style: Theme.of(context).textTheme.bodySmall,
          ),
          const SizedBox(height: 24),
        ],
      ),
    );
  }

  Future<void> _edit(
    BuildContext context,
    WidgetRef ref,
    PrinterConfig? existing,
  ) async {
    final result = await showDialog<PrinterConfig>(
      context: context,
      builder: (_) => _PrinterDialog(existing: existing),
    );
    if (result != null) {
      await ref.read(printerSettingsProvider.notifier).save(result);
    }
  }

  /// Removing a printer also drops every job pointing at it, so it is worth a
  /// confirmation naming what will stop printing.
  Future<void> _confirmRemove(
    BuildContext context,
    WidgetRef ref,
    PrinterConfig printer,
  ) async {
    final settings = ref.read(printerSettingsProvider).value;
    final jobs = [
      for (final target in PrintTarget.values)
        if (settings?.assigned(target)?.id == printer.id) target.label,
    ];

    final go = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('Remove ${printer.name}?'),
        content: Text(
          jobs.isEmpty
              ? 'Nothing is set to print on it, so nothing changes.'
              : 'These will have no printer until you set another: '
                    '${jobs.join(', ')}.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Keep it'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: Pos.red),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Remove'),
          ),
        ],
      ),
    );

    if (go == true) {
      await ref.read(printerSettingsProvider.notifier).remove(printer.id);
    }
  }

  /// Print a test slip. The only way to know a printer is set up correctly is
  /// to make paper come out of it, and doing that here — rather than by taking
  /// a real sale — is the difference between finding a problem now and finding
  /// it with a customer at the counter.
  Future<void> _test(BuildContext context, PrinterConfig printer) async {
    try {
      // The slip's own ruler line only means anything if it is laid out for the
      // width this printer was set up with.
      final builder = await ReceiptBuilder.forPrinter(printer);
      await PrinterTransport.of(printer).send(builder.testSlip(printer));
      if (context.mounted) {
        PosMessenger.success(context, 'Test sent to ${printer.name}.');
      }
    } catch (e) {
      if (context.mounted) {
        showDialog<void>(
          context: context,
          builder: (context) => AlertDialog(
            title: Text('${printer.name} did not print'),
            content: SingleChildScrollView(
              child: Text('$e', style: const TextStyle(fontSize: 13)),
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(context),
                child: const Text('Close'),
              ),
            ],
          ),
        );
      }
    }
  }
}

/// One configured printer.
class _PrinterCard extends StatelessWidget {
  const _PrinterCard({
    required this.printer,
    required this.usedFor,
    required this.onEdit,
    required this.onRemove,
    required this.onTest,
  });

  final PrinterConfig printer;
  final List<String> usedFor;
  final VoidCallback onEdit;
  final VoidCallback onRemove;
  final VoidCallback onTest;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;

    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Icon(
                  switch (printer.kind) {
                    PrinterKind.network => Icons.lan_outlined,
                    PrinterKind.usb => Icons.usb,
                    PrinterKind.serial => Icons.cable,
                    PrinterKind.windowsQueue => Icons.desktop_windows_outlined,
                  },
                  color: scheme.primary,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    printer.name,
                    style: theme.textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
                Chip(
                  label: Text('${printer.paperWidthMm}mm'),
                  visualDensity: VisualDensity.compact,
                ),
              ],
            ),
            const SizedBox(height: 8),
            Text(
              '${printer.kind.label} · ${printer.connectionSummary}',
              style: theme.textTheme.bodyMedium?.copyWith(
                color: scheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 4),
            // Whether the spooler is in the path is the single most useful
            // thing to know about a printer in a busy venue, so it is stated
            // on the card rather than buried in the edit dialog.
            Row(
              children: [
                Icon(
                  printer.isDirect ? Icons.bolt : Icons.schedule,
                  size: 15,
                  color: printer.isDirect ? Pos.green : scheme.onSurfaceVariant,
                ),
                const SizedBox(width: 5),
                Expanded(
                  child: Text(
                    printer.isDirect
                        ? 'Direct — no Windows spooler'
                        : 'Raw, but queued through the Windows spooler',
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: printer.isDirect
                          ? Pos.green
                          : scheme.onSurfaceVariant,
                    ),
                  ),
                ),
              ],
            ),
            if (!printer.isComplete) ...[
              const SizedBox(height: 4),
              Text(
                'Not finished — this printer has nothing to send to.',
                style: theme.textTheme.bodySmall?.copyWith(color: Pos.red),
              ),
            ],
            if (usedFor.isNotEmpty) ...[
              const SizedBox(height: 8),
              Text(
                'Prints: ${usedFor.join(', ')}',
                style: theme.textTheme.bodySmall?.copyWith(
                  color: scheme.onSurfaceVariant,
                ),
              ),
            ],
            const SizedBox(height: 6),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                TextButton.icon(
                  onPressed: onTest,
                  icon: const Icon(Icons.receipt_long, size: 18),
                  label: const Text('Test print'),
                ),
                IconButton(
                  onPressed: onEdit,
                  icon: const Icon(Icons.edit_outlined),
                  tooltip: 'Edit',
                ),
                IconButton(
                  onPressed: onRemove,
                  icon: const Icon(Icons.delete_outline),
                  tooltip: 'Remove',
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// One document, and the printer it comes out of.
class _TargetRow extends ConsumerWidget {
  const _TargetRow({
    required this.target,
    required this.settings,
    required this.onChanged,
  });

  final PrintTarget target;
  final PrinterSettings settings;
  final ValueChanged<String?> onChanged;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    // Named by the venue where they have named it, so this screen and the
    // paper coming out of the printer say the same thing.
    final label = target.isRoutable
        ? ref.watch(tillSettingsProvider).labelFor(target)
        : target.label;
    final assigned = settings.assigned(target);
    final effective = settings.deviceFor(target);
    final inherited = settings.isInherited(target);

    return ListTile(
      leading: Icon(
        switch (target) {
          PrintTarget.customerReceipt => Icons.receipt_long,
          PrintTarget.merchantCopy => Icons.content_copy,
          PrintTarget.bill => Icons.request_quote_outlined,
          PrintTarget.tillReport => Icons.summarize_outlined,
          PrintTarget.cashDrawer => Icons.point_of_sale,
          _ => Icons.soup_kitchen_outlined,
        },
        color: effective == null ? theme.hintColor : Pos.brandDeep,
      ),
      title: Text(label),
      subtitle: Text(
        switch ((effective, inherited)) {
          (null, _) when target.isKitchenStation =>
            'No printer — anything routed here is reported, not printed.',
          (null, _) => 'No printer set up.',
          (final p?, true) => 'Follows ${p.name}.',
          (final p?, false) => '${p.name} · ${p.connectionSummary}',
        },
        style: const TextStyle(fontSize: 12.5),
      ),
      trailing: SizedBox(
        width: 190,
        child: DropdownButtonFormField<String?>(
          initialValue: assigned?.id,
          isExpanded: true,
          decoration: const InputDecoration(
            isDense: true,
            border: OutlineInputBorder(),
            contentPadding: EdgeInsets.symmetric(horizontal: 10, vertical: 8),
          ),
          items: [
            DropdownMenuItem<String?>(
              value: null,
              child: Text(
                target.fallback == null ? 'Not set' : 'Same as receipt',
                style: const TextStyle(fontSize: 13),
              ),
            ),
            for (final printer in settings.printers)
              DropdownMenuItem<String?>(
                value: printer.id,
                child: Text(
                  printer.name,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 13),
                ),
              ),
          ],
          onChanged: onChanged,
        ),
      ),
    );
  }
}

/// Whether the venue prints its own copy of a receipt, and when.
class _MerchantCopyCard extends ConsumerWidget {
  const _MerchantCopyCard({required this.settings});

  final PrinterSettings settings;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final target = settings.deviceFor(PrintTarget.merchantCopy);

    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(Icons.content_copy, color: Pos.brandDeep),
                const SizedBox(width: 10),
                Text(
                  'Merchant copy',
                  style: Theme.of(
                    context,
                  ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Text(
              target == null
                  ? 'Set a printer for the merchant copy above to use this.'
                  : 'The venue\'s own copy of a sale, printed on '
                        '${target.name} and marked MERCHANT COPY so it cannot '
                        'be handed over by mistake.',
              style: Theme.of(context).textTheme.bodySmall,
            ),
            const SizedBox(height: 12),
            SegmentedButton<MerchantCopyWhen>(
              segments: [
                for (final when in MerchantCopyWhen.values)
                  ButtonSegment(value: when, label: Text(when.label)),
              ],
              selected: {settings.merchantCopyWhen},
              onSelectionChanged: (s) => ref
                  .read(printerSettingsProvider.notifier)
                  .setMerchantCopyWhen(s.first),
            ),
          ],
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// The add / edit dialog
// ---------------------------------------------------------------------------

class _PrinterDialog extends StatefulWidget {
  const _PrinterDialog({this.existing});

  final PrinterConfig? existing;

  @override
  State<_PrinterDialog> createState() => _PrinterDialogState();
}

class _PrinterDialogState extends State<_PrinterDialog> {
  late final _name = TextEditingController(
    text: widget.existing?.name ?? 'Printer',
  );
  late final _host = TextEditingController(text: widget.existing?.host ?? '');
  late final _port = TextEditingController(
    text: '${widget.existing?.port ?? 9100}',
  );
  late final _serial = TextEditingController(
    text: widget.existing?.serialPort ?? '',
  );
  late final _baud = TextEditingController(
    text: '${widget.existing?.baudRate ?? 9600}',
  );

  late PrinterKind _kind = widget.existing?.kind ?? _defaultKind;
  late int _width = widget.existing?.paperWidthMm ?? 80;
  late String _codePage = widget.existing?.codePage ?? 'CP1252';
  late String? _usbPath = widget.existing?.usbDevicePath;
  late String? _usbLabel = widget.existing?.usbLabel;
  late String? _queue = widget.existing?.windowsQueueName;

  List<UsbPrinterDevice>? _usbDevices;
  List<WindowsPrintQueue>? _queues;
  bool _scanning = false;

  /// USB direct where it exists, because it is the option a venue should be
  /// using; network everywhere else, because it is the only one a tablet has.
  static PrinterKind get _defaultKind =>
      Platform.isWindows ? PrinterKind.usb : PrinterKind.network;

  @override
  void initState() {
    super.initState();
    if (_kind == PrinterKind.usb || _kind == PrinterKind.windowsQueue) {
      _scan();
    }
  }

  @override
  void dispose() {
    _name.dispose();
    _host.dispose();
    _port.dispose();
    _serial.dispose();
    _baud.dispose();
    super.dispose();
  }

  /// Ask Windows what is actually plugged in. Cheap enough to run on opening
  /// the dialog, and far better than asking an operator to type a device path.
  Future<void> _scan() async {
    if (!Platform.isWindows) return;
    setState(() => _scanning = true);
    try {
      final usb = await discoverUsbPrinters();
      final queues = await discoverWindowsQueues();
      if (mounted) {
        setState(() {
          _usbDevices = usb;
          _queues = queues;
        });
      }
    } catch (_) {
      // A device-tree walk that fails leaves the lists empty; the dialog says
      // so and the operator can still fall back to another connection.
      if (mounted) {
        setState(() {
          _usbDevices ??= const [];
          _queues ??= const [];
        });
      }
    } finally {
      if (mounted) setState(() => _scanning = false);
    }
  }

  bool get _canSave => switch (_kind) {
    PrinterKind.network => _host.text.trim().isNotEmpty,
    PrinterKind.serial => _serial.text.trim().isNotEmpty,
    PrinterKind.usb => (_usbPath ?? '').isNotEmpty,
    PrinterKind.windowsQueue => (_queue ?? '').isNotEmpty,
  };

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final kinds = PrinterKind.values.where((k) => k.isAvailableHere).toList();

    return AlertDialog(
      title: Text(widget.existing == null ? 'Add a printer' : 'Edit printer'),
      content: SizedBox(
        width: 460,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              TextField(
                controller: _name,
                decoration: const InputDecoration(
                  labelText: 'Name',
                  helperText: 'What this printer is called on this till',
                ),
                onChanged: (_) => setState(() {}),
              ),
              const SizedBox(height: 16),

              Text('Roll width', style: theme.textTheme.labelLarge),
              const SizedBox(height: 6),
              SegmentedButton<int>(
                segments: const [
                  ButtonSegment(value: 80, label: Text('80mm')),
                  ButtonSegment(value: 58, label: Text('58mm')),
                ],
                selected: {_width},
                onSelectionChanged: (s) => setState(() => _width = s.first),
              ),
              const SizedBox(height: 6),
              Text(
                _width == 80
                    ? 'Standard receipt roll — 48 characters per line.'
                    : 'Narrow roll — 32 characters per line.',
                style: theme.textTheme.bodySmall,
              ),
              const SizedBox(height: 18),

              // Only ever touched by a venue whose printer draws the pound sign
              // wrong, which is why it is a dropdown with the right answer
              // already in it rather than a decision anybody has to make.
              Text('Character set', style: theme.textTheme.labelLarge),
              const SizedBox(height: 6),
              DropdownButtonFormField<String>(
                initialValue: _codePage,
                isExpanded: true,
                items: [
                  for (final entry in escPosCodePages.entries)
                    DropdownMenuItem(
                      value: entry.key,
                      child: Text(
                        entry.value,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                ],
                onChanged: (v) =>
                    setState(() => _codePage = v ?? 'CP1252'),
              ),
              const SizedBox(height: 6),
              Text(
                _codePage == escPosGbp
                    ? 'Sends the pound as the byte this printer draws as £ '
                          'whatever its settings say. A real # prints as "No." '
                          'Use this only if the test slip shows the wrong sign.'
                    : 'Leave this alone unless the test slip below prints '
                          'something other than £ against the amount.',
                style: theme.textTheme.bodySmall,
              ),
              const SizedBox(height: 18),

              Text('Connection', style: theme.textTheme.labelLarge),
              const SizedBox(height: 6),
              // Wrapped rather than a SegmentedButton: four connections do not
              // fit across a dialog on a narrow till screen.
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  for (final kind in kinds)
                    ChoiceChip(
                      label: Text(kind.label),
                      selected: _kind == kind,
                      avatar: kind.isDirect
                          ? const Icon(Icons.bolt, size: 16)
                          : null,
                      onSelected: (_) {
                        setState(() => _kind = kind);
                        if ((kind == PrinterKind.usb ||
                                kind == PrinterKind.windowsQueue) &&
                            _usbDevices == null) {
                          _scan();
                        }
                      },
                    ),
                ],
              ),
              const SizedBox(height: 8),
              Container(
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: theme.colorScheme.surfaceContainerHighest,
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Icon(
                      _kind.isDirect ? Icons.bolt : Icons.info_outline,
                      size: 17,
                      color: _kind.isDirect ? Pos.green : theme.hintColor,
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        _kind.blurb,
                        style: theme.textTheme.bodySmall,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 14),

              ..._connectionFields(theme),
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
          onPressed: _canSave ? _save : null,
          child: const Text('Save'),
        ),
      ],
    );
  }

  List<Widget> _connectionFields(ThemeData theme) => switch (_kind) {
    PrinterKind.network => [
      TextField(
        controller: _host,
        decoration: const InputDecoration(
          labelText: 'IP address',
          hintText: '192.168.1.50',
        ),
        onChanged: (_) => setState(() {}),
      ),
      const SizedBox(height: 10),
      TextField(
        controller: _port,
        keyboardType: TextInputType.number,
        decoration: const InputDecoration(
          labelText: 'Port',
          helperText: 'Thermal printers normally use 9100',
        ),
      ),
    ],
    PrinterKind.serial => [
      TextField(
        controller: _serial,
        decoration: InputDecoration(
          labelText: 'Port',
          hintText: Platform.isWindows ? 'COM3' : '/dev/tty.usbserial',
        ),
        onChanged: (_) => setState(() {}),
      ),
      const SizedBox(height: 8),
      _PortSuggestions(
        ports: availableSerialPorts(),
        onPick: (port) => setState(() => _serial.text = port),
      ),
      const SizedBox(height: 10),
      TextField(
        controller: _baud,
        keyboardType: TextInputType.number,
        decoration: const InputDecoration(labelText: 'Baud rate'),
      ),
    ],
    PrinterKind.usb => [
      _DeviceList<UsbPrinterDevice>(
        title: 'USB printers plugged in now',
        scanning: _scanning,
        devices: _usbDevices,
        emptyMessage:
            'No USB printer found. Check it is plugged in and switched '
            'on, and that Windows has installed it once. A printer with a '
            'vendor driver that does not expose a direct USB interface has to '
            'use the Windows printer option instead.',
        isSelected: (d) => d.devicePath == _usbPath,
        labelOf: (d) => d.label,
        detailOf: (d) => d.devicePath,
        onPick: (d) => setState(() {
          _usbPath = d.devicePath;
          _usbLabel = d.label;
          if (_name.text.trim().isEmpty || _name.text == 'Printer') {
            _name.text = d.label;
          }
        }),
        onRescan: _scan,
      ),
      // A path saved earlier for a printer that is not plugged in now. Kept
      // and shown rather than silently cleared: unplugging a printer to move
      // a till must not wipe its setup.
      if (_usbPath != null &&
          (_usbDevices ?? const []).every((d) => d.devicePath != _usbPath))
        Padding(
          padding: const EdgeInsets.only(top: 10),
          child: Text(
            'Currently set to ${_usbLabel ?? _usbPath}, which is not plugged '
            'in at the moment. It will print again when it is reconnected.',
            style: theme.textTheme.bodySmall?.copyWith(color: Pos.amber),
          ),
        ),
    ],
    PrinterKind.windowsQueue => [
      _DeviceList<WindowsPrintQueue>(
        title: 'Printers set up in Windows',
        scanning: _scanning,
        devices: _queues,
        emptyMessage:
            'Windows has no printers installed. Add one in Windows '
            'Settings first, then come back.',
        isSelected: (q) => q.name == _queue,
        labelOf: (q) => q.name,
        detailOf: (q) => q.isShared ? 'Shared from ${q.server}' : 'Local',
        onPick: (q) => setState(() {
          _queue = q.name;
          if (_name.text.trim().isEmpty || _name.text == 'Printer') {
            _name.text = q.name;
          }
        }),
        onRescan: _scan,
      ),
    ],
  };

  void _save() {
    final id =
        widget.existing?.id ??
        // Stable enough for a device-local list.
        'printer-${DateTime.now().millisecondsSinceEpoch}-'
            '${Random().nextInt(1 << 20)}';

    Navigator.pop(
      context,
      PrinterConfig(
        id: id,
        name: _name.text.trim().isEmpty ? 'Printer' : _name.text.trim(),
        kind: _kind,
        host: _host.text.trim().isEmpty ? null : _host.text.trim(),
        port: int.tryParse(_port.text) ?? 9100,
        serialPort: _serial.text.trim().isEmpty ? null : _serial.text.trim(),
        baudRate: int.tryParse(_baud.text) ?? 9600,
        windowsQueueName: _queue,
        usbDevicePath: _usbPath,
        usbLabel: _usbLabel,
        paperWidthMm: _width,
        codePage: _codePage,
      ),
    );
  }
}

/// A discovered-device picker: what is out there, which one is chosen, and a
/// way to look again.
class _DeviceList<T> extends StatelessWidget {
  const _DeviceList({
    required this.title,
    required this.scanning,
    required this.devices,
    required this.emptyMessage,
    required this.isSelected,
    required this.labelOf,
    required this.detailOf,
    required this.onPick,
    required this.onRescan,
  });

  final String title;
  final bool scanning;
  final List<T>? devices;
  final String emptyMessage;
  final bool Function(T) isSelected;
  final String Function(T) labelOf;
  final String Function(T) detailOf;
  final ValueChanged<T> onPick;
  final VoidCallback onRescan;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final list = devices;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(child: Text(title, style: theme.textTheme.labelLarge)),
            TextButton.icon(
              onPressed: scanning ? null : onRescan,
              icon: scanning
                  ? const SizedBox(
                      width: 14,
                      height: 14,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.refresh, size: 18),
              label: const Text('Scan again'),
            ),
          ],
        ),
        if (list == null && scanning)
          const Padding(
            padding: EdgeInsets.all(16),
            child: Center(child: CircularProgressIndicator()),
          )
        else if (list == null || list.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 6),
            child: Text(emptyMessage, style: theme.textTheme.bodySmall),
          )
        else
          for (final device in list)
            ListTile(
              contentPadding: EdgeInsets.zero,
              dense: true,
              leading: Icon(
                isSelected(device)
                    ? Icons.radio_button_checked
                    : Icons.radio_button_unchecked,
                color: isSelected(device) ? Pos.brand : theme.hintColor,
              ),
              title: Text(labelOf(device)),
              subtitle: Text(
                detailOf(device),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 11),
              ),
              onTap: () => onPick(device),
            ),
      ],
    );
  }
}

/// The COM ports this machine has, as tappable chips.
class _PortSuggestions extends StatelessWidget {
  const _PortSuggestions({required this.ports, required this.onPick});

  final List<String> ports;
  final ValueChanged<String> onPick;

  @override
  Widget build(BuildContext context) {
    if (ports.isEmpty) {
      return Text(
        'No serial ports found on this machine.',
        style: Theme.of(context).textTheme.bodySmall,
      );
    }
    return Wrap(
      spacing: 8,
      runSpacing: 4,
      children: [
        for (final port in ports)
          ActionChip(label: Text(port), onPressed: () => onPick(port)),
      ],
    );
  }
}
