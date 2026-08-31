/// Which piece of glass this window lives on.
///
/// The deployment this application was written for is one PC with two screens:
/// the till on one, this on the other. Nothing about that is automatic. A
/// Flutter window opens where Windows puts it, which is the primary screen —
/// the till's screen — at whatever size the runner asked for, and it stays
/// there until somebody drags it across and maximises it.
///
/// That somebody is a manager on install day. The person opening up at seven
/// the next morning is not, and a customer display showing a title bar and half
/// the till's wallpaper is the fault this file exists to prevent. So the screen
/// is a setting, it is remembered, and it is applied on every start.
///
/// IDENTIFYING A MONITOR ACROSS A RESTART
///
/// Windows gives each monitor a hardware id (`\?\DISPLAY#DELA0C1#...`) which
/// belongs to the *panel*, and a slot name (`\.\DISPLAY2`) which belongs to
/// the port it happens to be plugged into. The hardware id is stored, because
/// a venue that unplugs both screens to move the counter and plugs them back
/// the other way round should not end up with the bill facing the wall.
///
/// It is not always available — Windows returns an empty id for some virtual
/// and remote-session displays — so the slot name is kept as a fallback and
/// either will match. A screen that has genuinely gone (unplugged, failed,
/// swapped) matches nothing, and that case is deliberately left alone: see
/// [placeWindow].
library;

import 'dart:async';
import 'dart:ui';

import 'package:flutter/foundation.dart';
import 'package:screen_retriever/screen_retriever.dart';
import 'package:window_manager/window_manager.dart';

/// One monitor, as somebody standing in front of it would pick it out.
@immutable
class Screen {
  const Screen({
    required this.index,
    required this.id,
    required this.slot,
    required this.bounds,
    required this.isPrimary,
  });

  /// Its place in the list, from 1. What the settings screen counts by, because
  /// "Screen 2" is the only name for a monitor that a manager can act on.
  final int index;

  /// The panel's hardware id. Empty when Windows would not give one.
  final String id;

  /// The port it is plugged into — `\.\DISPLAY2`.
  final String slot;

  /// Where it sits on the desktop, in logical pixels.
  final Rect bounds;

  final bool isPrimary;

  /// What is stored to find this monitor again. See the note at the top for why
  /// the hardware id is preferred and why there is a fallback at all.
  String get key => id.isNotEmpty ? id : slot;

  /// Whether [storedKey] refers to this monitor. Either identifier counts, so a
  /// display set up on a build that could read the hardware id still matches on
  /// a machine or session where that comes back empty.
  bool matches(String storedKey) =>
      storedKey.isNotEmpty && (storedKey == id || storedKey == slot);

  /// How it is offered in Settings: something that can be checked against the
  /// monitors actually on the counter.
  String get label {
    final size = '${bounds.width.round()} x ${bounds.height.round()}';
    return 'Screen $index  ·  $size${isPrimary ? '  ·  the till\'s screen' : ''}';
  }
}

/// The monitors attached right now.
///
/// Returns an empty list rather than throwing on a machine where the enquiry
/// fails. The settings screen then says it cannot see any, and the window is
/// left exactly where it opened, which is a display somebody can still drag.
Future<List<Screen>> listScreens() async {
  try {
    final displays = await screenRetriever.getAllDisplays();
    final primary = await screenRetriever.getPrimaryDisplay();

    return [
      for (final (i, d) in displays.indexed)
        Screen(
          index: i + 1,
          id: d.id,
          slot: d.name ?? '',
          bounds: _boundsOf(d),
          // Compared by position rather than by id: the primary display comes
          // back from a second call into the plugin and its id is built by the
          // same enumeration that can return an empty string.
          isPrimary: d.visiblePosition == primary.visiblePosition,
        ),
    ];
  } catch (_) {
    return const [];
  }
}

Rect _boundsOf(Display d) {
  final at = d.visiblePosition ?? Offset.zero;
  return Rect.fromLTWH(at.dx, at.dy, d.size.width, d.size.height);
}

