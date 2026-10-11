/// Tickets: the gate, for a venue running the Events & tickets module.
///
/// WHAT THE SCREEN IS FOR
///
/// Somebody stands at the door with a scanner and a queue. Every ticket is a
/// QR code reading `VT:<code>`; the scanner types it and presses Return, and
/// the till answers in a colour that can be read from arm's length without
/// reading anything: green, let them in; red, do not.
///
/// So the scan box is always the thing with focus. It takes the scanner's
/// keystrokes the way any text box takes a keyboard's, Return sends it, and it
/// is cleared and ready again before the answer has finished drawing — a queue
/// moves at the speed of the scanner, not of the person holding it. A code can
/// also be typed, for the phone whose screen is too cracked to scan.
///
/// The card listener that normally hears every scan on the till (see
/// swipe_listener.dart) stands down while this section is open, so a ticket's
/// digits go into this box and not into a member lookup. See the shell.
///
/// THE ANSWER IS NOT A DIALOG
///
/// For the reason gym_greeting.dart gives: a dialog waits for somebody to
/// answer it, and the next person in the queue is already holding their phone
/// out. The answer covers the page, clears itself after a few seconds, goes
/// at a touch, and is replaced the instant the next ticket is scanned.
///
/// NOTHING IS ADMITTED OFFLINE
///
/// Whether a ticket has been used is the back office's to say — a till that
/// waved people through while the broadband was down would let the same
/// screenshot in at every gate. When it cannot ask, the gate says so in red.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../data/events_api.dart';
import '../data/training_mode.dart';
import '../main.dart';
import 'theme.dart';
import 'widgets/on_screen_keyboard.dart' show PosKeyboardMode;
import 'widgets/pos_text_field.dart';

String _money(int minor) => '£${(minor / 100).toStringAsFixed(2)}';

/// "Today 19:30", "Tomorrow 14:00", "Sat 18 Oct 19:30".
String eventWhen(DateTime? at, {DateTime? now}) {
  if (at == null) return '';
  final today = now ?? DateTime.now();
  final day = DateTime(at.year, at.month, at.day);
  final diff = day.difference(DateTime(today.year, today.month, today.day));
  final time = DateFormat('HH:mm').format(at);
  return switch (diff.inDays) {
    0 => 'Today $time',
    1 => 'Tomorrow $time',
    -1 => 'Yesterday $time',
    _ => DateFormat('EEE d MMM HH:mm').format(at),
  };
}

/// What the gate says, in the words a queue can read.
@immutable
class GateLook {
  const GateLook({
    required this.ok,
    required this.headline,
    this.detail,
  });

  final bool ok;
  final String headline;
  final String? detail;
}

/// The answer drawn for one check-in. Kept apart from the widget so the words
/// can be tested.
GateLook gateLookFor(CheckinResult r, {DateTime? now}) {
  final t = r.ticket;
  final event = [
    if (t?.eventTitle != null) t!.eventTitle!,
    if (t?.startsAt != null) eventWhen(t!.startsAt, now: now),
  ].join(' · ');
  switch (r.outcome) {
    case CheckinOutcome.admitted:
      final who = [
        if (t?.holder != null) t!.holder!,
        if (t?.type != null) t!.type!,
      ].join(' · ');
      return GateLook(
        ok: true,
        headline: who.isEmpty ? 'Admit' : 'Admit: $who',
        detail: event.isEmpty ? null : event,
      );
    case CheckinOutcome.alreadyUsed:
      final at = r.checkedInAt;
      final today = now ?? DateTime.now();
      final sameDay =
          at != null &&
          at.year == today.year &&
          at.month == today.month &&
          at.day == today.day;
      final when = at == null
          ? null
          : sameDay
          ? DateFormat('HH:mm').format(at)
          : DateFormat('d MMM HH:mm').format(at);
      final who = [
        if (t?.holder != null) t!.holder!,
        if (t?.type != null) t!.type!,
      ].join(' · ');
      return GateLook(
        ok: false,
        headline: when == null ? 'Already scanned' : 'Already scanned at $when',
        detail: [
          if (who.isNotEmpty) who,
          if (event.isNotEmpty) event,
          if (who.isEmpty && event.isEmpty && r.message != null) r.message!,
        ].join('\n'),
      );
    case CheckinOutcome.invalid:
      return GateLook(
        ok: false,
        headline: r.message ?? 'Not a valid ticket',
        detail: 'Do not admit. Check the code, or send them to the box office.',
      );
  }
}

