/// Vesopa Go on a television.
///
/// An Android TV, a Google TV or a Fire TV has a remote and nothing else: no
/// touch, no browser, no camera. The owner, 2026-11-16: "With the remote I am
/// unable to do any work on the TV. There is no touch, and the remote only
/// goes left and right." Three things follow, and they are all here:
///
///   * Focus is always drawn. Flutter hides the focus ring until it has seen a
///     key, and draws it faintly; on a TV the ring is the only cursor there
///     is, so it is forced on and made unmistakable ([tvFocusTheme]).
///   * The remote's keys mean what they mean on every TV app: the arrows move,
///     OK presses, Back goes back ([TvRemote]). A scrolling list no longer
///     swallows Up and Down.
///   * A TV starts as a screen: it shows a code to scan instead of a sign-in
///     page it could not complete (ui/pages/link_screen_page.dart).
library;

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'theme.dart';

class GoDevice {
  static bool _tv = false;

  /// Whether this is a television. False until [load] has answered.
  static bool get isTv => _tv;

  /// Whether a remote (or a D-pad) is driving the app: a television, or any
  /// box that has sent an arrow or OK key. Many Android TV boxes call
  /// themselves tablets (no leanback, normal UI mode), so the first key from
  /// the remote turns the remote's behaviour on as well (owner, 2026-11-18:
  /// "left right up down button not working").
  static final remote = ValueNotifier<bool>(false);

  /// Set by tests and by the screenshot harness.
  @visibleForTesting
  static set debugTv(bool value) {
    _tv = value;
    remote.value = value;
  }

  static bool _listening = false;

  static bool _camera = true;
  static bool _nfc = true;
  static bool _touch = true;

  /// A camera to scan codes with. A TV, a Fire TV stick or a box has none.
  static bool get hasCamera => _camera;

  /// NFC hardware, for member cards, staff fobs and Tap to Pay.
  static bool get hasNfc => _nfc;

  /// A touchscreen. False on a television: only the remote.
  static bool get hasTouch => _touch;

  @visibleForTesting
  static void debugHardware({bool camera = true, bool nfc = true, bool touch = true}) {
    _camera = camera;
    _nfc = nfc;
    _touch = touch;
  }

  static Future<void> load() async {
    if (!_listening) {
      _listening = true;
      HardwareKeyboard.instance.addHandler(_noticeKey);
    }
    if (!Platform.isAndroid) return;
    try {
      final info = await const MethodChannel('com.vesopa.go/device').invokeMapMethod<String, Object?>('deviceInfo');
      _tv = info?['tv'] == true;
      // Older builds of the native side did not answer these: assume a phone.
      _camera = info?['camera'] != false && !(_tv && info?['camera'] == null);
      _nfc = info?['nfcHardware'] != false && !(_tv && info?['nfcHardware'] == null);
      _touch = info?['touch'] != false && !(_tv && info?['touch'] == null);
    } catch (_) {
      _tv = false;
    }
    if (_tv) _useRemote();
  }

  static final _remoteKeys = <LogicalKeyboardKey>{
    LogicalKeyboardKey.arrowUp,
    LogicalKeyboardKey.arrowDown,
    LogicalKeyboardKey.arrowLeft,
    LogicalKeyboardKey.arrowRight,
    LogicalKeyboardKey.select,
    LogicalKeyboardKey.gameButtonA,
    LogicalKeyboardKey.contextMenu,
  };

  static bool _noticeKey(KeyEvent event) {
    if (!remote.value && event is KeyDownEvent && _remoteKeys.contains(event.logicalKey)) _useRemote();
    return false;
  }

  static void _useRemote() {
    FocusManager.instance.highlightStrategy = FocusHighlightStrategy.alwaysTraditional;
    if (!remote.value) remote.value = true;
  }
}

/// Something to press that the remote can reach as well as a finger: it takes
/// the focus, draws the lime ring while it has it, and OK presses it. For the
/// custom tiles that were a bare GestureDetector, which a remote cannot reach.
class TvTap extends StatefulWidget {
  const TvTap({super.key, required this.onTap, required this.child, this.radius = 14, this.onLongPress, this.label});
  final VoidCallback? onTap;
  final VoidCallback? onLongPress;
  final Widget child;
  final double radius;
  final String? label;
  @override
  State<TvTap> createState() => _TvTapState();
}

class _TvTapState extends State<TvTap> {
  bool _focused = false;

  @override
  Widget build(BuildContext context) {
    final on = widget.onTap != null;
    return Semantics(
      button: true,
      label: widget.label,
      child: FocusableActionDetector(
        enabled: on,
        onShowFocusHighlight: (v) => setState(() => _focused = v),
        actions: {
          ActivateIntent: CallbackAction<ActivateIntent>(onInvoke: (_) {
            widget.onTap?.call();
            return null;
          }),
        },
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: widget.onTap,
          onLongPress: widget.onLongPress,
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 140),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(widget.radius),
              border: Border.all(color: _focused ? Tp.lime : Colors.transparent, width: 3),
              color: _focused ? Tp.lime.withValues(alpha: 0.12) : Colors.transparent,
            ),
            child: widget.child,
          ),
        ),
      ),
    );
  }
}

