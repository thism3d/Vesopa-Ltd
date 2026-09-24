/// The PIN pad a member of staff signs on with — the one pad, everywhere.
///
/// WHY THIS IS ITS OWN FILE
///
/// There were two. The idle screen had this one: a dark console, big keys,
/// `Clear` and `Back` spelled out, dots that spring in as digits land and a
/// shake when a PIN is refused. The Sign On key had a different, smaller pad
/// with a blank key where Clear should be and a bare ⌫ beside it.
///
/// The venue asked for them to be the same, in those words: "the keypad needs
/// to be identical to the sign on pin pad on the idle screen to make it simple
/// for staff". Which is the right instinct — signing on is the single most
/// repeated act on the terminal, staff do it without looking, and two layouts
/// means the muscle memory is wrong half the time. Somebody reaching for Clear
/// and hitting nothing, twenty times a shift.
///
/// Making them *look* the same twice would have lasted until the next change to
/// one of them. So there is one pad, and both screens show it.
///
/// WHAT IT DELIBERATELY DOES NOT HAVE
///
/// No Enter key. A PIN is four digits and the fourth key is the submit, so an
/// Enter on a fixed-length PIN is a tap that never carries information. The
/// bottom row carries what a clerk actually needs after a mis-tap instead: take
/// one digit back, or clear the lot — both worded, because `CL` meant nothing to
/// anybody and a bare ⌫ next to it left the difference to guesswork.
library;

import 'dart:math' as math;
import 'dart:ui' show ImageFilter;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme.dart';

/// The whole pad: prompt, dots, message, keys, and a way out.
///
/// Draws on a dark ground and expects one behind it — the idle screen's
/// photograph, or the scrim of a dialog. That is the point of it being shared:
/// the pad a clerk types into is the same object in both places, not two that
/// were made to match on a Tuesday.
class StaffPinPad extends StatelessWidget {
  const StaffPinPad({
    super.key,
    required this.pin,
    required this.onKey,
    required this.onCancel,
    this.prompt = 'Enter your PIN',
    this.cancelLabel = 'Cancel',
    this.error,
    this.busy = false,
    this.rejections = 0,
  });

  /// How much has been typed. The digits themselves are never drawn.
  final String pin;

  /// A digit, `<` for backspace, or `CL` for clear.
  final ValueChanged<String> onKey;

  final VoidCallback onCancel;

  final String prompt;
  final String cancelLabel;

  /// Why the last attempt was refused, or null.
  final String? error;

  /// True while a PIN is being checked.
  final bool busy;

  /// Bumped on every refusal. The value is not read — a change is what shakes.
  final int rejections;

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          prompt,
          textAlign: TextAlign.center,
          style: const TextStyle(
            color: Colors.white,
            fontSize: 19,
            fontWeight: FontWeight.w700,
          ),
        ),
        const SizedBox(height: 16),
        // The dots and the message move together, because they are one answer
        // to one question: "did that PIN work?"
        _Shake(
          trigger: rejections,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              _Dots(length: pin.length, busy: busy),
              if (error != null) ...[
                const SizedBox(height: 12),
                Text(
                  error!,
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: Pos.red, fontSize: 14),
                ),
              ],
            ],
          ),
        ),
        const SizedBox(height: 20),
        _Keypad(onKey: onKey),
        const SizedBox(height: 14),
        TextButton(
          onPressed: onCancel,
          child: Text(
            cancelLabel,
            style: const TextStyle(color: Color(0xB3FFFFFF)),
          ),
        ),
      ],
    );
  }
}

/// Shakes its child once, every time [trigger] changes.
///
/// The refusal message says what went wrong, but it is small text on a screen
/// the clerk is not reading — they are looking at the keypad. The movement is
/// what carries "that was rejected" to someone whose eyes are elsewhere, and it
/// arrives before a word of the message has been read.
///
/// Horizontal only. A head-shake is the gesture for "no" almost everywhere this
/// till is sold, and a vertical shudder reads as the app struggling instead.
class _Shake extends StatefulWidget {
  const _Shake({required this.trigger, required this.child});

  /// Any value that changes when a shake is due; the value itself is not read.
  final int trigger;
  final Widget child;

  @override
  State<_Shake> createState() => _ShakeState();
}

class _ShakeState extends State<_Shake> with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 420),
  );

  @override
  void didUpdateWidget(covariant _Shake oldWidget) {
    super.didUpdateWidget(oldWidget);
    // `from: 0` rather than `forward()`, so a rejection while the last shake is
    // still running restarts it instead of being swallowed.
    if (widget.trigger != oldWidget.trigger) _controller.forward(from: 0);
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _controller,
      // Passed through rather than rebuilt: the child is the dots and the
      // message, and neither depends on where the shake currently is.
      child: widget.child,
      builder: (context, child) {
        // Three passes out and back, each smaller than the last. The decay is
        // what stops it looking like a loop that was cut off.
        final t = _controller.value;
        final offset = math.sin(t * math.pi * 6) * 9 * (1 - t);
        return Transform.translate(offset: Offset(offset, 0), child: child);
      },
    );
  }
}

