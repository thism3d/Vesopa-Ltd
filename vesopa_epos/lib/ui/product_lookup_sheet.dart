/// Finding a product by name, to ring it or just to answer a question.
///
/// Two of the venue's requests, and one sheet, because they are the same
/// screen with different consequences for a tap:
///
///   * **Price check** — "how much is the Malbec?" asked across the bar, with
///     nothing on the bill and nothing to be added to it. The answer is read
///     out and the sheet closes. Ringing something up by accident here is the
///     failure to avoid, which is why the row does not add anything and the
///     price is the largest thing on it.
///   * **Product search** — the item is somewhere in a catalogue of five
///     hundred and the clerk does not know which page it is on. Tapping rings
///     it up.
///
/// Building them separately would have meant two search boxes, two matching
/// rules and two lists that sort differently — and the venue asking why the
/// search on one screen finds things the other does not.
///
/// The catalogue is already on the terminal, so this is local: no network, and
/// it works on the morning the line is down.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/local/database.dart';
import '../data/order_repository.dart' show ProductPricing;
import '../data/price_level_controller.dart';
import 'widgets/basket_panel.dart' show money;
import 'widgets/on_screen_keyboard.dart';

/// What a tap in the sheet does.
enum LookupMode {
  /// Answer a question. Nothing is added to the bill.
  priceCheck,

  /// Find it and ring it.
  ring,
}

/// Opens the lookup. Returns the product to ring, or null.
///
/// [LookupMode.priceCheck] always returns null — there is nothing to hand back,
/// which is the whole point of it — so a caller can await either mode and act
/// on a non-null answer without asking which mode it opened in.
Future<Product?> showProductLookup(
  BuildContext context,
  WidgetRef ref, {
  required LookupMode mode,
  required List<Product> products,
}) =>
    showDialog<Product>(
      context: context,
      builder: (_) => ProductLookupSheet(mode: mode, products: products),
    );

class ProductLookupSheet extends ConsumerStatefulWidget {
  const ProductLookupSheet({
    super.key,
    required this.mode,
    required this.products,
  });

  final LookupMode mode;
  final List<Product> products;

  @override
  ConsumerState<ProductLookupSheet> createState() => _ProductLookupSheetState();
}

class _ProductLookupSheetState extends ConsumerState<ProductLookupSheet> {
  final _search = TextEditingController();
  final _focus = FocusNode();

  @override
  void initState() {
    super.initState();
    _search.addListener(() => setState(() {}));
    // Straight into the box. A clerk opening this has a word in mind and a
    // customer waiting for it; making them tap the field first is a tap that
    // never had a reason.
    WidgetsBinding.instance
        .addPostFrameCallback((_) => _focus.requestFocus());
  }

  @override
  void dispose() {
    _search.dispose();
    _focus.dispose();
    super.dispose();
  }

  /// What the query finds, best match first.
  ///
  /// Name, PLU and barcode, because those are the three things a clerk has in
  /// hand: a word the customer said, a number off a shelf label, and a code off
  /// a packet that would not scan.
  ///
  /// A name *starting* with the query sorts above one merely containing it, so
  /// typing "cok" puts Coca-Cola above "Diet Coke, no ice" — otherwise the
  /// catalogue's own order decides, and the thing being looked for is halfway
  /// down a list of things that are not.
  List<Product> get _results {
    final q = _search.text.trim().toLowerCase();
    if (q.isEmpty) return const [];

    final starts = <Product>[];
    final contains = <Product>[];
    for (final p in widget.products) {
      final name = p.name.toLowerCase();
      if (name.startsWith(q)) {
        starts.add(p);
      } else if (name.contains(q) ||
          p.pluId.toString() == q ||
          p.barcode?.toLowerCase() == q) {
        contains.add(p);
      }
    }
    return [...starts, ...contains].take(60).toList();
  }

  bool get _isCheck => widget.mode == LookupMode.priceCheck;

