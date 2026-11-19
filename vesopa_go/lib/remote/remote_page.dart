/// The remote for the venue's TVs, on a phone or tablet (owner, 2026-11-19:
/// "control the TV kitchen and TV customer display app properly using Go
/// Android, iOS/iPad").
///
/// [ScreensRemotePage] lists the Kitchen screens and Customer displays that
/// are on; [RemotePadPage] is the remote for one: the arrows, OK and Back as on
/// the TV's own remote, the adverts on a customer display, Refresh, and
/// Settings, which opens the screen's settings once a manager's PIN has been
/// typed here (a phone has a keyboard, a TV does not).
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/api.dart';
import '../data/session.dart';
import '../modes/mode_settings.dart';
import '../ui/theme.dart';

class RemoteScreen {
  const RemoteScreen({required this.id, required this.name, required this.mode, required this.live, required this.tv});
  final String id;
  final String name;
  final String mode;
  final bool live;
  final bool tv;

  factory RemoteScreen.fromJson(Map<String, dynamic> j) => RemoteScreen(
        id: '${j['device_id'] ?? ''}',
        name: '${j['name'] ?? 'Screen'}',
        mode: '${j['mode'] ?? 'display'}',
        live: j['live'] != false,
        tv: j['tv'] == true,
      );

  String get modeLabel => switch (mode) {
        'kitchen' => 'Kitchen screen',
        'display' => 'Customer display',
        'epos' => 'Till',
        'terminal' => 'Card terminal',
        _ => 'Screen',
      };

  IconData get icon => switch (mode) {
        'kitchen' => Icons.soup_kitchen_rounded,
        _ => tv ? Icons.tv_rounded : Icons.connected_tv_rounded,
      };
}

class ScreensRemotePage extends ConsumerStatefulWidget {
  const ScreensRemotePage({super.key});
  @override
  ConsumerState<ScreensRemotePage> createState() => _ScreensRemotePageState();
}

class _ScreensRemotePageState extends ConsumerState<ScreensRemotePage> {
  List<RemoteScreen>? _screens;
  String? _error;
  Timer? _poll;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
    _poll = Timer.periodic(const Duration(seconds: 6), (_) => unawaited(_load()));
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final r = await ref.read(apiProvider).awakeScreens(ref.read(tapProvider.notifier).deviceId);
      final list = [for (final s in (r['screens'] as List? ?? const [])) RemoteScreen.fromJson(Map<String, dynamic>.from(s as Map))];
      if (mounted) setState(() {
        _screens = list;
        _error = null;
      });
    } on TapApiError catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final screens = _screens;
    return Scaffold(
      appBar: AppBar(title: const Text('Control a screen or TV')),
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(padding: const EdgeInsets.all(16), children: [
          Text('Kitchen screens and customer displays that are on now. Choose one to use this phone as its remote.',
              style: t.bodyMedium?.copyWith(color: context.goMuted)),
          const SizedBox(height: 12),
          if (_error != null) Text(_error!, style: t.bodyMedium?.copyWith(color: Tp.danger)),
          if (screens == null && _error == null) const Padding(padding: EdgeInsets.all(32), child: Center(child: CircularProgressIndicator())),
          if (screens != null && screens.isEmpty)
            Card(
              child: ListTile(
                leading: const Icon(Icons.tv_off_rounded),
                title: const Text('No screens on'),
                subtitle: const Text('Switch the TV on and open Vesopa Go on it. A new TV shows a code: Connect a screen or TV adds it first.'),
              ),
            ),
          for (final s in screens ?? const <RemoteScreen>[])
            Card(
              child: ListTile(
                leading: Icon(s.icon),
                title: Text(s.name),
                subtitle: Text(s.live ? s.modeLabel : '${s.modeLabel} · reconnecting, keys may be slow'),
                trailing: const Icon(Icons.settings_remote_rounded),
                onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => RemotePadPage(screen: s))),
              ),
            ),
        ]),
      ),
    );
  }
}

