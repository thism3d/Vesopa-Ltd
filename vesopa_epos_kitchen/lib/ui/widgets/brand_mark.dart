import 'package:flutter/material.dart';

import '../theme.dart';

/// Vesopa Kitchen's mark.
///
/// The brand's V, in the Kitchen's palette: a near-black square with a lime V
/// and a white wedge. Same geometry as the till's mark, inverted — which is
/// what makes the two separable on a taskbar in a venue running both, without
/// either of them stopping being Vesopa.
///
/// A widget rather than a bare `Image.asset` at three call sites, because a
/// wall-mounted screen must never show a broken-image glyph: the fallback below
/// draws the square in code, so a missing or corrupt asset degrades to a plain
/// brand tile instead of a grey box with a cross in it.
class BrandMark extends StatelessWidget {
  const BrandMark({super.key, this.size = 56});

  final double size;

  @override
  Widget build(BuildContext context) {
    return ClipRRect(
      // Rounded to match the Windows taskbar's own treatment, so the icon on
      // screen and the icon on the bar read as the same thing.
      borderRadius: BorderRadius.circular(size * 0.22),
      child: Image.asset(
        'assets/brand/kitchen_mark.png',
        width: size,
        height: size,
        filterQuality: FilterQuality.medium,
        errorBuilder: (_, _, _) => Container(
          width: size,
          height: size,
          color: Kds.chromeHeader,
          alignment: Alignment.center,
          child: Text(
            'V',
            style: TextStyle(
              color: Kds.brand,
              fontSize: size * 0.6,
              fontWeight: FontWeight.w800,
              height: 1,
            ),
          ),
        ),
      ),
    );
  }
}
