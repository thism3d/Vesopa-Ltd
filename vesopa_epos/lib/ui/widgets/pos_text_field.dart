/// A text box on a till, with somewhere to type into it.
///
/// THE PROBLEM THIS EXISTS FOR
///
/// A till is a touch screen on a counter. Some have a keyboard behind them and
/// most do not. [OnScreenKeyboard] was written for exactly that and says so —
/// "the next field somebody adds should get a keyboard by writing one line" —
/// but adopting it still meant laying out a panel, wiring a controller and
/// deciding where the thing goes, and so it was done twice in the whole
/// application. Sixteen files had a text box; two of them had a keyboard.
///
/// The venue reported the consequence rather than the cause: "when any custom
/// field box is used on the till please ensure there is an on screen keyboard".
/// A member's name, a note on a line, a reason for a discount — every one of
/// them a box a finger could reach and nothing to type into it.
///
/// So this is the one line. Where a screen said `TextField(...)` it says
/// `PosTextField(...)`, and the keyboard is there.
///
/// HOW IT APPEARS
///
/// Docked along the bottom of the window in an overlay, while the field holds
/// focus, and gone the moment it does not. An overlay rather than a widget in
/// the tree because these fields live inside dialogs and bottom sheets of every
/// shape, and a keyboard laid out inside one of those is a keyboard that is
/// half off the screen on the next one.
///
/// The page is padded by the keyboard's height while it is up, so the field
/// being typed into is never underneath it — which is the failure that makes an
/// on-screen keyboard worse than none at all.
///
/// STILL NOT GLOBAL
///
/// [OnScreenKeyboard]'s own note argues against installing a custom input
/// method application-wide, and it is right: a keyboard that *can* appear over
/// the sale grid is one that *will*, mid-queue, because a sleeve brushed a
/// line. This changes nothing about that. The keyboard still appears only where
/// a field has asked for it — asking is just no longer a day's work.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'on_screen_keyboard.dart';

/// A [TextField] that brings a keyboard with it.
///
/// The parameters are the ones the till's fields actually use. Anything not
/// here is deliberate rather than missing: a screen that needs more than this
/// is doing something a counter probably should not.
class PosTextField extends StatefulWidget {
  const PosTextField({
    super.key,
    required this.controller,
    this.decoration,
    this.mode = PosKeyboardMode.text,
    this.onSubmitted,
    this.submitLabel = 'Done',
    this.autofocus = false,
    this.enabled = true,
    this.maxLines = 1,
    this.maxLength,
    this.textCapitalization = TextCapitalization.sentences,
    this.inputFormatters,
    this.style,
    this.focusNode,
    this.onChanged,
    this.keyboard = true,
  });

  final TextEditingController controller;
  final InputDecoration? decoration;

  /// Which layout to put up. Numbers for covers and quantities, decimal for a
  /// typed price, the full board for anything with words in it.
  final PosKeyboardMode mode;

  final ValueChanged<String>? onSubmitted;
  final String submitLabel;
  final bool autofocus;
  final bool enabled;
  final int maxLines;
  final int? maxLength;
  final TextCapitalization textCapitalization;
  final List<TextInputFormatter>? inputFormatters;
  final TextStyle? style;
  final FocusNode? focusNode;
  final ValueChanged<String>? onChanged;

  /// False on the handful of screens that are used with a real keyboard — the
  /// sign-in page, the settings pages an installer fills in once. Those are not
  /// counter work, and a board covering half the window while somebody types a
  /// server address helps nobody.
  final bool keyboard;

  @override
  State<PosTextField> createState() => _PosTextFieldState();
}

class _PosTextFieldState extends State<PosTextField> {
  late final FocusNode _focus = widget.focusNode ?? FocusNode();
  bool _ownsFocus = false;
  OverlayEntry? _entry;

  @override
  void initState() {
    super.initState();
    _ownsFocus = widget.focusNode == null;
    _focus.addListener(_focusChanged);
  }

