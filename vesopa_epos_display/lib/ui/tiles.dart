import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../data/basket_feed.dart';
import '../data/settings.dart';
import 'customer_qr.dart';
import 'theme.dart';

/// Tiles for a customer display on a big screen (2026-10-17).
///
/// "Customer Display we are using a big screen on a pub": a TV has room for
/// more than a bill and a poster, so the venue can add tiles -- the time, the
/// date, a welcome, today's special, their QR code, the cards they take, and
/// the running total in letters you can read from the bar. Every one is off
/// until the till (or this screen's settings) turns it on, so a counter
/// display is exactly what it was.
///
/// Drawn from what this screen already has: no network, no new data. The
/// clock ticks with the display page's own one-second timer.
class TileStrip extends StatelessWidget {
  const TileStrip({
    super.key,
    required this.settings,
    required this.basket,
    required this.vertical,
  });

  final DisplaySettings settings;
  final Basket basket;

  /// A column down the side, rather than a strip along the bottom.
  final bool vertical;

  /// Whether any tile would draw, so the screen keeps its whole area when
  /// none would (all off, or only the total with no sale on).
  static bool anyVisible(DisplaySettings settings, Basket basket) =>
      TileStrip(settings: settings, basket: basket, vertical: false)._visible.isNotEmpty;

  /// Tile ids in the order the venue chose, minus any this build cannot draw
  /// and any with nothing to show.
  List<String> get _visible => [
    for (final id in settings.tiles)
      if (_hasContent(id)) id,
  ];

  bool _hasContent(String id) => switch (id) {
    'clock' || 'date' || 'cards' => true,
    'welcome' => settings.welcomeText.trim().isNotEmpty,
    'special' => settings.specialTitle.trim().isNotEmpty || settings.specialText.trim().isNotEmpty,
    'qr' => settings.customerQr.trim().isNotEmpty,
    'total' => basket.hasSale,
    _ => false,
  };

  @override
  Widget build(BuildContext context) {
    final tiles = _visible;
    if (tiles.isEmpty) return const SizedBox.shrink();
    final children = [
      for (final id in tiles)
        Expanded(
          flex: id == 'special' || id == 'welcome' ? 2 : 1,
          child: Padding(
            padding: const EdgeInsets.all(6),
            child: _Tile(id: id, settings: settings, basket: basket),
          ),
        ),
    ];
    return Container(
      color: Brand.panel,
      padding: const EdgeInsets.all(6),
      child: vertical ? Column(children: children) : Row(children: children),
    );
  }
}

class _Tile extends StatelessWidget {
  const _Tile({required this.id, required this.settings, required this.basket});

  final String id;
  final DisplaySettings settings;
  final Basket basket;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: Brand.panelSoft,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: Brand.line, width: 1.5),
      ),
      padding: const EdgeInsets.all(14),
      child: LayoutBuilder(
        builder: (context, box) {
          // Type sized from the tile, so a tile reads the same on any screen.
          final unit = (box.maxHeight < box.maxWidth ? box.maxHeight : box.maxWidth / 2).clamp(40.0, 400.0);
          return Center(child: _body(unit));
        },
      ),
    );
  }

  Widget _body(double unit) {
    final now = DateTime.now();
    switch (id) {
      case 'clock':
        return _Big(DateFormat('HH:mm').format(now), size: unit * 0.42, colour: Brand.ink);
      case 'date':
        return Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            _Big(DateFormat('EEEE').format(now), size: unit * 0.2, colour: Brand.lime),
            const SizedBox(height: 4),
            _Big(DateFormat('d MMMM').format(now), size: unit * 0.24, colour: Brand.ink),
          ],
        );
      case 'welcome':
        return _Big(settings.welcomeText.trim(), size: unit * 0.24, colour: Brand.ink, lines: 3);
      case 'special':
        return Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (settings.specialTitle.trim().isNotEmpty)
              _Big(settings.specialTitle.trim(), size: unit * 0.2, colour: Brand.lime, lines: 2),
            if (settings.specialText.trim().isNotEmpty) ...[
              const SizedBox(height: 6),
              _Big(settings.specialText.trim(), size: unit * 0.15, colour: Brand.ink, lines: 4),
            ],
          ],
        );
      case 'qr':
        return CustomerQr(
          data: settings.customerQr.trim(),
          caption: settings.customerQrCaption,
          size: unit * 0.62,
          captionSize: unit * 0.09,
        );
      case 'cards':
        return Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            _Big('We accept', size: unit * 0.13, colour: Brand.inkSoft),
            const SizedBox(height: 8),
            Wrap(
              alignment: WrapAlignment.center,
              spacing: unit * 0.06,
              runSpacing: unit * 0.06,
              children: [
                for (final c in const ['Visa', 'Mastercard', 'Amex', 'Apple Pay', 'Google Pay', 'Cash'])
                  Container(
                    padding: EdgeInsets.symmetric(horizontal: unit * 0.07, vertical: unit * 0.035),
                    decoration: BoxDecoration(
                      color: Colors.white,
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: Text(
                      c,
                      style: TextStyle(
                        color: const Color(0xFF14161A),
                        fontWeight: FontWeight.w800,
                        fontSize: unit * 0.1,
                      ),
                    ),
                  ),
              ],
            ),
          ],
        );
      case 'total':
        return Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            _Big(basket.state == 'paid' ? 'Paid' : 'Total', size: unit * 0.16, colour: Brand.inkSoft),
            const SizedBox(height: 4),
            _Big(money(basket.totalMinor), size: unit * 0.36, colour: Brand.lime),
          ],
        );
    }
    return const SizedBox.shrink();
  }
}

class _Big extends StatelessWidget {
  const _Big(this.text, {required this.size, required this.colour, this.lines = 1});

  final String text;
  final double size;
  final Color colour;
  final int lines;

  @override
  Widget build(BuildContext context) => Text(
    text,
    textAlign: TextAlign.center,
    maxLines: lines,
    overflow: TextOverflow.ellipsis,
    style: TextStyle(
      color: colour,
      fontSize: size,
      fontWeight: FontWeight.w800,
      height: 1.1,
    ),
  );
}
