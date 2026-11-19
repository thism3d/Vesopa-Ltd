/// Vesopa Go on a phone or tablet as the remote for the venue's TVs (owner,
/// 2026-11-19: "Add options to the Vesopa Go mobile app properly to control
/// the TV kitchen and TV customer display").
///
/// A screen (Kitchen or Customer display) says it is here every ten seconds
/// ([ScreenBeacon]); a phone lists the screens and presses keys on one
/// (lib/remote/remote_page.dart); the back office passes each key at once
/// over the venue's live connection as `go.remote` (vesopa_server
/// src/go_remote.js), and the screen with that id acts on it here, as if its
/// own remote had been pressed.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/widgets.dart';

import '../ui/go_frame.dart';
import '../ui/tv.dart';

class GoRemote {
  GoRemote._();

  /// A page that knows better than the default what a key means (the
  /// customer display's adverts, its settings): answers true when it took it.
  static final _handlers = <bool Function(String key)>[];

  static void listen(bool Function(String key) handler) => _handlers.add(handler);
  static void forget(bool Function(String key) handler) => _handlers.remove(handler);

  /// A key from the phone. The page on top gets it first; else the arrows
  /// move the focus, OK presses what has it and Back goes back, exactly as
  /// the TV's own remote does.
  static void press(String key) {
    // The remote is in use: draw the focus as the TV's own remote would.
    FocusManager.instance.highlightStrategy = FocusHighlightStrategy.alwaysTraditional;
    for (final h in _handlers.reversed.toList()) {
      if (h(key)) return;
    }
    final focus = FocusManager.instance.primaryFocus;
    switch (key) {
      case 'up':
        focus?.focusInDirection(TraversalDirection.up);
      case 'down':
        focus?.focusInDirection(TraversalDirection.down);
      case 'left':
        focus?.focusInDirection(TraversalDirection.left);
      case 'right':
        focus?.focusInDirection(TraversalDirection.right);
      case 'ok':
        final c = focus?.context;
        if (c != null) Actions.maybeInvoke(c, const ActivateIntent());
      case 'back':
        goNavigator.currentState?.maybePop();
    }
  }
}

/// While a screen is open: "I am here" to the back office every ten
/// seconds, so the phone's remote can find it.
class ScreenBeacon {
  ScreenBeacon(this._hello);

  final Future<void> Function() _hello;
  Timer? _timer;

  void start() {
    unawaited(_beat());
    _timer = Timer.periodic(const Duration(seconds: 10), (_) => unawaited(_beat()));
  }

  Future<void> _beat() async {
    try {
      await _hello();
    } catch (_) {
      // Offline for a moment: the next beat says it again.
    }
  }

  void stop() => _timer?.cancel();

  static bool get isTv => GoDevice.isTv;
}
