/// A barcode at the counter.
///
/// Scanners are keyboards. The till has heard them since swipe cards went in
/// (see `data/swipe_cards.dart`) — a run of characters and a Return, told from
/// typing by its speed — and what it does with one depends on the prefix: a
/// clerk card signs somebody on, a loyalty card names a member. A code matching
/// none of the venue's card programmes used to end in "Not a card this venue
/// uses", which is true and useless when the thing in the clerk's hand is a
/// bottle.
///
/// So an unmatched scan comes here first:
///
///   * **Known barcode** — ring it up. This is the whole point of a scanner
///     behind a bar, and it goes through the sale screen's own `ring`, so a
///     product with modifier questions still asks them.
///   * **Unknown barcode** — offer to create the product, then ring it. The
///     venue asked for name, price, tax rate, sub department and department,
///     which is exactly the form below.
///
/// A product created here goes to the **back office**, not to this terminal.
/// The till's Products screen edits its own database and says so; that is fine
/// for a stock adjustment and useless for a new product, which would be wiped
/// by the next catalogue sync and would not exist on the till at the other end
/// of the bar. See `POST /till/products`.
library;

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;

import '../data/local/database.dart';
import '../main.dart';
import 'sale_page.dart' show productsProvider;
import 'widgets/on_screen_keyboard.dart';
import 'widgets/pos_message.dart';

/// The product this barcode names, or null.
///
/// Trimmed and compared exactly. A scanner's Return is not part of the code,
/// and a barcode stored with trailing whitespace matches nothing at the counter
/// with no way to see why by looking at it — so both ends are trimmed, here and
/// on the way into the database.
Future<Product?> productForBarcode(WidgetRef ref, String code) async {
  final wanted = code.trim();
  if (wanted.isEmpty) return null;

  final db = ref.read(databaseProvider);
  final rows = await (db.select(db.products)
        ..where((p) => p.barcode.equals(wanted))
        ..limit(1))
      .get();
  return rows.isEmpty ? null : rows.first;
}

/// What the till should do about a scan that is not one of the venue's cards.
///
/// Returns the product to ring, or null when there is nothing to ring — either
/// the clerk declined to create one, or the create failed and has already been
/// reported.
Future<Product?> handleScannedBarcode(
  BuildContext context,
  WidgetRef ref,
  String code,
) async {
  final known = await productForBarcode(ref, code);
  if (known != null) return known;

  if (!context.mounted) return null;
  final wanted = await showDialog<bool>(
    context: context,
    builder: (context) => AlertDialog(
      title: const Text('Not on the till yet'),
      content: Text(
        'Nothing on this till has the barcode $code.\n\n'
        'Add it to the catalogue now? It goes to the back office, so every '
        'till gets it.',
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context, false),
          child: const Text('Not now'),
        ),
        FilledButton(
          onPressed: () => Navigator.pop(context, true),
          child: const Text('Add it'),
        ),
      ],
    ),
  );
  if (wanted != true || !context.mounted) return null;

  final made = await showDialog<_NewProduct>(
    context: context,
    builder: (_) => _NewProductDialog(barcode: code),
  );
  if (made == null || !context.mounted) return null;

  return _createOnServer(context, ref, made);
}

/// Send it to the back office, then wait for it to come back down.
///
/// The product is not written into this terminal's database directly. The
/// catalogue is the server's, and a till that wrote its own row would be a till
/// whose copy differs from every other one until somebody noticed — so it is
/// created, the catalogue is refreshed, and the product is read back. Slower by
/// a second, and there is exactly one version of the truth.
Future<Product?> _createOnServer(
  BuildContext context,
  WidgetRef ref,
  _NewProduct made,
) async {
  final token = ref.read(sessionProvider).terminalToken;
  final apiBase = ref.read(apiBaseProvider);
  if (token == null || token.isEmpty) {
    PosMessenger.error(
      context,
      'This terminal is not commissioned, so it cannot add to the catalogue.',
    );
    return null;
  }

  try {
    final res = await http
        .post(
          Uri.parse('$apiBase/till/products'),
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer $token',
          },
          body: jsonEncode({
            'product_name': made.name,
            'barcode': made.barcode,
            'price': made.priceMinor / 100,
            'tax_percentage': made.taxPercentage,
            'department_name': made.department,
            'group_name': made.group,
          }),
        )
        .timeout(const Duration(seconds: 12));

    if (res.statusCode < 200 || res.statusCode >= 300) {
      final why = switch (jsonDecode(res.body)) {
        final Map<String, dynamic> m => m['error'] as String?,
        _ => null,
      };
      if (context.mounted) {
        PosMessenger.error(context, why ?? 'Could not add it (${res.statusCode}).');
      }
      return null;
    }

    // Pull the catalogue down so the new row exists locally the same way every
    // other product does.
    await ref.read(syncServiceProvider).pullCatalogue();
    final product = await productForBarcode(ref, made.barcode);
    if (context.mounted) {
      PosMessenger.success(
        context,
        product == null
            ? '${made.name} added. It will appear when the till next refreshes.'
            : '${made.name} added to the catalogue.',
      );
    }
    return product;
  } catch (e) {
    if (context.mounted) {
      // The line being down is the ordinary reason, and it is worth saying
      // which: a clerk who reads "could not add" reaches for the barcode again.
      PosMessenger.error(
        context,
        'Could not reach the back office, so nothing was added. $e',
      );
    }
    return null;
  }
}

