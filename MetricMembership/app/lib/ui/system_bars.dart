import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// The colours of the phone's own bars, as staff chose them under Appearance
/// in the console (server/src/themes.js, delivered in /api/v1/brand).
class BarTheme {
  const BarTheme({required this.stops, required this.bottom, required this.dark, required this.animated});

  factory BarTheme.fromJson(Map<String, dynamic> j) {
    final stops = [for (final s in (j['stops'] as List? ?? const [])) _hex(s as String)];
    return BarTheme(
      stops: stops.isEmpty ? metric.stops : stops,
      bottom: j['bottom'] is String ? _hex(j['bottom'] as String) : metric.bottom,
      dark: j['dark'] != false,
      animated: j['motion'] != 'still',
    );
  }

  static const metric = BarTheme(
    stops: [Color(0xFF002788), Color(0xFF00144D), Color(0xFF1D3FA8)],
    bottom: Color(0xFF002788),
    dark: true,
    animated: true,
  );

  final List<Color> stops;
  final Color bottom;
  final bool dark;
  final bool animated;

  static Color _hex(String s) => Color(int.parse(s.replaceFirst('#', ''), radix: 16) | 0xFF000000);
}

/// The live choice. Starts from the last one this device saw, so the bars
/// don't flash the default while /brand is on its way.
final barTheme = ValueNotifier<BarTheme>(BarTheme.metric);

const _key = 'metric.barTheme.v1';

Future<void> loadSavedBarTheme() async {
  try {
    final saved = (await SharedPreferences.getInstance()).getString(_key);
    if (saved != null) barTheme.value = BarTheme.fromJson(jsonDecode(saved) as Map<String, dynamic>);
  } catch (_) {}
}

Future<void> setBarTheme(Map<String, dynamic> json) async {
  barTheme.value = BarTheme.fromJson(json);
  try {
    await (await SharedPreferences.getInstance()).setString(_key, jsonEncode(json));
  } catch (_) {}
}

/// Paints the strips behind the phone's status bar and navigation bar.
///
/// Android 15 and later draw every app edge to edge and ignore a status bar
/// colour, so the only way to colour the bars natively is to paint under them.
/// On the web the insets are zero and public/theme.js colours the browser's
/// bars instead, so this draws nothing there.
class SystemBars extends StatefulWidget {
  const SystemBars({super.key, required this.child});

  final Widget child;

  @override
  State<SystemBars> createState() => _SystemBarsState();
}

class _SystemBarsState extends State<SystemBars> with SingleTickerProviderStateMixin {
  late final _drift = AnimationController(vsync: this, duration: const Duration(seconds: 7));

  @override
  void initState() {
    super.initState();
    if (!kIsWeb) SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
    barTheme.addListener(_changed);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _sync();
  }

  void _changed() {
    if (!mounted) return;
    _sync();
    setState(() {});
  }

  void _sync() {
    final t = barTheme.value;
    final moving = t.animated && !MediaQuery.disableAnimationsOf(context) && !kIsWeb;
    if (moving && !_drift.isAnimating) _drift.repeat(reverse: true);
    if (!moving) _drift.stop();
    if (!kIsWeb) {
      final icons = t.dark ? Brightness.light : Brightness.dark;
      SystemChrome.setSystemUIOverlayStyle(SystemUiOverlayStyle(
        statusBarColor: Colors.transparent,
        statusBarIconBrightness: icons,
        statusBarBrightness: t.dark ? Brightness.dark : Brightness.light,
        systemNavigationBarColor: t.bottom,
        systemNavigationBarIconBrightness: icons,
        systemNavigationBarContrastEnforced: false,
      ));
    }
  }

  @override
  void dispose() {
    barTheme.removeListener(_changed);
    _drift.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final pad = MediaQuery.viewPaddingOf(context);
    final t = barTheme.value;
    return Stack(
      children: [
        widget.child,
        if (pad.top > 0)
          Positioned(
            top: 0,
            left: 0,
            right: 0,
            height: pad.top,
            child: IgnorePointer(
              child: AnimatedBuilder(
                animation: _drift,
                builder: (context, _) => DecoratedBox(
                  decoration: BoxDecoration(
                    gradient: LinearGradient(
                      colors: t.stops.length > 1 ? t.stops : [t.stops.first, t.stops.first],
                      begin: Alignment(-1 - 2 * _drift.value, 0),
                      end: Alignment(3 - 2 * _drift.value, 0),
                    ),
                  ),
                ),
              ),
            ),
          ),
        if (pad.bottom > 0)
          Positioned(
            left: 0,
            right: 0,
            bottom: 0,
            height: pad.bottom,
            child: IgnorePointer(child: ColoredBox(color: t.bottom)),
          ),
      ],
    );
  }
}