class TicketsPage extends ConsumerStatefulWidget {
  const TicketsPage({super.key});

  @override
  ConsumerState<TicketsPage> createState() => _TicketsPageState();
}

class _TicketsPageState extends ConsumerState<TicketsPage> {
  @override
  Widget build(BuildContext context) {
    ref.watch(tillModulesRevisionProvider);
    if (!ref.watch(tillModulesProvider).events) return const _ModuleOff();
    return const _Gate();
  }
}

class _ModuleOff extends StatelessWidget {
  const _ModuleOff();

  @override
  Widget build(BuildContext context) => const Center(
    child: Padding(
      padding: EdgeInsets.all(40),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.confirmation_number, size: 56, color: Pos.graphite),
          SizedBox(height: 16),
          Text(
            'Events & tickets is switched off',
            style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700),
          ),
          SizedBox(height: 8),
          Text(
            'A manager switches the Events & tickets module on in the back '
            'office under Modules. This page appears on every till in the '
            'venue when they do.',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 13.5, color: Pos.graphite),
          ),
        ],
      ),
    ),
  );
}

class _Gate extends ConsumerStatefulWidget {
  const _Gate();

  @override
  ConsumerState<_Gate> createState() => _GateState();
}

class _GateState extends ConsumerState<_Gate> {
  final _scan = TextEditingController();
  final _focus = FocusNode(debugLabel: 'ticket scan');

  List<TicketEvent>? _events;
  String? _error;
  bool _loading = false;
  Timer? _poll;

  /// The answer on screen, and what clears it.
  GateLook? _shown;
  Timer? _clear;

