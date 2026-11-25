/// The till's keyboard, laid out like an iPad's (owner, 2026-11-20: "create
/// another layout feature for Keyboard like iPad ... keep the .?123 layout,
/// only keep UK keyboard layout for now ... hardware keyboard connected and
/// typing keys should hide the on screen keyboard just like iPad, copy paste
/// undo redo ... undock, split, floating options should be enabled replacing
/// the previous keyboard in Vesopa EPOS windows"). Meirion, Pontardawe RFC:
/// "Can we increase the size to a larger keypad please".
///
/// One keyboard for the whole till, drawn in the root overlay along the bottom
/// of the window, the full width of it. A field asks for it (an
/// [OnScreenKeyboard] in text mode, or a [PosTextField] while it has focus) and
/// it goes when the last field that asked lets go. Still never on the sale
/// screen by itself: only where a field asks.
///
/// While it is docked the till's pages are told it is there the way a phone's
/// own keyboard tells them, through `MediaQuery.viewInsets` ([KeyboardInsets],
/// in the app's builder), so a dialog moves up above it and a page shrinks to
/// the room left, rather than being drawn underneath it.
///
/// What it has, as an iPad:
///  * UK QWERTY with the number on each top-row key and `!` / `?` on the comma
///    and full stop: pull a key down to type its small character;
///  * `.?123` (digits and the common symbols) and `#+=` behind it;
///  * Shift for one letter, a second press for caps lock; a capital at the
///    start of a sentence where the field wants one; two spaces type a full
///    stop;
///  * the bar above the keys: undo, redo, cut, copy, paste, select all, the
///    key size (A− A+), and the layout: Dock, Undock, Split or Floating;
///  * the keyboard button puts it away; typing on a real keyboard puts it away
///    too, leaving a small bar with the keyboard button to bring it back.
///
/// Not here, as the owner asked: word suggestions, emoji and dictation.
library;

import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../theme.dart';

/// How big the till's on-screen keyboard is, chosen on the till (2026-10-21,
/// Pontardawe RFC: "make the keyboard on the message screen slightly
/// bigger"). One setting for every keyboard on this till, kept on the till,
/// changed with A- / A+ on the keyboard itself or in Settings.
class KeyboardSize {
  KeyboardSize._();

  static const sizes = <(String, double)>[
    ('Small', 0.85),
    ('Standard', 1.0),
    ('Large', 1.2),
    ('Extra large', 1.4),
  ];
  static const _key = 'till.keyboard_scale';

  /// The current scale. Listened to by every keyboard, so a change is seen
  /// at once, on the keyboard the clerk is looking at.
  static final scale = ValueNotifier<double>(1.0);
  static bool _loaded = false;

  /// Read the saved size once. Safe to call often.
  static Future<void> load() async {
    if (_loaded) return;
    _loaded = true;
    try {
      final prefs = await SharedPreferences.getInstance();
      final saved = prefs.getDouble(_key);
      if (saved != null && saved >= minScale && saved <= maxScale) scale.value = saved;
    } catch (_) {
      // A till whose preferences will not open keeps the standard size.
    }
  }

  static const minScale = 0.7;
  static const maxScale = 1.8;

  static Future<void> set(double value) async {
    value = value.clamp(minScale, maxScale);
    scale.value = value;
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setDouble(_key, value);
    } catch (_) {}
  }

  /// The named size nearest the current scale (the grip sets any scale).
  static int get _index {
    var best = 0;
    for (var i = 1; i < sizes.length; i++) {
      if ((sizes[i].$2 - scale.value).abs() < (sizes[best].$2 - scale.value).abs()) best = i;
    }
    return best;
  }

  static String get label => sizes[_index].$1;

  /// The named size nearest the current scale.
  static double get nearest => sizes[_index].$2;
  static bool get canGrow => scale.value < sizes.last.$2 - 0.001;
  static bool get canShrink => scale.value > sizes.first.$2 + 0.001;
  static void grow() {
    final next = sizes.firstWhere((s) => s.$2 > scale.value + 0.001, orElse: () => sizes.last);
    set(next.$2);
  }
  static void shrink() {
    final next = sizes.lastWhere((s) => s.$2 < scale.value - 0.001, orElse: () => sizes.first);
    set(next.$2);
  }

  /// A dialog's width: [base], never wider than the screen. The keyboard is
  /// docked below dialogs now, so its size no longer widens them.
  static double dialogWidth(BuildContext context, double base) {
    final screen = MediaQuery.sizeOf(context).width;
    final most = screen - 96;
    return base > most ? most : base;
  }
}

/// Which keyboard a field gets.
enum PosKeyboardMode {
  /// Letters, with `.?123` and `#+=` behind them.
  text,

  /// The number pad — covers, quantities, table numbers.
  number,

  /// The number pad with a point, for a typed price.
  decimal,
}

/// Where the keyboard sits.
enum KeyboardLayout {
  /// Along the bottom, the full width; the page makes room for it.
  docked,

  /// The full width, lifted off the bottom and moved up or down by its handle.
  undocked,

  /// In two halves at the edges, for two thumbs; along the bottom or lifted.
  split,

  /// Small, phone-sized, anywhere on the screen.
  floating,
}

/// One field's ask for the keyboard.
class KeyboardRequest {
  KeyboardRequest({
    required this.controller,
    this.onSubmit,
    this.submitLabel = 'Done',
    this.mode = PosKeyboardMode.text,
    this.autoCapitalise = false,
  });

  TextEditingController controller;

  /// Letters, or the number pad.
  PosKeyboardMode mode;

  /// The return key. Null greys it out.
  VoidCallback? onSubmit;
  String submitLabel;

  /// A capital at the start of the field and of each sentence.
  bool autoCapitalise;
}

/// The one keyboard, and who has asked for it.
class KeyboardDock {
  KeyboardDock._();

  static final KeyboardDock instance = KeyboardDock._();

  final List<KeyboardRequest> _asks = [];
  OverlayEntry? _entry;

  /// The field being typed into, or null when no field wants a keyboard.
  final ValueNotifier<KeyboardRequest?> active = ValueNotifier(null);

  /// Bumped when the active field's return key or label changes.
  final ValueNotifier<int> revision = ValueNotifier(0);

  /// Put away by its keyboard button, or by typing on a real keyboard.
  final ValueNotifier<bool> hidden = ValueNotifier(false);

  final ValueNotifier<KeyboardLayout> layout = ValueNotifier(KeyboardLayout.docked);

  /// Undocked or split: how far above the bottom of the window it sits.
  final ValueNotifier<double> lift = ValueNotifier(0);

  /// Floating: where its top left corner is, or null for the default.
  final ValueNotifier<Offset?> floatAt = ValueNotifier(null);

