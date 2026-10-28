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
    return LayoutBuilder(builder: (context, box) {
      final start = style.fontSize ?? 14;
      final size = fitSize(text, style, box.maxWidth, box.maxHeight, maxLines: maxLines, minSize: minSize, scaler: scaler, dir: dir);
      return Text(
        text,
        maxLines: maxLines,
        overflow: TextOverflow.ellipsis,
        textAlign: textAlign,
        style: style.copyWith(fontSize: size.clamp(minSize, start)),
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
