// Gives the taskbar icon the breathing room every other taskbar icon has.
//
// THE FAULT
//
// `msix` builds every image in the package from one master, and it builds them
// all the same way: scale the master to fill the canvas, centre it, done. For a
// square master and a square target that is edge-to-edge, so the Vesopa mark
// arrives on the taskbar as a solid green square filling its whole cell — while
// Chrome, Explorer and everything else beside it draw a glyph with a margin
// inside theirs. The result reads as an icon that is too big and sitting badly,
// which is exactly how it was reported: "icon should be in the center … should
// match width height with others".
//
// WHY NOT JUST PAD THE MASTER
//
// Because the master is also every tile. `msix` writes
// `BackgroundColor="transparent"` into the manifest with no way to configure it,
// so a Start tile is the mark on the user's accent colour. Full bleed is right
// there — it is why the tiles were reported as fine — and padding the master
// would put a floating green square on a blue tile. The padding is wanted on
// exactly one family of assets, so it is applied to exactly that family.
//
// WHAT IT DOES
//
// Rewrites every `Square44x44Logo*.png` in a package's `Images` folder: same
// pixel dimensions, transparent canvas, the master scaled to [_markFraction] of
// it and centred. Everything else in the folder is left alone.
//
// The list of files is read from the folder rather than written down here, so
// it cannot drift from whatever `msix` decides to emit — it emits the plain
// scale-* set, the targetsize-* set, and the unplated and lightunplated
// variants of that, and the taskbar picks between them by DPI and theme.
//
//   dart run tool/pad_taskbar_icons.dart <path-to-Images-folder>

import 'dart:io';

import 'package:image/image.dart';

/// How much of the canvas the mark occupies, edge to edge.
///
/// Microsoft's own app-list and taskbar icons put the artwork in a 16px area of
/// a 24px canvas — two thirds. That is measured on a glyph with its own
/// internal whitespace; the Vesopa mark is a solid tile with none, so it is
/// given slightly more of the box, or it reads as smaller than its neighbours
/// instead of larger. 0.78 lines its edges up with the icons either side of it.
const _markFraction = 0.78;

const _sourcePath = 'assets/brand/512x512.png';

/// Only this family is touched. See the note above about tiles.
const _prefix = 'Square44x44Logo';

int main(List<String> args) {
  if (args.length != 1) {
    stderr.writeln('usage: dart run tool/pad_taskbar_icons.dart <Images folder>');
    return 2;
  }

  final images = Directory(args.single);
  if (!images.existsSync()) {
    stderr.writeln('No such folder: ${images.path}');
    return 1;
  }

  final source = File(_sourcePath);
  if (!source.existsSync()) {
    stderr.writeln('Source not found: $_sourcePath');
    stderr.writeln('Run this from the vesopa_epos project root.');
    return 1;
  }

  final master = decodePng(source.readAsBytesSync());
  if (master == null) {
    stderr.writeln('Could not decode $_sourcePath as PNG.');
    return 1;
  }

  final targets = images
      .listSync()
      .whereType<File>()
      .where((f) {
        final name = f.uri.pathSegments.last;
        return name.startsWith(_prefix) && name.toLowerCase().endsWith('.png');
      })
      .toList()
    ..sort((a, b) => a.path.compareTo(b.path));

  if (targets.isEmpty) {
    // Loud rather than silent. A rename upstream turning this into a no-op
    // would ship the fault it exists to fix, and look like it had worked.
    stderr.writeln('No $_prefix*.png found in ${images.path}.');
    return 1;
  }

  for (final file in targets) {
    final existing = decodePng(file.readAsBytesSync());
    if (existing == null) {
      stderr.writeln('Skipped (not a PNG): ${file.path}');
      continue;
    }

    // The canvas keeps the size msix chose — the manifest and the block map
    // both care, and guessing it back from the file name would be wrong for
    // the scale-* variants, whose size is 44 times the scale rather than the
    // number in the name.
    final width = existing.width;
    final height = existing.height;
    final mark = (width < height ? width : height) * _markFraction;

    final scaled = copyResize(
      master,
      width: mark.round(),
      height: mark.round(),
      // Box-averaging beats cubic this far down: cubic rings the mark's hard
      // edges and leaves a halo at 16px.
      interpolation: Interpolation.average,
    );

    final canvas = Image(width: width, height: height, numChannels: 4);
    compositeImage(canvas, scaled, center: true, linearBlend: true);
    file.writeAsBytesSync(encodePng(canvas));
  }

  stdout.writeln(
    'Padded ${targets.length} $_prefix images to '
    '${(_markFraction * 100).round()}% in ${images.path}',
  );
  return 0;
}
