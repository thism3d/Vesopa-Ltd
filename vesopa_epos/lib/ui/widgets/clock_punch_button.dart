/// One key that clocks the person standing at the till in, or out.
///
/// WHAT THIS REPLACED, AND WHY
///
/// The Clock key used to open a list of everybody at the venue, and you found
/// your own name in it before anything happened. That is the right screen for a
/// manager checking who is on and the wrong one for the twenty people a day who
/// press it about themselves: a pub with twenty staff put a scroll between a
/// clerk and their own shift, at the two moments of the day when they are least
/// inclined to hunt for anything — arriving, and leaving.
///
/// The venue asked for the key to clock in "the person that is signed into the
/// till", and the till already knows who that is. So the key acts, and the list
/// moves to Functions, where a manager looks for it.
///
/// GREEN AND RED, WITH THE TIME
///
/// Also as asked, and it is the better half of the change. A key labelled
/// "Clock in / out" answers neither of the questions somebody presses it with —
/// am I on, and since when. A green key reading `In 09:14` answers both from
/// across the counter, and a red one reading `Out 17:32` is the receipt for
/// having gone home.
///
/// NO SECOND PIN
///
/// The list asks for one, and has to: it lets anybody punch anybody, so without
/// a PIN it proves nothing and one person could clock a colleague in from the
/// car park. This key cannot do that. It only ever acts on the signed-on
/// session, which was opened with that person's own PIN — so asking again is
/// asking the same question twice, at a counter, to establish a fact already
/// established.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/local/database.dart';
import '../../data/staff_session.dart';
import '../../data/terminal_service.dart';
import '../../main.dart';
import '../theme.dart';
import 'pos_message.dart';

/// Where the signed-on member of staff stands with the clock.
@immutable
class ClockPunch {
  const ClockPunch({this.staff, this.openedAt, this.closedAt});

  /// Nobody signed on. The key says so rather than offering to punch a shift
  /// for a person the till cannot name.
  final StaffData? staff;

  /// When the open shift started, if there is one.
  final DateTime? openedAt;

  /// When today's last shift ended, if it has. Only read when [openedAt] is
  /// null — a person who clocked out at lunch and back in at two is *on*, and
  /// the earlier clock-out is not what the key should be reporting.
  final DateTime? closedAt;

  bool get signedOn => staff != null;
  bool get isOn => openedAt != null;

  /// Read the clock for whoever is signed on.
  static ClockPunch of(WidgetRef ref) {
    final staff = ref.watch(staffSessionProvider).staff;
    if (staff == null) return const ClockPunch();
    return from(staff, ref.watch(clockStateProvider).value ?? ClockState.empty);
  }

  /// The same, from values rather than from providers — so the rule about
  /// which of a day's several shifts the key reports can be tested without
  /// standing a till up.
  static ClockPunch from(StaffData staff, ClockState clock) {
    final open = clock.open.where((e) => e.staffId == staff.id).firstOrNull;

    // The latest close, not the first: somebody who worked two shifts today
    // should see the end of the second.
    DateTime? closed;
    for (final entry in clock.today) {
      if (entry.staffId != staff.id) continue;
      final out = entry.clockedOutAt;
      if (out == null) continue;
      if (closed == null || out.isAfter(closed)) closed = out;
    }

    return ClockPunch(
      staff: staff,
      openedAt: open?.clockedInAt,
      closedAt: closed,
    );
  }

  /// `In 09:14`, `Out 17:32`, or an instruction.
  String label(BuildContext context) {
    if (!signedOn) return 'Clock in';
    if (isOn) return 'In ${_hhmm(context, openedAt!)}';
    if (closedAt != null) return 'Out ${_hhmm(context, closedAt!)}';
    return 'Clock in';
  }

  /// The second line: what pressing it will do.
  String get action {
    if (!signedOn) return 'Sign on first';
    return isOn ? 'Tap to clock out' : 'Tap to clock in';
  }

  static String _hhmm(BuildContext context, DateTime at) =>
      TimeOfDay.fromDateTime(at).format(context);
}

/// Clock the signed-on member of staff in or out.
///
/// The server decides which, from its own state, so a double press cannot open
/// two shifts or close one twice — see [TerminalService.punch].
Future<void> punchSignedOnStaff(BuildContext context, WidgetRef ref) async {
  final staff = ref.read(staffSessionProvider).staff;
  if (staff == null) {
    PosMessenger.info(
      context,
      'Sign on first — the clock records a shift against whoever is on the '
      'till, and nobody is.',
    );
    return;
  }

  try {
    final state = await ref
        .read(terminalServiceProvider)
        .punch(staffId: staff.id, staffName: staff.name);
    ref.invalidate(clockStateProvider);
    if (!context.mounted) return;
    PosMessenger.success(
      context,
      state == 'in'
          ? '${staff.name} clocked in.'
          : '${staff.name} clocked out.',
    );
  } on TerminalUnavailable catch (e) {
    if (context.mounted) PosMessenger.error(context, e.message);
  }
}

/// The key itself: green on shift, red once the shift has ended.
///
/// Sized to whatever it is given, so the same widget serves a bar key and a
/// tile on the Functions page.
class ClockPunchKey extends ConsumerStatefulWidget {
  const ClockPunchKey({super.key, this.compact = false});

  /// True on the top bar, where there is one line of room rather than two.
  final bool compact;

  @override
  ConsumerState<ClockPunchKey> createState() => _ClockPunchKeyState();
}

class _ClockPunchKeyState extends ConsumerState<ClockPunchKey> {
  /// Set while a punch is on the wire, so a second press cannot start a second
  /// one against a shift that is already changing.
  bool _busy = false;

  Future<void> _press() async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await punchSignedOnStaff(context, ref);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final punch = ClockPunch.of(ref);

    // Green, red, or neutral. Stated as fills rather than as theme roles
    // because the venue asked for these two colours by name, and a theme that
    // maps "error" to something other than red would quietly answer a different
    // question from the one they asked.
    final (Color fill, Color ink) = switch (punch) {
      ClockPunch(signedOn: false) => (
        Theme.of(context).colorScheme.surfaceContainerHighest,
        Theme.of(context).colorScheme.onSurfaceVariant,
      ),
      ClockPunch(isOn: true) => (Pos.green, Colors.white),
      ClockPunch(closedAt: != null) => (Pos.red, Colors.white),
      _ => (
        Theme.of(context).colorScheme.surfaceContainerHighest,
        Theme.of(context).colorScheme.onSurface,
      ),
    };

    return Material(
      color: fill,
      borderRadius: BorderRadius.circular(10),
      child: InkWell(
        // Live even with nobody signed on. A dead key is a key somebody presses
        // twice and then reports as broken; this one says what to do instead.
        onTap: _press,
        borderRadius: BorderRadius.circular(10),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
          child: Center(
            child: _busy
                ? SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2, color: ink),
                  )
                : Column(
                    mainAxisSize: MainAxisSize.min,
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Icon(
                        punch.isOn ? Icons.timer : Icons.schedule,
                        size: widget.compact ? 16 : 20,
                        color: ink,
                      ),
                      const SizedBox(height: 2),
                      Text(
                        punch.label(context),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: ink,
                          fontSize: widget.compact ? 13 : 15,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      if (!widget.compact) ...[
                        const SizedBox(height: 1),
                        Text(
                          punch.action,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            color: ink.withValues(alpha: 0.85),
                            fontSize: 11,
                          ),
                        ),
                      ],
                    ],
                  ),
          ),
        ),
      ),
    );
  }
}
