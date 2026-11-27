/// The remote for the venue's TVs and screens, on a phone or tablet, laid out
/// as Google TV's own app (owner, 2026-11-27): a list of the screens by name,
/// Local (same Wi-Fi) or Live (through Vesopa); "Connected" with the one in
/// hand, and as many as are wanted; the D-pad or a swipe pad, Back, Home, the
/// microphone for voice commands, mute and volume, power, a keyboard; what
/// is on the TV, live, to tap ("On the screen"); and the kitchen's and the
/// display's own keys.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:speech_to_text/speech_to_text.dart';

import '../data/api.dart';
import '../data/session.dart';
import '../modes/mode_settings.dart';
import '../ui/theme.dart';
import 'remote_link.dart';
import 'voice.dart';

/// Opens the remote for [id], adding it to the Connected bar.
void openRemote(BuildContext context, String id) {
  RemoteLink.connect(id);
  Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => RemotePadPage(screenId: id)));
}

class ScreensRemotePage extends ConsumerStatefulWidget {
  const ScreensRemotePage({super.key});
  @override
  ConsumerState<ScreensRemotePage> createState() => _ScreensRemotePageState();
}

class _ScreensRemotePageState extends ConsumerState<ScreensRemotePage> {
  String? _error;
  bool _loaded = false;
  Timer? _poll;

  @override
  void initState() {
    super.initState();
    RemoteLink.listenLocal();
    unawaited(_load());
    _poll = Timer.periodic(const Duration(seconds: 5), (_) => unawaited(_load()));
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      await RemoteLink.refresh(ref.read(apiProvider), ref.read(tapProvider.notifier).deviceId);
      if (mounted) setState(() => _error = null);
    } on TapApiError catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _loaded = true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(title: const Text('Select a screen')),
      body: ValueListenableBuilder<Map<String, LinkedScreen>>(
        valueListenable: RemoteLink.screens,
        builder: (context, all, _) {
          final mine = ref.read(tapProvider.notifier).deviceId;
          final list = all.values.where((s) => s.id != mine && s.reachable).toList()..sort((a, b) => a.name.compareTo(b.name));
          return RefreshIndicator(
            onRefresh: _load,
            child: ListView(padding: const EdgeInsets.all(16), children: [
              Text('AVAILABLE SCREENS', style: t.labelMedium?.copyWith(color: context.goMuted, letterSpacing: 1.2)),
              const SizedBox(height: 8),
              if (_error != null && list.isEmpty) Text(_error!, style: t.bodyMedium?.copyWith(color: Tp.danger)),
              if (!_loaded && list.isEmpty) const Padding(padding: EdgeInsets.all(32), child: Center(child: CircularProgressIndicator())),
              if (_loaded && list.isEmpty)
                const Card(
                  child: ListTile(
                    leading: Icon(Icons.tv_off_rounded),
                    title: Text('No screens on'),
                    subtitle: Text('Switch the TV on and open Vesopa Go on it. A new TV shows a code: Connect a screen or TV adds it first.'),
                  ),
                ),
              for (final s in list)
                Card(
                  child: ListTile(
                    leading: Icon(s.mode == 'kitchen' ? Icons.soup_kitchen_rounded : (s.tv ? Icons.tv_rounded : Icons.connected_tv_rounded)),
                    title: Text(s.name, style: const TextStyle(fontWeight: FontWeight.w700)),
                    subtitle: Text(s.modeLabel),
                    trailing: _ViaChip(screen: s),
                    onTap: () => openRemote(context, s.id),
                  ),
                ),
              const SizedBox(height: 14),
              Text(
                'On the same Wi-Fi as this phone, a screen is found at once and answers fastest (Local). '
                'Anywhere else it is reached through Vesopa (Live). Keys go the local way first.',
                style: t.bodySmall?.copyWith(color: context.goMuted),
              ),
            ]),
          );
        },
      ),
    );
  }
}

