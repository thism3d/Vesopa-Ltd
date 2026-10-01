import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';

/// How much of a golden may differ before it fails: 1.5% of its pixels.
///
/// The goldens in test/goldens were made on a Mac. Linux and Windows smooth the
/// edges of text and rounded corners slightly differently, so the same correct
/// screen came out 0.98% (programmed grid) and 0.51% (functions page)
/// different there, all of it anti-aliasing along letters and borders. A
/// real change is far bigger: one key losing its colour is about 4% of the
/// programmed grid, a key moving or going missing more than that.
const double goldenTolerance = 0.015;

/// Runs before every test file in this folder (Flutter's test config hook).
Future<void> testExecutable(FutureOr<void> Function() testMain) async {
  final current = goldenFileComparator;
  if (current is LocalFileComparator) {
    goldenFileComparator = TolerantGoldenComparator(
      current.basedir.resolve('golden_test.dart'),
    );
  }
  await testMain();
}

/// A [LocalFileComparator] that passes a golden within [goldenTolerance], and
/// otherwise fails with the usual diff images in test/failures.
class TolerantGoldenComparator extends LocalFileComparator {
  TolerantGoldenComparator(super.testFile, {this.tolerance = goldenTolerance});

  final double tolerance;

  @override
  Future<bool> compare(Uint8List imageBytes, Uri golden) async {
    final result = await GoldenFileComparator.compareLists(
      imageBytes,
      await getGoldenBytes(golden),
    );
    if (result.passed || result.diffPercent <= tolerance) {
      result.dispose();
      return true;
    }
    final error = await generateFailureOutput(result, golden, basedir);
    result.dispose();
    throw FlutterError(error);
  }
}
