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

  /// Set by tests and by the screenshot harness.
  @visibleForTesting
  static set debugTv(bool value) => _tv = value;

  static Future<void> load() async {
    if (!Platform.isAndroid) return;
    try {
      final info = await const MethodChannel('com.vesopa.go/dojo').invokeMapMethod<String, Object?>('deviceInfo');
      _tv = info?['tv'] == true;
    } catch (_) {
      _tv = false;
    }
    if (_tv) FocusManager.instance.highlightStrategy = FocusHighlightStrategy.alwaysTraditional;
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
    if (!GoDevice.isTv) return child;
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
  @override
  void invoke(DirectionalFocusIntent intent) {
    final focus = primaryFocus;
    if (focus == null) return;
    if (focus.context?.widget is EditableText && (intent.direction == TraversalDirection.left || intent.direction == TraversalDirection.right)) {
      // Inside a text box the left and right keys move the caret.
      return;
    }
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
/// every button, tile and field. Applied on a TV only.
ThemeData tvFocusTheme(ThemeData base) {
  if (!GoDevice.isTv) return base;
  const ring = BorderSide(color: Tp.lime, width: 3);
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