/// How many digits are in, without showing what they are.
class _Dots extends StatelessWidget {
  const _Dots({required this.length, required this.busy});

  final int length;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    // Cross-faded rather than swapped, so submitting on the fourth digit is one
    // continuous move instead of the dots vanishing and a spinner appearing
    // where they were.
    return AnimatedSwitcher(
      duration: const Duration(milliseconds: 220),
      child: busy
          ? const SizedBox(
              key: ValueKey('busy'),
              height: 22,
              width: 22,
              child: CircularProgressIndicator(
                strokeWidth: 2.4,
                color: Pos.brand,
              ),
            )
          : _slots(),
    );
  }

  Widget _slots() {
    // Four slots for the common case, growing for a longer PIN so the display
    // never disagrees with what has been typed.
    final slots = length > 4 ? length : 4;
    return SizedBox(
      key: const ValueKey('dots'),
      height: 22,
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [for (var i = 0; i < slots; i++) _Dot(filled: i < length)],
      ),
    );
  }
}

/// One PIN slot, empty or filled.
///
/// The fill is the only confirmation a clerk gets that a key landed — the digit
/// itself is deliberately never shown — so it is worth animating. It springs up
/// to size rather than appearing at it, which puts the feedback in peripheral
/// vision: the eye catches movement next to the keypad without leaving the keys.
class _Dot extends StatelessWidget {
  const _Dot({required this.filled});

  final bool filled;

  @override
  Widget build(BuildContext context) {
    return AnimatedScale(
      scale: filled ? 1 : 0.7,
      // easeOutBack overshoots once and settles. Deliberately not a spring:
      // four of these in a row wobbling is a novelty the twentieth PIN of the
      // shift does not want.
      duration: const Duration(milliseconds: 260),
      curve: Curves.easeOutBack,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 180),
        width: 14,
        height: 14,
        margin: const EdgeInsets.symmetric(horizontal: 7),
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          color: filled ? Pos.brand : Colors.transparent,
          border: Border.all(
            color: filled ? Pos.brand : const Color(0x66FFFFFF),
            width: 1.6,
          ),
        ),
      ),
    );
  }
}

/// There is no Enter key — see the note at the top of the file.
class _Keypad extends StatelessWidget {
  const _Keypad({required this.onKey});

  final void Function(String key) onKey;

  @override
  Widget build(BuildContext context) {
    void press(String key) {
      // A PIN pad that gives no feedback feels broken on glass.
      HapticFeedback.selectionClick();
      onKey(key);
    }

    // The pad sits on its own surface, not on the venue's picture.
    //
    // Transparent keys were tried twice and lost twice, and the second failure
    // is the instructive one: over a high-contrast backdrop — a gold wordmark
    // across the middle of the screen — a 35% scrim and a blur still left the
    // digits fighting the letters underneath, and "5" and "0" were close to
    // unreadable. Alpha cannot win that, because the thing behind is not a
    // texture the blur can flatten; it is type with the same tonal weight as
    // the digits.
    //
    // So the picture stops at the pad rather than being dimmed everywhere. The
    // console is opaque, which is the only setting that holds against *any*
    // image the venue might choose, and it covers a small enough area that the
    // backdrop is still plainly theirs around it. The blur stays underneath so
    // the edge reads as glass over the picture rather than as a panel dropped
    // on top of it.
    return ClipRRect(
      borderRadius: BorderRadius.circular(20),
      child: BackdropFilter(
        filter: ImageFilter.blur(sigmaX: 24, sigmaY: 24),
        child: Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(20),
            color: _consoleFace,
            border: Border.all(color: _consoleEdge),
          ),
          child: _grid(press),
        ),
      ),
    );
  }

  /// The console's own face. Near-opaque on purpose — see [build].
  static const _consoleFace = Color(0xF01B2026);
  static const _consoleEdge = Color(0x2EFFFFFF);

  Widget _grid(void Function(String key) press) {
    return GridView.count(
      crossAxisCount: 3,
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      mainAxisSpacing: 10,
      crossAxisSpacing: 10,
      childAspectRatio: 1.5,
      children: [
        for (final key in const ['1', '2', '3', '4', '5', '6', '7', '8', '9'])
          _PadKey(label: key, onTap: () => press(key)),
        _PadKey(label: 'Clear', icon: Icons.close, onTap: () => press('CL')),
        _PadKey(label: '0', onTap: () => press('0')),
        _PadKey(
          label: 'Back',
          icon: Icons.backspace_outlined,
          onTap: () => press('<'),
        ),
      ],
    );
  }
}

class _PadKey extends StatefulWidget {
  const _PadKey({required this.label, required this.onTap, this.icon});

