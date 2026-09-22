import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/local/database.dart';
import '../../main.dart';
import '../theme.dart';
import '../void_dialog.dart';
import 'basket_panel.dart' show money;

/// Tap a basket line to open this: change the quantity, discount it, note it,
/// or remove it. One place for everything you can do to a single line, rather
/// than scattering those across long-press and hidden gestures.
Future<void> showLineEditor(
  BuildContext context,
  WidgetRef ref, {
  required String orderId,
  required OrderLine line,
}) {
  return showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (_) => Padding(
      // Lift above the keyboard when the note or amount field is focused.
      padding: EdgeInsets.only(
        bottom: MediaQuery.of(context).viewInsets.bottom,
      ),
      child: _LineEditor(orderId: orderId, line: line),
    ),
  );
}

class _LineEditor extends ConsumerStatefulWidget {
  const _LineEditor({required this.orderId, required this.line});

  final String orderId;
  final OrderLine line;

  @override
  ConsumerState<_LineEditor> createState() => _LineEditorState();
}

class _LineEditorState extends ConsumerState<_LineEditor> {
  late double _qty = widget.line.quantity;

  OrderRepositoryLike get _repo => ref.read(orderRepositoryProvider);

  @override
  Widget build(BuildContext context) {
    final line = widget.line;
    final lineTotal = (line.unitPriceMinor * _qty).round();

    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 4, 20, 20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    line.name,
                    style: const TextStyle(
                      fontSize: 19,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
                Text(
                  money(lineTotal),
                  style: const TextStyle(
                    fontSize: 19,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ],
            ),
            Text(
              '${money(line.unitPriceMinor)} each',
              style: TextStyle(color: Theme.of(context).hintColor),
            ),
            if (line.lineDiscountMinor > 0)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text(
                  'Discount -${money(line.lineDiscountMinor)}',
                  style: const TextStyle(color: Pos.green, fontSize: 13),
                ),
              ),
            const SizedBox(height: 20),

            // Quantity: steppers for the common case, a tap on the number for
            // an exact amount.
            Row(
              children: [
                const Text('Quantity', style: TextStyle(fontSize: 15)),
                const Spacer(),
                _StepButton(
                  icon: Icons.remove,
                  onTap: () => _setQty(_qty - 1),
                ),
                InkWell(
                  onTap: _promptExactQty,
                  borderRadius: BorderRadius.circular(6),
                  child: Container(
                    width: 64,
                    alignment: Alignment.center,
                    padding: const EdgeInsets.symmetric(vertical: 8),
                    child: Text(
                      _qty.toStringAsFixed(_qty % 1 == 0 ? 0 : 2),
                      style: const TextStyle(
                        fontSize: 22,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                ),
                _StepButton(icon: Icons.add, onTap: () => _setQty(_qty + 1)),
              ],
            ),
            const Divider(height: 28),

            _ActionTile(
              icon: Icons.percent,
              label: 'Discount this line',
              value: line.lineDiscountMinor > 0
                  ? '-${money(line.lineDiscountMinor)}'
                  : null,
              onTap: _promptDiscount,
            ),
            _ActionTile(
              icon: Icons.edit_note,
              label: 'Note',
              value: (line.notes?.isNotEmpty ?? false) ? line.notes : null,
              onTap: _promptNote,
            ),
            _ActionTile(
              icon: Icons.delete_outline,
              label: 'Remove from bill',
              danger: true,
              onTap: _removeLine,
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _setQty(double q) async {
    final next = q < 0 ? 0.0 : q;
    setState(() => _qty = next);
    await _repo.setLineQuantity(widget.orderId, widget.line.id, next);
    if (next == 0 && mounted) Navigator.pop(context);
  }

  Future<void> _promptExactQty() async {
    final value = await _numberDialog('Quantity', _qty.toString());
    if (value != null) await _setQty(value);
  }

  Future<void> _promptDiscount() async {
    final pounds = await _numberDialog('Discount on this line (£)', '');
    if (pounds != null) {
      await _repo.setLineDiscount(
        widget.orderId,
        widget.line.id,
        (pounds * 100).round(),
      );
      if (mounted) Navigator.pop(context);
    }
  }

  /// Take this line off the bill.
  ///
  /// Goes through the same void dialog as the Void key, and writes the same
  /// audit record. It used to delete the row outright: a clerk could take an
  /// item — and the money for it — off a check from here with no reason and
  /// nothing recorded, while the identical action one screen away demanded
  /// both. One bill cannot have two rules about removing from it.
  Future<void> _removeLine() async {
    final reason = await showVoidDialog(
      context,
      ref,
      itemCount: 1,
      itemSummary: widget.line.name,
    );
    if (reason == null) return;

    await _repo.voidLines(
      widget.orderId,
      lineIds: {widget.line.id},
      reason: reason,
    );
    // Push the audit record now rather than waiting for the periodic flush, so
    // the back office sees the reversal in real time — same as the Void key.
    unawaited(ref.read(syncServiceProvider).flush());

    if (mounted) Navigator.pop(context);
  }

  Future<void> _promptNote() async {
    final controller = TextEditingController(text: widget.line.notes ?? '');
    final note = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Line note'),
        content: TextField(
          controller: controller,
          autofocus: true,
          decoration: const InputDecoration(
            hintText: 'e.g. no ice, well done',
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, controller.text.trim()),
            child: const Text('Save'),
          ),
        ],
      ),
    );
    if (note != null) {
      await _repo.setLineNote(widget.line.id, note.isEmpty ? null : note);
      if (mounted) Navigator.pop(context);
    }
  }

  Future<double?> _numberDialog(String title, String initial) {
    final controller = TextEditingController(text: initial);
    return showDialog<double>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(title),
        content: TextField(
          controller: controller,
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          autofocus: true,
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () =>
                Navigator.pop(context, double.tryParse(controller.text.trim())),
            child: const Text('OK'),
          ),
        ],
      ),
    );
  }
}

/// The subset of the repository the editor needs — kept as an interface so the
/// widget does not depend on the whole class surface.
typedef OrderRepositoryLike = dynamic;

class _StepButton extends StatelessWidget {
  const _StepButton({required this.icon, required this.onTap});

  final IconData icon;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Theme.of(context).colorScheme.surfaceContainerHighest,
      shape: const CircleBorder(),
      child: InkWell(
        customBorder: const CircleBorder(),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(10),
          child: Icon(icon, size: 22),
        ),
      ),
    );
  }
}

class _ActionTile extends StatelessWidget {
  const _ActionTile({
    required this.icon,
    required this.label,
    required this.onTap,
    this.value,
    this.danger = false,
  });

  final IconData icon;
  final String label;
  final VoidCallback onTap;
  final String? value;
  final bool danger;

  @override
  Widget build(BuildContext context) {
    final color = danger ? Pos.red : null;
    return ListTile(
      contentPadding: EdgeInsets.zero,
      leading: Icon(icon, color: danger ? Pos.red : Pos.brandDeep),
      title: Text(label, style: TextStyle(color: color)),
      subtitle: value == null ? null : Text(value!),
      onTap: onTap,
    );
  }
}