/// Local (same Wi-Fi) or Live (through Vesopa).
class _ViaChip extends StatelessWidget {
  const _ViaChip({required this.screen});
  final LinkedScreen screen;
  @override
  Widget build(BuildContext context) {
    final local = screen.local;
    final colour = local ? Tp.green : const Color(0xFF3E8CF0);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(color: colour.withValues(alpha: 0.15), borderRadius: BorderRadius.circular(99)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Icon(local ? Icons.wifi_rounded : Icons.cloud_rounded, size: 14, color: colour),
        const SizedBox(width: 4),
        Text(screen.via, style: TextStyle(color: colour, fontWeight: FontWeight.w800, fontSize: 12)),
      ]),
    );
  }
}

/// The Connected bar under the app's pages, while this phone controls
/// screens: the last one, Local or Live, and how many.
class ConnectedScreensBar extends StatelessWidget {
  const ConnectedScreensBar({super.key});
  @override
  Widget build(BuildContext context) => ValueListenableBuilder<List<String>>(
        valueListenable: RemoteLink.connected,
        builder: (context, ids, _) {
          if (ids.isEmpty) return const SizedBox.shrink();
          return ValueListenableBuilder<Map<String, LinkedScreen>>(
            valueListenable: RemoteLink.screens,
            builder: (context, all, _) {
              final s = all[ids.last];
              if (s == null) return const SizedBox.shrink();
              final t = Theme.of(context).textTheme;
              return Material(
                color: Theme.of(context).colorScheme.surfaceContainerHighest,
                child: SafeArea(
                  top: false,
                  child: InkWell(
                    onTap: () => openRemote(context, s.id),
                    child: Padding(
                      padding: const EdgeInsets.fromLTRB(16, 8, 8, 8),
                      child: Row(children: [
                        Expanded(
                          child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                            Text('Connected', style: t.titleSmall?.copyWith(fontWeight: FontWeight.w700)),
                            Row(children: [
                              Icon(Icons.tv_rounded, size: 14, color: Tp.green),
                              const SizedBox(width: 4),
                              Flexible(child: Text(s.name, overflow: TextOverflow.ellipsis, style: t.bodySmall?.copyWith(color: Tp.green))),
                              const SizedBox(width: 8),
                              _ViaChip(screen: s),
                              if (ids.length > 1) ...[const SizedBox(width: 6), Text('+${ids.length - 1}', style: t.bodySmall)],
                            ]),
                          ]),
                        ),
                        if (ids.length > 1)
                          IconButton(
                            tooltip: 'Other screens',
                            icon: const Icon(Icons.swap_horiz_rounded),
                            onPressed: () => _pickConnected(context, ids, all),
                          ),
                        IconButton.filledTonal(tooltip: 'Remote', icon: const Icon(Icons.settings_remote_rounded), onPressed: () => openRemote(context, s.id)),
                        IconButton(tooltip: 'Disconnect', icon: const Icon(Icons.close_rounded), onPressed: () => RemoteLink.disconnect(s.id)),
                      ]),
                    ),
                  ),
                ),
              );
            },
          );
        },
      );

  void _pickConnected(BuildContext context, List<String> ids, Map<String, LinkedScreen> all) => showModalBottomSheet<void>(
        context: context,
        showDragHandle: true,
        builder: (c) => SafeArea(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            for (final id in ids.reversed)
              if (all[id] != null)
                ListTile(
                  leading: const Icon(Icons.tv_rounded),
                  title: Text(all[id]!.name),
                  subtitle: Text(all[id]!.modeLabel),
                  trailing: _ViaChip(screen: all[id]!),
                  onTap: () {
                    Navigator.pop(c);
                    openRemote(context, id);
                  },
                ),
          ]),
        ),
      );
}

enum _Pane { pad, touch, keyboard }

/// The remote for one screen.
class RemotePadPage extends ConsumerStatefulWidget {
  const RemotePadPage({super.key, required this.screenId});
  final String screenId;
  @override
  ConsumerState<RemotePadPage> createState() => _RemotePadPageState();
}

class _RemotePadPageState extends ConsumerState<RemotePadPage> {
  _Pane _pane = _Pane.pad;
  bool _switching = false;
  Timer? _poll;
  final _typed = TextEditingController();
  Timer? _typeTimer;
  final _speech = SpeechToText();
  bool _listening = false;
  String _heard = '';

  LinkedScreen? get _s => RemoteLink.screens.value[widget.screenId];