/// What the venue asked to be asked for.
class _NewProduct {
  const _NewProduct({
    required this.name,
    required this.barcode,
    required this.priceMinor,
    required this.taxPercentage,
    this.department,
    this.group,
  });

  final String name;
  final String barcode;
  final int priceMinor;
  final double taxPercentage;
  final String? department;
  final String? group;
}

class _NewProductDialog extends ConsumerStatefulWidget {
  const _NewProductDialog({required this.barcode});

  final String barcode;

  @override
  ConsumerState<_NewProductDialog> createState() => _NewProductDialogState();
}

class _NewProductDialogState extends ConsumerState<_NewProductDialog> {
  final _name = TextEditingController();
  final _price = TextEditingController();

  /// Which field the on-screen keyboard is typing into. A till has one
  /// keyboard and several boxes, so the dialog has to say which is live rather
  /// than leaving the clerk to guess.
  late TextEditingController _focused;

  String? _department;
  String? _group;
  double _tax = 20;

  @override
  void initState() {
    super.initState();
    _focused = _name;
    _name.addListener(() => setState(() {}));
    _price.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _name.dispose();
    _price.dispose();
    super.dispose();
  }

  int? get _minor {
    final text = _price.text.trim();
    if (text.isEmpty) return null;
    final pounds = double.tryParse(text);
    if (pounds == null || pounds < 0) return null;
    return (pounds * 100).round();
  }

  bool get _canSave => _name.text.trim().isNotEmpty && _minor != null;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final products = ref.watch(productsProvider).value ?? const <Product>[];

    // The venue's own departments and sub departments, off the catalogue that
    // is already on the terminal. Free text would let a clerk invent
    // "Softdrinks" beside "Soft Drinks" at the counter, at speed, with a queue.
    final departments = <String>{
      for (final p in products)
        if (p.departmentName?.trim().isNotEmpty ?? false) p.departmentName!,
    }.toList()
      ..sort();
    final groups = <String>{
      for (final p in products)
        if ((p.groupName?.trim().isNotEmpty ?? false) &&
            (_department == null || p.departmentName == _department))
          p.groupName!,
    }.toList()
      ..sort();

    return AlertDialog(
      title: const Text('New product'),
      content: SizedBox(
        width: 460,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                'Barcode ${widget.barcode}',
                style: TextStyle(fontSize: 13, color: scheme.onSurfaceVariant),
              ),
              const SizedBox(height: 14),
              TextField(
                controller: _name,
                autofocus: true,
                keyboardType: TextInputType.none,
                onTap: () => setState(() => _focused = _name),
                decoration: const InputDecoration(
                  labelText: 'Name',
                  border: OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: _price,
                keyboardType: TextInputType.none,
                onTap: () => setState(() => _focused = _price),
                decoration: const InputDecoration(
                  labelText: 'Price',
                  prefixText: '£ ',
                  border: OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 10),
              DropdownButtonFormField<double>(
                initialValue: _tax,
                decoration: const InputDecoration(
                  labelText: 'Tax rate',
                  border: OutlineInputBorder(),
                ),
                items: const [
                  DropdownMenuItem(value: 20.0, child: Text('20% — standard')),
                  DropdownMenuItem(value: 5.0, child: Text('5% — reduced')),
                  DropdownMenuItem(value: 0.0, child: Text('0% — zero rated')),
                ],
                onChanged: (v) => setState(() => _tax = v ?? 20),
              ),
              const SizedBox(height: 10),
              DropdownButtonFormField<String>(
                initialValue: _department,
                decoration: const InputDecoration(
                  labelText: 'Department',
                  border: OutlineInputBorder(),
                ),
                items: [
                  for (final d in departments)
                    DropdownMenuItem(value: d, child: Text(d)),
                ],
                // Changing the department clears the sub department under it,
                // or the product lands in a group belonging to somewhere else.
                onChanged: (v) => setState(() {
                  _department = v;
                  _group = null;
                }),
              ),
              const SizedBox(height: 10),
              DropdownButtonFormField<String>(
                initialValue: _group,
                decoration: const InputDecoration(
                  labelText: 'Sub department',
                  border: OutlineInputBorder(),
                ),
                items: [
                  for (final g in groups)
                    DropdownMenuItem(value: g, child: Text(g)),
                ],
                onChanged: (v) => setState(() => _group = v),
              ),
              const SizedBox(height: 12),
              OnScreenKeyboard(
                controller: _focused,
                mode: _focused == _price
                    ? PosKeyboardMode.decimal
                    : PosKeyboardMode.text,
                submitLabel: 'Add',
                onSubmit: _canSave ? _save : null,
              ),
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
          child: const Text('Add'),
        ),
      ],
    );
  }

  void _save() {
    final minor = _minor;
    if (!_canSave || minor == null) return;
    Navigator.pop(
      context,
      _NewProduct(
        name: _name.text.trim(),
        barcode: widget.barcode,
        priceMinor: minor,
        taxPercentage: _tax,
        department: _department,
        group: _group,
      ),
    );
  }
}
