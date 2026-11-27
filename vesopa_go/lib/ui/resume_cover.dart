/// Back from the background (owner, 2026-11-27): the Vesopa mark full screen
/// with a loading bar while the venue's menu, staff and bills are fetched
/// again behind it, then the page as it was, with the new data in place. It
/// says nothing about what is being fetched. And on a TV, quitting asks first.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../counter/ui/brand.dart';
import 'go_frame.dart';
import 'theme.dart';

class ResumeCover extends StatefulWidget {
  const ResumeCover({super.key, required this.child, required this.onResume});
  final Widget child;

  /// Fetch the venue again; the cover lifts after a moment either way.
  final VoidCallback onResume;

  @override
  State<ResumeCover> createState() => _ResumeCoverState();
}

class _ResumeCoverState extends State<ResumeCover> {
  late final AppLifecycleListener _life;
  DateTime? _away;
  bool _shown = false;
  Timer? _lift;

  @override
  void initState() {
    super.initState();
    _life = AppLifecycleListener(
      onHide: () => _away ??= DateTime.now(),
      onShow: _back,
    );
  }

  void _back() {
    final away = _away;
    _away = null;
    // A glance at another app is not worth a cover; a few seconds away is.
    if (away == null || DateTime.now().difference(away) < const Duration(seconds: 8)) return;
    widget.onResume();
    setState(() => _shown = true);
    _lift?.cancel();
    _lift = Timer(const Duration(milliseconds: 1100), () {
      if (mounted) setState(() => _shown = false);
    });
  }

  @override
  void dispose() {
    _life.dispose();
    _lift?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Stack(fit: StackFit.expand, children: [
        widget.child,
        IgnorePointer(
          ignoring: !_shown,
          child: AnimatedOpacity(
            opacity: _shown ? 1 : 0,
            duration: const Duration(milliseconds: 220),
            child: _shown || _lift != null
                ? ColoredBox(
                    color: Tp.ink,
                    child: Center(
                      child: Column(mainAxisSize: MainAxisSize.min, children: [
                        const GoMark(size: 88),
                        const SizedBox(height: 26),
                        SizedBox(
                          width: 180,
                          child: ClipRRect(
                            borderRadius: BorderRadius.circular(99),
                            child: LinearProgressIndicator(minHeight: 5, color: Tp.lime, backgroundColor: Colors.white12),
                          ),
                        ),
                      ]),
                    ),
                  )
                : const SizedBox.shrink(),
          ),
        ),
      ]);
}

/// "Quit Vesopa Go?" on a TV: OK closes the app, Cancel stays.
Future<void> askToQuit() async {
  final ctx = goNavigator.currentContext;
  if (ctx == null) return;
  final quit = await showDialog<bool>(
    context: ctx,
    builder: (c) => AlertDialog(
      icon: const Icon(Icons.exit_to_app_rounded, size: 40),
      title: const Text('Quit Vesopa Go?'),
      content: const Text('This screen stops showing the kitchen or the customer display until Vesopa Go is opened again.'),
      actions: [
        TextButton(autofocus: true, onPressed: () => Navigator.pop(c, false), child: const Text('Stay')),
        FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('OK, quit')),
      ],
    ),
  );
  if (quit == true) await SystemNavigator.pop();
}
