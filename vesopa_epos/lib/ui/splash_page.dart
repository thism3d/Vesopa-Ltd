import 'dart:async';

import 'package:flutter/material.dart';

import 'theme.dart';

/// The Vesopa splash: the wordmark resolving on black, with a lime sweep.
///
/// Drawn rather than played. The old splash decoded a bundled brand video,
/// which cost ~2.6MB, could fail on a codec-poor Windows till, and — the reason
/// it went — carried the retired identity. This animates the shipped logo, so
/// it can never disagree with the brand, and it cannot fail to decode.
///
/// It is still a flourish, not a gate: [onDone] fires on a failsafe timer
/// regardless of the animation, because a till that will not open because of an
/// intro is worse than no intro at all.
class SplashPage extends StatefulWidget {
  const SplashPage({super.key, required this.onDone});

  final VoidCallback onDone;

  @override
  State<SplashPage> createState() => _SplashPageState();
}

class _SplashPageState extends State<SplashPage>
    with SingleTickerProviderStateMixin {
  static const _duration = Duration(milliseconds: 1500);

  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: _duration,
  );

  bool _finished = false;
  Timer? _failsafe;

  @override
  void initState() {
    super.initState();
    // Whatever the animation does, the till opens.
    _failsafe = Timer(_duration + const Duration(milliseconds: 250), _finish);
    _controller.forward();
  }

  void _finish() {
    if (_finished) return;
    _finished = true;
    _failsafe?.cancel();
    widget.onDone();
  }

  @override
  void dispose() {
    _failsafe?.cancel();
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // The mark is drawn on black in the brand book, so the backdrop is a true
    // black rather than the chrome neutral.
    return Scaffold(
      backgroundColor: Colors.black,
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 420),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 40),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                FadeTransition(
                  opacity: CurvedAnimation(
                    parent: _controller,
                    curve: const Interval(0, 0.55, curve: Curves.easeOut),
                  ),
                  child: ScaleTransition(
                    scale: Tween<double>(begin: 0.94, end: 1).animate(
                      CurvedAnimation(
                        parent: _controller,
                        curve: const Interval(0, 0.7, curve: Curves.easeOutCubic),
                      ),
                    ),
                    child: Image.asset(
                      'assets/brand/vesopa_logo_on_dark.png',
                      fit: BoxFit.contain,
                      // A missing asset must not black-hole the splash.
                      errorBuilder: (_, _, _) => const SizedBox.shrink(),
                    ),
                  ),
                ),
                const SizedBox(height: 26),
                // The lime sweep, echoing the tail on the V.
                ClipRRect(
                  borderRadius: BorderRadius.circular(2),
                  child: SizedBox(
                    height: 3,
                    child: AnimatedBuilder(
                      animation: _controller,
                      builder: (context, _) {
                        final t = Curves.easeInOut.transform(
                          Interval(0.25, 1).transform(_controller.value),
                        );
                        return Align(
                          alignment: Alignment.centerLeft,
                          child: FractionallySizedBox(
                            widthFactor: t,
                            child: Container(color: Pos.brand),
                          ),
                        );
                      },
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
