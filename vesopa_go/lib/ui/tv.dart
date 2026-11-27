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
import 'package:flutter/scheduler.dart';
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

  /// What the device says about itself (model, Android version, the name
  /// set on it), for "About this screen" on the phone's remote.
  static Map<String, Object?> details = const {};

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
      details = {
        'model': info?['model'],
        'brand': info?['brand'],
        'android': info?['release'],
        'sdk': info?['sdk'],
        'deviceName': info?['deviceName'],
      };
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
    if (event is! KeyDownEvent || !_remoteKeys.contains(event.logicalKey)) return false;
    if (!remote.value) _useRemote();
    // The screen switched off from the phone: any key wakes it, and does
    // nothing else.
    if (screenOff.value) {
      screenOff.value = false;
      return true;
    }
    // Nothing has the focus (just after a page or a sheet opened, or a switch
    // of mode): the key goes nowhere, which is why the D-pad seemed dead
    // (owner, 2026-11-27). The first key gives the focus to the first thing on
    // the page instead.
    return focusSomething();
  }

  /// The screen blanked by the phone's power key; a key or the phone wakes it.
  static final screenOff = ValueNotifier<bool>(false);

  /// When nothing on the top page has the focus, give it to its first item.
  /// Answers whether it had to.
  static bool focusSomething() {
    final focus = FocusManager.instance.primaryFocus;
    final hasItem = focus != null && focus is! FocusScopeNode && focus.context != null && focus.context!.mounted;
    if (hasItem) return false;
    final scope = topScope();
    if (scope == null) return false;
    final first = scope.traversalDescendants.where((n) => n.canRequestFocus && n.context != null && n is! FocusScopeNode).firstOrNull;
    if (first == null) return false;
    first.requestFocus();
    final c = first.context;
    if (c != null) Scrollable.ensureVisible(c, alignment: 0.5, duration: const Duration(milliseconds: 150));
    return true;
  }

  /// The scope of the page on top (a sheet or dialog when one is open).
  static FocusScopeNode? topScope() {
    final focus = FocusManager.instance.primaryFocus;
    var scope = focus?.nearestScope ?? FocusManager.instance.rootScope;
    // Down to the deepest scope that has the focus (the open route's).
    while (true) {
      final next = scope.focusedChild;
      if (next is FocusScopeNode && next != scope) {
        scope = next;
      } else {
        break;
      }
    }
    if (scope == FocusManager.instance.rootScope) {
      // Nothing chosen yet: the last route's scope, which is the one on top.
      FocusScopeNode? last;
      void walk(FocusNode n) {
        for (final c in n.children) {
          if (c is FocusScopeNode && c.canRequestFocus && c.context != null) last = c;
          walk(c);
        }
      }
      walk(scope);
      return last ?? scope;
    }
    return scope;
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
    final inner = !Platform.isAndroid
        ? child
        : Shortcuts(
            shortcuts: _keys,
            child: Actions(
              actions: {
                DirectionalFocusIntent: _MoveOrScroll(),
              },
              child: FocusTraversalGroup(policy: ReadingOrderTraversalPolicy(), child: child),
            ),
          );
    return Stack(fit: StackFit.expand, children: [
      // On a TV, one layout for every set (owner, 2026-11-27: "maintaining
      // the ratio properly ... same to watch from every TV").
      GoDevice.isTv ? TvCanvas(child: inner) : inner,
      // Where the remote is, drawn round whatever has the focus, whatever it
      // is (owner, 2026-11-27: "box not highlighted properly").
      const IgnorePointer(child: _FocusRing()),
      // The phone's power key: the screen dark until a key or the phone.
      ValueListenableBuilder<bool>(
        valueListenable: GoDevice.screenOff,
        builder: (_, off, _) => off
            ? GestureDetector(onTap: () => GoDevice.screenOff.value = false, child: const ColoredBox(color: Colors.black))
            : const SizedBox.shrink(),
      ),
    ]);
  }
}

