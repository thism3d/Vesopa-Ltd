import 'package:flutter/material.dart';

import 'keyboard_dock.dart';

export 'keyboard_dock.dart'
    show KeyboardDock, KeyboardInsets, KeyboardLayout, KeyboardRequest, KeyboardSize, PosKeyboardMode;

/// A field's keyboard on the till.
///
/// A till is a touch screen on a counter. Some have a keyboard behind them and
/// most do not, and every field that asks for words or numbers is unusable on
/// the ones that do not. This asks for the till's one keyboard — the iPad-style
/// keyboard docked along the bottom of the window (keyboard_dock.dart; owner,
/// 2026-11-20: "Replace all field's keyboard with this new keyboard") — while
/// it is on screen, and lets go of it when it is not. It draws nothing itself.
///
/// **Mounted by the field that needs it, never installed globally.** A
/// keyboard that *can* appear over the sale grid is a keyboard that *will*
/// appear over it, mid-queue, because somebody's sleeve brushed a line. It
/// appears where it is asked for.
class OnScreenKeyboard extends StatefulWidget {
  const OnScreenKeyboard({
    super.key,
    required this.controller,
    this.onSubmit,
    this.submitLabel = 'Done',
    this.mode = PosKeyboardMode.text,
    this.autoCapitalise = false,
  });

  final TextEditingController controller;

  /// The return key. Null leaves it greyed out, for a field with nothing to
  /// submit to yet — which is how a dialog greys it out while the field is
  /// empty.
  final VoidCallback? onSubmit;

  final String submitLabel;

  /// Letters, or the number pad for covers and quantities (with a point for a
  /// price).
  final PosKeyboardMode mode;

  /// Text: a capital at the start and after each sentence, as an iPad.
  final bool autoCapitalise;

  @override
  State<OnScreenKeyboard> createState() => _OnScreenKeyboardState();
}

class _OnScreenKeyboardState extends State<OnScreenKeyboard> {
  KeyboardRequest? _ask;

  KeyboardRequest _request() => KeyboardRequest(
        controller: widget.controller,
        onSubmit: widget.onSubmit,
        submitLabel: widget.submitLabel,
        mode: widget.mode,
        autoCapitalise: widget.autoCapitalise,
      );

  void _askForKeyboard() {
    final ask = _ask = _request();
    // Not in the middle of this build: the keyboard is an overlay.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && identical(_ask, ask)) KeyboardDock.instance.show(context, ask);
    });
  }

  void _letGo() {
    final ask = _ask;
    _ask = null;
    if (ask != null) KeyboardDock.instance.release(ask);
  }

  @override
  void initState() {
    super.initState();
    KeyboardSize.load();
    _askForKeyboard();
  }

  @override
  void didUpdateWidget(OnScreenKeyboard old) {
    super.didUpdateWidget(old);
    final ask = _ask;
    if (ask == null) return _askForKeyboard();
    if (!identical(ask.controller, widget.controller)) {
      // Another box in the same dialog: the keyboard types into it now.
      _letGo();
      _askForKeyboard();
      return;
    }
    ask
      ..onSubmit = widget.onSubmit
      ..submitLabel = widget.submitLabel
      ..mode = widget.mode
      ..autoCapitalise = widget.autoCapitalise;
    KeyboardDock.instance.changed(ask);
  }

  @override
  void dispose() {
    _letGo();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => const SizedBox.shrink();
}
