/// A QR code, painted.
///
/// The same encoder the customer display uses, and the same one the back
/// office's own implementation is checked against — so all three surfaces draw
/// a byte-identical code for the same payload. That matters more than it
/// sounds: when a venue rings up to say "the code on the till does not work",
/// the first thing to rule out is the three of them disagreeing.
///
/// Nothing here throws. A payload too long to encode draws nothing, and the
/// caller lays out around an absent square — a till must not fall over because
/// a link came back longer than expected.
library;

import 'package:flutter/material.dart';
import 'package:qr/qr.dart';

class WalletQr extends StatelessWidget {
  const WalletQr({required this.data, this.size = 180, super.key});

  final String data;
  final double size;

  @override
  Widget build(BuildContext context) {
    final image = _encode(data);
    if (image == null) return SizedBox.square(dimension: size);

    return Container(
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        // White, always, whatever the till's theme is doing. A QR drawn
        // light-on-dark reads on perhaps half the phones that try it, and the
        // half it fails on get no error — the camera simply sits there.
        color: Colors.white,
        borderRadius: BorderRadius.circular(10),
      ),
      child: CustomPaint(
        size: Size.square(size),
        painter: _QrPainter(image),
      ),
    );
  }

  /// The lowest error-correction level, deliberately.
  ///
  /// This is drawn on a backlit screen at arm's length, not printed on a beer
  /// mat. The redundancy buys nothing here and costs modules — and more modules
  /// in the same square is a code that scans *worse*.
  static QrImage? _encode(String data) {
    final trimmed = data.trim();
    if (trimmed.isEmpty) return null;
    try {
      return QrImage(
        QrCode.fromData(
          data: trimmed,
          errorCorrectLevel: QrErrorCorrectLevel.L,
        ),
      );
    } catch (_) {
      return null;
    }
  }
}

class _QrPainter extends CustomPainter {
  const _QrPainter(this.image);

  final QrImage image;

  @override
  void paint(Canvas canvas, Size size) {
    final count = image.moduleCount;
    if (count <= 0) return;

    // Floored to a whole pixel, with the remainder used as an inset, so every
    // module is the same size. Sub-pixel widths are what make a small QR look
    // furred: the rounding error accumulates across forty modules and the last
    // column ends up a different width from the first.
    final module = (size.width / count).floorToDouble();
    if (module < 1) return;
    final offset = (size.width - module * count) / 2;

    final paint = Paint()..color = Colors.black;
    for (var row = 0; row < count; row++) {
      for (var col = 0; col < count; col++) {
        if (!image.isDark(row, col)) continue;
        canvas.drawRect(
          Rect.fromLTWH(
            offset + col * module,
            offset + row * module,
            // A hairline over, so neighbouring modules meet rather than leaving
            // a seam the camera reads as a gap.
            module + 0.5,
            module + 0.5,
          ),
          paint,
        );
      }
    }
  }

  @override
  bool shouldRepaint(_QrPainter old) => old.image != image;
}
