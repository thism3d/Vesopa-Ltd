/// Reference QR matrices, from Dart's `qr` package.
///
/// Printed as JSON so `test/qr.test.js` can compare the JavaScript encoder in
/// `src/qr.js` against a second, independent implementation — module for
/// module, on the same inputs. Two encoders agreeing on the exact bit pattern
/// is a far stronger check than any structural assertion about finder patterns.
///
///     dart run bin/qr_reference.dart > ../../test/qr_reference.json
library;

import 'dart:convert';
import 'package:qr/qr.dart';

const _samples = [
  'https://epos.vesopa.com/wallet/c/abc',
  '999800001',
  'A',
  'https://back.vesopa.co.uk/wallet/c/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzY29wZSI6IndhbGxldCJ9.sig',
];

void main() {
  final out = <Map<String, Object?>>[];
  for (final text in _samples) {
    // Level L, matching src/qr.js. A wallet code is read off a bright screen at
    // close range, where more redundancy only costs modules.
    final code = QrCode.fromData(
      data: text,
      errorCorrectLevel: QrErrorCorrectLevel.L,
    );

    // Every mask, not just the chosen one. The two implementations each pick a
    // mask by scoring all eight, and a difference in that scoring would show up
    // as a completely different matrix -- which says nothing about whether the
    // encoding underneath is right. Comparing mask by mask separates "we encode
    // the same bits" from "we choose the same mask", and the first is the one
    // that decides whether a scanner can read it.
    List<String> rowsOf(QrImage image) => [
      for (var r = 0; r < image.moduleCount; r++)
        [
          for (var c = 0; c < image.moduleCount; c++)
            image.isDark(r, c) ? '1' : '0',
        ].join(),
    ];

    final chosen = QrImage(code);
    out.add({
      'text': text,
      'size': chosen.moduleCount,
      'rows': rowsOf(chosen),
      'chosen_mask': chosen.maskPattern,
      'masks': {
        for (var m = 0; m < 8; m++)
          '$m': rowsOf(QrImage.withMaskPattern(code, m)),
      },
    });
  }
  print(const JsonEncoder.withIndent('  ').convert(out));
}