  /// Scans in flight, one after another, so two tickets scanned in quick
  /// succession are answered in the order they were scanned.
  Future<void> _queue = Future.value();
  int _inFlight = 0;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
    // Left up all evening, so the counts keep moving as other gates scan.
    _poll = Timer.periodic(const Duration(seconds: 30), (_) {
      if (mounted) unawaited(_load(quiet: true));
    });
  }

  @override
  void dispose() {
    _poll?.cancel();
    _clear?.cancel();
    _scan.dispose();
    _focus.dispose();
    super.dispose();
  }

  Future<void> _load({bool quiet = false}) async {
    if (!quiet) setState(() => _loading = true);
    try {
      final list = await ref.read(eventsRepositoryProvider).events();
      list.sort((a, b) {
        final x = a.startsAt, y = b.startsAt;
        if (x == null || y == null) return x == null ? 1 : -1;
        return x.compareTo(y);
      });
      if (!mounted) return;
      setState(() {
        _events = list;
        _error = null;
        _loading = false;
      });
    } on TicketsException catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.message;
        _loading = false;
      });
    }
  }

  void _refocus() {
    if (mounted && !_focus.hasFocus) _focus.requestFocus();
  }

  void _submit(String text) {
    final code = text.trim();
    _scan.clear();
    _refocus();
    if (!looksLikeTicketCode(code)) return;
    setState(() => _inFlight++);
    _queue = _queue.then((_) => _check(code));
  }

  Future<void> _check(String code) async {
    try {
      if (ref.read(trainingModeProvider)) {
        _show(
          const GateLook(
            ok: false,
            headline: 'Not in training mode',
            detail:
                'Checking a ticket in uses it for real, so practice cannot do '
                'it. Sign off training to work the gate.',
          ),
        );
        return;
      }
      final CheckinResult result;
      try {
        result = await ref
            .read(eventsRepositoryProvider)
            .checkIn(code, staff: ref.read(servedByProvider));
      } on TicketsException catch (e) {
        _show(
          GateLook(ok: false, headline: 'Not checked', detail: e.message),
        );
        return;
      }
      _show(gateLookFor(result));
      // The counts on the page move with the gate.
      if (result.admitted) unawaited(_load(quiet: true));
    } finally {
      if (mounted) setState(() => _inFlight--);
    }
  }

  void _show(GateLook look) {
    if (!mounted) return;
    _clear?.cancel();
    setState(() => _shown = look);
    if (look.ok) {
      unawaited(HapticFeedback.mediumImpact());
      unawaited(SystemSound.play(SystemSoundType.click));
    } else {
      unawaited(HapticFeedback.heavyImpact());
      unawaited(SystemSound.play(SystemSoundType.alert));
    }
    // Long enough to read a name off; a refusal longer, because somebody has
    // to be turned away and may need to see why.
    _clear = Timer(Duration(seconds: look.ok ? 3 : 6), _dismiss);
    _refocus();
  }

  void _dismiss() {
    _clear?.cancel();
    if (mounted && _shown != null) setState(() => _shown = null);
    _refocus();
  }

  Future<void> _typeCode() async {
    final typed = TextEditingController();
    final code = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Type a ticket code'),
        content: SizedBox(
          width: 420,
          child: PosTextField(
            controller: typed,
            autofocus: true,
            mode: PosKeyboardMode.text,
            textCapitalization: TextCapitalization.characters,
            submitLabel: 'Check',
            decoration: const InputDecoration(
              labelText: 'Code',
              hintText: 'As printed under the QR code',
            ),
            onSubmitted: (v) => Navigator.of(context).pop(v),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(typed.text),
            child: const Text('Check ticket'),
          ),
        ],
      ),
    );
    typed.dispose();
    if (code != null) _submit(code);
    _refocus();
  }

  @override
  Widget build(BuildContext context) {
    // Another gate, or the back office, changed an event.
    ref.listen(syncEventsProvider, (_, next) {
      if (next.value?.type == 'events') unawaited(_load(quiet: true));
    });

    final events = _events ?? const <TicketEvent>[];
    final shown = _shown;
    return Stack(
      children: [
        Positioned.fill(
          child: ListView(
            padding: const EdgeInsets.all(24),
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Tickets',
                          style: TextStyle(
                            fontSize: 24,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                        SizedBox(height: 4),
                        Text(
                          'Scan each ticket at the gate. Green, let them in; '
                          'red, do not.',
                          style: TextStyle(fontSize: 13),
                        ),
                      ],
                    ),
                  ),
                  OutlinedButton.icon(
                    onPressed: _typeCode,
                    icon: const Icon(Icons.keyboard),
                    label: const Text('Type a code'),
                  ),
                  const SizedBox(width: 8),
                  IconButton(
                    onPressed: _load,
                    icon: const Icon(Icons.refresh),
                    tooltip: 'Refresh',
                  ),
                ],
              ),
              const SizedBox(height: 20),
              _ScanBox(
                controller: _scan,
                focus: _focus,
                busy: _inFlight > 0,
                onSubmitted: _submit,
              ),
              const SizedBox(height: 24),
              if (_loading && _events == null)
                const Padding(
                  padding: EdgeInsets.all(24),
                  child: Center(child: CircularProgressIndicator()),
                )
              else if (_error != null && _events == null)
                _Notice(icon: Icons.cloud_off, text: _error!)
              else if (events.isEmpty)
                const _Notice(
                  icon: Icons.event_busy,
                  text:
                      'No events from yesterday to a week ahead. Events are '
                      'set up in the back office under Events & tickets.',
                )
              else ...[
                if (_error != null)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 12),
                    child: _Notice(icon: Icons.cloud_off, text: _error!),
                  ),
                for (final e in events) _EventCard(event: e),
              ],
            ],
          ),
        ),
        if (shown != null)
          Positioned.fill(
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: _dismiss,
              child: _Answer(look: shown),
            ),
          ),
      ],
    );
  }
}

/// The scan box: big, always focused, cleared after every scan.
///
/// A plain [TextField] rather than a [PosTextField] on purpose: the scanner is
/// the keyboard here, and an on-screen board that came up every time the box
/// took focus would cover the events for the whole evening. Typing a code by
/// hand has its own button and its own board.
class _ScanBox extends StatelessWidget {
  const _ScanBox({
    required this.controller,
    required this.focus,
    required this.busy,
    required this.onSubmitted,
  });

  final TextEditingController controller;
  final FocusNode focus;
  final bool busy;
  final ValueChanged<String> onSubmitted;