  /// Put away: the keyboard button sits in the bottom left corner instead of
  /// the right (drag it across).
  final ValueNotifier<bool> buttonLeft = ValueNotifier(false);

  /// What the pages make room for: the keyboard's height while it is along
  /// the bottom and showing, else nothing.
  final ValueNotifier<double> inset = ValueNotifier(0);

  double _height = 0;
  bool _loaded = false;
  bool _listening = false;

  bool get isShowing => active.value != null && !hidden.value;

  static const _prefLayout = 'till.keyboard.layout';
  static const _prefLift = 'till.keyboard.lift';
  static const _prefFloatX = 'till.keyboard.float_x';
  static const _prefFloatY = 'till.keyboard.float_y';
  static const _prefButtonLeft = 'till.keyboard.button_left';

  Future<void> setButtonLeft(bool left) async {
    buttonLeft.value = left;
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setBool(_prefButtonLeft, left);
    } catch (_) {}
  }

  Future<void> _load() async {
    if (_loaded) return;
    _loaded = true;
    try {
      final prefs = await SharedPreferences.getInstance();
      final name = prefs.getString(_prefLayout);
      layout.value = KeyboardLayout.values.firstWhere((l) => l.name == name, orElse: () => KeyboardLayout.docked);
      lift.value = prefs.getDouble(_prefLift) ?? 0;
      final x = prefs.getDouble(_prefFloatX), y = prefs.getDouble(_prefFloatY);
      if (x != null && y != null) floatAt.value = Offset(x, y);
      buttonLeft.value = prefs.getBool(_prefButtonLeft) ?? false;
      _updateInset();
    } catch (_) {
      // Preferences that will not open: docked, as it opens the first time.
    }
  }

  Future<void> setLayout(KeyboardLayout l) async {
    layout.value = l;
    if (l == KeyboardLayout.docked) lift.value = 0;
    if (l == KeyboardLayout.undocked && lift.value < 40) lift.value = 160;
    _updateInset();
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_prefLayout, l.name);
      await prefs.setDouble(_prefLift, lift.value);
    } catch (_) {}
  }

  Future<void> savePlace() async {
    _updateInset();
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setDouble(_prefLift, lift.value);
      final f = floatAt.value;
      if (f != null) {
        await prefs.setDouble(_prefFloatX, f.dx);
        await prefs.setDouble(_prefFloatY, f.dy);
      }
    } catch (_) {}
  }

  /// Runs [f] now, or after this frame when called in the middle of a build
  /// (a field's dispose or update), where telling the keyboard to rebuild is
  /// not allowed.
  void _safely(VoidCallback f) {
    if (SchedulerBinding.instance.schedulerPhase == SchedulerPhase.persistentCallbacks) {
      SchedulerBinding.instance.addPostFrameCallback((_) => f());
    } else {
      f();
    }
  }

  /// A field wants the keyboard. The latest to ask is the one typed into.
  void show(BuildContext context, KeyboardRequest request) {
    final overlay = Overlay.maybeOf(context, rootOverlay: true);
    _safely(() => _show(overlay, request));
  }

  void _show(OverlayState? overlay, KeyboardRequest request) {
    _asks.remove(request);
    _asks.add(request);
    _history(request.controller);
    active.value = request;
    revision.value++;
    unawaited(_load());
    KeyboardSize.load();
    if (!_listening) {
      _listening = true;
      HardwareKeyboard.instance.addHandler(_onHardwareKey);
    }
    if (_entry != null && !_entry!.mounted) _entry = null;
    if (_entry == null) {
      if (overlay == null || !overlay.mounted) return;
      _entry = OverlayEntry(builder: (_) => const _DockedKeyboard());
      overlay.insert(_entry!);
    }
    _updateInset();
  }

  /// The field's return key or label changed.
  void changed(KeyboardRequest request) => _safely(() {
        if (identical(active.value, request)) revision.value++;
      });

  /// A field is finished with the keyboard.
  void release(KeyboardRequest request) => _safely(() => _release(request));

  void _release(KeyboardRequest request) {
    if (!_asks.remove(request)) return;
    active.value = _asks.isEmpty ? null : _asks.last;
    revision.value++;
    if (_asks.isEmpty) {
      // A real keyboard put it away: the next field opens without it, as an
      // iPad does while its keyboard is attached. Otherwise it is up again.
      if (!_hardware) hidden.value = false;
      final entry = _entry;
      _entry = null;
      inset.value = 0;
      if (entry != null && entry.mounted) entry.remove();
    }
    _updateInset();
  }

  /// Put away, or brought back.
  void setHidden(bool value) {
    hidden.value = value;
    if (!value) _hardware = false;
    _updateInset();
  }

  bool _hardware = false;

  /// Typing on a real keyboard puts the one on screen away, as on an iPad.
  /// The key still goes to the field: this only watches.
  bool _onHardwareKey(KeyEvent event) {
    if (event is! KeyDownEvent || !isShowing) return false;
    final modifiers = {
      LogicalKeyboardKey.shiftLeft, LogicalKeyboardKey.shiftRight,
      LogicalKeyboardKey.controlLeft, LogicalKeyboardKey.controlRight,
      LogicalKeyboardKey.altLeft, LogicalKeyboardKey.altRight,
      LogicalKeyboardKey.metaLeft, LogicalKeyboardKey.metaRight,
      LogicalKeyboardKey.capsLock, LogicalKeyboardKey.numLock,
    };
    if (modifiers.contains(event.logicalKey)) return false;
    _hardware = true;
    hidden.value = true;
    _updateInset();
    return false;
  }

  void _measured(double height) {
    if ((height - _height).abs() < 0.5) return;
    _height = height;
    _updateInset();
  }

  void _updateInset() {
    final along = layout.value == KeyboardLayout.docked || (layout.value == KeyboardLayout.split && lift.value < 1);
    final value = isShowing && along ? _height : 0.0;
    if ((inset.value - value).abs() >= 0.5) {
      // Never in the middle of a frame's layout.
      final phase = SchedulerBinding.instance.schedulerPhase;
      if (phase == SchedulerPhase.idle || phase == SchedulerPhase.postFrameCallbacks) {
        inset.value = value;
      } else {
        SchedulerBinding.instance.addPostFrameCallback((_) => _updateInset());
      }
    }
  }

  // ---- Undo and redo, per field ---------------------------------------------

  final Expando<_History> _histories = Expando();

  _History _history(TextEditingController c) => _histories[c] ??= _History(c);

  bool canUndo() => active.value != null && _history(active.value!.controller).canUndo;
  bool canRedo() => active.value != null && _history(active.value!.controller).canRedo;
  void undo() => active.value == null ? null : _history(active.value!.controller).undo();
  void redo() => active.value == null ? null : _history(active.value!.controller).redo();

  /// For tests: forget everything.
  @visibleForTesting
  void reset() {
    if (_listening) HardwareKeyboard.instance.removeHandler(_onHardwareKey);
    _listening = false;
    _asks.clear();
    _entry = null;
    active.value = null;
    hidden.value = false;
    _hardware = false;
    inset.value = 0;
    _height = 0;
    layout.value = KeyboardLayout.docked;
    lift.value = 0;
    floatAt.value = null;
    buttonLeft.value = false;
  }
}

