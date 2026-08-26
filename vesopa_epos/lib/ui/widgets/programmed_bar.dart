import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/local/database.dart';
import '../../data/screens.dart';
import '../../data/staff_session.dart';
import '../../main.dart';
import '../shell.dart' show SyncStatusBadge;
import '../theme.dart';
import 'basket_panel.dart' show money;
import 'open_bills_strip.dart';
import 'print_status.dart';

/// What the bar needs to know about the sale it is sitting on.
///
/// Passed in rather than read from providers here, because these four things
/// are the sale page's own state — which bill is on the till, what it comes to,
/// which screen is open — and a bar that went looking for them itself would be
/// a second answer to a question that already has one.
class BarLive {
  const BarLive({
    required this.currentOrderId,
    required this.currentOrder,
    required this.totalMinor,
    required this.screenName,
    required this.onSwitchOrder,
  });

  final String currentOrderId;
  final Order? currentOrder;
  final int totalMinor;

  /// The name of the sale screen currently open, for the `screen_name` key.
  final String screenName;

  final void Function(String orderId) onSwitchOrder;
}

/// A venue's own top or bottom bar, drawn.
///
/// The alternative to the two strips the till has always shown: the live list
/// of open bills across the top, and Void / Cancel / Save Table … Pay across
/// the bottom. Which one a venue gets is `TillSettings.topBarScreenId` and
/// `bottomBarScreenId` — null means the built-in, and the sale page keeps its
/// old rendering. See `docs/screen-programming.md` §9.
///
/// A bar is a screen, so this is [ProgrammedGrid] with two differences:
///
///   * **Height is fixed per row, not derived from the space.** A bar is as
///     tall as a bar. Sizing it from the box the way the grid does would let a
///     one-row bar grow to fill half a till.
///   * **Some keys draw rather than wait.** `open_bills` is the strip of open
///     tables; `clock`, `order_total`, `staff_name`, `venue_name`,
///     `sync_status` and `screen_name` are the furniture around it. Without
///     those a venue that programmed a top bar would lose the ability to run
///     two bills at once — which is the whole reason the top bar exists.
///
/// **Nothing here may fail to draw**, for the reason given on the grid: a
/// layout is arranged in an office weeks before a clerk stands in front of it,
/// and everything it points at can be deleted in between.
class ProgrammedBar extends ConsumerWidget {
  const ProgrammedBar({
    super.key,
    required this.bar,
    required this.screens,
    required this.products,
    required this.live,
    required this.onProduct,
    required this.onPage,
    required this.onFunction,
    this.showPrices = true,
  });

  final TillScreen bar;
  final ScreenSet screens;
  final Map<int, Product> products;
  final BarLive live;

  final void Function(Product) onProduct;
  final void Function(TillScreen) onPage;
  final void Function(String functionKey) onFunction;

  final bool showPrices;

  /// One row of bar. Matches the built-in action bar's key height closely
  /// enough that switching a venue over does not move the sale grid under a
  /// clerk's hand.
  static const rowHeight = 58.0;
  static const _gap = 6.0;

  /// Below this a key stops being reliably hittable with a thumb on a busy
  /// counter — the same figure, for the same reason, as PosActionBar's
  /// `_minKeyWidth`.
  ///
  /// A bar is laid out in an office against a counter terminal and then met on
  /// whatever the venue happens to be holding. Twelve keys across a handheld is
  /// 30px each, which is a bar a clerk cannot use and cannot fix. So the bar
  /// keeps the width it was given and scrolls sideways instead of shrinking —
  /// the same trade the open-bills strip makes, and the one that leaves the
  /// venue's layout intact rather than silently rearranging it.
  static const _minKeyWidth = 72.0;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final pal = PayPalette.of(context);
    final covered = bar.covered;