  @override
  Widget build(BuildContext context) => TextField(
    key: const ValueKey('ticket-scan'),
    controller: controller,
    focusNode: focus,
    autofocus: true,
    // A touch elsewhere on the page must not take the scanner's box away.
    onTapOutside: (_) {},
    textInputAction: TextInputAction.done,
    onSubmitted: onSubmitted,
    style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w600),
    decoration: InputDecoration(
      prefixIcon: const Icon(Icons.qr_code_scanner, size: 32),
      suffixIcon: busy
          ? const Padding(
              padding: EdgeInsets.all(14),
              child: SizedBox(
                width: 20,
                height: 20,
                child: CircularProgressIndicator(strokeWidth: 2.5),
              ),
            )
          : null,
      hintText: 'Scan a ticket',
      helperText: 'The scanner types here. Return checks the ticket.',
      border: const OutlineInputBorder(),
      contentPadding: const EdgeInsets.symmetric(vertical: 22, horizontal: 16),
    ),
  );
}

class _Answer extends StatelessWidget {
  const _Answer({required this.look});

  final GateLook look;

  @override
  Widget build(BuildContext context) {
    final bg = look.ok ? Pos.green : Pos.red;
    return Material(
      color: bg,
      child: SafeArea(
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(32),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(
                  look.ok ? Icons.check_circle_outline : Icons.block,
                  size: 120,
                  color: Colors.white,
                ),
                const SizedBox(height: 20),
                Text(
                  look.headline,
                  textAlign: TextAlign.center,
                  style: const TextStyle(
                    color: Colors.white,
                    fontSize: 44,
                    fontWeight: FontWeight.w800,
                  ),
                ),
                if ((look.detail ?? '').isNotEmpty) ...[
                  const SizedBox(height: 14),
                  Text(
                    look.detail!,
                    textAlign: TextAlign.center,
                    style: const TextStyle(color: Colors.white, fontSize: 22),
                  ),
                ],
                const SizedBox(height: 28),
                const Text(
                  'Touch to clear, or scan the next ticket',
                  style: TextStyle(color: Colors.white70, fontSize: 14),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _Notice extends StatelessWidget {
  const _Notice({required this.icon, required this.text});

  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) => Row(
    children: [
      Icon(icon, color: Pos.graphite),
      const SizedBox(width: 12),
      Expanded(
        child: Text(text, style: const TextStyle(color: Pos.graphite)),
      ),
    ],
  );
}

class _EventCard extends StatelessWidget {
  const _EventCard({required this.event});

  final TicketEvent event;

  @override
  Widget build(BuildContext context) {
    final e = event;
    final share = e.sold == 0 ? 0.0 : (e.checkedIn / e.sold).clamp(0.0, 1.0);
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        e.title,
                        style: const TextStyle(
                          fontSize: 18,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      if (e.startsAt != null)
                        Text(
                          eventWhen(e.startsAt),
                          style: const TextStyle(color: Pos.graphite),
                        ),
                    ],
                  ),
                ),
                _Count(label: 'Sold', value: e.sold),
                const SizedBox(width: 20),
                _Count(label: 'In', value: e.checkedIn, colour: Pos.green),
                const SizedBox(width: 20),
                _Count(label: 'To come', value: e.toCome),
              ],
            ),
            const SizedBox(height: 10),
            LinearProgressIndicator(
              value: share,
              minHeight: 8,
              color: Pos.green,
              backgroundColor: Pos.green.withValues(alpha: 0.15),
            ),
            if (e.types.isNotEmpty) ...[
              const SizedBox(height: 10),
              Wrap(
                spacing: 8,
                runSpacing: 6,
                children: [
                  for (final t in e.types)
                    Chip(
                      visualDensity: VisualDensity.compact,
                      label: Text(
                        t.priceMinor == 0
                            ? '${t.name} · free'
                            : '${t.name} · ${_money(t.priceMinor)}',
                      ),
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

class _Count extends StatelessWidget {
  const _Count({required this.label, required this.value, this.colour});

  final String label;
  final int value;
  final Color? colour;

  @override
  Widget build(BuildContext context) => Column(
    children: [
      Text(
        '$value',
        style: TextStyle(
          fontSize: 24,
          fontWeight: FontWeight.w800,
          color: colour,
        ),
      ),
      Text(label, style: const TextStyle(fontSize: 12, color: Pos.graphite)),
    ],
  );
}
