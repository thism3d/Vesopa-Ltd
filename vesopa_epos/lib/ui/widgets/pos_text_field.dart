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
    _hide();
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
      builder: (context) => Positioned(
        left: 0,
        right: 0,
        bottom: 0,
        child: Material(
          elevation: 12,
          child: SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(10, 8, 10, 10),
              child: OnScreenKeyboard(
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
          ),
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
      padding: EdgeInsets.only(bottom: _entry == null ? 0 : _boardHeight),
      child: field,
    );
  }

  /// Roughly what the board occupies. Deliberately an estimate: the exact
  /// height depends on the width it is given, and a field that had to measure
  /// the overlay before it could lay itself out would need a frame in between —
  /// which is a visible jump under a finger that is already moving.
  static const _boardHeight = 300.0;
}
