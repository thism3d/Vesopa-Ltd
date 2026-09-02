/// Turn the source artwork into the PNGs an Apple `.pkpass` needs.
///
///     dart pub get --offline
///     dart run bin/build.dart
///
/// Run by hand when the artwork changes. The results are committed, so the
/// server never needs an image codec at runtime — which matters, because Node
/// has none built in and none of this project's dependencies bring one.
///
/// WHY EVERY SIZE IS PRODUCED RATHER THAN ONE SCALED AT RUNTIME
///
/// iOS picks `@2x` or `@3x` by device and does not scale between them. Ship one
/// size and every phone that is not that size gets a soft image — on a card the
/// holder is looking at from six inches away, which is exactly where softness
/// shows.
///
/// WHY THE STRIPS ARE CROPPED RATHER THAN SQUASHED
///
/// The generated art is 21:9 (2.33:1) and Apple's strip is 375x98 (3.83:1).
/// Fitting one to the other by scaling both axes independently would stretch
/// the artwork; taking the centre band keeps it. See [_coverCrop].
library;

import 'dart:io';

import 'package:image/image.dart' as img;

/// Where the generated art comes from and the PNGs go. Both relative to the
/// server root, two levels up from this package.
const _assets = '../../assets/wallet';

/// Apple's strip, at each scale. 375x98 is the reference; the multiples are
/// what iOS actually asks for.
///
/// 98pt, not 123. An `eventTicket` strip is 98pt tall and a `storeCard` one is
/// 144 — these were rendered at 123 for the old style, and all five passes moved
/// to `eventTicket` to get `groupingIdentifier` (see PASS_TYPES in
/// src/wallet_google.js). A strip that is too tall is not rejected; iOS crops it
/// to fit, off centre, which is a card that looks subtly wrong on a phone and
/// perfectly fine everywhere it is checked.
const _stripSizes = {'': (375, 98), '@2x': (750, 196), '@3x': (1125, 294)};

/// Apple's icon. Required — an archive without one is rejected outright, with
/// no message naming the file.
const _iconSizes = {'': 29, '@2x': 58, '@3x': 87};

/// Apple's logo, as a maximum. The mark keeps its own proportions inside this
/// box rather than being fitted to it.
///
/// 22pt, not 50. At 50 the wordmark filled all 160pt of Apple's logo box, so
/// every card — whoever issued it — read as an advertisement for Vesopa rather
/// than as the venue's own card. The chevron at 22pt sits beside the venue's
/// name instead of instead of it. See [_logo] for which source that is.
const _logoHeights = {'': 22, '@2x': 44, '@3x': 66};

const _kinds = ['loyalty', 'customer', 'giftcard', 'staff', 'promo'];

void main(List<String> args) {
  final root = Directory(_assets);
  if (!root.existsSync()) {
    stderr.writeln('No $_assets folder. Run this from tools/wallet_art.');
    exit(1);
  }

  for (final kind in _kinds) {
    final source = _find('$_assets/strip_$kind');
    if (source == null) {
      stderr.writeln('! no source artwork for $kind, skipping');
      continue;
    }

    final decoded = img.decodeImage(source.readAsBytesSync());
    if (decoded == null) {
      stderr.writeln('! could not read ${source.path}');
      continue;
    }

    for (final entry in _stripSizes.entries) {
      final (width, height) = entry.value;
      final out = '$_assets/strip_$kind${entry.key}.png';
      File(out).writeAsBytesSync(
        img.encodePng(_coverCrop(decoded, width, height), level: 9),
      );
      stdout.writeln('strip_$kind${entry.key}.png  ${width}x$height');
    }
  }

  _icon();
  _logo();
  stdout.writeln('\nDone. The .jpg sources can stay; the server reads the PNGs.');
}