  @override
  void initState() {
    super.initState();
    _poll = Timer.periodic(const Duration(milliseconds: 1500), (_) => unawaited(_refresh()));
    unawaited(_refresh());
  }

  Future<void> _refresh() async {
    final api = ref.read(apiProvider);
    try {
      await RemoteLink.refresh(api, ref.read(tapProvider.notifier).deviceId);
    } on TapApiError {
      // Local only for now.
    }
    await RemoteLink.refreshState(api, widget.screenId);
  }

  @override
  void dispose() {
    _poll?.cancel();
    _typeTimer?.cancel();
    _typed.dispose();
    unawaited(_speech.stop());
    super.dispose();
  }

  Future<void> _press(String key, {int? index, String? text}) async {
    HapticFeedback.selectionClick();
    final messenger = ScaffoldMessenger.of(context);
    try {
      await RemoteLink.send(ref.read(apiProvider), widget.screenId, key, index: index, text: text);
      unawaited(Future.delayed(const Duration(milliseconds: 350), _refresh));
    } on TapApiError catch (e) {
      messenger.hideCurrentSnackBar();
      messenger.showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  Future<void> _settings() async {
    // The screen's settings are behind a manager's PIN, typed here.
    if (!await askManagerPin(context, ref, why: 'Settings on ${_s?.name ?? 'the screen'}')) return;
    await _press('settings');
  }

  /// Kitchen screen or Customer display, after a manager's PIN.
  Future<void> _switchTo(String mode, {bool ask = true}) async {
    final s = _s;
    if (s == null || mode == s.mode || _switching) return;
    final label = mode == 'kitchen' ? 'a Kitchen screen' : 'a Customer display';
    if (ask && !await askManagerPin(context, ref, why: 'Make ${s.name} $label')) return;
    if (!mounted) return;
    setState(() => _switching = true);
    final messenger = ScaffoldMessenger.of(context);
    try {
      await ref.read(apiProvider).changeGoMode(s.id, mode);
      await _press('mode');
      s.mode = mode;
      messenger.showSnackBar(SnackBar(content: Text('${s.name} is now $label.')));
    } on TapApiError catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(e.message)));
    } finally {
      if (mounted) setState(() => _switching = false);
    }
  }

  // ---- Voice ----

  Future<void> _voice() async {
    final messenger = ScaffoldMessenger.of(context);
    if (_listening) {
      await _speech.stop();
      setState(() => _listening = false);
      return;
    }
    final ok = await _speech.initialize(onError: (e) {
      if (mounted) setState(() => _listening = false);
    }, onStatus: (st) {
      if (st == 'done' || st == 'notListening') {
        if (mounted) setState(() => _listening = false);
      }
    });
    if (!ok) {
      messenger.showSnackBar(const SnackBar(content: Text('Voice is not available on this phone, or the microphone is not allowed for Vesopa Go.')));
      return;
    }
    setState(() {
      _listening = true;
      _heard = '';
    });
    await _speech.listen(
      // On the device only: no recording goes to Apple's or Google's speech
      // servers, as the stores' privacy answers say (store/play_console.md).
      listenOptions: SpeechListenOptions(partialResults: true, cancelOnError: true, listenMode: ListenMode.confirmation, onDevice: true),
      pauseFor: const Duration(seconds: 2),
      onResult: (r) {
        if (!mounted) return;
        setState(() => _heard = r.recognizedWords);
        if (r.finalResult) unawaited(_act(r.recognizedWords));
      },
    );
  }

  Future<void> _act(String said) async {
    final s = _s;
    if (s == null) return;
    final messenger = ScaffoldMessenger.of(context);
    final r = VoiceCommands.parse(said, mode: s.mode);
    if (!r.understood) {
      messenger.showSnackBar(SnackBar(content: Text('"$said": not a command I know. Tap ? for the list.')));
      return;
    }
    messenger.showSnackBar(SnackBar(content: Text('"$said" → ${r.said}')));
    for (final step in r.steps) {
      if (step.key.startsWith('mode:')) {
        await _switchTo(step.key.substring(5));
      } else {
        await _press(step.key, index: step.index, text: step.text);
      }
      await Future<void>.delayed(const Duration(milliseconds: 250));
    }
  }

  void _voiceHelp() => showModalBottomSheet<void>(
        context: context,
        showDragHandle: true,
        isScrollControlled: true,
        builder: (c) => DraggableScrollableSheet(
          expand: false,
          initialChildSize: 0.7,
          builder: (c, scroll) => ListView(controller: scroll, padding: const EdgeInsets.fromLTRB(20, 0, 20, 24), children: [
            Text('Voice commands', style: Theme.of(c).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800)),
            const SizedBox(height: 4),
            const Text('Tap the microphone and say one. Two at once work too.'),
            for (final (title, lines) in VoiceCommands.help) ...[
              const SizedBox(height: 16),
              Text(title, style: Theme.of(c).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700)),
              for (final l in lines) Padding(padding: const EdgeInsets.only(top: 6), child: Text('•  $l')),
            ],
          ]),
        ),
      );

  // ---- Parts ----

  Widget _round(IconData icon, String label, VoidCallback onTap, {double size = 56, bool filled = false, Color? colour}) {
    final scheme = Theme.of(context).colorScheme;
    return Semantics(
      button: true,
      label: label,
      excludeSemantics: true,
      child: Tooltip(
        message: label,
        child: SizedBox(
          width: size,
          height: size,
          child: IconButton.filledTonal(
            style: IconButton.styleFrom(backgroundColor: filled ? (colour ?? Tp.lime) : scheme.surfaceContainerHighest),
            iconSize: size * 0.46,
            onPressed: onTap,
            icon: Icon(icon, color: filled ? Tp.onLime : colour),
          ),
        ),
      ),
    );
  }

  Widget _dpad() {
    final scheme = Theme.of(context).colorScheme;
    Widget arrow(String key, IconData icon, Alignment at) => Align(
          alignment: at,
          child: IconButton(iconSize: 44, onPressed: () => _press(key), icon: Icon(icon), tooltip: key),
        );
    return SizedBox(
      width: 260,
      height: 260,
      child: DecoratedBox(
        decoration: BoxDecoration(color: scheme.surfaceContainerHighest, shape: BoxShape.circle),
        child: Stack(children: [
          arrow('up', Icons.keyboard_arrow_up_rounded, Alignment.topCenter),
          arrow('down', Icons.keyboard_arrow_down_rounded, Alignment.bottomCenter),
          arrow('left', Icons.keyboard_arrow_left_rounded, Alignment.centerLeft),
          arrow('right', Icons.keyboard_arrow_right_rounded, Alignment.centerRight),
          Center(
            child: Semantics(
              button: true,
              label: 'OK',
              child: GestureDetector(
                onTap: () => _press('ok'),
                child: Container(
                  width: 108,
                  height: 108,
                  decoration: BoxDecoration(shape: BoxShape.circle, color: Tp.lime),
                  alignment: Alignment.center,
                  child: Text('OK', style: TextStyle(color: Tp.onLime, fontWeight: FontWeight.w900, fontSize: 24)),
                ),
              ),
            ),
          ),
        ]),
      ),
    );
  }

  /// Swipe to move, tap to press, as Google TV's touch pad.
  Widget _touch() {
    final scheme = Theme.of(context).colorScheme;
    Offset start = Offset.zero;
    return GestureDetector(
      onTap: () => _press('ok'),
      onPanStart: (d) => start = d.localPosition,
      onPanEnd: (d) {
        final v = d.velocity.pixelsPerSecond;
        final dir = v.dx.abs() > v.dy.abs() ? (v.dx > 0 ? 'right' : 'left') : (v.dy > 0 ? 'down' : 'up');
        if (v.distance > 80 || start != Offset.zero) _press(dir);
      },
      child: Container(
        width: 280,
        height: 320,
        decoration: BoxDecoration(color: scheme.surfaceContainerHighest, borderRadius: BorderRadius.circular(28)),
        alignment: Alignment.center,
        child: Text('SWIPE TO MOVE\nTAP TO SELECT', textAlign: TextAlign.center, style: TextStyle(color: context.goMuted, fontWeight: FontWeight.w700, letterSpacing: 1.2)),
      ),
    );
  }

  Widget _keyboard() {
    final t = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8),
      child: Column(children: [
        Text('Start typing', style: t.headlineSmall?.copyWith(color: context.goMuted)),
        Text('What you type shows in the box the TV is on.', style: t.bodyMedium?.copyWith(color: context.goMuted)),
        const SizedBox(height: 12),
        TextField(
          controller: _typed,
          autofocus: true,
          textInputAction: TextInputAction.done,
          decoration: const InputDecoration(border: OutlineInputBorder(), hintText: 'Type here'),
          onChanged: (v) {
            _typeTimer?.cancel();
            _typeTimer = Timer(const Duration(milliseconds: 250), () => _press('text', text: v));
          },
          onSubmitted: (v) async {
            _typeTimer?.cancel();
            await _press('text', text: v);
            await _press('submit');
          },
        ),
      ]),
    );
  }

  /// What is on the TV now: its buttons, tabs, settings and boxes, the one
  /// the remote is on highlighted; tap one to press it on the TV.
  Widget _mirror(LinkedScreen s) {
    final st = s.state;
    final t = Theme.of(context).textTheme;
    final items = [for (final i in (st?['items'] as List? ?? const [])) Map<String, dynamic>.from(i as Map)];
    if (st == null) {
      return Text('Waiting for the screen…', textAlign: TextAlign.center, style: t.bodySmall?.copyWith(color: context.goMuted));
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Row(children: [
        Text('ON THE SCREEN', style: t.labelMedium?.copyWith(color: context.goMuted, letterSpacing: 1.2)),
        const SizedBox(width: 8),
        Expanded(child: Text('${st['page'] ?? ''}', overflow: TextOverflow.ellipsis, style: t.labelMedium?.copyWith(fontWeight: FontWeight.w800))),
        if (st['off'] == true) Text('Screen off', style: t.labelMedium?.copyWith(color: Tp.danger)),
      ]),
      const SizedBox(height: 8),
      if (items.isEmpty) Text('Nothing to press here.', style: t.bodySmall?.copyWith(color: context.goMuted)),
      Wrap(spacing: 8, runSpacing: 8, children: [
        for (var i = 0; i < items.length; i++)
          _MirrorChip(
            item: items[i],
            onTap: () {
              if (items[i]['k'] == 'text') {
                _typed.text = '${items[i]['v'] ?? ''}';
                setState(() => _pane = _Pane.keyboard);
              }
              _press('tap', index: i);
            },
          ),
      ]),
    ]);
  }

  /// What the screen says about itself (owner, 2026-11-27).
  void _about(LinkedScreen s) {
    final d = s.state?['device'] is Map ? Map<String, dynamic>.from(s.state!['device'] as Map) : const <String, dynamic>{};
    String v(Object? x) => x == null || '$x'.isEmpty ? '—' : '$x';
    final rows = <(String, String)>[
      ('Name in Vesopa', v(d['name'] ?? s.name)),
      ('Name on the device', v(d['deviceName'])),
      ('Runs as', s.modeLabel),
      ('Connection', s.local ? 'Local (same Wi-Fi)' : 'Live (through Vesopa)'),
      ('Model', v([d['brand'], d['model']].whereType<Object>().join(' ').trim())),
      ('Android', d['android'] == null ? '—' : 'Android ${d['android']} (API ${v(d['sdk'])})'),
      ('Screen', d['pixels'] == null ? '—' : '${d['pixels']} pixels${d['density'] == null ? '' : ' · ${(d['density'] as num).toStringAsFixed(1)}×'}'),
      ('Kind', d['tv'] == true ? 'TV' : 'Tablet or phone'),
      ('Vesopa Go', v(d['app'])),
      ('Device id', v(d['id'] ?? s.id)),
    ];
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (c) => SafeArea(
        child: ListView(shrinkWrap: true, padding: const EdgeInsets.fromLTRB(20, 0, 20, 20), children: [
          Text('About ${s.name}', style: Theme.of(c).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800)),
          const SizedBox(height: 8),
          for (final (k, val) in rows)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 6),
              child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                SizedBox(width: 150, child: Text(k, style: TextStyle(color: c.goMuted))),
                Expanded(child: SelectableText(val, style: const TextStyle(fontWeight: FontWeight.w600))),
              ]),
            ),
        ]),
      ),
    );
  }

  void _more(LinkedScreen s) => showModalBottomSheet<void>(
        context: context,
        showDragHandle: true,
        isScrollControlled: true,
        builder: (c) => SafeArea(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Text('What ${s.tv ? 'this TV' : 'this screen'} shows', style: Theme.of(c).textTheme.titleMedium),
              const SizedBox(height: 8),
              SegmentedButton<String>(
                showSelectedIcon: false,
                segments: const [
                  ButtonSegment(value: 'kitchen', icon: Icon(Icons.soup_kitchen_rounded), label: Text('Kitchen screen')),
                  ButtonSegment(value: 'display', icon: Icon(Icons.connected_tv_rounded), label: Text('Customer display')),
                ],
                selected: {s.mode == 'kitchen' ? 'kitchen' : 'display'},
                onSelectionChanged: (v) {
                  Navigator.pop(c);
                  _switchTo(v.first);
                },
              ),
              const SizedBox(height: 18),
              Text('Colour on the screen', style: Theme.of(c).textTheme.titleMedium),
              const SizedBox(height: 8),
              Wrap(spacing: 10, runSpacing: 10, alignment: WrapAlignment.center, children: [
                for (final p in GoPalette.all)
                  Tooltip(
                    message: p.name,
                    child: InkWell(
                      customBorder: const CircleBorder(),
                      onTap: () => _press('theme:${p.id}'),
                      child: Container(width: 44, height: 44, decoration: BoxDecoration(color: p.colour, shape: BoxShape.circle)),
                    ),
                  ),
              ]),
              const SizedBox(height: 12),
              Row(children: [
                Expanded(child: OutlinedButton.icon(onPressed: () => _press('appearance:light'), icon: const Icon(Icons.light_mode_rounded), label: const Text('Day'))),
                const SizedBox(width: 8),
                Expanded(child: OutlinedButton.icon(onPressed: () => _press('appearance:dark'), icon: const Icon(Icons.dark_mode_rounded), label: const Text('Night'))),
              ]),
              if (s.mode == 'kitchen') ...[
                const SizedBox(height: 18),
                Text('New orders fill the screen for', style: Theme.of(c).textTheme.titleMedium),
                const SizedBox(height: 8),
                Wrap(spacing: 8, children: [
                  for (final n in const [0, 5, 10, 15, 30]) ActionChip(label: Text(n == 0 ? 'Off' : '$n s'), onPressed: () => _press('popup:$n')),
                ]),
              ],
              const SizedBox(height: 18),
              ListTile(leading: const Icon(Icons.info_outline_rounded), title: const Text('About this screen'), onTap: () {
                Navigator.pop(c);
                _about(s);
              }),
              ListTile(leading: const Icon(Icons.settings_rounded), title: const Text('Settings on the screen'), onTap: () {
                Navigator.pop(c);
                _settings();
              }),
              ListTile(leading: const Icon(Icons.record_voice_over_rounded), title: const Text('Voice commands'), onTap: () {
                Navigator.pop(c);
                _voiceHelp();
              }),
              ListTile(leading: const Icon(Icons.link_off_rounded), title: const Text('Disconnect'), onTap: () {
                Navigator.pop(c);
                RemoteLink.disconnect(s.id);
                Navigator.pop(context);
              }),
            ]),
          ),
        ),
      );

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<Map<String, LinkedScreen>>(
      valueListenable: RemoteLink.screens,
      builder: (context, all, _) {
        final s = all[widget.screenId];
        final t = Theme.of(context).textTheme;
        if (s == null) return Scaffold(appBar: AppBar(), body: const Center(child: Text('That screen is not on just now.')));
        final kitchen = s.mode == 'kitchen';
        final display = s.mode == 'display';
        final volume = s.state?['volume'] is Map ? Map<String, dynamic>.from(s.state!['volume'] as Map) : null;
        return Scaffold(
          appBar: AppBar(
            leading: IconButton(icon: const Icon(Icons.keyboard_arrow_down_rounded), onPressed: () => Navigator.pop(context)),
            titleSpacing: 0,
            title: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(s.reachable ? 'Connected' : 'Reconnecting…', style: t.titleMedium?.copyWith(fontWeight: FontWeight.w700)),
              Row(children: [
                Icon(Icons.tv_rounded, size: 14, color: Tp.green),
                const SizedBox(width: 4),
                Flexible(child: Text('${s.name} · ${s.modeLabel}', overflow: TextOverflow.ellipsis, style: t.bodySmall?.copyWith(color: Tp.green))),
                const SizedBox(width: 6),
                _ViaChip(screen: s),
              ]),
            ]),
            actions: [
              IconButton(
                tooltip: _pane == _Pane.keyboard ? 'Remote' : 'Keyboard',
                icon: Icon(_pane == _Pane.keyboard ? Icons.settings_remote_rounded : Icons.keyboard_rounded),
                onPressed: () => setState(() => _pane = _pane == _Pane.keyboard ? _Pane.pad : _Pane.keyboard),
              ),
              IconButton(
                tooltip: s.state?['off'] == true ? 'Screen on' : 'Screen off',
                icon: Icon(Icons.power_settings_new_rounded, color: s.state?['off'] == true ? Tp.danger : null),
                onPressed: () => _press('power'),
              ),
              IconButton(tooltip: 'More', icon: const Icon(Icons.more_vert_rounded), onPressed: () => _more(s)),
            ],
          ),
          body: SafeArea(
            child: Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 520),
                child: ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 24), children: [
                  if (_switching) const LinearProgressIndicator(),
                  if (_pane != _Pane.keyboard)
                    Align(
                      alignment: Alignment.centerRight,
                      child: TextButton.icon(
                        onPressed: () => setState(() => _pane = _pane == _Pane.pad ? _Pane.touch : _Pane.pad),
                        icon: Icon(_pane == _Pane.pad ? Icons.touch_app_rounded : Icons.gamepad_rounded),
                        label: Text(_pane == _Pane.pad ? 'Swipe pad' : 'D-pad'),
                      ),
                    ),
                  Center(
                    child: switch (_pane) {
                      _Pane.pad => _dpad(),
                      _Pane.touch => _touch(),
                      _Pane.keyboard => _keyboard(),
                    },
                  ),
                  const SizedBox(height: 18),
                  // Back, Home, voice and Settings.
                  Row(mainAxisAlignment: MainAxisAlignment.spaceEvenly, children: [
                    _round(Icons.arrow_back_rounded, 'Back', () => _press('back')),
                    _round(Icons.home_rounded, 'Home', () => _press('home')),
                    _round(_listening ? Icons.graphic_eq_rounded : Icons.mic_rounded, 'Voice command', _voice, filled: _listening),
                    _round(Icons.settings_rounded, 'Settings', _settings),
                  ]),
                  if (_listening || _heard.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 10),
                      child: Text(_listening ? (_heard.isEmpty ? 'Listening…' : '"$_heard"') : '"$_heard"',
                          textAlign: TextAlign.center, style: t.bodyMedium?.copyWith(color: context.goMuted)),
                    ),
                  Align(
                    child: TextButton.icon(onPressed: _voiceHelp, icon: const Icon(Icons.help_outline_rounded, size: 18), label: const Text('What can I say?')),
                  ),
                  const SizedBox(height: 4),
                  // Mute and volume, the TV's own.
                  Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                    _round(volume?['muted'] == true ? Icons.volume_off_rounded : Icons.volume_mute_rounded, 'Mute', () => _press('mute'), size: 60,
                        colour: volume?['muted'] == true ? Tp.danger : null),
                    const SizedBox(width: 12),
                    _round(Icons.volume_down_rounded, 'Volume down', () => _press('volume_down'), size: 60),
                    const SizedBox(width: 6),
                    _round(Icons.volume_up_rounded, 'Volume up', () => _press('volume_up'), size: 60),
                    if (volume?['level'] != null) ...[
                      const SizedBox(width: 10),
                      Text('${volume!['level']}%', style: t.titleSmall),
                    ],
                  ]),
                  const SizedBox(height: 20),
                  if (kitchen)
                    _Panel(title: 'Kitchen', children: [
                      Wrap(spacing: 8, runSpacing: 8, alignment: WrapAlignment.center, children: [
                        FilledButton.icon(onPressed: () => _press('done_shown'), icon: const Icon(Icons.check_circle_rounded), label: const Text('Mark done')),
                        OutlinedButton.icon(onPressed: () => _press('expand_last'), icon: const Icon(Icons.open_in_full_rounded), label: const Text('Newest order')),
                        OutlinedButton.icon(onPressed: () => _press('expand_first'), icon: const Icon(Icons.first_page_rounded), label: const Text('Oldest order')),
                        OutlinedButton.icon(onPressed: () => _press('recall'), icon: const Icon(Icons.undo_rounded), label: const Text('Recall')),
                      ]),
                      const SizedBox(height: 10),
                      SegmentedButton<String>(
                        showSelectedIcon: false,
                        emptySelectionAllowed: true,
                        segments: const [
                          ButtonSegment(value: 'tickets', label: Text('Open')),
                          ButtonSegment(value: 'finished', label: Text('Closed')),
                          ButtonSegment(value: 'orders', label: Text('Phone orders')),
                        ],
                        selected: const {},
                        onSelectionChanged: (v) => v.isEmpty ? null : _press(v.first),
                      ),
                    ]),
                  if (display)
                    _Panel(title: 'Adverts', children: [
                      Wrap(spacing: 8, runSpacing: 8, alignment: WrapAlignment.center, children: [
                        OutlinedButton.icon(onPressed: () => _press('previous'), icon: const Icon(Icons.skip_previous_rounded), label: const Text('Previous')),
                        OutlinedButton.icon(onPressed: () => _press('next'), icon: const Icon(Icons.skip_next_rounded), label: const Text('Next')),
                        OutlinedButton.icon(onPressed: () => _press('hold:5'), icon: const Icon(Icons.pause_circle_rounded), label: const Text('Keep 5 min')),
                        OutlinedButton.icon(onPressed: () => _press('hold:0'), icon: const Icon(Icons.play_circle_rounded), label: const Text('Resume')),
                        OutlinedButton.icon(onPressed: () => _press('refresh'), icon: const Icon(Icons.refresh_rounded), label: const Text('Reload')),
                      ]),
                    ]),
                  const SizedBox(height: 16),
                  _mirror(s),
                ]),
              ),
            ),
          ),
        );
      },
    );
  }
}

