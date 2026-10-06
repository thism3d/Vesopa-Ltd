import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// A venue build's opening: the crest, alive, while the app gets its venue.
///
/// ONLY IN A VENUE'S OWN BUILD. tool/make_venue_app.py bundles the crest as
/// assets/venue/crest.png and passes its colours and words as dart-defines;
/// the shared Store app and the browser have neither and open as they always
/// did. Nothing here is fetched: the point of it is to be on screen at once,
/// on a bad line, before the back office has answered.
///
/// IT PICKS UP EXACTLY WHERE THE PHONE'S OWN SPLASH LEAVES OFF. Android's
/// splash (12+ and older) and the iPhone launch screen show the crest 140
/// points tall on the venue colour; the first frame here is the same picture,
/// so the hand-over cannot be seen. Then the crest breathes, a light passes
/// over it, a ring goes out from it, and the venue's name rises beneath. When
/// the opening has played AND the venue's branding is in, the crest lifts
/// away and the app comes up from underneath.
///
/// The opening plays once, about two seconds, and never holds anybody up on
/// its own account: if the branding is slower than that, the crest keeps
/// breathing until it arrives; if it fails, the app's own "try again" shows.
class VenueIntro extends StatefulWidget {
  const VenueIntro({super.key, required this.ready, required this.child});

  /// The app underneath has something to show (branding loaded, or failed).
  final bool ready;
  final Widget child;

  static const _bg = String.fromEnvironment('VENUE_SPLASH_BG');
  static const _deep = String.fromEnvironment('VENUE_SPLASH_DEEP');
  static const _glow = String.fromEnvironment('VENUE_SPLASH_GLOW');
  static const _name = String.fromEnvironment('VENUE_NAME');
  static const _tagline = String.fromEnvironment('VENUE_TAGLINE');

  /// The crest's height on every splash. tool/make_venue_art.py SPLASH_DP.
  static const crestHeight = 140.0;
  static const crestAsset = 'assets/venue/crest.png';

  /// A venue build with an opening of its own.
  static const enabled = !kIsWeb && _bg != '';

  static var _held = false;

  /// Holds the app's first frame back until the crest is decoded (main.dart).
  static void holdFirstFrame() {
    if (_held) return;
    _held = true;
    WidgetsBinding.instance.deferFirstFrame();
  }

  static void _releaseFirstFrame() {
    if (!_held) return;
    _held = false;
    WidgetsBinding.instance.allowFirstFrame();
  }

  static Color _colour(String hex, Color fallback) {
    final v = int.tryParse(hex.replaceFirst('#', ''), radix: 16);
    return v == null ? fallback : Color(0xFF000000 | v);
  }

  @override
  State<VenueIntro> createState() => _VenueIntroState();
}

class _VenueIntroState extends State<VenueIntro> with TickerProviderStateMixin {
  late final Color _bg = VenueIntro._colour(VenueIntro._bg, const Color(0xFF8F0000));
  late final Color _deep = VenueIntro._colour(VenueIntro._deep, Color.lerp(_bg, Colors.black, 0.55)!);
  late final Color _glow = VenueIntro._colour(VenueIntro._glow, Color.lerp(_bg, Colors.white, 0.15)!);

  /// The opening itself.
  late final AnimationController _play = AnimationController(vsync: this, duration: const Duration(milliseconds: 1900));

  /// The crest breathing, for as long as the branding keeps us waiting.
  late final AnimationController _wait = AnimationController(vsync: this, duration: const Duration(milliseconds: 1400));

  /// The crest lifting away and the app coming up.
  late final AnimationController _exit = AnimationController(vsync: this, duration: const Duration(milliseconds: 650));

  var _gone = false;
  var _firstFrameAllowed = false;

