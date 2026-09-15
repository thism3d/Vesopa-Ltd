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
  );
  if (product == null || !context.mounted) return;

  final controller = TextEditingController(text: '1');
  final quantity = await showDialog<double>(
    context: context,
    builder: (context) => AlertDialog(
      title: Text('How many ${product.name}?'),
      content: PosTextField(
        controller: controller,
        mode: PosKeyboardMode.decimal,
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
          child: const Text('Continue'),
        ),
      ],
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
