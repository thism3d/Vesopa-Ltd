/// The venue's programmed screens, drawn as the till draws them
/// (vesopa_epos/lib/ui/widgets/programmed_grid.dart): a grid of rows x cols
/// sized from the space there is, each key at its row and column with its
/// spans, the venue's colours, its picture and label. Product keys ring up,
/// page keys open another screen, function keys do what the till's do.
///
/// Three ways to lay the same keys out, so every device can read them
/// (owner, 2026-10-28):
///   * [ProgrammedGrid]: the till's own rows and columns (an iPad, a tablet);
///   * [ProgrammedGrid.reflow]: the same keys in the same order, a few to a
///     row and scrolling (a phone);
///   * [ProgrammedStrip]: a bar's keys side by side, each as wide as its
///     words need, scrolling when there are more than fit.
library;

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';

import '../data/models.dart';
import '../data/screen_set.dart';
import '../data/venue_data.dart' show VenueMenu;
import 'fit_text.dart';
import 'product_photo.dart' show photoUrl;
import 'theme.dart';

/// The till's function keys Go carries out, with the till's own names for a
/// key the back office left unnamed (vesopa_epos programmed_bar.dart). Any
/// other function key is the till's only and is left off Go's screens.
const goFunctions = <String, String>{
  'pay': 'Pay',
  'void': 'Void',
  'cancel': 'Cancel',
  'save_table': 'Save Table',
  'new_bill': 'New bill',
  'last_bill': 'Last Bill',
  'note': 'Notes',
  'customer': 'Customer',
  'open_drawer': 'No Sale',
  'go_sale': 'Sale',
  'go_tables': 'Tables',
  'table_plan': 'Table Plan',
  'go_receipts': 'Receipts',
  'go_reports': 'Reports',
  'go_tickets': 'Tickets',
  'go_settings': 'Settings',
  'refund': 'Refund',
  'sign_off': 'Sign off',
  'sign_on': 'Sign on',
  'display_lock': 'Lock display',
  'clock_in_out': 'Clock in / out',
  'covers': 'Covers',
};

/// The till's icon for each function key (vesopa_epos programmed_bar.dart),
/// drawn above the key's name on a bar.
const functionIcons = <String, IconData>{
  'pay': Icons.credit_card_rounded,
  'void': Icons.backspace_outlined,
  'cancel': Icons.block_rounded,
  'save_table': Icons.event_seat_rounded,
  'new_bill': Icons.note_add_rounded,
  'last_bill': Icons.receipt_long_rounded,
  'note': Icons.edit_note_rounded,
  'customer': Icons.person_rounded,
  'open_drawer': Icons.point_of_sale_rounded,
  'go_sale': Icons.shopping_basket_rounded,
  'go_tables': Icons.table_restaurant_rounded,
  'table_plan': Icons.table_bar_rounded,
  'go_receipts': Icons.receipt_rounded,
  'go_reports': Icons.insights_rounded,
  'go_tickets': Icons.confirmation_number_rounded,
  'go_settings': Icons.settings_rounded,
  'refund': Icons.currency_exchange_rounded,
  'sign_off': Icons.logout_rounded,
  'sign_on': Icons.login_rounded,
  'display_lock': Icons.lock_rounded,
  'clock_in_out': Icons.schedule_rounded,
  'covers': Icons.groups_rounded,
};

/// Whether Go shows [b]: products, pages and the function keys Go carries
/// out, so a phone or iPad never shows a key that does nothing.
bool goUses(ScreenButton b) => switch (b.kind) {
      ScreenButtonKind.product || ScreenButtonKind.page => true,
      ScreenButtonKind.function => goFunctions.containsKey(b.functionKey ?? ''),
      // A modifier key works when its group is on the menu (MIXERS ?).
      ScreenButtonKind.modifier => VenueMenu.current.containsKey('${b.modifierGroupId}'),
      _ => false,
    };

/// Whether a bar has anything Go can use on it, so an empty bar takes no room.
bool barHasKeys(TillScreen bar) => bar.buttons.any(goUses);

/// [screen]'s keys Go uses, in reading order (row by row, left to right).
List<ScreenButton> keysInOrder(TillScreen screen) {
  final covered = screen.covered;
  return [
    for (var r = 0; r < screen.rows; r++)
      for (var c = 0; c < screen.cols; c++)
        if (!covered.contains('$r:$c'))
          if (screen.at(r, c) case final b? when goUses(b)) b,
  ];
}

