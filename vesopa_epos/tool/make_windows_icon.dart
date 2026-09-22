// Builds windows/runner/resources/app_icon.ico as a true multi-resolution icon.
//
// Why this exists rather than leaving it to flutter_launcher_icons:
//
// That package writes the Windows icon with a single image in it, at whatever
// `icon_size` is configured — and its default is 48. So the shipped icon was
// one 48x48 frame, which Windows then had to rescale for every context it uses:
// upscaled ~5x for the 256px desktop and Alt-Tab icon (visibly soft and
// blocky), and downscaled for the 16px taskbar and title bar (mushy). That is
// the "wrong icon" you see on Windows — the artwork was right, the resolutions
// were not.
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

const _sourcePath = 'assets/brand/512x512.png';
const _outputPath = 'windows/runner/resources/app_icon.ico';

void main(List<String> args) {
  final source = File(_sourcePath);
  if (!source.existsSync()) {
    stderr.writeln('Source not found: $_sourcePath');
    stderr.writeln('Run this from the vesopa_epos project root.');
    exitCode = 1;
    return;
  }

  final master = decodePng(source.readAsBytesSync());
  if (master == null) {
    stderr.writeln('Could not decode $_sourcePath as PNG.');
    exitCode = 1;
    return;
  }

  if (master.width != master.height) {
    stderr.writeln(
      'Source is ${master.width}x${master.height}. A Windows icon must be '
      'square, or every frame comes out stretched.',
    );
    exitCode = 1;
    return;
  }

  final frames = <Image>[];
  for (final size in _sizes) {
    frames.add(
      copyResize(
        master,
        width: size,
        height: size,
        // Box-averaging beats cubic when shrinking this far: cubic rings around
        // the hard edges of the mark and leaves a halo at 16px.
        interpolation: Interpolation.average,
      ),
    );
  }

  final output = File(_outputPath);
  output.parent.createSync(recursive: true);
  output.writeAsBytesSync(IcoEncoder().encodeImages(frames));

  final kb = (output.lengthSync() / 1024).toStringAsFixed(1);
  stdout.writeln('Wrote $_outputPath');
  stdout.writeln('  source ${master.width}x${master.height} — $_sourcePath');
  stdout.writeln('  frames ${_sizes.join(', ')}');
  stdout.writeln('  size   $kb KB');
}