/// A field's past, for undo and redo. Typing close together is one step.
class _History extends ChangeNotifier {
  _History(this.controller) : _last = controller.value {
    controller.addListener(_changed);
  }

  final TextEditingController controller;
  final List<TextEditingValue> _undo = [];
  final List<TextEditingValue> _redo = [];
  TextEditingValue _last;
  DateTime _at = DateTime.fromMillisecondsSinceEpoch(0);
  bool _applying = false;

  bool get canUndo => _undo.isNotEmpty;
  bool get canRedo => _redo.isNotEmpty;

  void _changed() {
    final now = controller.value;
    if (now.text == _last.text) {
      _last = now;
      return;
    }
    if (!_applying) {
      final t = DateTime.now();
      final word = now.text.length > _last.text.length && now.text.endsWith(' ');
      if (_undo.isEmpty || t.difference(_at) > const Duration(milliseconds: 900) || word) {
        _undo.add(_last);
        if (_undo.length > 100) _undo.removeAt(0);
      }
      _at = t;
      _redo.clear();
    }
    _last = now;
    notifyListeners();
  }

  void undo() {
    if (_undo.isEmpty) return;
    _redo.add(controller.value);
    _set(_undo.removeLast());
  }

  void redo() {
    if (_redo.isEmpty) return;
    _undo.add(controller.value);
    _set(_redo.removeLast());
  }

  void _set(TextEditingValue v) {
    _applying = true;
    controller.value = v.copyWith(selection: TextSelection.collapsed(offset: v.text.length));
    _applying = false;
    _at = DateTime.fromMillisecondsSinceEpoch(0);
    notifyListeners();
  }
}

/// Tells the till's pages the keyboard is there, as a phone's keyboard does.
/// In the app's builder, around the navigator.
class KeyboardInsets extends StatelessWidget {
  const KeyboardInsets({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<double>(
      valueListenable: KeyboardDock.instance.inset,
      child: child,
      builder: (context, inset, child) {
        if (inset <= 0) return child!;
        final mq = MediaQuery.of(context);
        return MediaQuery(
          data: mq.copyWith(
            viewInsets: mq.viewInsets.copyWith(bottom: math.max(mq.viewInsets.bottom, inset)),
          ),
          child: child!,
        );
      },
    );
  }
}

// ---- The layouts --------------------------------------------------------------

enum _Do { char, shift, back, enter, toNumbers, toLetters, toSymbols, hide, undo, redo, space, gap, clear }

class _Spec {
  const _Spec(this.act, {this.ch, this.alt, this.units = 1.0, this.icon, this.label});
  final _Do act;
  final String? ch;

  /// The small character above: pull the key down to type it.
  final String? alt;
  final double units;
  final IconData? icon;
  final String? label;
}

_Spec _c(String ch, [String? alt, double units = 1.0]) => _Spec(_Do.char, ch: ch, alt: alt, units: units);

const _back = _Spec(_Do.back, icon: Icons.backspace_outlined, units: 1.4);
const _enter = _Spec(_Do.enter, units: 1.9);
const _indent = _Spec(_Do.gap, units: 0.5);
const _hide = _Spec(_Do.hide, icon: Icons.keyboard_hide_outlined, units: 1.0);

/// The rows of each page, as an iPad's UK keyboard. Every row adds up to the
/// same 11.4 units, so the edges line up.
final _letters = <List<_Spec>>[
  [
    for (final (i, ch) in 'qwertyuiop'.split('').indexed) _c(ch, '${(i + 1) % 10}'),
    _back,
  ],
  [_indent, for (final ch in 'asdfghjkl'.split('')) _c(ch), _enter],
  [
    const _Spec(_Do.shift, units: 1.0),
    for (final ch in 'zxcvbnm'.split('')) _c(ch),
    _c(',', '!'),
    _c('.', '?'),
    const _Spec(_Do.shift, units: 1.4),
  ],
  [
    const _Spec(_Do.toNumbers, label: '.?123', units: 2.0),
    const _Spec(_Do.space, units: 6.4),
    const _Spec(_Do.toNumbers, label: '.?123', units: 2.0),
    _hide,
  ],
];

final _numbers = <List<_Spec>>[
  [for (final ch in '1234567890'.split('')) _c(ch), _back],
  [
    _indent,
    _c('@', '€'), _c('#', '£'), _c(r'$', '¥'), _c('&', '_'), _c('*', '^'),
    _c('(', '['), _c(')', ']'), _c("'", '{'), _c('"', '}'),
    _enter,
  ],
  [
    const _Spec(_Do.toSymbols, label: '#+=', units: 1.0),
    _c('%', '§'), _c('-', '|'), _c('+', '~'), _c('=', '…'), _c('/', r'\'),
    _c(';', '<'), _c(':', '>'), _c('!', ','), _c('?', '.'),
    const _Spec(_Do.toSymbols, label: '#+=', units: 1.4),
  ],
  [
    const _Spec(_Do.toLetters, label: 'ABC', units: 2.0),
    const _Spec(_Do.space, units: 5.0),
    const _Spec(_Do.undo, label: 'undo', units: 1.4),
    const _Spec(_Do.toLetters, label: 'ABC', units: 2.0),
    _hide,
  ],
];

final _symbols = <List<_Spec>>[
  [for (final ch in '[]{}#%^*+='.split('')) _c(ch), _back],
  [_indent, for (final ch in r'_\|~<>€£•'.split('')) _c(ch), _enter],
  [
    const _Spec(_Do.toNumbers, label: '123', units: 1.0),
    for (final ch in const ['.', ',', '?', '!', "'", '"']) _c(ch, null, 1.5),
    const _Spec(_Do.toNumbers, label: '123', units: 1.4),
  ],
  [
    const _Spec(_Do.toLetters, label: 'ABC', units: 2.0),
    const _Spec(_Do.space, units: 5.0),
    const _Spec(_Do.redo, label: 'redo', units: 1.4),
    const _Spec(_Do.toLetters, label: 'ABC', units: 2.0),
    _hide,
  ],
];

/// Where each row breaks in two for the split keyboard: the number of keys in
/// the left half (a space bar on the break is shared between the halves).
const _splitAt = [5, 6, 5, 2];

// ---- The keyboard on screen -----------------------------------------------------

class _DockedKeyboard extends StatefulWidget {
  const _DockedKeyboard();

  @override
  State<_DockedKeyboard> createState() => _DockedKeyboardState();
}

class _DockedKeyboardState extends State<_DockedKeyboard> {
  final dock = KeyboardDock.instance;

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: Listenable.merge([
        dock.active, dock.hidden, dock.buttonLeft, dock.layout, dock.lift, dock.floatAt, dock.revision, KeyboardSize.scale,
      ]),
      builder: (context, _) {
        final request = dock.active.value;
        if (request == null) return const SizedBox.shrink();
        final screen = MediaQuery.sizeOf(context);
        // Part of the field being typed into, as far as taps go: on Windows a
        // field lets go of its focus at any touch outside it, and this is in
        // an overlay of its own (Pontardawe RFC, 2026-10-26).
        if (dock.hidden.value) {
          // A keyboard button in the corner, as an iPad's: tap it for the
          // keyboard again, drag it to the other corner.
          final left = dock.buttonLeft.value;
          return Positioned(
            left: left ? 16 : null,
            right: left ? null : 16,
            bottom: 16,
            child: TextFieldTapRegion(
              child: GestureDetector(
                onHorizontalDragEnd: (d) {
                  final v = d.primaryVelocity ?? 0;
                  if (v < -100) dock.setButtonLeft(true);
                  if (v > 100) dock.setButtonLeft(false);
                },
                child: _PutAwayBar(request: request),
              ),
            ),
          );
        }
        final board = _Board(key: ValueKey(request), request: request);
        switch (dock.layout.value) {
          case KeyboardLayout.docked:
            return Positioned(left: 0, right: 0, bottom: 0, child: TextFieldTapRegion(child: _measure(board)));
          case KeyboardLayout.undocked:
          case KeyboardLayout.split:
            final lift = dock.lift.value.clamp(0.0, math.max(0.0, screen.height - 220)).toDouble();
            return Positioned(left: 0, right: 0, bottom: lift, child: TextFieldTapRegion(child: _measure(board)));
          case KeyboardLayout.floating:
            final width = math.min(screen.width - 16, 420 * KeyboardSize.scale.value);
            final at = dock.floatAt.value ?? Offset((screen.width - width) / 2, screen.height * 0.45);
            final left = at.dx.clamp(0.0, math.max(0.0, screen.width - width)).toDouble();
            final top = at.dy.clamp(0.0, math.max(0.0, screen.height - 120)).toDouble();
            return Positioned(left: left, top: top, width: width, child: TextFieldTapRegion(child: board));
        }
      },
    );
  }

