import 'package:flutter/material.dart';

import '../../data/local/database.dart';
import '../../data/screens.dart';
import '../layout.dart';
import '../theme.dart';
import 'basket_panel.dart' show money;

/// A venue's own sale screen, drawn.
///
/// The alternative to the catalogue-driven grid the till has always shown. Which
/// one a venue gets is `TillSettings.homeScreenId`: null means the built-in
/// Default, and the sale page keeps its old rendering. See
/// `docs/screen-programming.md`.
///
/// **Nothing here may fail to draw.** A layout is arranged in an office, weeks
/// before a clerk stands in front of it, and everything it points at can be
/// deleted in between — the product, the screen a button jumps to, or a function
/// this build has never heard of. Each of those renders as a key that says what
/// is wrong and refuses the press, because a blank key is one a clerk presses
/// twice before asking anybody, and a crash is a till that has stopped taking
/// money.
class ProgrammedGrid extends StatelessWidget {
  const ProgrammedGrid({
    super.key,
    required this.screen,
    required this.screens,
    required this.products,
    required this.onProduct,
    required this.onPage,
    required this.onFunction,
    this.showPrices = true,
  });

  final TillScreen screen;

  /// The whole set, so a page button can name the screen it points at without
  /// another fetch — and so a button pointing at a deleted one can say so.
  final ScreenSet screens;

  /// The catalogue, by PLU. Built once by the caller rather than searched per
  /// button: a screen is up to 120 keys and a catalogue is thousands of rows.
  final Map<int, Product> products;

  final void Function(Product) onProduct;
  final void Function(TillScreen) onPage;
  final void Function(String functionKey) onFunction;

  final bool showPrices;

  @override
  Widget build(BuildContext context) {
    final pal = PayPalette.of(context);
    final covered = screen.covered;

    return Padding(
      padding: EdgeInsets.all(context.isPhone ? 8 : 12),
      child: LayoutBuilder(
        builder: (context, box) {
          // Cells sized from the space actually available, so the same layout
          // works on a 1920 counter till and a 1280 handheld. This is the whole
          // reason a button is a grid cell rather than a pixel rectangle — see
          // the design doc, §2.
          const gap = 8.0;
          final cellW =
              (box.maxWidth - gap * (screen.cols - 1)) / screen.cols;
          final cellH =
              (box.maxHeight - gap * (screen.rows - 1)) / screen.rows;

          final keys = <Widget>[];
          for (var r = 0; r < screen.rows; r++) {
            for (var c = 0; c < screen.cols; c++) {
              if (covered.contains('$r:$c')) continue;
              final button = screen.at(r, c);
              if (button == null) continue;

              keys.add(
                Positioned(
                  left: c * (cellW + gap),
                  top: r * (cellH + gap),
                  width: cellW * button.colSpan + gap * (button.colSpan - 1),
                  height: cellH * button.rowSpan + gap * (button.rowSpan - 1),
                  child: _Key(
                    button: button,
                    screens: screens,
                    product: button.pluId == null
                        ? null
                        : products[button.pluId],
                    pal: pal,
                    showPrices: showPrices,
                    onProduct: onProduct,
                    onPage: onPage,
                    onFunction: onFunction,
                  ),
                ),
              );
            }
          }

          return Stack(children: keys);
        },
      ),
    );
  }
}

class _Key extends StatelessWidget {
  const _Key({
    required this.button,
    required this.screens,
    required this.product,
    required this.pal,
    required this.showPrices,
    required this.onProduct,
    required this.onPage,
    required this.onFunction,
  });

  final ScreenButton button;
  final ScreenSet screens;
  final Product? product;
  final PayPalette pal;
  final bool showPrices;

  final void Function(Product) onProduct;
  final void Function(TillScreen) onPage;
  final void Function(String) onFunction;

  /// What the key says, and what happens when it is pressed.
  ///
  /// Resolved together because they are the same question: a button whose
  /// product has been deleted has no action *and* has to say why, and working
  /// those out in two places is how they end up disagreeing.
  ({String label, String? note, VoidCallback? onTap}) get _resolved {
    switch (button.kind) {
      case ScreenButtonKind.product:
        final p = product;
        if (p == null) {
          return (
            label: button.label ?? 'Unavailable',
            note: 'Not in the catalogue',
            onTap: null,
          );
        }
        return (
          label: button.label ?? p.name,
          note: showPrices ? money(p.priceMinor) : null,
          onTap: () => onProduct(p),
        );

      case ScreenButtonKind.page:
        final target = screens.byId(button.targetScreenId);
        if (target == null) {
          return (
            label: button.label ?? 'Unavailable',
            note: 'Screen removed',
            onTap: null,
          );
        }
        return (
          label: button.label ?? target.name,
          note: '›››',
          onTap: () => onPage(target),
        );

      case ScreenButtonKind.function:
        final key = button.functionKey;
        if (key == null || key.isEmpty) {
          return (label: button.label ?? 'Unset', note: null, onTap: null);
        }
        return (
          label: button.label ?? _functionNames[key] ?? key,
          note: null,
          onTap: () => onFunction(key),
        );

      // A button from a newer release. Drawn as inert rather than dropped, so
      // the layout keeps its shape and the gap is explained — a key that simply
      // vanished would have somebody looking for it.
      case ScreenButtonKind.unknown:
        return (
          label: button.label ?? 'Not supported',
          note: 'Update the till',
          onTap: null,
        );
    }
  }

  /// Mirrors FUNCTION_KEYS in vesopa_server/src/screens.js.
  ///
  /// A key that is not in here still draws — as "Not supported", via the
  /// unknown branch above — so a till running an older release than the back
  /// office shows an inert key rather than failing to parse the screen.
  static const _functionNames = <String, String>{
    'qty': 'Quantity',
    'note': 'Note',
    'covers': 'Covers',
    'customer': 'Customer',
    'open_drawer': 'No sale',
    'print_bill': 'Print bill',
  };

  @override
  Widget build(BuildContext context) {
    final r = _resolved;
    final enabled = r.onTap != null;

    // The venue's colour when it has chosen one, the till's own key colour when
    // it has not — which is what keeps an unstyled screen looking like Vesopa
    // rather than looking unfinished.
    final fill = button.fill ?? pal.keyFill;
    final ink = button.ink ?? (button.fill == null ? pal.ink : Pos.inkOn(fill));

    return Opacity(
      // Dimmed rather than hidden. It still holds its place in the layout, and
      // it is still obviously a key — just one that cannot be pressed.
      opacity: enabled ? 1 : 0.55,
      child: Material(
        color: fill,
        borderRadius: BorderRadius.circular(10),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: r.onTap,
          child: Container(
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(10),
              border: Border.all(
                color: enabled ? pal.keyLine : Pos.red.withValues(alpha: 0.6),
              ),
            ),
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 6),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Flexible(
                  child: Text(
                    r.label,
                    textAlign: TextAlign.center,
                    maxLines: 3,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      color: ink,
                      fontSize: 14,
                      fontWeight: FontWeight.w700,
                      height: 1.15,
                    ),
                  ),
                ),
                if (r.note != null) ...[
                  const SizedBox(height: 2),
                  Text(
                    r.note!,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      color: ink.withValues(alpha: 0.75),
                      fontSize: 11.5,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}
