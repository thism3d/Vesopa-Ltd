// Builds windows/runner/resources/app_icon.ico as a true multi-resolution icon.
//
// The same tool the till has, for the same reason — and Vesopa Kitchen needed
// it more, because it was actually shipping the broken icon.
//
// `flutter_launcher_icons` writes the Windows icon with a single image in it,
// at whatever `icon_size` is configured. This app's pubspec says 256, so the
// shipped app_icon.ico held one 256x256 frame and nothing else. Windows then
// has to rescale that for every context it uses — down to 16px for the title
// bar and the taskbar, which is where a kitchen screen actually shows it, and
// downscaling a 256px mark by sixteen is what makes an icon look mushy.
//
// There is already a good multi-frame icon in the tree at
// assets/brand/kitchen_mark.ico. It was simply not what got shipped: the
// launcher-icons step overwrites the runner's copy, and nothing put it back.
//
// A real .ico is a container. Windows picks the frame nearest the size it
// needs, so supplying purpose-built frames means no runtime rescaling at any
// of the sizes the shell actually asks for:
//
//   16, 20, 24, 32  title bar, taskbar, Explorer small/details, notification area
//   40, 48, 64      Explorer medium, desktop shortcut at 100-150% DPI
//   96, 128, 256    Explorer large/extra-large, Alt-Tab, Start, desktop at high DPI
//
// Run after any `dart run flutter_launcher_icons`, because that will overwrite
// this file with a single frame again:
//
//   dart run tool/make_windows_icon.dart

import 'dart:io';

import 'package:image/image.dart';

/// Every size the Windows shell asks for. 256 is the largest the ICO format
/// allows — its width field is a single byte, with 0 meaning 256.
const _sizes = <int>[16, 20, 24, 32, 40, 48, 64, 96, 128, 256];

/// The kitchen's own mark, not the till's. The two apps run on the same
/// counter and the whole point of the recolour (see tool/make_icons.py) is that
/// they are separable on a taskbar — which they are not if this points at the
/// Vesopa mark by mistake.
const _sourcePath = 'assets/brand/kitchen_mark.png';
const _outputPath = 'windows/runner/resources/app_icon.ico';

void main(List<String> args) {
  final source = File(_sourcePath);
  if (!source.existsSync()) {
    stderr.writeln('Source not found: $_sourcePath');
    exit(1);
  }

  final master = decodePng(source.readAsBytesSync());
  if (master == null) {
    stderr.writeln('Could not read $_sourcePath as a PNG.');
    exit(1);
  }

  if (master.width != master.height) {
    stderr.writeln(
      'Source is ${master.width}x${master.height}. A Windows icon must be '
      'square, or every frame comes out stretched.',
    );
    exit(1);
  }

  // One resample per frame from the full-resolution master, rather than a chain
  // of resizes off the previous one: resampling a resample compounds the
  // softness this file exists to remove.
  final frames = <Image>[
    for (final size in _sizes)
      copyResize(
        master,
        width: size,
        height: size,
        // Box-averaging beats cubic when shrinking this far: cubic rings around
        // the hard edges of the mark and leaves a halo at 16px. Same choice as
        // the till's copy of this tool, for the same reason.
        interpolation: Interpolation.average,
      ),
  ];

  final output = File(_outputPath);
  output.parent.createSync(recursive: true);
  output.writeAsBytesSync(IcoEncoder().encodeImages(frames));

  final kb = (output.lengthSync() / 1024).toStringAsFixed(1);
  stdout.writeln('Wrote $_outputPath');
  stdout.writeln('  source ${master.width}x${master.height} — $_sourcePath');
  stdout.writeln('  frames ${_sizes.join(', ')}');
  stdout.writeln('  size   $kb KB');
}
