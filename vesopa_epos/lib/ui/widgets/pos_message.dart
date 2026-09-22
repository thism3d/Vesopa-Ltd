import 'dart:async';

import 'package:flutter/material.dart';

import '../theme.dart';

/// Transient messages, shown in the middle of the screen.
///
/// These used to be SnackBars. On a till that was wrong twice over: the bar
/// rises from the bottom, which is exactly where PAY and the action strip live,
/// so a message sat on top of the buttons the clerk was reaching for and
/// swallowed the tap. And the default four-second dwell is far too long for a
/// counter — the clerk has already read it and moved on.
///
/// So: centre of the screen, above everything, never interactive, and gone
/// quickly. [IgnorePointer] is the important part — the overlay cannot take a
/// tap even while it is fading, so nothing is ever blocked.
enum PosMessageKind { info, success, error }

class PosMessenger {
  PosMessenger._();

  static OverlayEntry? _entry;
  static Timer? _timer;

  /// Show [text] in the centre of the screen.
  ///
  /// Errors linger slightly longer than confirmations — a clerk needs a moment
  /// to register that something did *not* happen — but both are well under the
  /// SnackBar default.
  static void show(
    BuildContext context,
    String text, {
    PosMessageKind kind = PosMessageKind.info,
    Duration? duration,
  }) {
    final overlay = Overlay.maybeOf(context, rootOverlay: true);
    if (overlay == null) return;

    // One message at a time. A second one replaces the first rather than
    // stacking, so a burst cannot bury the screen.
    _dismiss();

    final entry = OverlayEntry(
      builder: (_) => _PosMessageOverlay(text: text, kind: kind),
    );
    _entry = entry;
    overlay.insert(entry);

    _timer = Timer(
      duration ??
          (kind == PosMessageKind.error
              ? const Duration(milliseconds: 2200)
              : const Duration(milliseconds: 1500)),
      _dismiss,
    );
  }

  static void info(BuildContext context, String text) => show(context, text);

  static void success(BuildContext context, String text) =>
      show(context, text, kind: PosMessageKind.success);

  static void error(BuildContext context, String text) =>
      show(context, text, kind: PosMessageKind.error);

  /// Remove whatever is on screen. Safe to call when nothing is.
  static void _dismiss() {
    _timer?.cancel();
    _timer = null;
    _entry?.remove();
    _entry = null;
  }

  /// Tear down before the overlay itself goes away — otherwise a message still
  /// fading when the till signs out tries to remove itself from an overlay that
  /// no longer exists.
  static void clear() => _dismiss();
}

class _PosMessageOverlay extends StatefulWidget {
  const _PosMessageOverlay({required this.text, required this.kind});

  final String text;
  final PosMessageKind kind;

  @override
  State<_PosMessageOverlay> createState() => _PosMessageOverlayState();
}

class _PosMessageOverlayState extends State<_PosMessageOverlay>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 130),
  )..forward();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  (Color, Color, IconData) get _palette => switch (widget.kind) {
        PosMessageKind.success => (
            const Color(0xFF15361B),
            Pos.brand,
            Icons.check_circle,
          ),
        PosMessageKind.error => (
            const Color(0xFF3A1215),
            const Color(0xFFFF6B70),
            Icons.error_outline,
          ),
        PosMessageKind.info => (
            const Color(0xFF1C1C21),
            Colors.white,
            Icons.info_outline,
          ),
      };

  @override
  Widget build(BuildContext context) {
    final (background, accent, icon) = _palette;

    return IgnorePointer(
      child: Center(
        child: FadeTransition(
          opacity: _controller,
          child: ScaleTransition(
            scale: Tween<double>(begin: 0.94, end: 1).animate(
              CurvedAnimation(parent: _controller, curve: Curves.easeOutBack),
            ),
            child: Material(
              color: Colors.transparent,
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 460),
                child: Container(
                  margin: const EdgeInsets.symmetric(horizontal: 24),
                  padding: const EdgeInsets.symmetric(
                    horizontal: 24,
                    vertical: 18,
                  ),
                  decoration: BoxDecoration(
                    color: background,
                    borderRadius: BorderRadius.circular(14),
                    border: Border.all(color: accent.withValues(alpha: 0.45)),
                    boxShadow: const [
                      BoxShadow(
                        color: Color(0x66000000),
                        blurRadius: 28,
                        offset: Offset(0, 8),
                      ),
                    ],
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(icon, color: accent, size: 24),
                      const SizedBox(width: 14),
                      Flexible(
                        child: Text(
                          widget.text,
                          textAlign: TextAlign.left,
                          style: const TextStyle(
                            color: Colors.white,
                            fontSize: 16,
                            fontWeight: FontWeight.w600,
                            height: 1.3,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