  @override
  Widget build(BuildContext context) {
    final screen = MediaQuery.sizeOf(context);
    final scheme = Theme.of(context).colorScheme;
    final results = _results;

    // What this terminal is charging today, so a price check during a happy
    // hour answers with the happy-hour price rather than the shelf one.
    final level = ref.watch(currentPriceLevelProvider);

    return Dialog(
      insetPadding: const EdgeInsets.all(20),
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxWidth: screen.width * 0.92 < 720 ? screen.width * 0.92 : 720,
          maxHeight: screen.height * 0.9,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 18, 20, 8),
              child: Row(
                children: [
                  Icon(_isCheck ? Icons.search : Icons.manage_search),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      _isCheck ? 'Price check' : 'Find an item',
                      style: Theme.of(context).textTheme.titleLarge,
                    ),
                  ),
                  IconButton(
                    onPressed: () => Navigator.pop(context),
                    icon: const Icon(Icons.close),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 10),
              child: TextField(
                controller: _search,
                focusNode: _focus,
                autofocus: true,
                textInputAction: TextInputAction.search,
                decoration: InputDecoration(
                  prefixIcon: const Icon(Icons.search),
                  hintText: 'Name, PLU or barcode',
                  border: const OutlineInputBorder(),
                  suffixIcon: _search.text.isEmpty
                      ? null
                      : IconButton(
                          onPressed: () => _search.clear(),
                          icon: const Icon(Icons.clear),
                        ),
                ),
                // Enter rings the only match, so a clerk who knows the name can
                // type it and press the key their hand is already on.
                onSubmitted: (_) {
                  if (!_isCheck && results.length == 1) {
                    Navigator.pop(context, results.first);
                  }
                },
              ),
            ),
            Flexible(child: _list(results, level, scheme)),
            // The till's own keyboard, because a Windows terminal with no
            // physical keyboard is the ordinary case here.
            OnScreenKeyboard(
              controller: _search,
              mode: PosKeyboardMode.text,
              submitLabel: _isCheck ? 'Done' : 'Ring',
              // In search mode the green key rings the only match, so a clerk
              // who knows the name can type it and finish on the keyboard.
              onSubmit: _isCheck || results.length != 1
                  ? null
                  : () => Navigator.pop(context, results.first),
            ),
          ],
        ),
      ),
    );
  }

  Widget _list(List<Product> results, int level, ColorScheme scheme) {
    if (_search.text.trim().isEmpty) {
      return Padding(
        padding: const EdgeInsets.fromLTRB(20, 24, 20, 30),
        child: Text(
          _isCheck
              ? 'Type a name to look a price up.'
              : 'Type a name to find an item.',
          style: TextStyle(color: scheme.onSurfaceVariant),
        ),
      );
    }
    if (results.isEmpty) {
      return Padding(
        padding: const EdgeInsets.fromLTRB(20, 24, 20, 30),
        child: Text(
          'Nothing matches “${_search.text.trim()}”.',
          style: TextStyle(color: scheme.onSurfaceVariant),
        ),
      );
    }

    return ListView.separated(
      shrinkWrap: true,
      padding: const EdgeInsets.symmetric(horizontal: 12),
      itemCount: results.length,
      separatorBuilder: (_, _) => Divider(height: 1, color: scheme.outlineVariant),
      itemBuilder: (context, i) {
        final p = results[i];
        return ListTile(
          title: Text(p.name, style: const TextStyle(fontSize: 16)),
          subtitle: Text(
            [
              'PLU ${p.pluId}',
              if (p.departmentName?.isNotEmpty ?? false) p.departmentName!,
            ].join('  ·  '),
            style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant),
          ),
          trailing: Text(
            money(p.priceAt(level)),
            style: TextStyle(
              // The largest thing on the row when the question *is* the price.
              fontSize: _isCheck ? 22 : 16,
              fontWeight: FontWeight.w700,
              color: _isCheck ? scheme.primary : scheme.onSurface,
            ),
          ),
          // A price check adds nothing to the bill, whatever is tapped. That is
          // not a missing feature: this sheet is opened mid-conversation with a
          // customer, and an item silently landing on the bill is the failure
          // it exists to avoid.
          onTap: _isCheck ? null : () => Navigator.pop(context, p),
        );
      },
    );
  }
}