/// What every layout needs to draw and work a key.
class KeyActions {
  const KeyActions({
    required this.screens,
    required this.productsByPlu,
    required this.onProduct,
    required this.onPage,
    required this.onFunction,
    this.onProductLong,
    this.showPrices = true,
    this.currentScreenId,
    this.payEnabled = true,
    this.payLabel,
  });

  final ScreenSet screens;
  final Map<int, Product> productsByPlu;
  final ValueChanged<Product> onProduct;
  final ValueChanged<Product>? onProductLong;
  final ValueChanged<TillScreen> onPage;
  final ValueChanged<String> onFunction;
  final bool showPrices;

  /// The screen on show, so its page key is drawn as "you are here".
  final int? currentScreenId;

  /// Pay works only with something on the sale, as on the till; its key
  /// says how much ("Pay £9.85").
  final bool payEnabled;
  final String? payLabel;

  Widget key(ScreenButton b, {double fontScale = 1, bool bar = false, bool compact = false, VoidCallback? onDone}) {
    final product = b.pluId == null ? null : productsByPlu[b.pluId];
    return _Key(
      button: b,
      here: b.kind == ScreenButtonKind.page && b.targetScreenId == currentScreenId,
      product: product,
      target: b.kind == ScreenButtonKind.page ? screens.byId(b.targetScreenId) : null,
      actions: this,
      fontScale: fontScale,
      bar: bar,
      compact: compact,
      onDone: onDone,
    );
  }
}

class ProgrammedGrid extends StatelessWidget {
  ProgrammedGrid({
    super.key,
    required this.screen,
    required ScreenSet screens,
    required Map<int, Product> productsByPlu,
    required ValueChanged<Product> onProduct,
    required ValueChanged<TillScreen> onPage,
    required ValueChanged<String> onFunction,
    ValueChanged<Product>? onProductLong,
    bool showPrices = true,
    bool payEnabled = true,
    String? payLabel,
    this.gap = 8,
    this.reflowColumns,
    this.bottomPad = 0,
  }) : actions = KeyActions(
          screens: screens,
          productsByPlu: productsByPlu,
          onProduct: onProduct,
          onPage: onPage,
          onFunction: onFunction,
          onProductLong: onProductLong,
          showPrices: showPrices,
          currentScreenId: screen.id,
          payEnabled: payEnabled,
          payLabel: payLabel,
        );

  final TillScreen screen;
  final KeyActions actions;
  final double gap;

  /// Set: the keys in the till's order, this many to a row, scrolling.
  final int? reflowColumns;
  final double bottomPad;

  /// Below this a key is too thin for its name (iPad portrait, Split View,
  /// Android): the same keys reflow, a few to a row (owner, 2026-10-30).
  static const minCell = 92.0;

  @override
  Widget build(BuildContext context) {
    final cols = reflowColumns;
    if (cols != null) return _reflow(cols);
    return _geometry();
  }

  Widget _reflow(int cols) {
    {
      final keys = keysInOrder(screen);
      // A key two columns wide on the till is two wide here too, up to a row.
      return LayoutBuilder(builder: (context, box) {
        final cell = (box.maxWidth - gap * (cols - 1)) / cols;
        return SingleChildScrollView(
          padding: EdgeInsets.only(bottom: bottomPad),
          child: Wrap(spacing: gap, runSpacing: gap, children: [
            for (final b in keys)
              SizedBox(
                width: cell * b.colSpan.clamp(1, cols) + gap * (b.colSpan.clamp(1, cols) - 1),
                height: cell * 0.86,
                child: actions.key(b),
              ),
          ]),
        );
      });
    }
  }

  Widget _geometry() {
    final covered = screen.covered;
    return LayoutBuilder(builder: (context, box) {
      final cellW = (box.maxWidth - gap * (screen.cols - 1)) / screen.cols;
      final cellH = (box.maxHeight - gap * (screen.rows - 1)) / screen.rows;
      if (cellW < minCell && screen.cols > 3) return _reflow((box.maxWidth / 112).floor().clamp(3, 8));
      final keys = <Widget>[];
      // A line before the category keys when the last column holds only
      // page keys, as the owner drew it.
      final last = [for (var r = 0; r < screen.rows; r++) if (screen.at(r, screen.cols - 1) case final b? when goUses(b)) b];
      if (screen.cols > 2 && last.isNotEmpty && last.every((b) => b.kind == ScreenButtonKind.page)) {
        keys.add(Positioned(
          left: (screen.cols - 1) * (cellW + gap) - gap / 2 - 0.75,
          top: 4,
          bottom: 4,
          width: 1.5,
          child: ColoredBox(color: context.goLine),
        ));
      }
      for (var r = 0; r < screen.rows; r++) {
        for (var c = 0; c < screen.cols; c++) {
          if (covered.contains('$r:$c')) continue;
          final b = screen.at(r, c);
          if (b == null || !goUses(b)) continue;
          keys.add(Positioned(
            left: c * (cellW + gap),
            top: r * (cellH + gap),
            width: cellW * b.colSpan + gap * (b.colSpan - 1),
            height: cellH * b.rowSpan + gap * (b.rowSpan - 1),
            child: actions.key(b),
          ));
        }
      }
      return Stack(children: keys);
    });
  }
}

