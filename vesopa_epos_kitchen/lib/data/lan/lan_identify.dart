/// "This is the device you picked" (2026-11-02): Vesopa support's Identify, from
/// the till or the back office, puts a banner across this device's screen for
/// ten seconds and sounds an alert, so somebody can tell which box in a kitchen
/// it is. Wraps the app, above every page. Shared like lan_link.dart.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'lan_service.dart';

class LanIdentifyBanner extends StatefulWidget {
  const LanIdentifyBanner({super.key, required this.child});

  final Widget child;

  @override
  State<LanIdentifyBanner> createState() => _LanIdentifyBannerState();
}

class _LanIdentifyBannerState extends State<LanIdentifyBanner> {
  StreamSubscription<String>? _requests;
  Timer? _hide;
  String? _message;

  @override
  void initState() {
    super.initState();
    _requests = LanService.instance.identifyRequests.listen((message) {
      if (!mounted) return;
      SystemSound.play(SystemSoundType.alert);
      setState(() => _message = message);
      _hide?.cancel();
      _hide = Timer(const Duration(seconds: 10), () {
        if (mounted) setState(() => _message = null);
      });
    });
  }

  @override
  void dispose() {
    _requests?.cancel();
    _hide?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final message = _message;
    return Directionality(
      textDirection: TextDirection.ltr,
      child: Stack(
        fit: StackFit.passthrough,
        children: [
          widget.child,
          if (message != null)
            Positioned(
              left: 0,
              right: 0,
              top: 0,
              child: Material(
                color: const Color(0xFFA6CE12),
                elevation: 12,
                child: Padding(
                  padding: const EdgeInsets.all(28),
                  child: Text(
                    message,
                    textAlign: TextAlign.center,
                    style: const TextStyle(color: Colors.black, fontSize: 34, fontWeight: FontWeight.w800),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}
