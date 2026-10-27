/// The venue's programmed screens, drawn as the till draws them
/// (vesopa_epos/lib/ui/widgets/programmed_grid.dart): a grid of rows x cols
/// sized from the space there is, each key at its row and column with its
/// spans, the venue's colours, its picture and label. Product keys ring up,
/// page keys open another screen, function keys do what Go can do.
library;

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';

import '../data/models.dart';
import '../data/screen_set.dart';
import 'theme.dart';

/// The till's function keys Go carries out; any other shows as the till's
/// only and does nothing here (dimmed, so a clerk is not left wondering).
const goFunctions = <String, String>{
  'note': 'Note',
  'sign_on': 'Sign on',
  'display_lock': 'Lock screen',
  'pay': 'Pay',
};

class ProgrammedGrid extends StatelessWidget {
  const ProgrammedGrid({
    super.key,
    required this.screen,
    required this.screens,
    required this.productsByPlu,
    required this.onProduct,
    required this.onPage,
    required this.onFunction,
    this.onProductLong,
    this.showPrices = true,
    this.gap = 8,
  });

  final TillScreen screen;
  final ScreenSet screens;
  final Map<int, Product> productsByPlu;
  final ValueChanged<Product> onProduct;
  final ValueChanged<Product>? onProductLong;
  final ValueChanged<TillScreen> onPage;
  final ValueChanged<String> onFunction;
  final bool showPrices;
  final double gap;

  @override
  Widget build(BuildContext context) {
    final covered = screen.covered;
    return LayoutBuilder(builder: (context, box) {
      final cellW = (box.maxWidth - gap * (screen.cols - 1)) / screen.cols;
      final cellH = (box.maxHeight - gap * (screen.rows - 1)) / screen.rows;
      final keys = <Widget>[];
      for (var r = 0; r < screen.rows; r++) {
        for (var c = 0; c < screen.cols; c++) {
          if (covered.contains('$r:$c')) continue;
          final b = screen.at(r, c);
          if (b == null || b.kind == ScreenButtonKind.blank) continue;
          keys.add(Positioned(
            left: c * (cellW + gap),
            top: r * (cellH + gap),
            width: cellW * b.colSpan + gap * (b.colSpan - 1),
            height: cellH * b.rowSpan + gap * (b.rowSpan - 1),
            child: _Key(
              button: b,
              here: b.kind == ScreenButtonKind.page && b.targetScreenId == screen.id,
              product: b.pluId == null ? null : productsByPlu[b.pluId],
              target: b.kind == ScreenButtonKind.page ? screens.byId(b.targetScreenId) : null,
              showPrices: showPrices,
              onProduct: onProduct,
              onProductLong: onProductLong,
              onPage: onPage,
              onFunction: onFunction,
            ),
          ));
        }
      }
      return Stack(children: keys);
    });
  }
}

class _Key extends StatelessWidget {
  const _Key({
    required this.button,
    required this.here,
    required this.product,
    required this.target,
    required this.showPrices,
    required this.onProduct,
    required this.onProductLong,
    required this.onPage,
    required this.onFunction,
  });

  final ScreenButton button;
  final bool here;
  final Product? product;
  final TillScreen? target;
  final bool showPrices;
  final ValueChanged<Product> onProduct;
  final ValueChanged<Product>? onProductLong;
  final ValueChanged<TillScreen> onPage;
  final ValueChanged<String> onFunction;

  @override
  Widget build(BuildContext context) {
    String label;
    String? note;
    VoidCallback? onTap;
    VoidCallback? onLong;
    switch (button.kind) {
      case ScreenButtonKind.product:
        final p = product;
        label = button.label ?? p?.name ?? 'Unavailable';
        if (p != null && !p.outOfStock) {
          onTap = () => onProduct(p);
          if (onProductLong != null) onLong = () => onProductLong!(p);
          note = showPrices ? money(p.priceMinor) : null;
        } else {
          note = p == null ? 'Not on the menu' : 'Sold out';
        }
      case ScreenButtonKind.page:
        final t = target;
        label = button.label ?? t?.name ?? 'Unavailable';
        note = here ? '●' : '›››';
        if (t != null) onTap = () => onPage(t);
      case ScreenButtonKind.function:
        final k = button.functionKey ?? '';
        label = button.label ?? goFunctions[k] ?? k;
        if (goFunctions.containsKey(k)) {
          onTap = () => onFunction(k);
        } else {
          note = 'On the till';
        }
      case ScreenButtonKind.modifier:
      case ScreenButtonKind.blank:
      case ScreenButtonKind.unknown:
        label = button.label ?? '';
        note = button.kind == ScreenButtonKind.modifier ? '?' : null;
    }
    final fill = here ? Tp.lime.withValues(alpha: 0.28) : (button.fill ?? Tp.inkCard);
    final ink = button.ink ?? (button.fill == null ? Colors.white : (fill.computeLuminance() > 0.5 ? Tp.onLime : Colors.white));
    final image = button.imageUrl;
    return Opacity(
      opacity: onTap != null ? 1 : 0.55,
      child: Material(
        color: fill,
        clipBehavior: Clip.antiAlias,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(10),
          side: BorderSide(color: here ? Tp.lime : Tp.inkLine, width: here ? 2 : 1),
        ),
        child: InkWell(
          onTap: onTap,
          onLongPress: onLong,
          child: Stack(fit: StackFit.expand, children: [
            if (image != null && image.isNotEmpty)
              CachedNetworkImage(imageUrl: image, fit: button.imageFit.boxFit, errorWidget: (_, _, _) => const SizedBox.shrink()),
            if (button.showLabel || image == null || image.isEmpty)
              Container(
                decoration: image != null && image.isNotEmpty
                    ? const BoxDecoration(gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Color(0x00000000), Color(0xB3000000)]))
                    : null,
                padding: const EdgeInsets.all(8),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisAlignment: image != null && image.isNotEmpty ? MainAxisAlignment.end : MainAxisAlignment.start, children: [
                  Flexible(
                    child: Text(
                      [if ((button.emoji ?? '').isNotEmpty) button.emoji, label].join(' '),
                      maxLines: 3,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: (button.fontSize ?? 14).toDouble().clamp(10, 28), height: 1.15, fontWeight: FontWeight.w700, color: image != null && image.isNotEmpty ? Colors.white : ink),
                    ),
                  ),
                  if (image == null || image.isEmpty) const Spacer(),
                  if (note != null)
                    Text(note, maxLines: 1, style: TextStyle(fontSize: 12, fontFeatures: Tp.tabular, color: (image != null && image.isNotEmpty ? Colors.white : ink).withValues(alpha: 0.8))),
                ]),
              ),
          ]),
        ),
      ),
    );
  }
}
