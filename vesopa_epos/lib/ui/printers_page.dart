import 'dart:io';
import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/printer_settings.dart';
import '../printing/printer_transport.dart';

/// The terminal's printers, loaded once and kept in memory.
final printerSettingsProvider =
    AsyncNotifierProvider<PrinterSettingsController, PrinterSettings>(
  PrinterSettingsController.new,
);

class PrinterSettingsController extends AsyncNotifier<PrinterSettings> {
  final _store = const PrinterSettingsStore();

  @override
  Future<PrinterSettings> build() => _store.load();

  Future<void> save(PrinterConfig printer) async {
    final current = state.value ?? const PrinterSettings();
    final next = current.upsert(printer);
    await _store.save(next);
    state = AsyncData(next);
  }

  Future<void> remove(String id) async {
    final current = state.value ?? const PrinterSettings();
    final next = current.remove(id);
    await _store.save(next);
    state = AsyncData(next);
  }
}

/// Set up the printers wired to this till.
///
/// Roll width is per printer, not per venue: a counter printer on 80mm and a
/// kitchen printer on 58mm is a normal pairing, and getting it wrong crops the
/// price column off the right-hand edge of the receipt.
class PrintersPage extends ConsumerWidget {
  const PrintersPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final settings = ref.watch(printerSettingsProvider);

    return settings.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (e, _) => Center(child: Text('Could not read printer settings: $e')),
      data: (data) => ListView(
        padding: const EdgeInsets.all(20),
        children: [
          Text('Printers on this terminal',
              style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 6),
          Text(
            'Each till keeps its own printers, because they are physically '
            'plugged into it. Set the roll width to match the paper actually '
            'loaded — an 80mm layout on a 58mm roll loses the price column.',
            style: Theme.of(context).textTheme.bodySmall,
          ),
          const SizedBox(height: 20),

          for (final role in PrinterRole.values) ...[
            _RoleSection(
              role: role,
              printer: data.forRole(role),
              onEdit: (existing) => _edit(context, ref, role, existing),
              onRemove: (id) => ref.read(printerSettingsProvider.notifier)
                  .remove(id),
            ),
            const SizedBox(height: 14),
          ],
        ],
      ),
    );
  }

  Future<void> _edit(
    BuildContext context,
    WidgetRef ref,
    PrinterRole role,
    PrinterConfig? existing,
  ) async {
    final result = await showDialog<PrinterConfig>(
      context: context,
      builder: (_) => _PrinterDialog(role: role, existing: existing),
    );
    if (result != null) {
      await ref.read(printerSettingsProvider.notifier).save(result);
    }
  }
}

class _RoleSection extends StatelessWidget {
  const _RoleSection({
    required this.role,
    required this.printer,
    required this.onEdit,
    required this.onRemove,
  });

