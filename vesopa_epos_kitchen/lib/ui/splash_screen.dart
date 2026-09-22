import 'dart:async';

import 'package:flutter/material.dart';

import '../config/constants.dart';
import '../data/kitchen_branding.dart';
import 'theme.dart';
import 'widgets/brand_mark.dart';

/// The start screen.
///
/// A venue's own mark, its own name, its own colours — the white label. Shown
/// once, while the app starts, and then gone.
///
/// **It never delays an order.** The board is fetched behind it: the session is
/// read off disk, the token goes onto the client and the first poll goes out
/// while this is still animating, so what the hold costs is the moment the
/// board is *looked at*, not the moment it arrives. That is the whole reason
/// this is a layer over the app rather than a page in front of it — gating the
/// widget tree behind a timer would cost a kitchen two seconds of not seeing
/// its orders on every restart, which is exactly what the note in `main.dart`
/// was written to prevent.
///
/// It is also skippable. One tap anywhere clears it, because a chef who has
/// restarted a screen mid-service wants the board and not the branding, and
/// making them sit through an animation they have seen four hundred times is
/// the software being pleased with itself.
class SplashScreen extends StatefulWidget {
  const SplashScreen({
    super.key,
    required this.branding,
    required this.onDone,
  });

  final KitchenBranding branding;

  /// Called once, when the splash has finished or been tapped away.
  final VoidCallback onDone;

  @override
  State<SplashScreen> createState() => _SplashScreenState();
}

class _SplashScreenState extends State<SplashScreen>
    with SingleTickerProviderStateMixin {
  /// The whole sequence on one controller.
  ///
  /// One, and not four staggered ones, so the timings below read as a
  /// storyboard rather than being scattered across four `Future.delayed` calls
  /// that drift apart on a slow frame.
  late final AnimationController _run = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1250),
  );

  Timer? _hold;
  bool _finished = false;

  // The storyboard, as fractions of the run.
  late final _markIn = CurvedAnimation(
    parent: _run,
    curve: const Interval(0.00, 0.45, curve: Curves.easeOutBack),
  );
  late final _markFade = CurvedAnimation(
    parent: _run,
    curve: const Interval(0.00, 0.30, curve: Curves.easeOut),
  );
  late final _nameIn = CurvedAnimation(
    parent: _run,
    curve: const Interval(0.28, 0.62, curve: Curves.easeOutCubic),
  );
  late final _taglineIn = CurvedAnimation(
    parent: _run,
    curve: const Interval(0.42, 0.76, curve: Curves.easeOut),
  );
  late final _sweep = CurvedAnimation(
    parent: _run,
    curve: const Interval(0.52, 1.00, curve: Curves.easeInOutCubic),
  );

  @override
  void initState() {
    super.initState();
    _run.forward().whenComplete(() {
      if (!mounted) return;
      // The hold is *after* the animation rather than part of it, so a venue
      // that sets it to zero still sees the piece play instead of one frame
      // of it.
      _hold = Timer(widget.branding.splashHold, _finish);
    });
  }

  @override
  void dispose() {
    _hold?.cancel();
    _run.dispose();
    super.dispose();
  }

  /// Idempotent: the tap and the timer both land here, and on a slow frame
  /// they can land in either order.
  void _finish() {
    if (_finished) return;
    _finished = true;
    widget.onDone();
  }

  @override
  Widget build(BuildContext context) {
    final branding = widget.branding;
    final background = branding.background ?? Kds.chromeHeader;
    final accent = branding.accent ?? Kds.brand;
    final ink = Kds.inkOn(background);
    final mutedInk = Kds.mutedInkOn(background);

    return GestureDetector(
      onTap: _finish,
      // Opaque, or a tap falls through to whatever is behind the splash — which
      // is the board, where a stray tap bumps an order.
      behavior: HitTestBehavior.opaque,
      child: Material(
        color: background,
        child: Stack(
          children: [
            Center(
              child: AnimatedBuilder(
                animation: _run,
                builder: (context, _) => Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Opacity(
                      opacity: _markFade.value,
                      child: Transform.scale(
                        scale: 0.82 + (0.18 * _markIn.value),
                        child: _Mark(branding: branding),
                      ),
                    ),
                    const SizedBox(height: 26),

                    // Name and tagline rise a little as they fade in. Sixteen
                    // pixels, not forty: this is read at two metres, and a long
                    // travel reads as a screen still loading.
                    Opacity(
                      opacity: _nameIn.value,
                      child: Transform.translate(
                        offset: Offset(0, 16 * (1 - _nameIn.value)),
                        child: Text(
                          branding.displayName,
                          textAlign: TextAlign.center,
                          style: TextStyle(
                            color: ink,
                            fontSize: 40,
                            fontWeight: FontWeight.w700,
                            letterSpacing: 0.3,
                            height: 1.1,
                          ),
                        ),
                      ),
                    ),

                    if (branding.tagline.isNotEmpty) ...[
                      const SizedBox(height: 10),
                      Opacity(
                        opacity: _taglineIn.value,
                        child: Text(
                          branding.tagline,
                          textAlign: TextAlign.center,
                          style: TextStyle(
                            color: mutedInk,
                            fontSize: 17,
                            letterSpacing: 0.2,
                          ),
                        ),
                      ),
                    ],

                    const SizedBox(height: 30),

                    // The accent's one job: a rule that draws itself out from
                    // the centre. It is the only motion after the name lands,
                    // so it reads as "still working" without a spinner — which
                    // on a brand screen looks like a fault.
                    Container(
                      height: 4,
                      width: 180 * _sweep.value,
                      decoration: BoxDecoration(
                        color: accent,
                        borderRadius: BorderRadius.circular(2),
                      ),
                    ),
                  ],
                ),
              ),
            ),

            if (branding.showPoweredBy)
              Positioned(
                left: 0,
                right: 0,
                bottom: 26,
                child: AnimatedBuilder(
                  animation: _taglineIn,
                  builder: (context, child) =>
                      Opacity(opacity: 0.55 * _taglineIn.value, child: child),
                  child: Text(
                    'POWERED BY VESOPA',
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      color: mutedInk,
                      fontSize: 11.5,
                      letterSpacing: 2.4,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// The venue's logo, or the built-in mark.
///
/// A network image is the one thing on this screen that can fail, and it fails
/// on exactly the machine least able to cope with it: a wall panel that has
/// just booted, possibly before the venue's wifi. So it degrades twice — to the
/// bundled Vesopa Kitchen mark, and then, inside [BrandMark], to a square drawn
/// in code. A start screen must never show a broken-image glyph.
class _Mark extends StatelessWidget {
  const _Mark({required this.branding});

  final KitchenBranding branding;

  static const _size = 132.0;

  @override
  Widget build(BuildContext context) {
    final url = branding.logoFor(Api.resolvedBase);
    if (url == null) return const BrandMark(size: _size);

    return Image.network(
      url,
      width: _size,
      height: _size,
      fit: BoxFit.contain,
      filterQuality: FilterQuality.medium,
      errorBuilder: (_, _, _) => const BrandMark(size: _size),
      // No progress indicator: the frame it would occupy is shorter than the
      // fade it would appear during, so it could only ever be a flicker.
      frameBuilder: (_, child, frame, wasSynchronous) =>
          wasSynchronous || frame != null
          ? child
          : const SizedBox(width: _size, height: _size),
    );
  }
}
