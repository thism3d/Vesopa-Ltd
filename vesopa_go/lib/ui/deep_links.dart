/// Links into Go from outside it (owner, 2026-11-18: "Scanning a QR from the
/// TV opening a browser page, I want to use deeplink to the app").
///
/// A screen or TV shows a QR holding https://go.vesopa.com/link/?c=CODE. On a
/// phone or iPad with Go, the camera opens Go itself (iOS universal links:
/// `applinks:go.vesopa.com`; Android verified app links, AndroidManifest.xml),
/// straight at "Connect <the TV's name>?" (link_screen_page.dart). Without Go,
/// the same address is a web page that says how to get it.
library;

import 'dart:async';

import 'package:app_links/app_links.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/session.dart';
import 'go_frame.dart' show goNavigator;
import 'pages/link_screen_page.dart' show connectScreenCode, linkCodeFrom;
import 'tv.dart';

class GoLinks extends ConsumerStatefulWidget {
  const GoLinks({super.key, required this.child});
  final Widget child;
  @override
  ConsumerState<GoLinks> createState() => _GoLinksState();
}

class _GoLinksState extends ConsumerState<GoLinks> {
  StreamSubscription<Uri>? _links;
  String? _waiting;

  @override
  void initState() {
    super.initState();
    // A TV is the screen being connected, never the one connecting.
    if (GoDevice.isTv) return;
    try {
      _links = AppLinks().uriLinkStream.listen(_open, onError: (_) {});
    } catch (_) {
      // No link plugin on this platform (tests, desktop): nothing to hear.
    }
  }

  @override
  void dispose() {
    _links?.cancel();
    super.dispose();
  }

  void _open(Uri uri) {
    if (uri.host != 'go.vesopa.com' || !uri.path.startsWith('/link')) return;
    final code = linkCodeFrom(uri.toString());
    if (code == null) return;
    _waiting = code;
    _tryConnect();
  }

  /// Once the device is signed in to its venue (it may be on the PIN pad or
  /// still opening when the link arrives).
  Future<void> _tryConnect() async {
    final code = _waiting;
    if (code == null) return;
    final s = ref.read(tapProvider);
    final context = goNavigator.currentState?.overlay?.context;
    if (context == null) return;
    if (s.demo || (s.phase != Phase.ready && s.phase != Phase.locked)) {
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(const SnackBar(
        content: Text('Sign in to your venue in Vesopa Go first, then scan the screen\'s code again.'),
      ));
      _waiting = null;
      return;
    }
    _waiting = null;
    await connectScreenCode(context, ref, code);
  }

  @override
  Widget build(BuildContext context) {
    ref.listen(tapProvider.select((s) => s.phase), (_, _) {
      if (_waiting != null) unawaited(_tryConnect());
    });
    return widget.child;
  }
}