    return Material(
      color: pal.canvas,
      child: SafeArea(
        top: bar.surface != ScreenSurface.bottomBar,
        bottom: bar.surface == ScreenSurface.bottomBar,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(8, 8, 8, 8),
          child: SizedBox(
            height: bar.rows * rowHeight + (bar.rows - 1) * _gap,
            child: LayoutBuilder(
              builder: (context, box) {
                final natural =
                    (box.maxWidth - _gap * (bar.cols - 1)) / bar.cols;
                final cellW = natural < _minKeyWidth ? _minKeyWidth : natural;
                final width = cellW * bar.cols + _gap * (bar.cols - 1);

                final keys = <Widget>[];
                for (var r = 0; r < bar.rows; r++) {
                  for (var c = 0; c < bar.cols; c++) {
                    if (covered.contains('$r:$c')) continue;
                    final button = bar.at(r, c);
                    if (button == null) continue;

                    keys.add(
                      Positioned(
                        left: c * (cellW + _gap),
                        top: r * (rowHeight + _gap),
                        width: cellW * button.colSpan +
                            _gap * (button.colSpan - 1),
                        height: rowHeight * button.rowSpan +
                            _gap * (button.rowSpan - 1),
                        child: _BarKey(
                          button: button,
                          screens: screens,
                          product: button.pluId == null
                              ? null
                              : products[button.pluId],
                          live: live,
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

                final stack = SizedBox(width: width, child: Stack(children: keys));
                // Only scrollable when it has to be. A bar that fits is an
                // ordinary bar, and wrapping every one of them in a scroll view
                // would let a clerk drag the whole strip sideways by accident
                // while reaching for Pay.
                return natural < _minKeyWidth
                    ? SingleChildScrollView(
                        scrollDirection: Axis.horizontal,
                        child: stack,
                      )
                    : stack;
              },
            ),
          ),
        ),
      ),
    );
  }
}

/// One key on a bar — or one live display, which is not a key at all.
class _BarKey extends ConsumerWidget {
  const _BarKey({
    required this.button,
    required this.screens,
    required this.product,
    required this.live,
    required this.pal,
    required this.showPrices,
    required this.onProduct,
    required this.onPage,
    required this.onFunction,
  });

  final ScreenButton button;
  final ScreenSet screens;
  final Product? product;
  final BarLive live;
  final PayPalette pal;
  final bool showPrices;

  final void Function(Product) onProduct;
  final void Function(TillScreen) onPage;
  final void Function(String) onFunction;

  /// The keys that draw something live instead of waiting to be pressed.
  ///
  /// Mirrors the widget group of BAR_KEYS in vesopa_server/src/screens.js. A
  /// key not in here is an ordinary button; a key in here is never pressed, so
  /// it is deliberately checked before anything works out an onTap.
  static const _widgets = <String>{
    'open_bills',
    'order_total',
    'clock',
    'venue_name',
    'staff_name',
    'sync_status',
    'print_status',
    'screen_name',
    'spacer',
  };

  /// The icon a function key wears when the venue has not given it a face.
  ///
  /// The same icons the built-in bar uses, so a venue that rebuilds its bar
  /// from the preset gets the bar it already had rather than a row of words.
  static const _icons = <String, IconData>{
    'pay': Icons.credit_card,
    'void': Icons.backspace_outlined,
    'cancel': Icons.block,
    'save_table': Icons.table_restaurant,
    'new_bill': Icons.note_add,
    'last_bill': Icons.receipt_long,
    'qty': Icons.tag,
    'note': Icons.edit_note,
    'covers': Icons.people,
    'customer': Icons.person,
    'open_drawer': Icons.point_of_sale,
    'print_bill': Icons.print,
    'go_sale': Icons.sell,
    'go_tables': Icons.grid_view,
    'go_receipts': Icons.receipt_long,
    'go_reports': Icons.bar_chart,
    'go_products': Icons.shopping_bag,
    'go_functions': Icons.exit_to_app,
    'go_settings': Icons.settings,
    'sign_off': Icons.logout,
  };

  /// Mirrors the labels the back office offers. A key not in here still draws —
  /// as its raw key, dimmed — so a till running an older release than the back
  /// office shows an inert key rather than failing to parse the bar.
  static const _names = <String, String>{
    'pay': 'Pay',
    'void': 'Void',
    'cancel': 'Cancel',
    'save_table': 'Save Table',
    'new_bill': 'New bill',
    'last_bill': 'Last Bill',
    'qty': 'Quantity',
    'note': 'Notes',
    'covers': 'Covers',
    'customer': 'Customer',
    'open_drawer': 'No Sale',
    'print_bill': 'Print',
    'go_sale': 'Sale',
    'go_tables': 'Tables',
    'go_receipts': 'Receipts',
    'go_reports': 'Reports',
    'go_products': 'Products',
    'go_functions': 'Functions',
    'go_settings': 'Settings',
    'sign_off': 'Sign off',
  };

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final key = button.functionKey;
    if (button.kind == ScreenButtonKind.function &&
        key != null &&
        _widgets.contains(key)) {
      return _display(context, ref, key);
    }
    return _key(context);
  }

  // -------------------------------------------------------------------------
  // The live displays
  // -------------------------------------------------------------------------

  Widget _display(BuildContext context, WidgetRef ref, String key) {
    // A spacer is the one key that draws nothing at all. Deliberately not an
    // empty cell: an empty cell is where a venue has not put anything, and a
    // spacer is where it has decided nothing goes — which it can then colour,
    // and which stops the keys either side of it drifting together when the
    // bar is laid out again.
    if (key == 'spacer') {
      return button.fill == null
          ? const SizedBox.shrink()
          : DecoratedBox(
              decoration: BoxDecoration(
                color: button.fill,
                borderRadius: BorderRadius.circular(10),
              ),
            );
    }

    if (key == 'open_bills') {
      // No Material or padding of its own — the chips bring their own colour,
      // and a coloured slab behind them fights every one of them.
      return OpenBillsStrip(
        currentOrderId: live.currentOrderId,
        currentOrder: live.currentOrder,
        onSwitch: live.onSwitchOrder,
        padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 6),
      );
    }

    final fill = button.fill ?? pal.softFill;
    final ink = button.ink ?? (button.fill == null ? pal.ink : Pos.inkOn(fill));

    final Widget body = switch (key) {
      'order_total' => _twoLine(
        button.label ?? 'Total',
        money(live.totalMinor),
        ink,
        big: true,
      ),
      'clock' => const _Clock(),
      'venue_name' => _oneLine(
        button.label ?? ref.watch(brandingProvider).venueName,
        ink,
      ),
      'staff_name' => _oneLine(
        ref.watch(staffSessionProvider).name ??
            ref.watch(sessionProvider).name ??
            'Not signed on',
        ink,
        icon: Icons.person,
      ),
      'sync_status' => const Center(child: SyncStatusBadge()),
      // Whether the last kitchen ticket landed. On the bar because the till's
      // own top bar can be turned off in favour of a programmed one, and this
      // was the only thing on it a venue could not otherwise place. Draws
      // nothing at all when there is nothing to report, exactly as it does in
      // the built-in bar.
      'print_status' => const Center(child: PrintStatusBadge()),
      'screen_name' => _oneLine(button.label ?? live.screenName, ink),
      _ => const SizedBox.shrink(),
    };

    return Container(
      decoration: BoxDecoration(
        color: fill,
        borderRadius: BorderRadius.circular(10),
      ),
      padding: const EdgeInsets.symmetric(horizontal: 8),
      alignment: Alignment.center,
      // The clock brings its own colour handling; everything else takes the
      // ink worked out above.
      child: DefaultTextStyle.merge(
        style: TextStyle(color: ink),
        child: body,
      ),
    );
  }

  Widget _oneLine(String text, Color ink, {IconData? icon}) => Row(
    mainAxisAlignment: MainAxisAlignment.center,
    children: [
      if (icon != null) ...[
        Icon(icon, size: 16, color: ink.withValues(alpha: 0.8)),
        const SizedBox(width: 6),
      ],
      Flexible(
        child: Text(
          text,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w700),
        ),
      ),
    ],
  );

