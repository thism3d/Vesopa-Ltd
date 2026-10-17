import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/kitchen_remote.dart';
import '../main.dart' show apiBaseProvider, servedByProvider, sessionProvider;
import 'theme.dart';
import 'widgets/pos_message.dart';

/// The till's client for its venue's kitchen.
final kitchenRemoteProvider = Provider<KitchenRemote>(
  (ref) => KitchenRemote(
    apiBase: ref.watch(apiBaseProvider),
    terminalToken: ref.watch(sessionProvider).terminalToken,
  ),
);

/// Open the kitchen remote: the screen's settings, and the orders on it.
Future<void> showKitchenRemote(BuildContext context) => Navigator.of(context)
    .push(MaterialPageRoute(builder: (_) => const KitchenRemotePage()));

/// Running the kitchen screen from the till (2026-10-17).
///
/// For a kitchen screen on a TV that nobody can touch: "The problem mate not
/// touch screen". The top is the screen's size and touch, the rest is the
/// board with the keys the screen would have: Done, Rush and Recall.
class KitchenRemotePage extends ConsumerStatefulWidget {
  const KitchenRemotePage({super.key});

  @override
  ConsumerState<KitchenRemotePage> createState() => _KitchenRemotePageState();
}

class _KitchenRemotePageState extends ConsumerState<KitchenRemotePage> {
  List<RemoteTicket>? _tickets;
  String? _error;
  final Set<String> _busy = {};
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _load();
    // The screens push to each other; the till asks every few seconds, which
    // is quick enough for a page somebody is looking at.
    _timer = Timer.periodic(const Duration(seconds: 5), (_) => _load());
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final tickets = await ref.read(kitchenRemoteProvider).board();
      if (mounted) setState(() {
        _tickets = tickets;
        _error = null;
      });
    } catch (e) {
      if (mounted) setState(() => _error = '$e'.replaceFirst('Bad state: ', ''));
    }
  }

  Future<void> _act(RemoteTicket t, Future<void> Function() action) async {
    setState(() => _busy.add(t.id));
    try {
      await action();
      await _load();
    } catch (e) {
      if (mounted) {
        PosMessenger.error(context, '$e'.replaceFirst('Bad state: ', ''));
      }
    } finally {
      if (mounted) setState(() => _busy.remove(t.id));
    }
  }

  @override
  Widget build(BuildContext context) {
    final remote = ref.watch(kitchenRemoteProvider);
    final by = ref.watch(servedByProvider);
    final tickets = _tickets;
    final open = tickets?.where((t) => t.open).toList() ?? const [];
    final done = tickets?.where((t) => !t.open).toList() ?? const [];

    return Scaffold(
      appBar: AppBar(
        title: const Text('Kitchen Screen'),
        actions: [
          IconButton(
            tooltip: 'Refresh',
            icon: const Icon(Icons.refresh),
            onPressed: _load,
          ),
        ],
      ),
      body: !remote.canUse
          ? const _Notice(
              'This till needs to be signed in again before it can run the kitchen screen.',
            )
          : ListView(
              padding: const EdgeInsets.all(16),
              children: [
                const KitchenScreenSettingsCard(),
                const SizedBox(height: 14),
                // What the kitchen screen shows, for one nobody touches.
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    const Text('Show on the kitchen screen:', style: TextStyle(fontWeight: FontWeight.w700)),
                    for (final t in const [('open', 'Open orders'), ('counts', 'Counts'), ('stock', 'Stock'), ('completed', 'Completed')])
                      OutlinedButton(
                        onPressed: () async {
                          try {
                            await remote.showTab(t.$1);
                            if (context.mounted) PosMessenger.info(context, 'Kitchen screen: ${t.$2}');
                          } catch (e) {
                            if (context.mounted) PosMessenger.error(context, '$e'.replaceFirst('Bad state: ', ''));
                          }
                        },
                        child: Text(t.$2),
                      ),
                  ],
                ),
                const SizedBox(height: 18),
                Text(
                  'On the kitchen screen now (${open.length})',
                  style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800),
                ),
                const SizedBox(height: 8),
                if (_error != null) _Notice(_error!),
                if (tickets == null && _error == null)
                  const Padding(
                    padding: EdgeInsets.all(24),
                    child: Center(child: CircularProgressIndicator()),
                  ),
                if (tickets != null && open.isEmpty)
                  const _Notice('Nothing waiting in the kitchen.'),
                for (final t in open)
                  _TicketRow(
                    ticket: t,
                    busy: _busy.contains(t.id),
                    primaryLabel: 'Done',
                    primaryIcon: Icons.check,
                    onPrimary: () => _act(t, () => remote.bump(t.id, by: by)),
                    onRush: () => _act(t, () => remote.rush(t.id, !t.rushed)),
                  ),
                if (done.isNotEmpty) ...[
                  const SizedBox(height: 18),
                  Text(
                    'Completed in the last hour (${done.length})',
                    style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
                  ),
                  const SizedBox(height: 8),
                  for (final t in done)
                    _TicketRow(
                      ticket: t,
                      busy: _busy.contains(t.id),
                      primaryLabel: 'Recall',
                      primaryIcon: Icons.undo,
                      onPrimary: () => _act(t, () => remote.recall(t.id, by: by)),
                    ),
                ],
              ],
            ),
    );
  }
}