class ProgrammedStrip extends StatefulWidget {
  const ProgrammedStrip({super.key, required this.bar, required this.actions, this.minKey = 104, this.gap = 8});

  final TillScreen bar;
  final KeyActions actions;
  final double minKey;
  final double gap;

  @override
  State<ProgrammedStrip> createState() => _ProgrammedStripState();
}

/// A bar's keys as the owner drew them (2026-10-30): they share the width
/// when they fit; when they do not, they get narrower (icon over a small
/// name) before anything is hidden; and when even that is not enough, the
/// ones that do not fit go behind an arrow beside a Pay key that never moves
/// from the right. The arrow opens them in a row just above the bar; a tap
/// anywhere else puts them away.
class _ProgrammedStripState extends State<ProgrammedStrip> with SingleTickerProviderStateMixin {
  final _link = LayerLink();
  final _portal = OverlayPortalController();
  late final _anim = AnimationController(vsync: this, duration: const Duration(milliseconds: 220));

  @override
  void dispose() {
    _anim.dispose();
    super.dispose();
  }

  void _toggle() {
    if (_portal.isShowing) {
      _hide();
    } else {
      _portal.show();
      _anim.forward(from: 0);
    }
  }

  Future<void> _hide() async {
    await _anim.reverse();
    if (mounted && _portal.isShowing) _portal.hide();
  }

  @override
  Widget build(BuildContext context) {
    final keys = keysInOrder(widget.bar);
    if (keys.isEmpty) return const SizedBox.shrink();
    final gap = widget.gap;
    // Pay stays where the hand expects it: the right-hand end.
    final pay = keys.where((k) => k.kind == ScreenButtonKind.function && k.functionKey == 'pay').firstOrNull;
    final rest = [for (final k in keys) if (!identical(k, pay)) k];
    return LayoutBuilder(builder: (context, box) {
      int spans(Iterable<ScreenButton> ks) => ks.fold<int>(0, (n, b) => n + b.colSpan);
      final all = spans(keys);
      final room = box.maxWidth - gap * (keys.length - 1);
      // 1. Everything at full size.
      if (room / all >= widget.minKey) return _row(keys, room / all, compact: false);
      // 2. Everything, narrower, as icon keys with a small name.
      final compactMin = widget.minKey * 0.68;
      if (room / all >= compactMin) return _row(keys, room / all, compact: true);
      // 3. As many as fit before the arrow and Pay; the rest above.
      // Pay keeps a thumb's width, not its span on a 15-inch till.
      final payWidth = pay == null ? 0.0 : compactMin * 1.6;
      final arrowWidth = compactMin * 0.8;
      var space = box.maxWidth - payWidth - arrowWidth - gap * 2;
      final shown = <ScreenButton>[];
      for (final k in rest) {
        final w = compactMin * k.colSpan + (shown.isEmpty ? 0 : gap);
        if (w > space) break;
        shown.add(k);
        space -= w;
      }
      final hidden = rest.skip(shown.length).toList();
      if (hidden.isEmpty) return _row(keys, room / all, compact: true);
      final unit = shown.isEmpty ? compactMin : (compactMin + space / spans(shown).clamp(1, 999));
      return CompositedTransformTarget(
        link: _link,
        child: OverlayPortal(
          controller: _portal,
          overlayChildBuilder: (_) => _overflow(context, hidden, box.maxWidth, box.maxHeight.isFinite ? box.maxHeight : 64, compactMin),
          child: Row(children: [
            for (var i = 0; i < shown.length; i++) ...[
              if (i > 0) SizedBox(width: gap),
              SizedBox(width: unit * shown[i].colSpan, child: widget.actions.key(shown[i], fontScale: 0.9, bar: true, compact: true)),
            ],
            if (shown.isNotEmpty) SizedBox(width: gap),
            SizedBox(width: arrowWidth, child: _Arrow(open: _anim, onTap: _toggle)),
            if (pay != null) ...[
              SizedBox(width: gap),
              Expanded(child: widget.actions.key(pay, fontScale: 0.95, bar: true)),
            ],
          ]),
        ),
      );
    });
  }

