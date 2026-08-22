import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme.dart';

/// A keyboard drawn on the till.
///
/// A till is a touch screen on a counter. Some have a keyboard behind them and
/// most do not, and every field that asks for words — a void reason, a note on
/// a line, a customer's name — is unusable on the ones that do not. This is the
/// answer to that, and it is deliberately one widget rather than a per-dialog
/// arrangement: the next field somebody adds should get a keyboard by writing
/// one line, not by rediscovering this problem.
///
/// **Mounted by the field that needs it, never installed globally.** Flutter
/// will happily provide a custom input method for every field in the app, and
/// that is the wrong shape on a till: a keyboard that *can* appear over the
/// sale grid is a keyboard that *will* appear over it, mid-queue, because
/// somebody's sleeve brushed a line. It appears where it is asked for.
///
/// The layout arithmetic is lifted from the kitchen screen's keyboard, where it
/// was worked out the hard way: keys are a multiple of a unit divided out of
/// the width actually available, rather than fixed pixel sizes. Fixed sizes
/// overflow the moment the keyboard is narrower than they happen to add up to,
/// and a till is whatever panel the venue had on the shelf.
enum PosKeyboardMode {
  /// Full QWERTY, with a symbols layer behind `123`.
  text,

  /// Digits only — covers, quantities, table numbers.
  number,

  /// Digits and a decimal point, for a typed price.
  decimal,
}

class OnScreenKeyboard extends StatefulWidget {
  const OnScreenKeyboard({
    super.key,
    required this.controller,
    this.onSubmit,
    this.submitLabel = 'Done',
    this.mode = PosKeyboardMode.text,
  });

  final TextEditingController controller;

  /// The green key. Null leaves it disabled, for a field with nothing to submit
  /// to yet — which is how a dialog greys it out while the field is empty.
  final VoidCallback? onSubmit;

  final String submitLabel;

  final PosKeyboardMode mode;

  bool get _isNumeric => mode != PosKeyboardMode.text;

  @override
  State<OnScreenKeyboard> createState() => _OnScreenKeyboardState();
}

class _OnScreenKeyboardState extends State<OnScreenKeyboard> {
  /// Follow the field this keyboard is typing into.
  ///
  /// Needed because a key can be disabled by what has already been typed — the
  /// decimal point, once there is one. Without this the keyboard is built once
  /// and the point stays live for ever, which is how "12.3.7" gets into a
  /// price. It also keeps a key's greyed-out state honest, which is the whole
  /// reason for disabling it rather than silently swallowing the tap.
  @override
  void initState() {
    super.initState();
    if (widget._isNumeric) widget.controller.addListener(_onTextChanged);
  }

  @override
  void didUpdateWidget(OnScreenKeyboard old) {
    super.didUpdateWidget(old);
    if (old.controller != widget.controller) {
      old.controller.removeListener(_onTextChanged);
      if (widget._isNumeric) widget.controller.addListener(_onTextChanged);
    }
  }

  @override
  void dispose() {
    widget.controller.removeListener(_onTextChanged);
    super.dispose();
  }

  void _onTextChanged() {
    if (mounted) setState(() {});
  }

  /// Shift is one-shot — it applies to the next character and then releases,
  /// which is what somebody typing a name means by it. Caps lock is the double
  /// tap, and is what somebody typing a venue name means.
  bool _shift = false;
  bool _capsLock = false;

  /// The digits-and-symbols layer.
  bool _symbols = false;

  static const _row1 = 'qwertyuiop';
  static const _row2 = 'asdfghjkl';
  static const _row3 = 'zxcvbnm';

  /// `@ . -` sit on the letter layer's bottom row as well as the symbol layer,
  /// because the fields this is used for are full of them — an email address, a
  /// hyphenated surname — and making somebody find a layer switch to type a
  /// full stop is how a note ends up unwritten.
  static const _sym1 = '1234567890';
  static const _sym2 = r'@#£_&-+()/';
  static const _sym3 = r'*"'':;!?,.';

  // The bottom row in units, and the widest row there is: it is what the unit
  // is divided out of, so it fits exactly and the letter rows sit inside it.
  static const _shiftUnits = 1.5;
  static const _layerUnits = 1.5;
  static const _spaceUnits = 3.4;
  static const _backspaceUnits = 1.5;
  static const _submitUnits = 2.0;
  static const _bottomUnits =
      _shiftUnits + _layerUnits + 3 + _spaceUnits + _backspaceUnits + _submitUnits;

  /// How many keys the bottom row has, for the gap arithmetic below.
  static const _bottomKeys = 8;

  /// The gap either side of every key, so a row's true width is
  /// `unit * units + gap * keys` rather than just the first half of that.
  /// Leaving it out of the sum is the classic version of this bug: the widths
  /// add up to something that fits and the gaps around them do not.
  static const _keyGap = 6.0;

  /// The largest a key may get, so a wide till does not draw keys the size of a
  /// fist. There is deliberately no *minimum*: a floor is what turns a cramped
  /// row into an overflow, and cramped keys beat a yellow-and-black hatch.
  static const _maxUnit = 62.0;
  static const _padding = 8.0;