  Widget _twoLine(String top, String bottom, Color ink, {bool big = false}) =>
      Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Text(
            top,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              fontSize: 10.5,
              fontWeight: FontWeight.w600,
              color: ink.withValues(alpha: 0.75),
            ),
          ),
          Text(
            bottom,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              fontSize: big ? 18 : 14,
              fontWeight: FontWeight.w800,
              fontFeatures: const [FontFeature.tabularFigures()],
            ),
          ),
        ],
      );

  // -------------------------------------------------------------------------
  // The keys
  // -------------------------------------------------------------------------

  /// What the key says, and what happens when it is pressed.
  ///
  /// Resolved together for the same reason [ProgrammedGrid] does it: a button
  /// whose product has been deleted has no action *and* has to say why, and
  /// working those out in two places is how they end up disagreeing.
  ({String label, String? note, IconData? icon, VoidCallback? onTap})
  get _resolved {
    switch (button.kind) {
      case ScreenButtonKind.product:
        final p = product;
        if (p == null) {
          return (
            label: button.label ?? 'Unavailable',
            note: 'Not in the catalogue',
            icon: null,
            onTap: null,
          );
        }
        return (
          label: button.label ?? p.name,
          note: showPrices ? money(p.priceMinor) : null,
          icon: null,
          onTap: () => onProduct(p),
        );

      case ScreenButtonKind.page:
        final target = screens.byId(button.targetScreenId);
        if (target == null) {
          return (
            label: button.label ?? 'Unavailable',
            note: 'Screen removed',
            icon: null,
            onTap: null,
          );
        }
        return (
          label: button.label ?? target.name,
          note: null,
          icon: Icons.chevron_right,
          onTap: () => onPage(target),
        );

      case ScreenButtonKind.function:
        final key = button.functionKey;
        if (key == null || key.isEmpty) {
          return (
            label: button.label ?? 'Unset',
            note: null,
            icon: null,
            onTap: null,
          );
        }
        // Pay carries what it is about to charge, on the key that charges it —
        // the one thing the built-in bar does that a plain label cannot, and
        // the reason a venue would otherwise have to keep the built-in bar.
        final payable = key != 'pay' || live.totalMinor != 0;
        return (
          label: button.label ?? _names[key] ?? key,
          note: key == 'pay' && live.totalMinor != 0
              ? money(live.totalMinor)
              : null,
          icon: _icons[key],
          onTap: payable ? () => onFunction(key) : null,
        );

      case ScreenButtonKind.unknown:
        return (
          label: button.label ?? 'Not supported',
          note: 'Update the till',
          icon: null,
          onTap: null,
        );
    }
  }

  Widget _key(BuildContext context) {
    final r = _resolved;
    final enabled = r.onTap != null;
    final fill = button.fill ?? pal.keyFill;
    final ink = button.ink ?? (button.fill == null ? pal.ink : Pos.inkOn(fill));

    // The venue's own picture beats the icon, and on a product key the
    // product's own picture beats nothing — the same fallback chain the grid
    // uses, so a key does not change its face when it is moved onto a bar.
    final emoji = button.emoji?.isNotEmpty == true
        ? button.emoji
        : (button.kind == ScreenButtonKind.product ? product?.emoji : null);
    final image = button.imageUrl?.isNotEmpty == true
        ? button.imageUrl
        : (button.kind == ScreenButtonKind.product ? product?.imageUrl : null);

    return Opacity(
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
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                if (image != null && image.isNotEmpty)
                  Flexible(
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(5),
                      child: Image.network(
                        image,
                        height: 20,
                        fit: BoxFit.cover,
                        // A picture that will not load leaves the key exactly
                        // as a key with no picture. A broken-image frame on a
                        // bar is worse than no picture at all.
                        errorBuilder: (_, _, _) => const SizedBox.shrink(),
                        loadingBuilder: (context, child, progress) =>
                            progress == null ? child : const SizedBox.shrink(),
                      ),
                    ),
                  )
                else if (emoji != null && emoji.isNotEmpty)
                  Text(emoji, style: const TextStyle(fontSize: 17))
                else if (r.icon != null)
                  Icon(r.icon, size: 18, color: ink),
                Flexible(
                  child: Text(
                    r.label,
                    textAlign: TextAlign.center,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      color: ink,
                      fontSize: 12,
                      fontWeight: FontWeight.w700,
                      height: 1.1,
                    ),
                  ),
                ),
                if (r.note != null)
                  Text(
                    r.note!,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      color: ink.withValues(alpha: 0.85),
                      fontSize: 12,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The time, to the minute.
///
/// Its own stateful widget with its own timer, so the one key that has to
/// rebuild every minute is the only thing that does. A clock wired into the
/// sale page's build would repaint the bill, the grid and the bar with it.
class _Clock extends StatefulWidget {
  const _Clock();

  @override
  State<_Clock> createState() => _ClockState();
}

class _ClockState extends State<_Clock> {
  late Timer _timer;
  late DateTime _now;

  @override
  void initState() {
    super.initState();
    _now = DateTime.now();
    // Ticking on the second and only repainting on the minute: a timer aligned
    // to the minute drifts, and a till left running for a fortnight would show
    // a clock a minute or two behind the one on the wall.
    _timer = Timer.periodic(const Duration(seconds: 10), (_) {
      final now = DateTime.now();
      if (now.minute == _now.minute && now.hour == _now.hour) return;
      if (mounted) setState(() => _now = now);
    });
  }

  @override
  void dispose() {
    _timer.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final hh = _now.hour.toString().padLeft(2, '0');
    final mm = _now.minute.toString().padLeft(2, '0');
    return Text(
      '$hh:$mm',
      maxLines: 1,
      style: const TextStyle(
        fontSize: 18,
        fontWeight: FontWeight.w800,
        fontFeatures: [FontFeature.tabularFigures()],
      ),
    );
  }
}
