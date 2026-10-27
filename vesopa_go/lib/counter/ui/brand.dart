/// Vesopa Go's mark and the bits of look it adds to Vesopa Go's theme.
///
/// The family palette (lime #A5C715 on ink) from Go's `Tp`, so Lite
/// sits beside the tills and Tap as one product line. Lime is the next thing
/// to press: Pay, Add, Done. The sale screen is ink by default, as the
/// terminal it runs on is usually behind a bar.
library;

import 'package:flutter/material.dart';
import 'package:vesopa_go/ui/theme.dart';

const appName = 'Vesopa Go';

/// Vesopa Go's mark: the V with its speed lines on ink, the app icon itself
/// (tool/make_icons.py).
class GoMark extends StatelessWidget {
  const GoMark({super.key, this.size = 40});
  final double size;

  @override
  Widget build(BuildContext context) => ClipRRect(
    borderRadius: BorderRadius.circular(size * 0.22),
    child: Image.asset('assets/brand/go_mark.png', width: size, height: size, filterQuality: FilterQuality.medium, semanticLabel: 'Vesopa'),
  );
}

/// "Vesopa Go": the family name, then Go in lime.
class GoWordmark extends StatelessWidget {
  const GoWordmark({super.key, this.size = 20, this.mark = true});
  final double size;
  final bool mark;

  @override
  Widget build(BuildContext context) {
    final colour = Theme.of(context).colorScheme.onSurface;
    // Scales down rather than overflows: an app bar on a small terminal,
    // beside the clerk's name and the offline mark, has little room.
    return FittedBox(
      fit: BoxFit.scaleDown,
      alignment: Alignment.centerLeft,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          if (mark) ...[GoMark(size: size * 1.5), SizedBox(width: size * 0.45)],
          Text(
            'Vesopa ',
            style: TextStyle(fontSize: size, fontWeight: FontWeight.w800, letterSpacing: -0.3, color: colour),
          ),
          Text(
            'Go',
            style: TextStyle(fontSize: size, fontWeight: FontWeight.w900, letterSpacing: -0.3, color: Tp.lime),
          ),
        ],
      ),
    );
  }
}

/// An icon for a menu category from its name, so the rail reads at a glance
/// without anyone choosing icons in the back office.
IconData categoryIcon(String name) {
  final n = name.toLowerCase();
  bool has(List<String> words) => words.any(n.contains);
  // Most specific first: "Soft drinks" is not a drink with alcohol, "Sides" not a starter.
  if (has(['tea', 'infusion'])) return Icons.emoji_food_beverage_rounded;
  if (has(['coffee', 'hot drink'])) return Icons.coffee_rounded;
  if (has(['cocktail'])) return Icons.local_bar_rounded;
  if (has(['spirit', 'gin', 'vodka', 'whisky', 'rum', 'shot'])) return Icons.liquor_rounded;
  if (has(['wine', 'fizz', 'prosecco', 'champagne'])) return Icons.wine_bar_rounded;
  if (has(['beer', 'ale', 'lager', 'draught', 'cider', 'pint', 'bottle'])) return Icons.sports_bar_rounded;
  if (has(['soft', 'mixer', 'minerals', 'juice', 'drink'])) return Icons.local_drink_rounded;
  if (has(['side'])) return Icons.fastfood_rounded;
  if (has(['starter', 'small plate', 'snack', 'tapas'])) return Icons.tapas_rounded;
  if (has(['dessert', 'pudding', 'sweet', 'cake'])) return Icons.cake_rounded;
  if (has(['ice cream'])) return Icons.icecream_rounded;
  if (has(['special', 'offer', 'deal', 'set', 'meal'])) return Icons.star_rounded;
  if (has(['burger', 'main', 'food', 'grill', 'kitchen', 'hot food'])) return Icons.restaurant_rounded;
  if (has(['crisp', 'nut', 'confection'])) return Icons.cookie_rounded;
  if (has(['kid', 'child'])) return Icons.child_care_rounded;
  if (has(['merch', 'retail', 'shop'])) return Icons.shopping_bag_rounded;
  return Icons.grid_view_rounded;
}