class _TicketRow extends StatelessWidget {
  const _TicketRow({
    required this.ticket,
    required this.busy,
    required this.primaryLabel,
    required this.primaryIcon,
    required this.onPrimary,
    this.onRush,
  });

  final RemoteTicket ticket;
  final bool busy;
  final String primaryLabel;
  final IconData primaryIcon;
  final VoidCallback onPrimary;
  final VoidCallback? onRush;

  @override
  Widget build(BuildContext context) {
    final age = ticket.placedAt == null
        ? ''
        : '${DateTime.now().difference(ticket.placedAt!).inMinutes} min';
    final items = ticket.lines
        .where((l) => !l.isModifier)
        .map((l) => '${l.quantity % 1 == 0 ? l.quantity.toInt() : l.quantity} ${l.name}')
        .join(', ');
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      color: ticket.rushed ? Pos.red.withValues(alpha: 0.08) : null,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 10, 10, 10),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    [
                      ticket.title,
                      if (ticket.ticketNo != null) 'Order ${ticket.ticketNo}',
                      if (age.isNotEmpty) age,
                      if (ticket.rushed) 'RUSH',
                    ].join('  ·  '),
                    style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w800),
                  ),
                  const SizedBox(height: 3),
                  Text(
                    items,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 13),
                  ),
                ],
              ),
            ),
            if (busy)
              const Padding(
                padding: EdgeInsets.all(12),
                child: SizedBox(
                  width: 22,
                  height: 22,
                  child: CircularProgressIndicator(strokeWidth: 2.5),
                ),
              )
            else ...[
              if (onRush != null)
                OutlinedButton(
                  onPressed: onRush,
                  child: Text(ticket.rushed ? 'Unrush' : 'Rush'),
                ),
              const SizedBox(width: 8),
              FilledButton.icon(
                onPressed: onPrimary,
                icon: Icon(primaryIcon),
                label: Text(primaryLabel),
                style: FilledButton.styleFrom(
                  minimumSize: const Size(110, 48),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// The kitchen screens' size, zoom and touch: the venue's default and each
/// named screen. On the Kitchen Screen page and in the till's settings.
class KitchenScreenSettingsCard extends ConsumerStatefulWidget {
  const KitchenScreenSettingsCard({super.key});

  @override
  ConsumerState<KitchenScreenSettingsCard> createState() =>
      _KitchenScreenSettingsCardState();
}

class _KitchenScreenSettingsCardState
    extends ConsumerState<KitchenScreenSettingsCard> {
  KitchenDisplaySettings? _settings;
  String? _error;

  /// -1 is the venue's default; otherwise a named screen's id.
  int _target = -1;
  bool _saving = false;

  final _note = TextEditingController();
  bool _noteFilled = false;

  @override
  void dispose() {
    _note.dispose();
    super.dispose();
  }

  /// The kitchen widgets and the note are venue-wide, whichever screen is
  /// chosen above.
  Future<void> _saveWidgets({List<String>? tiles, String? note}) async {
    setState(() => _saving = true);
    try {
      await ref.read(kitchenRemoteProvider).setVenue(tiles: tiles, note: note);
      await _load();
      if (note != null && mounted) PosMessenger.info(context, 'Sent to the kitchen screen.');
    } catch (e) {
      if (mounted) PosMessenger.error(context, '$e'.replaceFirst('Bad state: ', ''));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final s = await ref.read(kitchenRemoteProvider).display();
      if (mounted) setState(() {
        _settings = s;
        _error = null;
        if (!_noteFilled) {
          _note.text = s.note;
          _noteFilled = true;
        }
        if (_target != -1 && !s.screens.any((x) => x.id == _target)) _target = -1;
      });
    } catch (e) {
      if (mounted) setState(() => _error = '$e'.replaceFirst('Bad state: ', ''));
    }
  }

  KitchenScreenEntry? get _screen {
    final s = _settings;
    if (s == null || _target == -1) return null;
    for (final x in s.screens) {
      if (x.id == _target) return x;
    }
    return null;
  }

  /// What the chosen target actually draws with, the venue's filled in.
  KitchenDisplay get _effective {
    final venue = _settings!.venue;
    final own = _screen?.display;
    return KitchenDisplay(
      tvSize: own?.tvSize ?? venue.tvSize,
      zoom: own?.zoom ?? venue.zoom,
      touch: own?.touch ?? venue.touch,
    );
  }

  Future<void> _save({String? tvSize, int? zoom, bool? touch, bool useVenue = false}) async {
    final remote = ref.read(kitchenRemoteProvider);
    setState(() => _saving = true);
    try {
      if (_target == -1) {
        await remote.setVenue(tvSize: tvSize, zoom: zoom, touch: touch);
      } else {
        await remote.setScreen(
          _target,
          tvSize: tvSize,
          zoom: zoom,
          touch: touch,
          useVenue: useVenue,
        );
      }
      await _load();
    } catch (e) {
      if (mounted) PosMessenger.error(context, '$e'.replaceFirst('Bad state: ', ''));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = _settings;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(Icons.tv),
                const SizedBox(width: 10),
                const Expanded(
                  child: Text(
                    'Kitchen screen size and touch',
                    style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800),
                  ),
                ),
                if (_saving)
                  const SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(strokeWidth: 2.5),
                  ),
              ],
            ),
            const SizedBox(height: 4),
            const Text(
              'Changes show on the kitchen screen straight away. For a TV, pick '
              'its size; turn touch off when nobody can tap it, and run it from '
              'here instead.',
              style: TextStyle(fontSize: 12.5),
            ),
            const SizedBox(height: 12),
            if (_error != null) _Notice(_error!),
            if (s == null && _error == null)
              const Center(child: CircularProgressIndicator()),
            if (s != null) ...[
              if (s.screens.isNotEmpty) ...[
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    ChoiceChip(
                      label: const Text('All screens (venue default)'),
                      selected: _target == -1,
                      onSelected: (_) => setState(() => _target = -1),
                    ),
                    for (final x in s.screens)
                      ChoiceChip(
                        label: Text(x.name),
                        selected: _target == x.id,
                        onSelected: (_) => setState(() => _target = x.id),
                      ),
                  ],
                ),
                const SizedBox(height: 12),
              ],
              if (_screen != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: Row(
                    children: [
                      Expanded(
                        child: Text(
                          _screen!.display.usesVenue
                              ? '${_screen!.name} uses the venue default.'
                              : '${_screen!.name} has its own settings.',
                          style: const TextStyle(fontSize: 12.5),
                        ),
                      ),
                      if (!_screen!.display.usesVenue)
                        TextButton(
                          onPressed: _saving ? null : () => _save(useVenue: true),
                          child: const Text('Use venue default'),
                        ),
                    ],
                  ),
                ),
              const Text('Screen size', style: TextStyle(fontWeight: FontWeight.w700)),
              const SizedBox(height: 6),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  for (final e in kitchenTvSizes.entries)
                    ChoiceChip(
                      label: Text(e.value),
                      selected: _effective.tvSize == e.key,
                      onSelected: _saving ? null : (_) => _save(tvSize: e.key),
                    ),
                ],
              ),
              const SizedBox(height: 14),
              Row(
                children: [
                  const Text('Zoom', style: TextStyle(fontWeight: FontWeight.w700)),
                  const SizedBox(width: 12),
                  IconButton.filledTonal(
                    tooltip: 'Smaller',
                    icon: const Icon(Icons.remove),
                    onPressed: _saving || (_effective.zoom ?? 100) <= 50
                        ? null
                        : () => _save(zoom: ((_effective.zoom ?? 100) - 10).clamp(50, 300)),
                  ),
                  SizedBox(
                    width: 64,
                    child: Text(
                      '${_effective.zoom ?? 100}%',
                      textAlign: TextAlign.center,
                      style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w800),
                    ),
                  ),
                  IconButton.filledTonal(
                    tooltip: 'Bigger',
                    icon: const Icon(Icons.add),
                    onPressed: _saving || (_effective.zoom ?? 100) >= 300
                        ? null
                        : () => _save(zoom: ((_effective.zoom ?? 100) + 10).clamp(50, 300)),
                  ),
                  const SizedBox(width: 8),
                  TextButton(
                    onPressed: _saving || _effective.zoom == 100 ? null : () => _save(zoom: 100),
                    child: const Text('Reset'),
                  ),
                ],
              ),
              const SizedBox(height: 6),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text('Touch screen'),
                subtitle: Text(
                  _effective.touch ?? true
                      ? 'Staff can tap the screen, and this till can run it too.'
                      : 'Fingers do nothing on the screen; a mouse still works, and this till runs it.',
                ),
                value: _effective.touch ?? true,
                onChanged: _saving ? null : (on) => _save(touch: on),
              ),
              const Divider(height: 28),
              const Text('Kitchen widgets', style: TextStyle(fontWeight: FontWeight.w700)),
              const Text(
                'Along the top of every kitchen screen. All off unless you turn them on.',
                style: TextStyle(fontSize: 12.5),
              ),
              for (final id in (s.tilesSupported.isEmpty ? kitchenTileNames.keys.toList() : s.tilesSupported))
                CheckboxListTile(
                  contentPadding: EdgeInsets.zero,
                  dense: true,
                  title: Text(kitchenTileNames[id] ?? id),
                  value: s.tiles.contains(id),
                  onChanged: _saving
                      ? null
                      : (on) {
                          final order = s.tilesSupported.isEmpty ? kitchenTileNames.keys.toList() : s.tilesSupported;
                          _saveWidgets(tiles: [
                            for (final t in order)
                              if (t == id ? on == true : s.tiles.contains(t)) t,
                          ]);
                        },
                ),
              const SizedBox(height: 6),
              Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _note,
                      maxLength: 160,
                      decoration: const InputDecoration(
                        labelText: 'Note from the front',
                        hintText: '86 salmon',
                        helperText: 'Shown when the note widget is on. Empty to clear.',
                      ),
                      onSubmitted: (v) => _saveWidgets(note: v.trim()),
                    ),
                  ),
                  const SizedBox(width: 10),
                  FilledButton(
                    onPressed: _saving ? null : () => _saveWidgets(note: _note.text.trim()),
                    child: const Text('Send'),
                  ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _Notice extends StatelessWidget {
  const _Notice(this.text);
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 10),
    child: Text(text, style: const TextStyle(fontSize: 14)),
  );
}