/// Every TV draws Go on the same canvas: 540 points high (1080p at 2×), as
/// wide as the panel's own shape, scaled up evenly to its real pixels. A
/// 720p, 1080p or 4K set, whatever density its maker chose, shows the same
/// layout at the same proportions; a 21:9 or 4:3 panel gets a wider or
/// narrower canvas rather than squashed boxes or black bars.
class TvCanvas extends StatelessWidget {
  const TvCanvas({super.key, required this.child});
  final Widget child;

  static const designHeight = 540.0;

  @override
  Widget build(BuildContext context) {
    final mq = MediaQuery.of(context);
    final size = mq.size;
    if (size.height <= 0 || (size.height - designHeight).abs() < 1) return child;
    final scale = size.height / designHeight;
    final canvas = Size(size.width / scale, designHeight);
    return ClipRect(
      child: FittedBox(
        fit: BoxFit.fill,
        alignment: Alignment.topLeft,
        child: SizedBox.fromSize(
          size: canvas,
          child: MediaQuery(
            data: mq.copyWith(
              size: canvas,
              devicePixelRatio: mq.devicePixelRatio * scale,
              padding: mq.padding / scale,
              viewPadding: mq.viewPadding / scale,
              viewInsets: mq.viewInsets / scale,
            ),
            child: child,
          ),
        ),
      ),
    );
  }
}

/// A thick ring in the venue's colour round whatever has the focus, while a
/// remote is in use. It follows the focus as it moves and as lists scroll.
class _FocusRing extends StatefulWidget {
  const _FocusRing();
  @override
  State<_FocusRing> createState() => _FocusRingState();
}

class _FocusRingState extends State<_FocusRing> {
  Rect? _rect;
  ShapeBorder _shape = const RoundedRectangleBorder(borderRadius: BorderRadius.all(Radius.circular(12)));
  bool _shown = false;
  bool _alive = true;
  bool _queued = false;

  @override
  void initState() {
    super.initState();
    // Measured after each frame the app draws anyway (a list scrolled, a
    // page changed) and when the focus moves; never a frame of its own unless
    // the ring has to move, so the app still settles.
    SchedulerBinding.instance.addPersistentFrameCallback((_) => _queue());
    FocusManager.instance.addListener(_queue);
    GoDevice.remote.addListener(_queue);
  }

  void _queue() {
    if (!_alive || _queued) return;
    _queued = true;
    SchedulerBinding.instance.addPostFrameCallback((_) {
      _queued = false;
      if (_alive && mounted) _measure();
    });
  }

  /// The shape the focused control is drawn with (owner, 2026-11-27: "focus
  /// outline ... not matching the border buttons and circular buttons"): the
  /// button's own Material (a circle, a pill, a rounded card), or its
  /// InkWell's border; the box itself when it has none.
  (Rect, ShapeBorder)? _shapeOf(BuildContext c, RenderBox mine) {
    final box = c.findRenderObject();
    if (box is! RenderBox || !box.attached || !box.hasSize) return null;
    Rect rectOf(RenderBox b) => b.localToGlobal(Offset.zero, ancestor: mine) & b.size;
    final own = rectOf(box);
    ShapeBorder? shape;
    Rect rect = own;
    var levels = 0;
    c.visitAncestorElements((e) {
      if (++levels > 12) return false;
      final w = e.widget;
      final r = e.renderObject;
      if (w is InkWell && w.customBorder != null) {
        shape = w.customBorder;
      } else if (w is InkWell && w.borderRadius != null) {
        shape = RoundedRectangleBorder(borderRadius: w.borderRadius!);
      } else if (w is Material && r is RenderBox && r.attached && r.hasSize) {
        final mr = rectOf(r);
        // Only the Material this control is drawn on, not the card or page
        // a whole list sits on.
        if (mr.width * mr.height <= own.width * own.height * 1.8) {
          rect = mr;
          shape ??= w.shape ??
              (w.type == MaterialType.circle
                  ? const CircleBorder()
                  : (w.borderRadius != null ? RoundedRectangleBorder(borderRadius: w.borderRadius!) : null));
        }
        return false;
      }
      return true;
    });
    final side = rect.shortestSide;
    shape ??= RoundedRectangleBorder(borderRadius: BorderRadius.circular(side >= 64 ? 14 : side / 4));
    return (rect, shape!);
  }