  Widget _measure(Widget child) => _MeasureHeight(onHeight: dock._measured, child: child);
}

/// Put away: undo, redo, paste and the keyboard button, as an iPad's bar when
/// a real keyboard is attached.
class _PutAwayBar extends StatelessWidget {
  const _PutAwayBar({required this.request});
  final KeyboardRequest request;

  @override
  Widget build(BuildContext context) {
    final pal = PayPalette.of(context);
    final dock = KeyboardDock.instance;
    return Material(
      elevation: 10,
      color: pal.panel,
      borderRadius: BorderRadius.circular(28),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          IconButton(tooltip: 'Undo', onPressed: dock.undo, icon: const Icon(Icons.undo_rounded)),
          IconButton(tooltip: 'Redo', onPressed: dock.redo, icon: const Icon(Icons.redo_rounded)),
          IconButton(tooltip: 'Paste', onPressed: () => _Edit(request.controller).paste(), icon: const Icon(Icons.content_paste_rounded)),
          const SizedBox(width: 4),
          IconButton.filledTonal(
            tooltip: 'Keyboard',
            iconSize: 30,
            onPressed: () => dock.setHidden(false),
            icon: const Icon(Icons.keyboard_rounded),
          ),
        ]),
      ),
    );
  }
}

/// Edits on a field's text, at its caret.
class _Edit {
  _Edit(this.c);
  final TextEditingController c;

  TextSelection get _sel {
    final s = c.selection;
    return s.isValid ? s : TextSelection.collapsed(offset: c.text.length);
  }

  void insert(String text) {
    final s = _sel;
    c.value = TextEditingValue(
      text: c.text.replaceRange(s.start, s.end, text),
      selection: TextSelection.collapsed(offset: s.start + text.length),
    );
  }

  void backspace() {
    final s = _sel;
    if (!s.isCollapsed) return insert('');
    if (s.start == 0) return;
    // A whole character, an emoji or an accented letter included.
    final before = c.text.substring(0, s.start).characters;
    final cut = before.isEmpty ? 0 : before.last.length;
    c.value = TextEditingValue(
      text: c.text.replaceRange(s.start - cut, s.start, ''),
      selection: TextSelection.collapsed(offset: s.start - cut),
    );
  }

  String get selected {
    final s = c.selection;
    return s.isValid && !s.isCollapsed ? s.textInside(c.text) : '';
  }

  Future<void> copy() async {
    if (selected.isNotEmpty) await Clipboard.setData(ClipboardData(text: selected));
  }

  Future<void> cut() async {
    if (selected.isEmpty) return;
    await Clipboard.setData(ClipboardData(text: selected));
    insert('');
  }

  Future<void> paste() async {
    final data = await Clipboard.getData(Clipboard.kTextPlain);
    final text = data?.text;
    if (text != null && text.isNotEmpty) insert(text);
  }

  void selectAll() => c.selection = TextSelection(baseOffset: 0, extentOffset: c.text.length);

  String get beforeCaret => c.text.substring(0, _sel.start);
}

class _Board extends StatefulWidget {
  const _Board({super.key, required this.request});
  final KeyboardRequest request;

  @override
  State<_Board> createState() => _BoardState();
}

enum _Page { letters, numbers, symbols }

class _BoardState extends State<_Board> {
  final dock = KeyboardDock.instance;
  _Page _page = _Page.letters;
  bool _shift = false;
  bool _caps = false;

  /// Shift was put on by the keyboard (a new sentence), not pressed.
  bool _autoShift = false;

  TextEditingController get _c => widget.request.controller;
  late _Edit _edit = _Edit(_c);

  @override
  void initState() {
    super.initState();
    _c.addListener(_onText);
    _autoCaps();
  }

  @override
  void didUpdateWidget(_Board old) {
    super.didUpdateWidget(old);
    if (!identical(old.request.controller, _c)) {
      old.request.controller.removeListener(_onText);
      _c.addListener(_onText);
      _edit = _Edit(_c);
      _autoCaps();
    }
  }

  @override
  void dispose() {
    _c.removeListener(_onText);
    _repeat?.cancel();
    super.dispose();
  }

  void _onText() {
    if (!mounted) return;
    setState(_autoCaps);
  }

