/// The code a customer points their phone at.
///
/// WHAT IT IS FOR
///
/// The moment a customer is standing at the counter watching their round being
/// rung up is the one moment in the day when they are looking at this screen and
/// have their phone in their hand. That is when "join our scheme" or "add your
/// card to your phone" actually gets done — not on a poster by the door, and not
/// on a receipt they put in their pocket.
///
/// So the till can put a code here. What it points at is the venue's business:
/// a sign-up page, a wallet pass, a review link. This end draws it and says
/// nothing about what it means.
///
/// WHY THE ENCODER AND NOT A WIDGET PACKAGE
///
/// `qr` turns a string into a grid of dark and light squares. Painting that is
/// the forty lines below. A widget package would bring its own theming, its own
/// error-correction opinions and its own dependency tree to do the same thing,
/// on a screen whose Store package deliberately declares no capabilities at all.
///
/// NOTHING HERE THROWS. A string too long to encode — or one that upsets the
/// encoder for any other reason — draws nothing, and the panel around it is
/// laid out so that "nothing" is simply an absent square rather than a hole. A
/// customer display must not fall over because somebody pasted a bad link into
/// a settings box on the till.
library;

import 'package:flutter/material.dart';
import 'package:qr/qr.dart';

import 'theme.dart';

/// A QR code with a line of text under it.
class CustomerQr extends StatelessWidget {
  const CustomerQr({
    required this.data,
    this.caption = '',
    this.size = 132,
    this.captionSize = 13,
    super.key,
  });

  /// What the code encodes. Empty draws nothing at all.
  final String data;

  /// The line under it — "Scan to join", or whatever the venue set. A code with
  /// no instruction beside it is a square nobody points a phone at.
  final String caption;

  final double size;

  /// How large the caption is. The default suits the code tucked under a bill;
  /// a code that has the panel to itself is read from further away and wants
  /// its instruction to scale with it.
  final double captionSize;

  @override
  Widget build(BuildContext context) {
    final image = _encode(data);
    if (image == null) return const SizedBox.shrink();

    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          padding: const EdgeInsets.all(8),
          decoration: BoxDecoration(
            // White, always, whatever the rest of this screen is doing. A QR
            // drawn light-on-dark reads on perhaps half the phones that try it,
            // and the half it fails on get no error — the camera simply sits
            // there. Not worth the styling.
            color: Colors.white,
            borderRadius: BorderRadius.circular(8),
          ),
          child: CustomPaint(
            size: Size.square(size),
            painter: _QrPainter(image),
          ),
        ),
        if (caption.trim().isNotEmpty) ...[
          const SizedBox(height: 8),
          SizedBox(
            width: size + 32,
            child: Text(
              caption.trim(),
              textAlign: TextAlign.center,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: captionSize,
                height: 1.25,
                color: Brand.inkSoft,
              ),
            ),
          ),
        ],
      ],
    );
  }

  /// Encode, or null.
  ///
  /// The error-correction level is deliberately the lowest: this is drawn on a
  /// clean backlit screen at close range, not printed on a beer mat, so the
  /// redundancy buys nothing and costs modules — and more modules on a small
  /// square is a code that scans *worse*.
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

    // Floored to a whole device pixel and the remainder used as an inset, so
    // every module is the same size. Sub-pixel module widths are what make a
    // small QR look furred and scan badly — the rounding error accumulates
    // across forty modules and the last column ends up a different width from
    // the first.
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
