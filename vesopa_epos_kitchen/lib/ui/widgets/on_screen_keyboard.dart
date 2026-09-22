import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme.dart';

/// A keyboard drawn on the screen.
///
/// Required by the brief, and required by the situation: a kitchen screen is a
/// panel on a wall with no keyboard anywhere near it, and there are exactly two
/// places in this app that ask for text.
///
/// **Mounted by the field that needs it, not installed globally.** Flutter can
/// be given a custom input method that appears for every field in the app, and
/// that is the wrong shape here: a keyboard that *can* appear over the board is
/// a keyboard that *will* appear over the board, at the worst possible moment,
/// because somebody's sleeve brushed a card. Two fields ask for one; nothing
/// else can produce one.
class OnScreenKeyboard extends StatefulWidget {
  const OnScreenKeyboard({
    super.key,
    required this.controller,
    this.onSubmit,
    this.submitLabel = 'Done',
  });

  final TextEditingController controller;

  /// The green key. Null leaves it disabled, for a field that has nothing to
  /// submit to.
  final VoidCallback? onSubmit;

  final String submitLabel;

  @override
  State<OnScreenKeyboard> createState() => _OnScreenKeyboardState();
}

class _OnScreenKeyboardState extends State<OnScreenKeyboard> {
  /// Shift is one-shot — it applies to the next character and then releases,
  /// which is what somebody typing an email address means by it. Caps lock is
  /// the double-tap, and is what somebody typing a venue name means.
  bool _shift = false;
  bool _capsLock = false;

  /// The digits-and-symbols layer.
  bool _symbols = false;

  static const _row1 = 'qwertyuiop';
  static const _row2 = 'asdfghjkl';
  static const _row3 = 'zxcvbnm';

  /// The bottom row in units, and the widest row there is: it is what the unit
  /// is divided out of, so it fits exactly and the letter rows sit inside it.
  ///
  /// 1.5 + 1.5 + 1 + 1 + 1 + 3.4 + 1.5 + 2 = 12.9 units.
  static const _shiftUnits = 1.5;
  static const _layerUnits = 1.5;
  static const _spaceUnits = 3.4;
  static const _backspaceUnits = 1.5;
  static const _submitUnits = 2.0;
  static const _bottomUnits = _shiftUnits +
      _layerUnits +
      3 +
      _spaceUnits +
      _backspaceUnits +
      _submitUnits;

  /// How many keys the bottom row has, for the gap arithmetic below.
  static const _bottomKeys = 8;

  /// The gap either side of every key, so the row's true width is
  /// `unit * units + gap * keys` rather than just the first half of that.
  ///
  /// Leaving this out of the sum was the original bug in miniature: the fixed
  /// widths added to 768, which fitted — and the 48 pixels of gap around them
  /// did not.
  static const _keyGap = 6.0;

  /// The largest a key is allowed to get, so a 4K panel does not draw keys the
  /// size of a fist.
  ///
  /// There is deliberately no *minimum*. A floor here is what caused the
  /// overflow it was meant to prevent: below it the row simply stopped fitting
  /// and painted the hatch. Cramped keys on an unusually narrow window are
  /// awkward; a hatched keyboard is unusable, and this is the screen somebody
  /// has to get past before they can see any orders at all. The height floor
  /// below keeps the target tappable in the axis that matters most.
  static const _maxUnit = 62.0;
  static const _padding = 8.0;

  /// The symbol layer's rows.
  ///
  /// `@ . -` are on the *letter* layer's bottom row as well, because the field
  /// this keyboard exists for most is an email address, and making somebody
  /// find a layer switch to type the `@` in it is the difference between a
  /// sign-in that works and one that gets abandoned.
  static const _sym1 = '1234567890';
  static const _sym2 = r'@#£_&-+()/';
  static const _sym3 = r'*"'':;!?,.';

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
    // without this check the substring below throws.
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

