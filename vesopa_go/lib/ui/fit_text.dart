/// Text that fits its box without breaking a word (owner, 2026-10-28: "text
/// proper boxes, not a word split over two lines").
///
/// Starts at the style's size and steps down to [minSize] until the longest
/// word fits the width on one line and the whole text fits in [maxLines] and
/// the height there is. Only then, at [minSize], does it ellipsise.
library;

import 'package:flutter/material.dart';

class FitText extends StatelessWidget {
  const FitText(this.text, {super.key, required this.style, this.maxLines = 3, this.minSize = 10, this.textAlign = TextAlign.start});

  final String text;
  final TextStyle style;
  final int maxLines;
  final double minSize;
  final TextAlign textAlign;

  @override
  Widget build(BuildContext context) {
    final scaler = MediaQuery.textScalerOf(context);
    final dir = Directionality.of(context);
    // Measured in the style the text is drawn in: the theme's font, merged.
    final drawn = DefaultTextStyle.of(context).style.merge(style);
    return LayoutBuilder(builder: (context, box) {
      final start = drawn.fontSize ?? 14;
      final size = fitSize(text, drawn, box.maxWidth, box.maxHeight, maxLines: maxLines, minSize: minSize, scaler: scaler, dir: dir)
          .clamp(minSize, start);
      // Never a line cut in half (owner, 2026-10-31, "the next line is being
      // hidden"): only as many lines as the height holds, the last one
      // ellipsised, rather than a second line clipped through its middle.
      final lineHeight = scaler.scale(size) * (drawn.height ?? 1.2);
      final room = box.maxHeight.isFinite ? (box.maxHeight / lineHeight).floor().clamp(1, maxLines) : maxLines;
      return Text(
        text,
        maxLines: room,
        overflow: TextOverflow.ellipsis,
        textAlign: textAlign,
        style: drawn.copyWith(fontSize: size),
      );
    });
  }
}

/// The largest size from [style]'s down to [minSize] at which [text] fits
/// [width] x [height] in [maxLines], with every word whole on its line.
double fitSize(String text, TextStyle style, double width, double height,
    {int maxLines = 3, double minSize = 10, TextScaler scaler = TextScaler.noScaling, TextDirection dir = TextDirection.ltr}) {
  final start = style.fontSize ?? 14;
  if (!width.isFinite || width <= 0 || text.isEmpty) return start;
  final words = text.split(RegExp(r'\s+')).where((w) => w.isNotEmpty).toList();
  for (var size = start; size > minSize; size -= 1) {
    final s = style.copyWith(fontSize: size);
    final wordsFit = words.every((w) {
      final p = TextPainter(text: TextSpan(text: w, style: s), textDirection: dir, textScaler: scaler, maxLines: 1)..layout();
      return p.width <= width;
    });
    if (!wordsFit) continue;
    final all = TextPainter(text: TextSpan(text: text, style: s), textDirection: dir, textScaler: scaler, maxLines: maxLines)
      ..layout(maxWidth: width);
    if (!all.didExceedMaxLines && (!height.isFinite || all.height <= height)) return size;
  }
  return minSize;
}