  @override
  void dispose() {
    _focus.removeListener(_focusChanged);
    // Not _hide(): its setState on a state being disposed is an assertion
    // failure whenever a dialog closes with its keyboard still up.
    _entry?.remove();
    _entry = null;
    if (_ownsFocus) _focus.dispose();
    super.dispose();
  }

  void _focusChanged() {
    if (!widget.keyboard || !widget.enabled) return;
    if (_focus.hasFocus) {
      _show();
    } else {
      _hide();
    }
  }

  void _show() {
    if (_entry != null) return;
    final overlay = Overlay.maybeOf(context, rootOverlay: true);
    if (overlay == null) return;

    _entry = OverlayEntry(
      builder: (context) => _FloatingKeyboard(
        keyboard: OnScreenKeyboard(
          controller: widget.controller,
          mode: widget.mode,
          submitLabel: widget.submitLabel,
          onSubmit: () {
            widget.onSubmitted?.call(widget.controller.text);
            // Dismissed on Done, because Done is the word for "finished
            // with this box". Leaving it up after that is a board sitting
            // over the thing the clerk pressed Done to get back to.
            _focus.unfocus();
          },
        ),
      ),
    );
    overlay.insert(_entry!);
    setState(() {});
  }

  void _hide() {
    _entry?.remove();
    _entry = null;
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final field = TextField(
      controller: widget.controller,
      focusNode: _focus,
      decoration: widget.decoration,
      enabled: widget.enabled,
      autofocus: widget.autofocus,
      maxLines: widget.maxLines,
      maxLength: widget.maxLength,
      textCapitalization: widget.textCapitalization,
      inputFormatters: widget.inputFormatters,
      style: widget.style,
      onChanged: widget.onChanged,
      onSubmitted: widget.onSubmitted,
      keyboardType: switch (widget.mode) {
        PosKeyboardMode.number => TextInputType.number,
        PosKeyboardMode.decimal =>
          const TextInputType.numberWithOptions(decimal: true),
        PosKeyboardMode.text => TextInputType.text,
      },
    );

    // Room underneath, so the box being typed into is never behind the board.
    //
    // The overlay is drawn over everything and reports nothing to the tree, so
    // nothing else can make this space — `MediaQuery.viewInsets` is the
    // system keyboard's channel and stays at zero for a keyboard the
    // application drew itself.
    return AnimatedPadding(
      duration: const Duration(milliseconds: 160),
      curve: Curves.easeOut,
      // Only while it is docked along the bottom: a floating keyboard is
      // wherever the clerk put it.
      padding: EdgeInsets.only(bottom: _entry == null || KeyboardSize.place.value != null ? 0 : _boardHeight),
      child: field,
    );
  }

  /// Roughly what the board occupies. Deliberately an estimate: the exact
  /// height depends on the width it is given, and a field that had to measure
  /// the overlay before it could lay itself out would need a frame in between —
  /// which is a visible jump under a finger that is already moving.
  static const _boardHeight = 300.0;
}

/// The keyboard over the screen: docked along the bottom as it first opens,
/// or dragged anywhere by its handle and resized by its corner grip
/// (2026-10-21, Pontardawe RFC). Where it was left is kept on this till.
/// Resizing changes the keys as well as the width.
class _FloatingKeyboard extends StatefulWidget {
  const _FloatingKeyboard({required this.keyboard});

  final Widget keyboard;

  @override
  State<_FloatingKeyboard> createState() => _FloatingKeyboardState();
}

class _FloatingKeyboardState extends State<_FloatingKeyboard> {
  /// The width a keyboard is drawn at for the standard size; the grip's
  /// width over this is the scale.
  static const _standardWidth = 820.0;
  static const _minWidth = 420.0;

  @override
  void initState() {
    super.initState();
    KeyboardSize.load();
  }

  Rect _clamp(Rect r, Size screen) {
    final w = r.width.clamp(_minWidth, screen.width);
    final x = r.left.clamp(0.0, (screen.width - w).clamp(0.0, double.infinity));
    final y = r.top.clamp(0.0, (screen.height - 120).clamp(0.0, double.infinity));
    return Rect.fromLTWH(x, y, w, 0);
  }