  /// A capital to start the field and each sentence, where the field wants it.
  void _autoCaps() {
    if (!widget.request.autoCapitalise || _caps) return;
    if (_shift && !_autoShift) return;
    final before = _edit.beforeCaret;
    final start = before.trim().isEmpty || RegExp(r'[.!?]\s+$').hasMatch(before) || before.endsWith('\n');
    _shift = start;
    _autoShift = start;
  }

  void _type(String ch) {
    final upper = (_shift || _caps) && _page == _Page.letters;
    _edit.insert(upper ? ch.toUpperCase() : ch);
    if (_shift && !_caps) {
      _shift = false;
      _autoShift = false;
    }
    setState(_autoCaps);
  }

  void _space() {
    // Two spaces after a word type a full stop, as on an iPad.
    final before = _edit.beforeCaret;
    if (before.length >= 2 && before.endsWith(' ') && RegExp(r'[A-Za-z0-9)"]$').hasMatch(before.substring(0, before.length - 1))) {
      _edit.backspace();
      _edit.insert('. ');
    } else {
      _edit.insert(' ');
    }
    if (_page != _Page.letters && before.isNotEmpty) _page = _Page.letters;
    setState(_autoCaps);
  }

  void _pressShift() => setState(() {
        if (_caps) {
          _caps = false;
          _shift = false;
        } else if (_shift && !_autoShift) {
          _caps = true;
        } else if (_shift) {
          // Shift the keyboard put on: pressing it takes it off.
          _shift = false;
        } else {
          _shift = true;
        }
        _autoShift = false;
      });

  Timer? _repeat;

  void _act(_Spec k, {bool alt = false}) {
    HapticFeedback.selectionClick();
    switch (k.act) {
      case _Do.char:
        _type(alt && k.alt != null ? k.alt! : k.ch!);
      case _Do.space:
        _space();
      case _Do.back:
        _edit.backspace();
        setState(_autoCaps);
      case _Do.shift:
        _pressShift();
      case _Do.enter:
        widget.request.onSubmit?.call();
      case _Do.toNumbers:
        setState(() => _page = _Page.numbers);
      case _Do.toLetters:
        setState(() => _page = _Page.letters);
      case _Do.toSymbols:
        setState(() => _page = _Page.symbols);
      case _Do.hide:
        dock.setHidden(true);
      case _Do.undo:
        dock.undo();
      case _Do.redo:
        dock.redo();
      case _Do.clear:
        _c.clear();
        setState(_autoCaps);
      case _Do.gap:
        break;
    }
  }