  Widget _row(List<ScreenButton> keys, double unit, {required bool compact}) => Row(children: [
        for (var i = 0; i < keys.length; i++) ...[
          if (i > 0) SizedBox(width: widget.gap),
          SizedBox(width: unit * keys[i].colSpan, child: widget.actions.key(keys[i], fontScale: compact ? 0.9 : 0.95, bar: true, compact: compact)),
        ],
      ]);

  /// The keys that did not fit, in a row just above the bar.
  Widget _overflow(BuildContext context, List<ScreenButton> hidden, double width, double height, double unit) {
    return Stack(children: [
      // A tap anywhere else puts them away.
      Positioned.fill(child: GestureDetector(behavior: HitTestBehavior.translucent, onTap: _hide)),
      CompositedTransformFollower(
        link: _link,
        targetAnchor: Alignment.topRight,
        followerAnchor: Alignment.bottomRight,
        offset: const Offset(0, -8),
        child: FadeTransition(
          opacity: _anim,
          child: SlideTransition(
            position: Tween(begin: const Offset(0, 0.25), end: Offset.zero).animate(CurvedAnimation(parent: _anim, curve: Curves.easeOutCubic)),
            child: Material(
              color: context.goCard,
              elevation: 8,
              borderRadius: BorderRadius.circular(14),
              child: Padding(
                padding: const EdgeInsets.all(8),
                child: ConstrainedBox(
                  constraints: BoxConstraints(maxWidth: width),
                  child: Wrap(spacing: widget.gap, runSpacing: widget.gap, alignment: WrapAlignment.end, children: [
                    for (final k in hidden)
                      SizedBox(
                        width: unit * 1.3 * k.colSpan,
                        height: height,
                        child: widget.actions.key(k, fontScale: 0.9, bar: true, compact: true, onDone: _hide),
                      ),
                  ]),
                ),
              ),
            ),
          ),
        ),
      ),
    ]);
  }
}

/// The arrow that opens a bar's other keys, pointing up, turning when open.
class _Arrow extends StatelessWidget {
  const _Arrow({required this.open, required this.onTap});
  final Animation<double> open;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Material(
        color: context.goCard,
        borderRadius: BorderRadius.circular(10),
        child: InkWell(
          borderRadius: BorderRadius.circular(10),
          onTap: onTap,
          child: Center(
            child: RotationTransition(
              turns: Tween(begin: 0.0, end: 0.5).animate(open),
              child: Icon(Icons.keyboard_arrow_up_rounded, size: 30, color: context.goText),
            ),
          ),
        ),
      );
}

class _Key extends StatelessWidget {
  const _Key({
    required this.button,
    required this.here,
    required this.product,
    required this.target,
    required this.actions,
    this.fontScale = 1,
    this.bar = false,
    this.compact = false,
    this.onDone,
  });

  /// Narrow: a smaller icon and name, one line.
  final bool compact;

  /// After the key has done its work (an overflow row closes itself).
  final VoidCallback? onDone;

  final ScreenButton button;
  final bool here;
  final Product? product;
  final TillScreen? target;
  final KeyActions actions;
  final double fontScale;