  /// The container's hairline. It has to be in the arithmetic below, not just
  /// in the decoration: a border is part of the box, so it takes a pixel a side
  /// out of the width the keys have to divide up. Leaving it out overflowed the
  /// bottom row by exactly 2px — the same shape of mistake as forgetting the
  /// gaps, and caught the same way.
  static const _border = 1.0;

  /// The numeric pad, laid out as a phone rather than as a calculator.
  ///
  /// Phone order, because the thing every clerk already owns is a phone and the
  /// muscle memory is worth more than any argument for the other one.
  static const _digits = [
    ['1', '2', '3'],
    ['4', '5', '6'],
    ['7', '8', '9'],
  ];

  void _tap(String character) {
    final shifted = _capsLock || _shift;
    _insert(shifted ? character.toUpperCase() : character);
    if (_shift && !_capsLock) setState(() => _shift = false);
  }

  void _insert(String text) {
    final value = widget.controller.value;
    final selection = value.selection;

    // A controller that has never been focused has an invalid selection
    // (offset -1). Appending is the right reading of a tap in that state, and
    // without this check the range replacement below throws.
    if (!selection.isValid) {
      widget.controller.text = value.text + text;
      widget.controller.selection = TextSelection.collapsed(
        offset: widget.controller.text.length,
      );
      return;
    }

    final next = value.text.replaceRange(selection.start, selection.end, text);
    widget.controller.value = TextEditingValue(
      text: next,
      selection: TextSelection.collapsed(offset: selection.start + text.length),
    );
  }

  void _backspace() {
    final value = widget.controller.value;
    final selection = value.selection;

    if (!selection.isValid || value.text.isEmpty) {
      if (value.text.isNotEmpty) {
        widget.controller.text = value.text.substring(0, value.text.length - 1);
      }
      return;
    }

    if (selection.start != selection.end) {
      _insert('');
      return;
    }
    if (selection.start == 0) return;

    widget.controller.value = TextEditingValue(
      text: value.text.replaceRange(selection.start - 1, selection.start, ''),
      selection: TextSelection.collapsed(offset: selection.start - 1),
    );
  }

  /// One decimal point, and never as the first character.
  ///
  /// Guarded here rather than left to the parser, because "12.3.7" typed into a
  /// price is a clerk who has to work out which tap went wrong. The key simply
  /// stops responding once there is a point, which is legible in a way an error
  /// afterwards is not.
  bool get _canTypeDecimalPoint => !widget.controller.text.contains('.');