/// The largest centre crop of [src] with the target aspect, scaled to fit.
///
/// "Cover", the way CSS means it: fill the box, lose what does not fit, never
/// distort. The centre is taken rather than the top because these images are
/// composed around a diagonal sweep through the middle.
img.Image _coverCrop(img.Image src, int width, int height) {
  final targetRatio = width / height;
  final sourceRatio = src.width / src.height;

  final int cropW;
  final int cropH;
  if (sourceRatio > targetRatio) {
    // Source is wider: keep full height, trim the sides.
    cropH = src.height;
    cropW = (src.height * targetRatio).round();
  } else {
    cropW = src.width;
    cropH = (src.width / targetRatio).round();
  }

  final cropped = img.copyCrop(
    src,
    x: ((src.width - cropW) / 2).round(),
    y: ((src.height - cropH) / 2).round(),
    width: cropW,
    height: cropH,
  );

  return img.copyResize(
    cropped,
    width: width,
    height: height,
    interpolation: img.Interpolation.cubic,
  );
}

/// The app mark, square, from the display's own brand folder.
void _icon() {
  final source = _find('../../../vesopa_epos_display/assets/brand/512x512');
  if (source == null) {
    stderr.writeln('! no 512x512 brand mark found; icons not written');
    return;
  }
  final decoded = img.decodeImage(source.readAsBytesSync());
  if (decoded == null) return;

  for (final entry in _iconSizes.entries) {
    final size = entry.value;
    File('$_assets/icon${entry.key}.png').writeAsBytesSync(
      img.encodePng(
        img.copyResize(
          decoded,
          width: size,
          height: size,
          interpolation: img.Interpolation.cubic,
        ),
        level: 9,
      ),
    );
    stdout.writeln('icon${entry.key}.png  ${size}x$size');
  }
}

/// The chevron, on dark — a small mark beside the venue's name.
///
/// NOT the wordmark any more. `vesopa_logo_on_dark` is 160x43 of lettering, and
/// at the old 50pt box it filled Apple's logo slot completely: the top-left of
/// every card, whoever issued it, said VESOPA in full. A customer's loyalty card
/// belongs to the pub, not to the company that sells the pub its till.
///
/// So the source is `mark` — the `v` chevron cropped out of that wordmark, with
/// transparency around it — and it is drawn at 22pt beside the venue's name,
/// which `logoText` now carries (see buildPassJson in src/wallet_apple.js).
///
/// Falls back to the wordmark if no chevron has been cropped, because a card
/// with a slightly overbearing logo still works and a card with none looks
/// broken.
///
/// Trimmed first: the source has transparent margin around it, and Apple gives
/// the logo a fixed box, so untrimmed padding shows up as a mark that looks too
/// small and off-centre.
void _logo() {
  final source = _find('$_assets/mark') ??
      _find('../../../vesopa_epos_display/assets/brand/vesopa_logo_on_dark');
  if (source == null) {
    stderr.writeln('! no mark or wordmark found; logos not written');
    return;
  }
  var decoded = img.decodeImage(source.readAsBytesSync());
  if (decoded == null) return;

  decoded = img.trim(decoded, mode: img.TrimMode.transparent);

  for (final entry in _logoHeights.entries) {
    // Apple's box is 160x50 points. A wide wordmark hits the width first, so
    // it is constrained by whichever edge it reaches — the same rule iOS
    // applies when it fits the image, done here so the shipped asset is the
    // size it will be drawn at rather than something to be scaled again.
    final maxHeight = entry.value;
    final maxWidth = (maxHeight * 160 / 50).round();

    var height = maxHeight;
    var width = (decoded.width * height / decoded.height).round();
    if (width > maxWidth) {
      width = maxWidth;
      height = (decoded.height * width / decoded.width).round();
    }
    File('$_assets/logo${entry.key}.png').writeAsBytesSync(
      img.encodePng(
        img.copyResize(
          decoded,
          width: width,
          height: height,
          interpolation: img.Interpolation.cubic,
        ),
        level: 9,
      ),
    );
    stdout.writeln('logo${entry.key}.png  ${width}x$height');
  }
}

/// The first of the extensions that actually exists.
///
/// The generator returns JPEG as readily as PNG — the file name it was asked
/// for is not the format it produced — so both are looked for rather than
/// assumed.
File? _find(String stem) {
  for (final ext in ['.png', '.jpg', '.jpeg']) {
    final file = File('$stem$ext');
    if (file.existsSync()) return file;
  }
  return null;
}