  /// On a bar: the till's small keys, an icon over a centred name.
  final bool bar;

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
          onTap = () => actions.onProduct(p);
          final long = actions.onProductLong;
          if (long != null) onLong = () => long(p);
          note = actions.showPrices ? money(p.priceMinor) : null;
        } else {
          note = p == null ? 'Not on the menu' : 'Sold out';
        }
      case ScreenButtonKind.page:
        final t = target;
        label = button.label ?? t?.name ?? 'Unavailable';
        note = here ? '●' : '›››';
        if (t != null) onTap = () => actions.onPage(t);
      case ScreenButtonKind.function:
        final k = button.functionKey ?? '';
        label = button.label ?? goFunctions[k] ?? k;
        if (k == 'pay' && actions.payLabel != null && actions.payEnabled) label = '$label ${actions.payLabel}';
        if (k != 'pay' || actions.payEnabled) onTap = () => actions.onFunction(k);
      case ScreenButtonKind.modifier:
        final group = VenueMenu.current['${button.modifierGroupId}'];
        label = button.label ?? group?.name ?? 'Choices';
        note = '?';
        if (group != null) onTap = () => actions.onFunction('modifier:${button.modifierGroupId}');
      case ScreenButtonKind.blank:
      case ScreenButtonKind.unknown:
        label = button.label ?? '';
    }
    final off = onTap == null && button.kind == ScreenButtonKind.function;
    final fill = off ? context.goDisabledFill : (here ? Tp.lime.withValues(alpha: 0.28) : (button.fill ?? context.goCard));
    final ink = off ? context.goDisabledInk : (button.ink ?? (button.fill == null ? context.goText : (fill.computeLuminance() > 0.5 ? Tp.onLime : Colors.white)));

    // The till's picture rule: the key's own picture, else the product's
    // back-office picture. A picture takes the whole key, and the name and
    // price go on it only when the back office ticks "show the name".
    final own = button.imageUrl;
    final productImage = product?.imageUrl ?? '';
    final image = own != null && own.isNotEmpty ? own : (productImage.isNotEmpty ? photoUrl(productImage) : null);
    final words = image == null || button.showLabel;
    final onPicture = image != null;
    final colour = onPicture ? Colors.white : ink;
    final size = (button.fontSize ?? 15).toDouble().clamp(10, 28) * fontScale;

    // A bar's key, as the till draws it: its icon, and its name centred under
    // it, a size that fits without breaking a word.
    if (onDone != null && onTap != null) {
      final tap = onTap;
      onTap = () {
        onDone!();
        tap();
      };
    }
    if (bar && image == null) {
      final icon = button.kind == ScreenButtonKind.function
          ? functionIcons[button.functionKey]
          : (button.kind == ScreenButtonKind.page ? Icons.grid_view_rounded : null);
      return Opacity(
        opacity: onTap != null || off ? 1 : 0.45,
        child: Material(
          color: fill,
          clipBehavior: Clip.antiAlias,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(10),
            side: BorderSide(color: here ? Tp.lime : context.goLine, width: here ? 2 : 1),
          ),
          child: InkWell(
            onTap: onTap,
            onLongPress: onLong,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 6),
              child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
                if (icon != null) Icon(icon, size: compact ? 18 : 20, color: colour),
                if (icon != null) SizedBox(height: compact ? 2 : 3),
                Flexible(
                  child: FitText(
                    [if ((button.emoji ?? '').isNotEmpty) button.emoji, label].join(' '),
                    maxLines: compact ? 1 : 2,
                    minSize: compact ? 8.5 : 10,
                    textAlign: TextAlign.center,
                    style: TextStyle(fontSize: (compact ? 11.5 : 13) * fontScale, height: 1.1, fontWeight: FontWeight.w700, color: colour),
                  ),
                ),
                if (button.kind == ScreenButtonKind.product && note != null)
                  Text(note, maxLines: 1, style: TextStyle(fontSize: 11, fontFeatures: Tp.tabular, color: colour.withValues(alpha: 0.85))),
              ]),
            ),
          ),
        ),
      );
    }

    return Opacity(
      opacity: onTap != null ? 1 : 0.55,
      child: Material(
        color: fill,
        clipBehavior: Clip.antiAlias,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(10),
          side: BorderSide(color: here ? Tp.lime : context.goLine, width: here ? 2 : 1),
        ),
        child: InkWell(
          onTap: onTap,
          onLongPress: onLong,
          child: Stack(fit: StackFit.expand, children: [
            if (image != null) CachedNetworkImage(imageUrl: image, fit: button.imageFit.boxFit, errorWidget: (_, _, _) => const SizedBox.shrink()),
            if (words)
              Container(
                decoration: onPicture
                    ? const BoxDecoration(gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Color(0x00000000), Color(0xB3000000)]))
                    : null,
                padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisAlignment: onPicture ? MainAxisAlignment.end : MainAxisAlignment.start,
                  children: [
                    Expanded(
                      child: Align(
                        alignment: onPicture ? Alignment.bottomLeft : Alignment.topLeft,
                        child: FitText(
                          [if ((button.emoji ?? '').isNotEmpty) button.emoji, label].join(' '),
                          maxLines: 3,
                          style: TextStyle(fontSize: size, height: 1.15, fontWeight: FontWeight.w700, color: colour),
                        ),
                      ),
                    ),
                    if (note != null)
                      Text(note, maxLines: 1, overflow: TextOverflow.ellipsis,
                          style: TextStyle(fontSize: 12.5 * fontScale, fontFeatures: Tp.tabular, color: colour.withValues(alpha: 0.85))),
                  ],
                ),
              ),
          ]),
        ),
      ),
    );
  }
}