/// The remote for one screen.
class RemotePadPage extends ConsumerStatefulWidget {
  const RemotePadPage({super.key, required this.screen});
  final RemoteScreen screen;
  @override
  ConsumerState<RemotePadPage> createState() => _RemotePadPageState();
}

class _RemotePadPageState extends ConsumerState<RemotePadPage> {
  bool _sending = false;

  Future<void> _press(String key) async {
    HapticFeedback.selectionClick();
    if (_sending && key != 'up' && key != 'down' && key != 'left' && key != 'right') return;
    _sending = true;
    final messenger = ScaffoldMessenger.of(context);
    try {
      await ref.read(apiProvider).screenKey(widget.screen.id, key);
    } on TapApiError catch (e) {
      messenger.hideCurrentSnackBar();
      messenger.showSnackBar(SnackBar(content: Text(e.message)));
    } finally {
      _sending = false;
    }
  }

  Future<void> _settings() async {
    // The screen's settings are behind a manager's PIN: typed here, on the
    // phone's own keyboard, instead of with a TV remote.
    if (!await askManagerPin(context, ref, why: 'Settings on ${widget.screen.name}')) return;
    await _press('settings');
  }

  Widget _key(String key, IconData icon, String label, {double size = 76, bool primary = false}) {
    final scheme = Theme.of(context).colorScheme;
    return Semantics(
      button: true,
      label: label,
      excludeSemantics: true,
      child: SizedBox(
        width: size,
        height: size,
        child: primary
            ? FilledButton(
                style: FilledButton.styleFrom(shape: const CircleBorder(), padding: EdgeInsets.zero),
                onPressed: () => _press(key),
                child: Text('OK', style: TextStyle(fontSize: size * 0.26, fontWeight: FontWeight.w900)),
              )
            : IconButton.filledTonal(
                style: IconButton.styleFrom(backgroundColor: scheme.surfaceContainerHighest),
                iconSize: size * 0.5,
                onPressed: () => _press(key),
                icon: Icon(icon),
              ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = widget.screen;
    final t = Theme.of(context).textTheme;
    final display = s.mode == 'display';
    return Scaffold(
      appBar: AppBar(title: Text(s.name)),
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(20),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                Text(s.modeLabel, style: t.titleMedium?.copyWith(color: context.goMuted)),
                const SizedBox(height: 24),
                // The D-pad, as on the TV's own remote.
                _key('up', Icons.keyboard_arrow_up_rounded, 'Up'),
                const SizedBox(height: 8),
                Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                  _key('left', Icons.keyboard_arrow_left_rounded, 'Left'),
                  const SizedBox(width: 8),
                  _key('ok', Icons.circle, 'OK', size: 96, primary: true),
                  const SizedBox(width: 8),
                  _key('right', Icons.keyboard_arrow_right_rounded, 'Right'),
                ]),
                const SizedBox(height: 8),
                _key('down', Icons.keyboard_arrow_down_rounded, 'Down'),
                const SizedBox(height: 28),
                Wrap(spacing: 12, runSpacing: 12, alignment: WrapAlignment.center, children: [
                  OutlinedButton.icon(onPressed: () => _press('back'), icon: const Icon(Icons.arrow_back_rounded), label: const Text('Back')),
                  if (display) ...[
                    OutlinedButton.icon(onPressed: () => _press('previous'), icon: const Icon(Icons.skip_previous_rounded), label: const Text('Previous advert')),
                    OutlinedButton.icon(onPressed: () => _press('next'), icon: const Icon(Icons.skip_next_rounded), label: const Text('Next advert')),
                  ],
                  OutlinedButton.icon(onPressed: () => _press('refresh'), icon: const Icon(Icons.refresh_rounded),
                      label: Text(display ? 'Reload adverts' : 'Refresh')),
                  FilledButton.tonalIcon(onPressed: _settings, icon: const Icon(Icons.settings_rounded), label: const Text('Settings')),
                ]),
                const SizedBox(height: 20),
                Text('Settings opens on the TV once a manager\'s PIN is typed here. Use the arrows and OK to change them.',
                    textAlign: TextAlign.center, style: t.bodySmall?.copyWith(color: context.goMuted)),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}