  void _measure() {
    if (!GoDevice.remote.value) {
      if (_shown) setState(() => _shown = false);
      return;
    }
    final focus = FocusManager.instance.primaryFocus;
    final c = focus?.context;
    final mine = context.findRenderObject();
    (Rect, ShapeBorder)? got;
    if (focus != null && focus is! FocusScopeNode && c != null && c.mounted && mine is RenderBox && mine.attached) {
      got = _shapeOf(c, mine);
      // A field's focus node can be the whole page's: a box that fills the
      // screen is not drawn.
      if (got != null && got.$1.width * got.$1.height > mine.size.width * mine.size.height * 0.8) got = null;
    }
    if (got == null) {
      if (_shown) setState(() => _shown = false);
      return;
    }
    if (got.$1 != _rect || got.$2 != _shape || !_shown) {
      setState(() {
        _rect = got!.$1;
        _shape = got.$2;
        _shown = true;
      });
    }
  }

  @override
  void dispose() {
    _alive = false;
    FocusManager.instance.removeListener(_queue);
    GoDevice.remote.removeListener(_queue);
    super.dispose();
  }

  static const _gap = 5.0;
  static const _move = Duration(milliseconds: 140);

  @override
  Widget build(BuildContext context) {
    final r = _rect;
    if (r == null) return const SizedBox.shrink();
    // The ring glides to the next control and fades in and out, as on Google
    // TV; it follows the control's own outline, a little outside it.
    return Stack(children: [
      AnimatedPositioned(
        duration: _move,
        curve: Curves.easeOutCubic,
        left: r.left - _gap,
        top: r.top - _gap,
        width: r.width + _gap * 2,
        height: r.height + _gap * 2,
        child: AnimatedOpacity(
          duration: const Duration(milliseconds: 180),
          opacity: _shown ? 1 : 0,
          child: CustomPaint(painter: _RingPainter(_shape, _gap)),
        ),
      ),
    ]);
  }
}

class _RingPainter extends CustomPainter {
  _RingPainter(this.shape, this.gap);
  final ShapeBorder shape;
  final double gap;

  /// The control's outline grown by [gap] all round: a circle stays a
  /// circle, a pill a pill, a card's corners a little rounder.
  Path _outline(Rect r) {
    final inner = r.deflate(gap);
    final s = shape;
    if (s is CircleBorder || inner.width == inner.height && s is StadiumBorder) return Path()..addOval(r);
    if (s is StadiumBorder) return Path()..addRRect(RRect.fromRectAndRadius(r, Radius.circular(r.shortestSide / 2)));
    if (s is RoundedRectangleBorder) {
      final br = s.borderRadius.resolve(TextDirection.ltr);
      Radius grow(Radius x) => Radius.elliptical(x.x + gap, x.y + gap);
      return Path()
        ..addRRect(RRect.fromRectAndCorners(r,
            topLeft: grow(br.topLeft), topRight: grow(br.topRight), bottomLeft: grow(br.bottomLeft), bottomRight: grow(br.bottomRight)));
    }
    return s.getOuterPath(r);
  }

  @override
  void paint(Canvas canvas, Size size) {
    final path = _outline(Offset.zero & size);
    canvas.drawPath(
      path,
      Paint()
        ..color = Tp.lime.withValues(alpha: 0.35)
        ..style = PaintingStyle.stroke
        ..strokeWidth = 8
        ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 8),
    );
    canvas.drawPath(
      path,
      Paint()
        ..color = Tp.lime
        ..style = PaintingStyle.stroke
        ..strokeWidth = 3.5,
    );
  }

  @override
  bool shouldRepaint(_RingPainter old) => old.shape != shape || old.gap != gap;
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
    if (GoDevice.focusSomething()) return;
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