  @override
  Widget build(BuildContext context) {
    final pal = PayPalette.of(context);
    final scale = KeyboardSize.scale.value;
    final layout = dock.layout.value;
    final floating = layout == KeyboardLayout.floating;
    final pad = widget.request.mode != PosKeyboardMode.text;
    final rows = pad
        ? const <List<_Spec>>[]
        : switch (_page) { _Page.letters => _letters, _Page.numbers => _numbers, _Page.symbols => _symbols };
    final dark = Theme.of(context).brightness == Brightness.dark;
    final background = dark ? const Color(0xFF1E2124) : const Color(0xFFD3D6DC);

    return Material(
      color: background,
      elevation: layout == KeyboardLayout.docked ? 8 : 6,
      shape: layout == KeyboardLayout.docked
          ? const RoundedRectangleBorder()
          : RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(floating ? 18 : 12),
              side: BorderSide(color: (dark ? Colors.white : Colors.black).withValues(alpha: 0.14)),
            ),
      clipBehavior: Clip.antiAlias,
      child: SafeArea(
        top: false,
        child: LayoutBuilder(builder: (context, box) {
          final width = box.maxWidth.isFinite ? box.maxWidth : MediaQuery.sizeOf(context).width;
          final edge = floating ? 6.0 : 8.0;
          final gap = floating ? 4.0 : 7.0;
          final keys = <Widget>[];
          if (pad) {
            // The number pad, as an iPad's passcode pad (owner, 2026-11-20):
            // round keys in a phone's order in the middle, the same height
            // as the letters so the keyboard does not jump, with Clear,
            // the keyboard button and a tall return key beside them.
            final full = (width - edge * 2) / 11.4;
            final letterHeight = (full * 0.62 * scale).clamp(38.0, 88.0 * scale);
            keys.add(Padding(
              padding: EdgeInsets.only(top: gap),
              child: _passcodePad(width - edge * 2, letterHeight, gap, dark),
            ));
          } else {
            final split = layout == KeyboardLayout.split && width >= 700;
            final half = split ? width * 0.34 : width - edge * 2;
            final unit = half / (split ? 6.4 : 11.4);
            final keyHeight = (unit * (split ? 0.82 : 0.62) * scale).clamp(38.0, 88.0 * scale);
            for (final (i, row) in rows.indexed) {
              keys.add(Padding(
                padding: EdgeInsets.only(top: gap),
                child: SizedBox(
                  height: keyHeight,
                  child: split ? _splitRow(row, i, half, gap, pal, dark) : _row(row, gap, pal, dark),
                ),
              ));
            }
          }
          return Padding(
            padding: EdgeInsets.fromLTRB(edge, 0, edge, edge),
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              if (layout != KeyboardLayout.docked) _grabber(context, layout),
              _Bar(request: widget.request, compact: floating || width < 640, pal: pal, dark: dark),
              ...keys,
            ]),
          );
        }),
      ),
    );
  }

  /// Round number keys, 3 by 4, with a column of wide keys on the right and
  /// the same room on the left, so the digits sit in the middle of the till.
  Widget _passcodePad(double width, double rowHeight, double gap, bool dark) {
    final point = widget.request.mode == PosKeyboardMode.decimal;
    // Width it needs, in key diameters: three keys and two gaps (0.45 each),
    // and either side a gap (0.6) and a column (1.9).
    // Narrow (floating): no matching room on the left, the digits take it.
    final wide = width >= 700;
    final d = math.min(rowHeight, width / (3 + 0.9 + (wide ? 2 : 1) * 2.5));
    final across = d * 0.45;
    final side = d * 1.9;
    final ink = dark ? Colors.white : Colors.black;
    final circle = dark ? const Color(0xFF3A3F45) : Colors.white;
    final functionFill = dark ? const Color(0xFF2E3236) : const Color(0xFFADB2BB);

    Widget digit(String ch) {
      final dead = ch == '.' && _c.text.contains('.');
      return SizedBox(
        width: d,
        height: d,
        child: _KeyCap(
          fill: circle,
          ink: ink,
          label: ch,
          round: true,
          onTap: dead ? null : () => _act(_Spec(_Do.char, ch: ch)),
        ),
      );
    }

    Widget blank() => SizedBox(width: d, height: d);

    Widget back() => SizedBox(
          width: d,
          height: d,
          child: _KeyCap(
            fill: Colors.transparent,
            ink: ink,
            icon: Icons.backspace_outlined,
            semantic: 'Delete',
            flat: true,
            onTap: () => _act(const _Spec(_Do.back)),
            onHoldStart: () {
              _repeat?.cancel();
              _repeat = Timer.periodic(const Duration(milliseconds: 90), (_) => _edit.backspace());
            },
            onHoldEnd: () => _repeat?.cancel(),
          ),
        );

    Widget grid = Column(mainAxisSize: MainAxisSize.min, children: [
      for (final (i, row) in const [
        ['1', '2', '3'],
        ['4', '5', '6'],
        ['7', '8', '9'],
      ].indexed) ...[
        if (i > 0) SizedBox(height: gap),
        Row(mainAxisSize: MainAxisSize.min, children: [
          for (final (j, ch) in row.indexed) ...[if (j > 0) SizedBox(width: across), digit(ch)],
        ]),
      ],
      SizedBox(height: gap),
      Row(mainAxisSize: MainAxisSize.min, children: [
        point ? digit('.') : blank(),
        SizedBox(width: across),
        digit('0'),
        SizedBox(width: across),
        back(),
      ]),
    ]);

    final on = widget.request.onSubmit != null;
    final column = SizedBox(
      width: side,
      height: d * 4 + gap * 3,
      child: Column(children: [
        SizedBox(
          height: d,
          child: _KeyCap(fill: functionFill, ink: ink, label: 'Clear', word: true, onTap: () => _act(const _Spec(_Do.clear))),
        ),
        SizedBox(height: gap),
        SizedBox(
          height: d,
          child: _KeyCap(fill: functionFill, ink: ink, icon: Icons.keyboard_hide_outlined, semantic: 'Hide keyboard', onTap: () => _act(_hide)),
        ),
        SizedBox(height: gap),
        Expanded(
          child: _KeyCap(
            fill: on ? Pos.brand : functionFill,
            ink: on ? Pos.onBrand : ink.withValues(alpha: 0.45),
            label: widget.request.submitLabel,
            word: true,
            onTap: on ? () => _act(const _Spec(_Do.enter)) : null,
          ),
        ),
      ]),
    );

    return Center(
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        if (wide) SizedBox(width: side + d * 0.6),
        grid,
        SizedBox(width: d * 0.6),
        column,
      ]),
    );
  }

  /// The handle to move a keyboard that is not docked.
  Widget _grabber(BuildContext context, KeyboardLayout layout) {
    final screen = MediaQuery.sizeOf(context);
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onPanUpdate: (d) {
        if (layout == KeyboardLayout.floating) {
          final width = math.min(screen.width - 16, 420 * KeyboardSize.scale.value);
          final at = dock.floatAt.value ?? Offset((screen.width - width) / 2, screen.height * 0.45);
          dock.floatAt.value = at + d.delta;
        } else {
          dock.lift.value = (dock.lift.value - d.delta.dy).clamp(0.0, math.max(0.0, screen.height - 220));
        }
      },
      onPanEnd: (_) => dock.savePlace(),
      child: SizedBox(
        height: 20,
        child: Center(
          child: Container(
            width: 56,
            height: 5,
            decoration: BoxDecoration(color: Colors.grey.withValues(alpha: 0.7), borderRadius: BorderRadius.circular(3)),
          ),
        ),
      ),
    );
  }

  Widget _row(List<_Spec> row, double gap, PayPalette pal, bool dark) {
    return Row(children: [
      for (final (i, k) in row.indexed) ...[
        if (i > 0) SizedBox(width: gap),
        Expanded(flex: (k.units * 100).round(), child: _key(k, pal, dark)),
      ],
    ]);
  }

  /// A row in two halves at the edges, the space bar shared between them.
  Widget _splitRow(List<_Spec> row, int index, double half, double gap, PayPalette pal, bool dark) {
    final at = _splitAt[index];
    var left = row.sublist(0, at);
    var right = row.sublist(at);
    if (left.isNotEmpty && left.last.act == _Do.space) {
      final s = left.last.units / 2;
      left = [...left.sublist(0, left.length - 1), _Spec(_Do.space, units: s)];
      right = [_Spec(_Do.space, units: s), ...right];
    } else if (right.isNotEmpty && right.first.act == _Do.space) {
      final s = right.first.units / 2;
      left = [...left, _Spec(_Do.space, units: s)];
      right = [_Spec(_Do.space, units: s), ...right.sublist(1)];
    }
    // The halves keep one key size, so a short row is short, as on an iPad.
    double unitsOf(List<_Spec> l) => l.fold(0.0, (a, k) => a + k.units);
    final unit = (half - gap * 6) / 6.4;
    Widget part(List<_Spec> keys, Alignment align) => Align(
          alignment: align,
          child: SizedBox(
            width: math.min(half, unit * unitsOf(keys) + gap * (keys.length - 1)),
            child: _row(keys, gap, pal, dark),
          ),
        );
    return Row(children: [
      SizedBox(width: half, child: part(left, Alignment.centerLeft)),
      const Spacer(),
      SizedBox(width: half, child: part(right, Alignment.centerRight)),
    ]);
  }

  Widget _key(_Spec k, PayPalette pal, bool dark) {
    if (k.act == _Do.gap) return const SizedBox.shrink();
    final letterFill = dark ? const Color(0xFF45494E) : Colors.white;
    final functionFill = dark ? const Color(0xFF2E3236) : const Color(0xFFADB2BB);
    final ink = dark ? Colors.white : Colors.black;
    final upper = (_shift || _caps) && _page == _Page.letters;
    switch (k.act) {
      case _Do.char:
        final ch = upper ? k.ch!.toUpperCase() : k.ch!;
        // One point in a price, and never a second: "12.3.7" is a clerk
        // working out which tap went wrong.
        final dead = widget.request.mode == PosKeyboardMode.decimal && ch == '.' && _c.text.contains('.');
        return _KeyCap(
          fill: letterFill,
          ink: ink,
          label: ch,
          alt: k.alt,
          onTap: dead ? null : () => _act(k),
          onPullDown: k.alt == null ? null : () => _act(k, alt: true),
        );
      case _Do.space:
        return _KeyCap(fill: letterFill, ink: ink, label: '', semantic: 'space', onTap: () => _act(k));
      case _Do.back:
        return _KeyCap(
          fill: functionFill,
          ink: ink,
          icon: Icons.backspace_outlined,
          semantic: 'Delete',
          onTap: () => _act(k),
          onHoldStart: () {
            _repeat?.cancel();
            _repeat = Timer.periodic(const Duration(milliseconds: 90), (_) {
              _edit.backspace();
            });
          },
          onHoldEnd: () => _repeat?.cancel(),
        );
      case _Do.shift:
        return _KeyCap(
          fill: _caps || (_shift && !_autoShift) ? letterFill : functionFill,
          ink: ink,
          icon: _caps ? Icons.keyboard_capslock : (_shift ? Icons.arrow_upward : Icons.arrow_upward_outlined),
          semantic: 'Shift',
          lit: _shift || _caps,
          onTap: () => _act(k),
        );
      case _Do.enter:
        final on = widget.request.onSubmit != null;
        return _KeyCap(
          fill: on ? Pos.brand : functionFill,
          ink: on ? Pos.onBrand : ink.withValues(alpha: 0.45),
          label: widget.request.submitLabel,
          word: true,
          onTap: on ? () => _act(k) : null,
        );
      case _Do.clear:
        return _KeyCap(fill: functionFill, ink: ink, label: k.label, word: true, onTap: () => _act(k));
      case _Do.hide:
        return _KeyCap(fill: functionFill, ink: ink, icon: Icons.keyboard_hide_outlined, semantic: 'Hide keyboard', onTap: () => _act(k));
      case _Do.undo:
      case _Do.redo:
      case _Do.toNumbers:
      case _Do.toLetters:
      case _Do.toSymbols:
        return _KeyCap(fill: functionFill, ink: ink, label: k.label, word: true, onTap: () => _act(k));
      case _Do.gap:
        return const SizedBox.shrink();
    }
  }
}