class _Panel extends StatelessWidget {
  const _Panel({required this.title, required this.children});
  final String title;
  final List<Widget> children;
  @override
  Widget build(BuildContext context) => Card(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 14),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text(title, textAlign: TextAlign.center, style: Theme.of(context).textTheme.titleSmall?.copyWith(color: context.goMuted, fontWeight: FontWeight.w700)),
            const SizedBox(height: 10),
            ...children,
          ]),
        ),
      );
}

/// One thing on the TV, as a chip: where the remote is, a lime ring.
class _MirrorChip extends StatelessWidget {
  const _MirrorChip({required this.item, required this.onTap});
  final Map<String, dynamic> item;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final focused = item['f'] == true;
    final kind = '${item['k'] ?? 'button'}';
    final value = item['v'];
    final label = '${item['l'] ?? ''}';
    final icon = switch (kind) {
      'text' => Icons.keyboard_rounded,
      'toggle' => value == 'On' ? Icons.toggle_on_rounded : Icons.toggle_off_rounded,
      _ => null,
    };
    return Opacity(
      opacity: item['o'] == true ? 0.6 : 1,
      child: ActionChip(
        avatar: icon == null ? null : Icon(icon, size: 18),
        side: BorderSide(color: focused ? Tp.lime : Theme.of(context).colorScheme.outlineVariant, width: focused ? 2.5 : 1),
        backgroundColor: focused ? Tp.lime.withValues(alpha: 0.18) : null,
        label: Text(
          kind == 'text' && value != null && '$value'.isNotEmpty ? '$label: $value' : (value != null && kind == 'toggle' ? '$label · $value' : label),
          overflow: TextOverflow.ellipsis,
        ),
        onPressed: onTap,
      ),
    );
  }
}