/// The remote, for everything under it.
///
/// Flutter already turns the arrow keys into "move focus" and Select into
/// "press" at the top of the app. What it does not do is win against a
/// scrollable, which takes Up and Down for itself and leaves the focus where
/// it was: the fault the owner described. Here the arrows always try to move
/// the focus first; only when there is nowhere to go does the list scroll.
class TvRemote extends StatelessWidget {
  const TvRemote({super.key, required this.child});
  final Widget child;

  static final _keys = <ShortcutActivator, Intent>{
    const SingleActivator(LogicalKeyboardKey.arrowUp): const DirectionalFocusIntent(TraversalDirection.up),
    const SingleActivator(LogicalKeyboardKey.arrowDown): const DirectionalFocusIntent(TraversalDirection.down),
    const SingleActivator(LogicalKeyboardKey.arrowLeft): const DirectionalFocusIntent(TraversalDirection.left),
    const SingleActivator(LogicalKeyboardKey.arrowRight): const DirectionalFocusIntent(TraversalDirection.right),
    const SingleActivator(LogicalKeyboardKey.select): const ActivateIntent(),
    const SingleActivator(LogicalKeyboardKey.enter): const ActivateIntent(),
    const SingleActivator(LogicalKeyboardKey.numpadEnter): const ActivateIntent(),
    const SingleActivator(LogicalKeyboardKey.gameButtonA): const ActivateIntent(),
    const SingleActivator(LogicalKeyboardKey.mediaPlayPause): const ActivateIntent(),
  };

  @override
  Widget build(BuildContext context) {
    // The same shape always (a widget that came and went would rebuild the
    // whole app under it); on Android the arrows move the focus or scroll.
    if (!Platform.isAndroid) return child;
    return Shortcuts(
      shortcuts: _keys,
      child: Actions(
        actions: {
          DirectionalFocusIntent: _MoveOrScroll(),
        },
        child: FocusTraversalGroup(policy: ReadingOrderTraversalPolicy(), child: child),
      ),
    );
  }
}

/// Move the focus; where it cannot move, scroll what is under it instead.
class _MoveOrScroll extends Action<DirectionalFocusIntent> {
  /// Inside a text box the left and right keys move the caret: the action
  /// stands aside, so the key goes on to the text box's own shortcuts.
  @override
  bool isEnabled(DirectionalFocusIntent intent, [BuildContext? context]) {
    final inText = primaryFocus?.context?.widget is EditableText;
    return !(inText && (intent.direction == TraversalDirection.left || intent.direction == TraversalDirection.right));
  }

  @override
  void invoke(DirectionalFocusIntent intent) {
    final focus = primaryFocus;
    if (focus == null) return;
    if (focus.focusInDirection(intent.direction)) {
      final context = primaryFocus?.context;
      if (context != null) {
        Scrollable.ensureVisible(context, alignment: 0.5, duration: const Duration(milliseconds: 180), curve: Curves.easeOut);
      }
      return;
    }
    final context = focus.context;
    if (context == null) return;
    final scroll = Scrollable.maybeOf(context);
    if (scroll == null) return;
    final position = scroll.position;
    final step = position.viewportDimension * 0.6;
    final down = intent.direction == TraversalDirection.down || intent.direction == TraversalDirection.right;
    final axisMatches = switch (intent.direction) {
      TraversalDirection.up || TraversalDirection.down => position.axis == Axis.vertical,
      _ => position.axis == Axis.horizontal,
    };
    if (!axisMatches) return;
    position.animateTo(
      (position.pixels + (down ? step : -step)).clamp(position.minScrollExtent, position.maxScrollExtent),
      duration: const Duration(milliseconds: 200),
      curve: Curves.easeOut,
    );
  }
}

/// The theme with a focus ring nobody can miss from a sofa: a lime outline on
/// every button, tile and field. Applied once a remote is in use
/// ([GoDevice.remote]); main.dart rebuilds the theme when that changes.
ThemeData tvFocusTheme(ThemeData base) {
  if (!GoDevice.remote.value) return base;
  final ring = BorderSide(color: Tp.lime, width: 3);
  WidgetStateProperty<BorderSide?> side(BorderSide? rest) =>
      WidgetStateProperty.resolveWith((states) => states.contains(WidgetState.focused) ? ring : rest);
  final lime = Tp.lime.withValues(alpha: 0.28);
  ButtonStyle focused(ButtonStyle? style, {BorderSide? rest}) => (style ?? const ButtonStyle()).copyWith(
        side: side(rest),
        overlayColor: WidgetStateProperty.resolveWith((states) => states.contains(WidgetState.focused) ? lime : null),
      );
  return base.copyWith(
    focusColor: lime,
    filledButtonTheme: FilledButtonThemeData(style: focused(base.filledButtonTheme.style)),
    elevatedButtonTheme: ElevatedButtonThemeData(style: focused(base.elevatedButtonTheme.style)),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: focused(base.outlinedButtonTheme.style, rest: BorderSide(color: base.colorScheme.outline)),
    ),
    textButtonTheme: TextButtonThemeData(style: focused(base.textButtonTheme.style)),
    iconButtonTheme: IconButtonThemeData(style: focused(base.iconButtonTheme.style)),
    listTileTheme: base.listTileTheme.copyWith(selectedTileColor: lime),
  );
}