/// The bar above the keys: editing on the left, size and layout on the right.
class _Bar extends StatelessWidget {
  const _Bar({required this.request, required this.compact, required this.pal, required this.dark});
  final KeyboardRequest request;
  final bool compact;
  final PayPalette pal;
  final bool dark;

  @override
  Widget build(BuildContext context) {
    final dock = KeyboardDock.instance;
    final edit = _Edit(request.controller);
    final ink = dark ? Colors.white : Colors.black87;
    Widget b(String tip, IconData icon, VoidCallback? on) => IconButton(
          tooltip: tip,
          visualDensity: VisualDensity.compact,
          color: ink,
          disabledColor: ink.withValues(alpha: 0.3),
          iconSize: 22,
          onPressed: on == null
              ? null
              : () {
                  HapticFeedback.selectionClick();
                  on();
                },
          icon: Icon(icon),
        );
    return SizedBox(
      height: 44,
      child: ListenableBuilder(
        listenable: request.controller,
        builder: (context, _) {
          final hasSelection = edit.selected.isNotEmpty;
          return Row(children: [
            b('Undo', Icons.undo_rounded, dock.canUndo() ? dock.undo : null),
            b('Redo', Icons.redo_rounded, dock.canRedo() ? dock.redo : null),
            if (!compact) ...[
              b('Cut', Icons.content_cut_rounded, hasSelection ? edit.cut : null),
              b('Copy', Icons.content_copy_rounded, hasSelection ? edit.copy : null),
            ],
            b('Paste', Icons.content_paste_rounded, edit.paste),
            if (!compact) b('Select all', Icons.select_all_rounded, request.controller.text.isEmpty ? null : edit.selectAll),
            const Spacer(),
            b('Smaller keys', Icons.text_decrease_rounded, KeyboardSize.canShrink ? KeyboardSize.shrink : null),
            b('Bigger keys', Icons.text_increase_rounded, KeyboardSize.canGrow ? KeyboardSize.grow : null),
            PopupMenuButton<KeyboardLayout>(
              tooltip: 'Keyboard layout',
              icon: Icon(Icons.keyboard_alt_outlined, color: ink),
              initialValue: dock.layout.value,
              onSelected: dock.setLayout,
              itemBuilder: (_) => [
                for (final (l, name, icon) in const [
                  (KeyboardLayout.docked, 'Dock', Icons.vertical_align_bottom_rounded),
                  (KeyboardLayout.undocked, 'Undock', Icons.unfold_less_rounded),
                  (KeyboardLayout.split, 'Split', Icons.vertical_split_outlined),
                  (KeyboardLayout.floating, 'Floating', Icons.picture_in_picture_alt_outlined),
                ])
                  CheckedPopupMenuItem(value: l, checked: dock.layout.value == l, child: Row(children: [Icon(icon, size: 20), const SizedBox(width: 10), Text(name)])),
              ],
            ),
          ]);
        },
      ),
    );
  }
}

class _KeyCap extends StatefulWidget {
  const _KeyCap({
    required this.fill,
    required this.ink,
    this.label,
    this.alt,
    this.icon,
    this.semantic,
    this.onTap,
    this.onPullDown,
    this.onHoldStart,
    this.onHoldEnd,
    this.word = false,
    this.lit = false,
    this.round = false,
    this.flat = false,
  });

  final Color fill;
  final Color ink;
  final String? label;
  final String? alt;
  final IconData? icon;
  final String? semantic;
  final VoidCallback? onTap;
  final VoidCallback? onPullDown;
  final VoidCallback? onHoldStart;
  final VoidCallback? onHoldEnd;
  final bool word;
  final bool lit;

  /// A circle, as an iPad's passcode keys.
  final bool round;

  /// No key under it: just the icon (the number pad's delete).
  final bool flat;

  @override
  State<_KeyCap> createState() => _KeyCapState();
}

class _KeyCapState extends State<_KeyCap> {
  double _pulled = 0;
  bool _down = false;

