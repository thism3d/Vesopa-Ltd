import 'package:flutter/material.dart';

import '../../data/page_highlight.dart';

/// The page highlight's underbar (2026-10-01): a strip along the foot of the
/// key for the page a till is on, in the venue's colour. Drawn inside the key
/// so the key never changes size, and faded in so a page change reads as the
/// highlight arriving rather than as a flicker.
class HereBar extends StatelessWidget {
  const HereBar({super.key, required this.colour});

  final Color colour;

  @override
  Widget build(BuildContext context) => Align(
    alignment: Alignment.bottomCenter,
    child: LayoutBuilder(
      builder: (context, box) => TweenAnimationBuilder<double>(
        tween: Tween(begin: 0, end: 1),
        duration: MediaQuery.of(context).disableAnimations
            ? Duration.zero
            : const Duration(milliseconds: 180),
        builder: (context, t, _) => SizedBox(
          width: double.infinity,
          height: hereBarThickness(
                box.maxHeight.isFinite ? box.maxHeight : 60,
              ) *
              t,
          child: ColoredBox(color: colour),
        ),
      ),
    ),
  );
}