  final String label;
  final VoidCallback onTap;

  /// Set on Clear and Back. Both carry an icon *and* the word, so neither has to
  /// be recognised from a glyph on a busy counter.
  final IconData? icon;

  /// How solid a key face is.
  ///
  /// These are composited over the pad's own opaque console rather than over
  /// the venue's picture, which is what makes them safe to state as fixed
  /// numbers: the surface behind a key is #1B2026 whatever the backdrop is,
  /// instead of being whatever pixel of a photograph happened to land there.
  /// Against that console:
  ///
  ///   * digits, white on #3C4148 — 8.9:1
  ///   * action label, white on #2F343A — 11.2:1
  ///
  /// Both clear 4.5:1 comfortably, and they stay there when the venue changes
  /// the picture, because the picture no longer reaches the key.
  static const _digitFace = Color(0x24FFFFFF);
  static const _actionFace = Color(0x14FFFFFF);

  /// A hairline so a key still has an edge where its face happens to land on
  /// something of nearly the same tone.
  static const _edge = Color(0x59FFFFFF);

  /// A dark halo under every glyph on the pad.
  ///
  /// The other half of holding readability while the faces are see-through.
  /// White type on a translucent key over a *white* photograph is the case that
  /// alpha cannot win — there is no tint faint enough to show the picture and
  /// solid enough to carry white text. A shadow sidesteps it: the contrast is
  /// carried by the glyph's own edge rather than by the panel behind it, so it
  /// holds over any picture at all and costs nothing in transparency.
  static const _glyphShadow = [
    Shadow(color: Color(0xB3000000), blurRadius: 5),
    Shadow(color: Color(0x66000000), blurRadius: 12),
  ];

  @override
  State<_PadKey> createState() => _PadKeyState();
}

class _PadKeyState extends State<_PadKey> {
  /// Whether a finger is currently down on this key.
  ///
  /// Drives the press effect rather than relying on the ink splash alone. A
  /// splash is a stain that spreads *after* the fact and, on a translucent key
  /// over a photograph, is close to invisible — which is the "did that press
  /// register" complaint the key faces were already raised once to answer. A
  /// key that physically dips under the finger cannot be missed, and it is
  /// there on contact rather than after it.
  bool _down = false;

  void _setDown(bool down) {
    if (_down == down) return;
    setState(() => _down = down);
  }

  @override
  Widget build(BuildContext context) {
    final isAction = widget.icon != null;

    return AnimatedScale(
      // Small on purpose. A key that visibly shrinks is a toy; 4% is felt more
      // than seen, which is what a counter wants.
      scale: _down ? 0.94 : 1,
      duration: Duration(milliseconds: _down ? 90 : 160),
      curve: _down ? Curves.easeOut : Curves.easeOutBack,
      // No blur of its own.
      //
      // Each key used to carry a BackdropFilter, because each key was a window
      // onto the venue's photograph and needed that detail flattened before a
      // digit could sit on it. The console behind the pad is opaque now, so a
      // per-key blur is a shader pass over a flat colour — twelve of them, on
      // the one screen a tired clerk taps fastest.
      child: ClipRRect(
        borderRadius: BorderRadius.circular(12),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 120),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(12),
            // The face brightens under the finger, and the edge goes brand
            // lime. Both track the press directly, so the key is lit for
            // exactly as long as it is held.
            color: _down
                ? const Color(0x66A5C715)
                : (isAction ? _PadKey._actionFace : _PadKey._digitFace),
            border: Border.all(
              color: _down ? Pos.brand : _PadKey._edge,
              width: _down ? 1.6 : 1,
            ),
          ),
          child: Material(
            color: Colors.transparent,
            child: InkWell(
              onTap: widget.onTap,
              onTapDown: (_) => _setDown(true),
              onTapUp: (_) => _setDown(false),
              // Both of these matter. A finger that slides off a key still has
              // to release it, or the key stays lit for the rest of the shift.
              onTapCancel: () => _setDown(false),
              borderRadius: BorderRadius.circular(12),
              splashColor: const Color(0x4DA5C715),
              highlightColor: Colors.transparent,
              child: Center(
                child: isAction
                    ? Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(
                            widget.icon,
                            color: Colors.white,
                            size: 20,
                            shadows: _PadKey._glyphShadow,
                          ),
                          const SizedBox(height: 2),
                          Text(
                            widget.label,
                            style: const TextStyle(
                              color: Colors.white,
                              fontSize: 12,
                              fontWeight: FontWeight.w600,
                              shadows: _PadKey._glyphShadow,
                            ),
                          ),
                        ],
                      )
                    : Text(
                        widget.label,
                        style: const TextStyle(
                          color: Colors.white,
                          fontSize: 26,
                          fontWeight: FontWeight.w700,
                          shadows: _PadKey._glyphShadow,
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