/// Put this window on [screenKey], and fill that screen if asked.
///
/// The two are independent: an empty [screenKey] means "leave it where Windows
/// opened it", not "do nothing". See inside for why that distinction was worth
/// making.
///
/// Nothing here throws.
Future<void> placeWindow({
  required String screenKey,
  required bool fullScreen,
}) async {
  try {
    // Moving and filling are two separate questions, and they were once wrongly
    // treated as one. A single-screen machine — a demo, a tablet beside the
    // till, every developer's desk — has no screen worth choosing and still
    // wants full screen, and gating the fill on the choice meant the toggle did
    // nothing at all there.
    Screen? chosen;

    if (screenKey.isNotEmpty) {
      Screen? target;
      for (final screen in await listScreens()) {
        if (screen.matches(screenKey)) {
          target = screen;
          break;
        }
      }

      // A missing screen is left alone on purpose. If the stored monitor is not
      // attached — somebody is working on the till at home, a screen has
      // failed, the second output is unplugged — the window stays where Windows
      // opened it rather than being moved to whatever is left.
      if (target != null) {
        // Out of full screen before moving. A full-screen window belongs to the
        // monitor it is on and will not be moved off it.
        await windowManager.setFullScreen(false);
        await windowManager.setBounds(_landingRect(target));
        chosen = target;
      }
    }

    if (fullScreen) {
      // Full screen snaps to whichever monitor holds the window, which is why
      // the move above only has to land *somewhere inside* the right one.
      await windowManager.setFullScreen(true);
    } else {
      // Never a bare setFullScreen(false) — see leaveFullScreen for what that
      // leaves behind.
      await leaveFullScreen(onScreen: chosen);
    }
  } catch (_) {
    // Nothing here throws. A window that could not be positioned is a window in
    // the wrong place; a window that threw on startup is no display at all.
  }
}

/// Come out of full screen into a window somebody can actually see.
///
/// **The restore is not optional.** A window that was made full screen before
/// it was ever shown has no earlier size for Windows to put it back to, and
/// `setFullScreen(false)` on its own leaves it at zero by zero — present in the
/// task list, invisible on the glass. That is the worst failure this
/// application has: the manager turns full screen off from the till, the
/// customer screen goes blank, and nothing anywhere says why.
///
/// So leaving full screen always ends with an explicit size. [onScreen], when
/// given, keeps the window on the monitor it belongs to instead of bouncing it
/// back to the primary one.
Future<void> leaveFullScreen({Screen? onScreen}) async {
  try {
    await windowManager.setFullScreen(false);

    // Only when it actually came back wrong. A window Windows restored
    // properly is left alone rather than jumped to the middle of the screen
    // under somebody who was reading it.
    final size = await windowManager.getSize();
    if (size.width >= 320 && size.height >= 240) return;

    if (onScreen != null) {
      await windowManager.setBounds(_landingRect(onScreen));
    } else {
      await windowManager.setSize(const Size(1280, 720));
      await windowManager.center();
    }
  } catch (_) {
    // Nothing here throws. See placeWindow.
  }
}

/// A window well inside [screen], rather than filling it.
///
/// Deliberately inset. Monitors can run at different scale factors, and the
/// logical rectangle of one is not the logical rectangle of the other; a window
/// asked to fill the target exactly can round a few pixels over the join and be
/// judged to be on the neighbouring screen — which is the till's. Landing in
/// the middle of the glass cannot round anywhere, and full screen does the
/// filling.
Rect _landingRect(Screen screen) {
  final width = (screen.bounds.width * 0.6).clamp(480.0, 1280.0);
  final height = (screen.bounds.height * 0.6).clamp(360.0, 800.0);
  return Rect.fromLTWH(
    screen.bounds.left + (screen.bounds.width - width) / 2,
    screen.bounds.top + (screen.bounds.height - height) / 2,
    width,
    height,
  );
}