  @override
  void initState() {
    super.initState();
    _play.addStatusListener((s) {
      if (s == AnimationStatus.completed) _maybeLeave();
    });
    _exit.addStatusListener((s) {
      if (s == AnimationStatus.completed && mounted) setState(() => _gone = true);
    });
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_firstFrameAllowed) return;
    _firstFrameAllowed = true;
    // main.dart held the first frame back so the crest is decoded before it
    // is drawn: a frame of bare colour between the native splash and this
    // would be the one visible seam.
    // A crest that will not load costs the picture, never the app -- and a
    // crest that is slow to decode costs at most a moment, never the opening.
    precacheImage(const AssetImage(VenueIntro.crestAsset), context, onError: (_, _) {}).whenComplete(_start);
    _startAnyway = Timer(const Duration(milliseconds: 600), _start);
  }

  Timer? _startAnyway;

  void _start() {
    _startAnyway?.cancel();
    VenueIntro._releaseFirstFrame();
    if (!mounted || _play.isAnimating || _play.isCompleted) return;
    final quiet = MediaQuery.maybeOf(context)?.disableAnimations ?? false;
    if (quiet) _play.duration = const Duration(milliseconds: 500);
    _play.forward();
  }

  @override
  void didUpdateWidget(VenueIntro old) {
    super.didUpdateWidget(old);
    if (widget.ready && !old.ready) _maybeLeave();
  }

  void _maybeLeave() {
    if (!mounted || _exit.isAnimating || _gone) return;
    if (!_play.isCompleted) return;
    if (!widget.ready) {
      if (!_wait.isAnimating) _wait.repeat(reverse: true);
      return;
    }
    _wait.stop();
    _exit.forward();
  }

  @override
  void dispose() {
    _startAnyway?.cancel();
    _play.dispose();
    _wait.dispose();
    _exit.dispose();
    super.dispose();
  }

  /// 0..1 of [t] between [from] and [to], eased.
  static double _span(double t, double from, double to, [Curve curve = Curves.easeOutCubic]) =>
      curve.transform(((t - from) / (to - from)).clamp(0.0, 1.0));

  @override
  Widget build(BuildContext context) {
    final app = AnimatedBuilder(
      animation: _exit,
      child: widget.child,
      builder: (context, child) {
        final t = Curves.easeOutCubic.transform(_exit.value);
        if (_gone) return child!;
        // Drawn but held back until the crest lifts away, then it settles up
        // into place rather than appearing.
        return Opacity(
          opacity: t,
          child: Transform.scale(scale: 0.94 + 0.06 * t, child: child),
        );
      },
    );
    if (_gone) return app;

    return Directionality(
      textDirection: TextDirection.ltr,
      child: Stack(
        fit: StackFit.expand,
        children: [
          app,
          AnnotatedRegion<SystemUiOverlayStyle>(
            value: SystemUiOverlayStyle.light.copyWith(
              statusBarColor: Colors.transparent,
              systemNavigationBarColor: _bg,
            ),
            child: AnimatedBuilder(
              animation: Listenable.merge([_play, _wait, _exit]),
              builder: (context, _) => _frame(context),
            ),
          ),
        ],
      ),
    );
  }

  Widget _frame(BuildContext context) {
    final t = _play.value;
    final out = Curves.easeInCubic.transform(_exit.value);
    final breath = math.sin(_wait.value * math.pi) * 0.025;

    // The crest: a small rise and settle, then a slow breath while waiting,
    // then up and away.
    final rise = _span(t, 0.0, 0.42, Curves.easeOutBack);
    final crestScale = 1 + 0.08 * rise + breath + 0.35 * out;
    final crestLift = -28.0 * _span(t, 0.30, 0.75) - 40 * out;

    // The light passing over the crest, left to right.
    final sheen = _span(t, 0.22, 0.70, Curves.easeInOutSine);

    // A ring going out from the crest and fading as it goes.
    final ring = _span(t, 0.12, 0.80, Curves.easeOutQuart);

    // The glow behind, and the venue's name and line rising underneath.
    final glow = _span(t, 0.0, 0.50);
    final name = _span(t, 0.35, 0.72);
    final tagline = _span(t, 0.52, 0.90);

    final size = MediaQuery.sizeOf(context);
    final ringMax = math.max(size.width, size.height) * 0.75;

    return Opacity(
      opacity: 1 - out,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: _bg,
          gradient: RadialGradient(
            center: const Alignment(0, -0.15),
            radius: 1.1,
            colors: [
              Color.lerp(_bg, _glow, glow)!,
              Color.lerp(_bg, _deep, glow)!,
            ],
          ),
        ),
        child: Stack(
          alignment: Alignment.center,
          children: [
            // The ring.
            if (ring > 0 && ring < 1)
              Transform.translate(
                offset: Offset(0, crestLift),
                child: Container(
                  width: VenueIntro.crestHeight + ringMax * ring,
                  height: VenueIntro.crestHeight + ringMax * ring,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    border: Border.all(
                      color: Colors.white.withValues(alpha: 0.35 * (1 - ring)),
                      width: 2 + 6 * (1 - ring),
                    ),
                  ),
                ),
              ),
            // The crest, with its light.
            Transform.translate(
              offset: Offset(0, crestLift),
              child: Transform.scale(
                scale: crestScale,
                child: SizedBox(
                  height: VenueIntro.crestHeight,
                  child: _Sheen(
                    progress: sheen,
                    child: Image.asset(
                      VenueIntro.crestAsset,
                      height: VenueIntro.crestHeight,
                      filterQuality: FilterQuality.medium,
                      gaplessPlayback: true,
                      errorBuilder: (_, _, _) => const SizedBox.shrink(),
                    ),
                  ),
                ),
              ),
            ),
            // The name and the line beneath it.
            Transform.translate(
              offset: Offset(0, VenueIntro.crestHeight / 2 + 48 + 18 * (1 - name) + crestLift * 0.4),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (VenueIntro._name.isNotEmpty)
                    Opacity(
                      opacity: name,
                      child: Text(
                        VenueIntro._name.toUpperCase(),
                        textAlign: TextAlign.center,
                        style: TextStyle(
                          color: Colors.white,
                          fontSize: 24,
                          fontWeight: FontWeight.w800,
                          // The letters close up as the name arrives.
                          letterSpacing: 2 + 7 * (1 - name),
                          decoration: TextDecoration.none,
                          shadows: const [Shadow(blurRadius: 12, color: Colors.black54, offset: Offset(0, 2))],
                        ),
                      ),
                    ),
                  const SizedBox(height: 10),
                  Opacity(
                    opacity: tagline,
                    child: Container(width: 42 * tagline, height: 2.5, color: Colors.white.withValues(alpha: 0.85)),
                  ),
                  const SizedBox(height: 10),
                  if (VenueIntro._tagline.isNotEmpty)
                    Opacity(
                      opacity: tagline * 0.85,
                      child: Text(
                        VenueIntro._tagline,
                        textAlign: TextAlign.center,
                        style: const TextStyle(
                          color: Colors.white,
                          fontSize: 14,
                          fontWeight: FontWeight.w500,
                          letterSpacing: 0.6,
                          decoration: TextDecoration.none,
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// A band of light drawn across [child], only where the child is opaque.
class _Sheen extends StatelessWidget {
  const _Sheen({required this.progress, required this.child});

  final double progress;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    if (progress <= 0 || progress >= 1) return child;
    return ShaderMask(
      blendMode: BlendMode.srcATop,
      shaderCallback: (rect) {
        final x = -0.6 + 2.2 * progress;
        return LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [
            Colors.white.withValues(alpha: 0),
            Colors.white.withValues(alpha: 0.55),
            Colors.white.withValues(alpha: 0),
          ],
          stops: [
            (x - 0.18).clamp(0.0, 1.0),
            x.clamp(0.0, 1.0),
            (x + 0.18).clamp(0.0, 1.0),
          ],
        ).createShader(rect);
      },
      child: child,
    );
  }
}