  @override
  Widget build(BuildContext context) {
    final pal = PayPalette.of(context);

    return LayoutBuilder(
      builder: (context, constraints) {
        // A finite width to divide up. Unbounded happens inside a Row or a
        // horizontal scroller, where falling back to the natural size is the
        // only sensible answer.
        final available = constraints.maxWidth.isFinite
            ? constraints.maxWidth - (_padding + _border) * 2
            : _maxUnit * _bottomUnits + _keyGap * _bottomKeys;

        // The gap comes off the top: it is fixed per key and does not scale, so
        // dividing the whole width by the units alone hands back a unit that is
        // too big by exactly the gap.
        final forKeys = available - _keyGap * _bottomKeys;
        final unit = (forKeys / _bottomUnits).clamp(1.0, _maxUnit);

        // Roughly square, with a floor: a finger needs a target in the vertical
        // axis too, and it is the axis that costs least to keep.
        final keyHeight = (unit * 0.92).clamp(40.0, 64.0);

        return Container(
          padding: const EdgeInsets.all(_padding),
          decoration: BoxDecoration(
            color: pal.softFill,
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: pal.softLine),
          ),
          child: widget._isNumeric
              ? _numberPad(pal, unit, keyHeight)
              : _letterPad(pal, unit, keyHeight),
        );
      },
    );
  }

  /// The numeric pad. Wider keys than the letter layer, because there are far
  /// fewer of them and the room is there.
  Widget _numberPad(PayPalette pal, double unit, double keyHeight) {
    final wide = unit * 2.2;
    final tall = keyHeight * 1.15;

    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (final row in _digits)
          Padding(
            padding: const EdgeInsets.only(bottom: 6),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                for (final digit in row)
                  _Key(
                    pal: pal,
                    label: digit,
                    width: wide,
                    height: tall,
                    onTap: () => _insert(digit),
                  ),
              ],
            ),
          ),
        Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            if (widget.mode == PosKeyboardMode.decimal)
              _Key(
                pal: pal,
                label: '.',
                width: wide,
                height: tall,
                onTap: _canTypeDecimalPoint ? () => _insert('.') : null,
              )
            else
              _Key(
                pal: pal,
                icon: Icons.backspace_outlined,
                width: wide,
                height: tall,
                onTap: _backspace,
              ),
            _Key(
              pal: pal,
              label: '0',
              width: wide,
              height: tall,
              onTap: () => _insert('0'),
            ),
            if (widget.mode == PosKeyboardMode.decimal)
              _Key(
                pal: pal,
                icon: Icons.backspace_outlined,
                width: wide,
                height: tall,
                onTap: _backspace,
              )
            else
              _Key(
                pal: pal,
                label: widget.submitLabel,
                width: wide,
                height: tall,
                filled: true,
                onTap: widget.onSubmit,
              ),
          ],
        ),
        if (widget.mode == PosKeyboardMode.decimal) ...[
          const SizedBox(height: 6),
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              _Key(
                pal: pal,
                label: widget.submitLabel,
                width: wide * 3 + _keyGap * 2,
                height: tall,
                filled: true,
                onTap: widget.onSubmit,
              ),
            ],
          ),
        ],
      ],
    );
  }

  Widget _letterPad(PayPalette pal, double unit, double keyHeight) {
    final rows = _symbols
        ? const [_sym1, _sym2, _sym3]
        : const [_row1, _row2, _row3];

    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (final row in rows)
          Padding(
            padding: const EdgeInsets.only(bottom: 6),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                for (final character in row.split(''))
                  _Key(
                    pal: pal,
                    label: _capsLock || _shift
                        ? character.toUpperCase()
                        : character,
                    width: unit,
                    height: keyHeight,
                    onTap: () => _tap(character),
                  ),
              ],
            ),
          ),
        Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            if (!_symbols)
              _Key(
                pal: pal,
                // Double tap for caps lock, and it says so by staying lit.
                icon: _capsLock
                    ? Icons.keyboard_capslock
                    : Icons.arrow_upward,
                width: unit * _shiftUnits,
                height: keyHeight,
                active: _capsLock || _shift,
                onTap: () => setState(() {
                  if (_capsLock) {
                    _capsLock = false;
                    _shift = false;
                  } else if (_shift) {
                    _capsLock = true;
                  } else {
                    _shift = true;
                  }
                }),
              ),
            _Key(
              pal: pal,
              label: _symbols ? 'abc' : '123',
              width: unit * _layerUnits,
              height: keyHeight,
              onTap: () => setState(() => _symbols = !_symbols),
            ),
            if (!_symbols) ...[
              for (final punctuation in const ['@', '.', '-'])
                _Key(
                  pal: pal,
                  label: punctuation,
                  width: unit,
                  height: keyHeight,
                  onTap: () => _insert(punctuation),
                ),
            ],
            _Key(
              pal: pal,
              label: 'space',
              // The symbol layer drops the shift key and the three punctuation
              // keys, so the space bar takes the room they leave rather than
              // the row shrinking away from the edges.
              width: unit * (_symbols ? _spaceUnits + 4.4 : _spaceUnits),
              height: keyHeight,
              onTap: () => _insert(' '),
            ),
            _Key(
              pal: pal,
              icon: Icons.backspace_outlined,
              width: unit * _backspaceUnits,
              height: keyHeight,
              onTap: _backspace,
            ),
            _Key(
              pal: pal,
              label: widget.submitLabel,
              width: unit * _submitUnits,
              height: keyHeight,
              filled: true,
              onTap: widget.onSubmit,
            ),
          ],
        ),
      ],
    );
  }
}

class _Key extends StatelessWidget {
  const _Key({
    required this.pal,
    this.label,
    this.icon,
    this.onTap,
    required this.width,
    required this.height,
    this.filled = false,
    this.active = false,
  });

  final PayPalette pal;
  final String? label;
  final IconData? icon;
  final VoidCallback? onTap;

  /// Both come from the keyboard's unit. Required rather than defaulted,
  /// because a default here is a size chosen against a screen nobody is
  /// looking at.
  final double width;
  final double height;

  final bool filled;
  final bool active;

  @override
  Widget build(BuildContext context) {
    final enabled = onTap != null;
    final background = filled
        ? Pos.brand
        : active
        ? pal.accentFill
        : pal.keyFill;
    final foreground = filled ? Pos.onBrand : pal.ink;

    return Padding(
      padding: const EdgeInsets.symmetric(
        horizontal: _OnScreenKeyboardState._keyGap / 2,
      ),
      child: SizedBox(
        width: width,
        height: height,
        child: Material(
          color: enabled ? background : background.withValues(alpha: 0.45),
          borderRadius: BorderRadius.circular(9),
          child: InkWell(
            borderRadius: BorderRadius.circular(9),
            onTap: enabled
                ? () {
                    // Feedback matters more here than usual: there is no key
                    // travel and no click, so without this a clerk cannot tell
                    // a press that landed from one that did not.
                    HapticFeedback.selectionClick();
                    onTap!();
                  }
                : null,
            child: Center(
              child: icon != null
                  ? Icon(icon, size: height * 0.38, color: foreground)
                  : FittedBox(
                      // A word key — "space", "Save" — shrinks to fit a narrow
                      // keyboard rather than overflowing it. A single character
                      // never reaches this: the box is always wider than one
                      // glyph.
                      fit: BoxFit.scaleDown,
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 4),
                        child: Text(
                          label ?? '',
                          maxLines: 1,
                          style: TextStyle(
                            fontSize: (label?.length ?? 0) > 1
                                ? height * 0.27
                                : height * 0.38,
                            fontWeight: FontWeight.w600,
                            color: enabled
                                ? foreground
                                : foreground.withValues(alpha: 0.4),
                          ),
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