  @override
  Widget build(BuildContext context) {
    final skin = Kds.of(context);
    final rows = _symbols
        ? const [_sym1, _sym2, _sym3]
        : const [_row1, _row2, _row3];

    // Every key is a multiple of one unit, and the unit is worked out from the
    // width actually available.
    //
    // The keys used to be fixed pixel widths, which overflowed the moment the
    // keyboard was narrower than those widths happened to add up to: the bottom
    // row came to 816px, and a sign-in card 804px wide put a yellow-and-black
    // hatch across it. Sizes chosen against one screen are sizes that are wrong
    // on the next one, and a kitchen buys whatever panel was on the shelf.
    //
    // The unit is divided out of the *widest* row rather than the letter row,
    // so the row that decides the fit gets it exactly and every other row is
    // narrower and centred.
    return LayoutBuilder(
      builder: (context, constraints) {
        // A finite width to divide up. Unbounded happens inside a Row or a
        // horizontal scroller, where falling back to the natural size is the
        // only sensible answer.
        final available = constraints.maxWidth.isFinite
            ? constraints.maxWidth - _padding * 2
            : _maxUnit * _bottomUnits + _keyGap * _bottomKeys;

        // The gap comes off the top: it is fixed per key and does not scale, so
        // dividing the whole width by the units would hand back a unit that is
        // too big by exactly the gap.
        final forKeys = available - _keyGap * _bottomKeys;
        final unit = (forKeys / _bottomUnits).clamp(1.0, _maxUnit);

        // Roughly square, with a floor: a finger needs a target in the vertical
        // axis too, and it is the axis that costs least to keep.
        final keyHeight = (unit * 0.92).clamp(40.0, 64.0);

        return Container(
          padding: const EdgeInsets.all(_padding),
          decoration: BoxDecoration(
            color: skin.surface,
            borderRadius: BorderRadius.circular(14),
          ),
          child: Column(
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
                    label: _symbols ? 'abc' : '123',
                    width: unit * _layerUnits,
                    height: keyHeight,
                    onTap: () => setState(() => _symbols = !_symbols),
                  ),
                  if (!_symbols) ...[
                    _Key(
                      label: '@',
                      width: unit,
                      height: keyHeight,
                      onTap: () => _insert('@'),
                    ),
                    _Key(
                      label: '.',
                      width: unit,
                      height: keyHeight,
                      onTap: () => _insert('.'),
                    ),
                    _Key(
                      label: '-',
                      width: unit,
                      height: keyHeight,
                      onTap: () => _insert('-'),
                    ),
                  ],
                  _Key(
                    label: 'space',
                    // The symbol layer drops the shift key and the three
                    // punctuation keys, so the space bar takes the room they
                    // leave rather than the row shrinking away from the edges.
                    width: unit * (_symbols ? _spaceUnits + 4.4 : _spaceUnits),
                    height: keyHeight,
                    onTap: () => _insert(' '),
                  ),
                  _Key(
                    icon: Icons.backspace_outlined,
                    width: unit * _backspaceUnits,
                    height: keyHeight,
                    onTap: _backspace,
                  ),
                  _Key(
                    label: widget.submitLabel,
                    width: unit * _submitUnits,
                    height: keyHeight,
                    filled: true,
                    onTap: widget.onSubmit,
                  ),
                ],
              ),
            ],
          ),
        );
      },
    );
  }
}

class _Key extends StatelessWidget {
  const _Key({
    this.label,
    this.icon,
    this.onTap,
    required this.width,
    required this.height,
    this.filled = false,
    this.active = false,
  });

  final String? label;
  final IconData? icon;
  final VoidCallback? onTap;

  /// Both come from the keyboard's unit — see [_OnScreenKeyboardState.build].
  /// Required rather than defaulted, because a default here is a size chosen
  /// against a screen nobody is looking at.
  final double width;
  final double height;

  final bool filled;
  final bool active;

  @override
  Widget build(BuildContext context) {
    final skin = Kds.of(context);
    final enabled = onTap != null;
    final background = filled
        ? Kds.selected
        : active
        ? skin.selectedTrack
        : skin.card;
    final foreground = filled ? Colors.white : skin.ink;

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
                    // travel and no click, so without this a chef cannot tell a
                    // press that landed from one that did not.
                    HapticFeedback.selectionClick();
                    onTap!();
                  }
                : null,
            child: Center(
              child: icon != null
                  ? Icon(icon, size: height * 0.38, color: foreground)
                  : FittedBox(
                      // A word key — "space", "Sign in" — shrinks to fit a
                      // narrow keyboard rather than overflowing it. A single
                      // character never reaches this: the box is always wider
                      // than one glyph.
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