  @override
  Widget build(BuildContext context) {
    final screen = MediaQuery.sizeOf(context);
    return ValueListenableBuilder<Rect?>(
      valueListenable: KeyboardSize.place,
      builder: (context, place, _) {
        final docked = place == null;
        final rect = docked ? null : _clamp(place, screen);
        final board = Material(
          elevation: 14,
          borderRadius: docked ? null : BorderRadius.circular(16),
          clipBehavior: Clip.antiAlias,
          child: SafeArea(
            top: false,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                _handle(context, place, screen),
                Padding(
                  padding: const EdgeInsets.fromLTRB(10, 0, 10, 10),
                  child: widget.keyboard,
                ),
              ],
            ),
          ),
        );
        // Part of the box being typed into, as far as taps go. On Windows a
        // text field lets go of its focus at any touch outside it, and the
        // board is drawn in an overlay of its own -- so the first key pressed
        // closed the keyboard before the letter landed, and nothing could be
        // typed (Nicki, Pontardawe RFC, 2026-10-26: a new member's name).
        if (docked) {
          return Positioned(left: 0, right: 0, bottom: 0, child: TextFieldTapRegion(child: board));
        }
        return Positioned(
          left: rect!.left,
          top: rect.top,
          width: rect.width,
          child: TextFieldTapRegion(child: Stack(
            children: [
              board,
              // The resize grip, bottom right.
              Positioned(
                right: 0,
                bottom: 0,
                child: GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onPanUpdate: (d) {
                    final r = KeyboardSize.place.value ?? rect;
                    final w = (r.width + d.delta.dx).clamp(_minWidth, screen.width - r.left);
                    KeyboardSize.place.value = Rect.fromLTWH(r.left, r.top, w, 0);
                    KeyboardSize.scale.value = (w / _standardWidth).clamp(KeyboardSize.minScale, KeyboardSize.maxScale);
                  },
                  onPanEnd: (_) {
                    KeyboardSize.setPlace(KeyboardSize.place.value);
                    KeyboardSize.set(KeyboardSize.scale.value);
                  },
                  child: const SizedBox(
                    width: 36,
                    height: 36,
                    child: Icon(Icons.open_in_full, size: 18),
                  ),
                ),
              ),
            ],
          )),
        );
      },
    );
  }

  /// The bar to drag the keyboard by, with Dock / Float.
  Widget _handle(BuildContext context, Rect? place, Size screen) {
    final docked = place == null;
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onPanStart: (d) {
        if (KeyboardSize.place.value == null) {
          // Lifting it off the bottom: it floats where it was, at its size.
          final w = (_standardWidth * KeyboardSize.scale.value).clamp(_minWidth, screen.width);
          KeyboardSize.place.value = _clamp(Rect.fromLTWH((screen.width - w) / 2, screen.height - 380, w, 0), screen);
        }
      },
      onPanUpdate: (d) {
        final r = KeyboardSize.place.value;
        if (r == null) return;
        KeyboardSize.place.value = _clamp(r.translate(d.delta.dx, d.delta.dy), screen);
      },
      onPanEnd: (_) => KeyboardSize.setPlace(KeyboardSize.place.value),
      child: SizedBox(
        height: 34,
        child: Row(
          children: [
            const SizedBox(width: 12),
            const Icon(Icons.drag_indicator, size: 20),
            const SizedBox(width: 6),
            Text(docked ? 'Drag to move' : 'Drag to move · corner to resize',
                style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
            const Spacer(),
            TextButton.icon(
              onPressed: () => docked
                  ? KeyboardSize.setPlace(_clamp(
                      Rect.fromLTWH(screen.width * 0.15, screen.height * 0.35, (_standardWidth * KeyboardSize.scale.value).clamp(_minWidth, screen.width * 0.7), 0),
                      screen))
                  : KeyboardSize.setPlace(null),
              icon: Icon(docked ? Icons.picture_in_picture_alt_outlined : Icons.vertical_align_bottom, size: 18),
              label: Text(docked ? 'Float' : 'Dock'),
            ),
            const SizedBox(width: 6),
          ],
        ),
      ),
    );
  }
}
