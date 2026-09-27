/// Recording wastage at the counter.
///
/// A dropped tray, a pint pulled wrong, a plate sent back. The person who
/// sees it happen is standing at the till, and by the time somebody is at
/// the back office the moment is gone -- so the venue asked for the key
/// here, and the `can_wastage` permission has waited for it since 1.6.
///
/// Find the product, say how many, say why. The till keeps no stock count
/// and moves nothing: the event goes up and the back office makes it a
/// completed wastage document, takes the units off the shelf and costs them
/// at what the venue paid. The Z counts the entries; the money is on the
/// Wastage Report where the cost is known.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/stock_api.dart';
import '../data/till_permissions.dart';
import '../main.dart';
import 'permission_gate.dart';
import 'product_lookup_sheet.dart';
import 'sale_page.dart' show productsProvider;
import 'void_dialog.dart';
import 'widgets/on_screen_keyboard.dart';
import 'widgets/pos_message.dart';
import 'widgets/pos_text_field.dart';

Future<void> showWastage(BuildContext context, WidgetRef ref) async {
  if (!await allowed(context, ref, TillPermission.wastage)) return;
  if (!context.mounted) return;

  final product = await showProductLookup(
    context,
    ref,
    mode: LookupMode.ring,
    products: ref.read(productsProvider).value ?? const [],
    listAll: true,
  );
  if (product == null || !context.mounted) return;

  // By the case or by the unit (2026-09-24, Dylan: "add QTYs by either
  // case size QTY or unit QTY"). A product with a case size gets both boxes;
  // what is recorded is always units.
  final quantity = await showDialog<double>(
    context: context,
    builder: (context) => WastageQuantityDialog(
      name: product.name,
      packName: product.packName,
      packUnits: product.packUnits,
    ),
  );
  if (quantity == null || quantity <= 0 || !context.mounted) return;

  final reason = await askReason(
    context,
    ref,
    ReasonFor.wastage,
    title: 'Why was ${_qty(quantity)} × ${product.name} wasted?',
  );
  if (!context.mounted) return;

  final session = await ref.read(sessionRepositoryProvider).current();
  await ref.read(orderRepositoryProvider).logWastage(
        sessionId: session.id,
        pluId: product.pluId,
        productName: product.name,
        quantity: quantity,
        reason: reason,
        staffName: ref.read(servedByProvider),
      );
  if (!context.mounted) return;
  PosMessenger.success(
    context,
    '${_qty(quantity)} × ${product.name} recorded as wastage. The back '
    'office takes it off the shelf.',
  );
}

String _qty(double n) => n == n.roundToDouble() ? '${n.round()}' : n.toStringAsFixed(2);

/// How many were wasted: cases and units for a product bought by the case,
/// units alone otherwise. Pops the total in units, or null.
class WastageQuantityDialog extends StatefulWidget {
  const WastageQuantityDialog({super.key, required this.name, this.packName, this.packUnits});
  final String name;
  final String? packName;
  final double? packUnits;
  @override
  State<WastageQuantityDialog> createState() => _WastageQuantityDialogState();
}

class _WastageQuantityDialogState extends State<WastageQuantityDialog> {
  final _cases = TextEditingController();
  final _units = TextEditingController(text: '1');

  bool get _hasCase => (widget.packUnits ?? 0) > 1;
  double? get _total => joinQty(_hasCase ? _cases.text : '', _units.text, widget.packUnits);

  @override
  void dispose() {
    _cases.dispose();
    _units.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final total = _total;
    return AlertDialog(
      title: Text('How many ${widget.name}?'),
      // Scrolls: the on-screen keyboard under a box can make it taller than a
      // short till screen.
      content: SingleChildScrollView(
        child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (_hasCase) ...[
            Text('${widget.packName ?? 'A case'} = ${fmtQty(widget.packUnits!)} units', style: Theme.of(context).textTheme.bodySmall),
            const SizedBox(height: 8),
            PosTextField(
              key: const Key('wastage-cases'),
              controller: _cases,
              mode: PosKeyboardMode.decimal,
              decoration: const InputDecoration(labelText: 'Cases'),
              onChanged: (_) => setState(() {}),
            ),
            const SizedBox(height: 8),
          ],
          PosTextField(
            key: const Key('wastage-units'),
            controller: _units,
            mode: PosKeyboardMode.decimal,
            autofocus: !_hasCase,
            decoration: const InputDecoration(labelText: 'Units'),
            onChanged: (_) => setState(() {}),
          ),
          if (_hasCase && total != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text('= ${fmtQty(total)} units (${qtyWords(total, widget.packUnits)})', key: const Key('wastage-total')),
            ),
        ],
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
        FilledButton(
          key: const Key('wastage-continue'),
          onPressed: total == null || total <= 0 ? null : () => Navigator.pop(context, total),
          child: const Text('Continue'),
        ),
      ],
    );
  }
}