  final PrinterRole role;
  final PrinterConfig? printer;
  final void Function(PrinterConfig? existing) onEdit;
  final void Function(String id) onRemove;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final p = printer;

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
                  role == PrinterRole.receipt
                      ? Icons.receipt_long
                      : Icons.soup_kitchen_outlined,
                  color: scheme.primary,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(role.label,
                      style: theme.textTheme.titleMedium
                          ?.copyWith(fontWeight: FontWeight.w700)),
                ),
                if (p != null)
                  Chip(
                    label: Text('${p.paperWidthMm}mm'),
                    visualDensity: VisualDensity.compact,
                  ),
              ],
            ),
            const SizedBox(height: 10),

            if (p == null)
              Row(
                children: [
                  Expanded(
                    child: Text('Not set up',
                        style: theme.textTheme.bodyMedium
                            ?.copyWith(color: scheme.onSurfaceVariant)),
                  ),
                  FilledButton.tonalIcon(
                    onPressed: () => onEdit(null),
                    icon: const Icon(Icons.add),
                    label: const Text('Add printer'),
                  ),
                ],
              )
            else ...[
              Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(p.name,
                            style: theme.textTheme.bodyLarge
                                ?.copyWith(fontWeight: FontWeight.w600)),
                        Text(
                          p.kind == PrinterKind.network
                              ? '${p.host}:${p.port} (network)'
                              : '${p.serialPort} @ ${p.baudRate} (serial)',
                          style: theme.textTheme.bodySmall
                              ?.copyWith(color: scheme.onSurfaceVariant),
                        ),
                        Text('${p.columns} characters per line',
                            style: theme.textTheme.bodySmall
                                ?.copyWith(color: scheme.onSurfaceVariant)),
                      ],
                    ),
                  ),
                  IconButton(
                    onPressed: () => onEdit(p),
                    icon: const Icon(Icons.edit_outlined),
                    tooltip: 'Edit',
                  ),
                  IconButton(
                    onPressed: () => onRemove(p.id),
                    icon: const Icon(Icons.delete_outline),
                    tooltip: 'Remove',
                  ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _PrinterDialog extends StatefulWidget {
  const _PrinterDialog({required this.role, this.existing});

  final PrinterRole role;
  final PrinterConfig? existing;

  @override
  State<_PrinterDialog> createState() => _PrinterDialogState();
}

class _PrinterDialogState extends State<_PrinterDialog> {
  late final _name = TextEditingController(
      text: widget.existing?.name ?? widget.role.label);
  late final _host = TextEditingController(text: widget.existing?.host ?? '');
  late final _port =
      TextEditingController(text: '${widget.existing?.port ?? 9100}');
  late final _serial =
      TextEditingController(text: widget.existing?.serialPort ?? '');
  late final _baud =
      TextEditingController(text: '${widget.existing?.baudRate ?? 9600}');

  late PrinterKind _kind = widget.existing?.kind ??
      // Serial is only reachable on desktop; a tablet has no COM port, so
      // offering it as the default there would be a dead end.
      (_desktop ? PrinterKind.serial : PrinterKind.network);
  late int _width = widget.existing?.paperWidthMm ?? 80;

  static bool get _desktop =>
      Platform.isWindows || Platform.isMacOS || Platform.isLinux;

  @override
  void dispose() {
    _name.dispose();
    _host.dispose();
    _port.dispose();
    _serial.dispose();
    _baud.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(widget.existing == null
          ? 'Add ${widget.role.label.toLowerCase()}'
          : 'Edit ${widget.role.label.toLowerCase()}'),
      content: SizedBox(
        width: 420,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              TextField(
                controller: _name,
                decoration: const InputDecoration(labelText: 'Name'),
              ),
              const SizedBox(height: 14),

              Text('Roll width',
                  style: Theme.of(context).textTheme.labelLarge),
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
                style: Theme.of(context).textTheme.bodySmall,
              ),
              const SizedBox(height: 16),

              Text('Connection',
                  style: Theme.of(context).textTheme.labelLarge),
              const SizedBox(height: 6),
              SegmentedButton<PrinterKind>(
                segments: [
                  const ButtonSegment(
                      value: PrinterKind.network, label: Text('Network')),
                  ButtonSegment(
                    value: PrinterKind.serial,
                    label: const Text('Serial / USB'),
                    enabled: _desktop,
                  ),
                ],
                selected: {_kind},
                onSelectionChanged: (s) => setState(() => _kind = s.first),
              ),
              const SizedBox(height: 12),

              if (_kind == PrinterKind.network) ...[
                TextField(
                  controller: _host,
                  decoration: const InputDecoration(
                    labelText: 'IP address',
                    hintText: '192.168.1.50',
                  ),
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
              ] else ...[
                TextField(
                  controller: _serial,
                  decoration: InputDecoration(
                    labelText: 'Port',
                    hintText: Platform.isWindows ? 'COM3' : '/dev/tty.usbserial',
                  ),
                ),
                const SizedBox(height: 10),
                TextField(
                  controller: _baud,
                  keyboardType: TextInputType.number,
                  decoration: const InputDecoration(labelText: 'Baud rate'),
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
          onPressed: () {
            final id = widget.existing?.id ??
                // Stable enough for a device-local list.
                '${widget.role.name}-${Random().nextInt(1 << 32)}';
            Navigator.pop(
              context,
              PrinterConfig(
                id: id,
                name: _name.text.trim().isEmpty
                    ? widget.role.label
                    : _name.text.trim(),
                kind: _kind,
                role: widget.role,
                host: _host.text.trim().isEmpty ? null : _host.text.trim(),
                port: int.tryParse(_port.text) ?? 9100,
                serialPort:
                    _serial.text.trim().isEmpty ? null : _serial.text.trim(),
                baudRate: int.tryParse(_baud.text) ?? 9600,
                paperWidthMm: _width,
              ),
            );
          },
          child: const Text('Save'),
        ),
      ],
    );
  }
}
