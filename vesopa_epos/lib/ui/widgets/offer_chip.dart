import 'package:flutter/material.dart';

import '../../data/commerce.dart';
import '../theme.dart';

/// The offer flash on a product button.
///
/// Shared by the catalogue grid and by a venue's own programmed screen, because
/// the two draw the same products and a promotion that shows on one and not the
/// other is a clerk quoting the wrong price on whichever screen they happen to
/// be standing in front of.
class OfferChip extends StatelessWidget {
  const OfferChip({super.key, required this.text, required this.colour});

  /// The wording from the back office — "HALF PRICE", "2 FOR £10".
  final String text;

  /// The promotion's own colour.
  final Color colour;

  /// The chip for a promotion, or null when there is nothing to flash. Kept
  /// beside the widget so both grids decide it the same way.
  static OfferChip? forPromotion(Promotion? promotion) {
    final text = promotion?.badgeText;
    if (text == null || text.isEmpty) return null;
    return OfferChip(
      text: text,
      colour: Pos.parseColor(promotion?.badgeColour) ?? const Color(0xFFD81B60),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
      decoration: BoxDecoration(
        color: colour,
        borderRadius: BorderRadius.circular(5),
      ),
      child: Text(
        text,
        // The badge colour is set per-promotion in the back office, so a
        // yellow "HALF PRICE" flash would otherwise be white-on-yellow.
        style: TextStyle(
          color: Pos.inkOn(colour),
          fontSize: 10,
          fontWeight: FontWeight.w800,
          letterSpacing: 0.3,
        ),
      ),
    );
  }
}