  @override
  Widget build(BuildContext context) {
    final enabled = widget.onTap != null;
    return LayoutBuilder(builder: (context, box) {
      final h = box.maxHeight.isFinite ? box.maxHeight : 56.0;
      final pulled = widget.onPullDown != null && _pulled > h * 0.25;
      Widget face;
      if (widget.icon != null) {
        face = Icon(widget.icon, size: h * (widget.flat ? 0.36 : 0.4), color: widget.ink);
      } else if (widget.round) {
        face = Text(widget.label ?? '', style: TextStyle(fontSize: h * 0.44, color: widget.ink, fontWeight: FontWeight.w300, height: 1));
      } else if (widget.alt != null) {
        face = Column(mainAxisAlignment: MainAxisAlignment.center, children: [
          Text(widget.alt!, style: TextStyle(fontSize: h * 0.22, color: widget.ink.withValues(alpha: pulled ? 1 : 0.45), fontWeight: pulled ? FontWeight.w700 : FontWeight.w400)),
          Text(widget.label ?? '', style: TextStyle(fontSize: h * 0.36, color: widget.ink.withValues(alpha: pulled ? 0.3 : 1), height: 1.05)),
        ]);
      } else {
        face = FittedBox(
          fit: BoxFit.scaleDown,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 6),
            child: Text(widget.label ?? '', maxLines: 1, style: TextStyle(fontSize: widget.word ? math.min(h * 0.27, 24.0) : h * 0.4, color: widget.ink, fontWeight: widget.word ? FontWeight.w600 : FontWeight.w400)),
          ),
        );
      }
      final cap = AnimatedContainer(
        duration: const Duration(milliseconds: 60),
        decoration: BoxDecoration(
          color: widget.flat
              ? (_down ? widget.ink.withValues(alpha: 0.12) : Colors.transparent)
              : (_down ? Color.lerp(widget.fill, widget.ink, widget.round ? 0.3 : 0.12) : widget.fill),
          shape: widget.round || widget.flat ? BoxShape.circle : BoxShape.rectangle,
          borderRadius: widget.round || widget.flat ? null : BorderRadius.circular(8),
          boxShadow: widget.flat ? null : [BoxShadow(color: Colors.black.withValues(alpha: 0.28), offset: const Offset(0, 1), blurRadius: 0)],
        ),
        alignment: Alignment.center,
        child: face,
      );
      return Semantics(
        button: true,
        enabled: enabled,
        label: widget.semantic ?? widget.label,
        excludeSemantics: widget.semantic != null,
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTapDown: enabled ? (_) => setState(() => _down = true) : null,
          onTapCancel: () => setState(() => _down = false),
          onTapUp: enabled ? (_) => setState(() => _down = false) : null,
          onTap: widget.onTap,
          onLongPressStart: widget.onHoldStart == null ? null : (_) => widget.onHoldStart!(),
          onLongPressEnd: widget.onHoldEnd == null ? null : (_) => widget.onHoldEnd!(),
          onVerticalDragStart: widget.onPullDown == null ? null : (_) => setState(() => _pulled = 0),
          onVerticalDragUpdate: widget.onPullDown == null ? null : (d) => setState(() => _pulled = math.max(0, _pulled + d.delta.dy)),
          onVerticalDragEnd: widget.onPullDown == null
              ? null
              : (_) {
                  if (_pulled > h * 0.25) {
                    widget.onPullDown!();
                  } else {
                    widget.onTap?.call();
                  }
                  setState(() => _pulled = 0);
                },
          child: Opacity(opacity: enabled ? 1 : 0.6, child: cap),
        ),
      );
    });
  }
}

/// Reports its child's height after layout.
class _MeasureHeight extends SingleChildRenderObjectWidget {
  const _MeasureHeight({required this.onHeight, required super.child});
  final ValueChanged<double> onHeight;

  @override
  RenderObject createRenderObject(BuildContext context) => _RenderMeasure(onHeight);

  @override
  void updateRenderObject(BuildContext context, _RenderMeasure renderObject) => renderObject.onHeight = onHeight;
}

class _RenderMeasure extends RenderProxyBox {
  _RenderMeasure(this.onHeight);
  ValueChanged<double> onHeight;
  double? _last;

  @override
  void performLayout() {
    super.performLayout();
    final h = size.height;
    if (_last != h) {
      _last = h;
      SchedulerBinding.instance.addPostFrameCallback((_) => onHeight(h));
    }
  }
}

/// Every text box on the till opens the keyboard, whether or not its screen
/// asked for it (Nicky, Pontardawe RFC, 2026-11-24: "This have now broken
/// keyboards on setting and custom text. Staff prefer the new keyboard but
/// need to sort out the errors.").
///
/// 1.16.56 gave the keyboard to the boxes built as [PosTextField] or paired
/// with an [OnScreenKeyboard], and took the old floating keyboard away from
/// everything else, which left about eighty plain text boxes (most of
/// Settings, custom text, the stock and printer screens) with no keyboard at
/// all on a till with no real one. This watches the till's focus instead: a
/// text box that has it, and has not brought a keyboard of its own, asks for
/// the dock, and lets go when it loses focus.
///
/// A box marked `keyboardType: TextInputType.none` is one that brings its own
/// (that is how every paired box says "ours is the input method"), and a
/// read-only box takes no typing, so neither is touched.
class KeyboardAutoAsk {
  KeyboardAutoAsk._();

  static bool _installed = false;
  static KeyboardRequest? _ask;
  static bool _pending = false;

  /// The request this has made for the focused box, for tests.
  @visibleForTesting
  static KeyboardRequest? get current => _ask;

  /// Start watching. Safe to call more than once.
  static void install() {
    if (_installed) return;
    _installed = true;
    FocusManager.instance.addListener(_focusMoved);
  }

  @visibleForTesting
  static void uninstall() {
    if (!_installed) return;
    _installed = false;
    FocusManager.instance.removeListener(_focusMoved);
    _letGo();
  }

  /// Looked at after the frame, so a box's own request (a [PosTextField]
  /// asks as its focus changes) is already in place and is left alone.
  static void _focusMoved() {
    if (_pending) return;
    _pending = true;
    SchedulerBinding.instance.addPostFrameCallback((_) {
      _pending = false;
      _check();
    });
    SchedulerBinding.instance.ensureVisualUpdate();
  }

  static void _check() {
    final focus = FocusManager.instance.primaryFocus;
    final context = focus?.context;
    EditableTextState? box;
    if (context != null && context.mounted) {
      box = context.findAncestorStateOfType<EditableTextState>();
    }
    final field = box?.widget;
    if (field == null ||
        field.readOnly ||
        field.keyboardType.index == TextInputType.none.index) {
      _letGo();
      return;
    }
    final controller = field.controller;
    final dock = KeyboardDock.instance;
    final active = dock.active.value;
    // The box's own keyboard is already up for it.
    if (active != null && !identical(active, _ask) && identical(active.controller, controller)) {
      _letGo();
      return;
    }
    if (_ask != null && identical(_ask!.controller, controller)) return;
    _letGo();

    final type = field.keyboardType;
    final mode = type.index == TextInputType.number.index || type.index == TextInputType.phone.index
        ? (type.decimal == true ? PosKeyboardMode.decimal : PosKeyboardMode.number)
        : PosKeyboardMode.text;
    final ask = _ask = KeyboardRequest(
      controller: controller,
      mode: mode,
      autoCapitalise: mode == PosKeyboardMode.text && field.textCapitalization != TextCapitalization.none,
      submitLabel: 'Done',
      onSubmit: () {
        field.onSubmitted?.call(controller.text);
        // Done means finished with this box: the keyboard goes with it.
        focus?.unfocus();
      },
    );
    dock.show(context!, ask);
    // Ours is the input method: Windows' own touch keyboard stays away, as it
    // does for the boxes that say so with `keyboardType: none`.
    unawaited(SystemChannels.textInput.invokeMethod<void>('TextInput.hide').catchError((_) {}));
  }

  static void _letGo() {
    final ask = _ask;
    _ask = null;
    if (ask != null) KeyboardDock.instance.release(ask);
  }
}
