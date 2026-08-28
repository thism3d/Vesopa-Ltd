/// Clock in, clock out.
///
/// Deliberately not the same thing as signing on, and the difference is the
/// reason this is a separate key rather than something that happens
/// automatically when somebody types their PIN. Signing on says "I am about to
/// ring something up on this machine" — it happens twenty times a shift and
/// ends every time the clerk walks away. A shift is one row that opens when a
/// person arrives and closes when they leave, and it is what a wage is paid
/// against.
///
/// One key and one list. Somebody arriving finds their name with **In** beside
/// it; somebody leaving finds their name with the time they started and how
/// long they have worked. A PIN is asked for either way: a time clock anybody
/// can punch on anybody's behalf is a time clock that proves nothing.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/local/database.dart';
import '../data/terminal_service.dart';
import '../main.dart';
import 'pin_dialog.dart';
import 'widgets/pos_message.dart';

/// How long a shift has run, as somebody standing at a counter reads it.
String shiftLength(Duration d) {
  final hours = d.inHours;
  final minutes = d.inMinutes.remainder(60);
  if (hours == 0) return '${minutes}m';
  return '${hours}h ${minutes}m';
}

/// Put the venue's staff up, marked with who is on, and punch whoever is
/// chosen in or out.
Future<void> showClockSheet(BuildContext context, WidgetRef ref) async {
  final terminals = ref.read(terminalServiceProvider);
  if (!terminals.canShare) {
    PosMessenger.error(
      context,
      'This terminal was set up before the time clock existed. Sign the till '
      'in again from Settings to enable it.',
    );
    return;
  }

  await showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    builder: (_) => const _ClockSheet(),
  );
}

class _ClockSheet extends ConsumerStatefulWidget {
  const _ClockSheet();

  @override
  ConsumerState<_ClockSheet> createState() => _ClockSheetState();
}

class _ClockSheetState extends ConsumerState<_ClockSheet> {
  /// Set while a punch is in flight, so a second press cannot open two shifts
  /// while the first is still on the wire.
  int? _busy;

  @override
  Widget build(BuildContext context) {
    final staff = ref.watch(staffListProvider).value ?? const <StaffData>[];
    final clock = ref.watch(clockStateProvider).value ?? ClockState.empty;

    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxHeight: MediaQuery.of(context).size.height * 0.85,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 18, 20, 4),
              child: Row(
                children: [
                  const Icon(Icons.schedule),
                  const SizedBox(width: 10),
                  const Expanded(
                    child: Text(
                      'Clock in / out',
                      style: TextStyle(
                        fontSize: 20,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
                  IconButton(
                    icon: const Icon(Icons.close),
                    onPressed: () => Navigator.of(context).pop(),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 12),
              child: Text(
                'Your shift, not the till. Signing on and off during service '
                'does not touch this.',
                style: TextStyle(
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
              ),
            ),
            if (staff.isEmpty)
              const Padding(
                padding: EdgeInsets.fromLTRB(20, 8, 20, 28),
                child: Text(
                  'Nobody is set up to sign on at this venue yet. Add staff in '
                  'the back office under Programming › Staff.',
                ),
              )
            else
              Flexible(
                child: ListView.separated(
                  shrinkWrap: true,
                  itemCount: staff.length,
                  separatorBuilder: (_, _) => const Divider(height: 1),
                  itemBuilder: (_, i) => _row(staff[i], clock),
                ),
              ),
            const SizedBox(height: 12),
          ],
        ),
      ),
    );
  }

  Widget _row(StaffData who, ClockState clock) {
    final open = clock.open.where((e) => e.staffId == who.id).firstOrNull;
    final on = open != null;

    return ListTile(
      leading: CircleAvatar(
        backgroundColor: on
            ? Theme.of(context).colorScheme.primary
            : Theme.of(context).colorScheme.surfaceContainerHighest,
        child: Icon(
          on ? Icons.check : Icons.person_outline,
          color: on
              ? Theme.of(context).colorScheme.onPrimary
              : Theme.of(context).colorScheme.onSurfaceVariant,
        ),
      ),
      title: Text(who.name),
      subtitle: Text(
        on
            ? 'On since ${TimeOfDay.fromDateTime(open.clockedInAt).format(context)}'
                  ' — ${shiftLength(open.worked)}'
            : 'Not clocked in',
      ),
      trailing: _busy == who.id
          ? const SizedBox(
              width: 20,
              height: 20,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          : FilledButton(
              style: on
                  ? FilledButton.styleFrom(
                      backgroundColor:
                          Theme.of(context).colorScheme.errorContainer,
                      foregroundColor:
                          Theme.of(context).colorScheme.onErrorContainer,
                    )
                  : null,
              onPressed: _busy != null ? null : () => _punch(who),
              child: Text(on ? 'Clock out' : 'Clock in'),
            ),
    );
  }

  Future<void> _punch(StaffData who) async {
    // The PIN is the signature. Without it one person could clock a colleague
    // in from the car park, which is the whole reason a venue asks for a time
    // clock rather than a sheet of paper by the door.
    final pin = await askForPin(context, 'Your PIN, ${who.name}');
    if (pin == null || !mounted) return;

    final matched = await ref.read(staffRepositoryProvider).byPin(pin);
    if (!mounted) return;
    if (matched == null || matched.id != who.id) {
      PosMessenger.error(context, 'That PIN does not match ${who.name}.');
      return;
    }

    setState(() => _busy = who.id);
    try {
      final state = await ref
          .read(terminalServiceProvider)
          .punch(staffId: who.id, staffName: who.name);
      ref.invalidate(clockStateProvider);
      if (!mounted) return;
      PosMessenger.success(
        context,
        state == 'in'
            ? '${who.name} clocked in.'
            : '${who.name} clocked out.',
      );
    } on TerminalUnavailable catch (e) {
      if (mounted) PosMessenger.error(context, e.message);
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }
}
