/// What a member sees when they swipe at the gym door.
///
/// THIS IS THE FILE THE "NO POP UPS" REQUIREMENT LIVES IN
///
/// "They use this as a self service where no one mans the till. Maybe another
/// prefix for gym member cards due to it being unmanned and can't have pop ups."
///
/// A dialog is a thing that waits. It takes the keyboard, it takes the tap, and
/// it stays where it is until somebody answers it — which at a counter is
/// exactly right and at an unmanned door is a screen frozen on one member's
/// name until a member of staff walks over from the other end of the building.
/// The next four people to swipe get nothing at all, and their visits are
/// recorded against a screen nobody can read.
///
/// So this is not a dialog. It is a layer painted over the whole till that
///
///   * takes no route, so nothing can be "behind" it and nothing has to be
///     popped before the till can be used again;
///   * swallows no input, so a member of staff can carry on ringing a sale up
///     underneath it — [IgnorePointer] is the whole of that;
///   * clears itself after the venue's few seconds, so the till is always ready
///     for the next person;
///   * and is replaced instantly by the next swipe rather than queueing behind
///     it, because two members arriving together is the normal case at half
///     past six in the morning and the second one must not be shown the first
///     one's name.
///
/// WHY IT IS PAINTED ABOVE THE IDLE LOCK
///
/// An unmanned gym till spends its whole life locked: nobody is signed on to it
/// and the screensaver is down. That is the state the door has to work in, so
/// the greeting is mounted in `_LockedTill` *after* the shutter — see main.dart.
/// Under it, the one screen this feature exists to draw would be the one screen
/// nobody ever sees.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/gym.dart';
import 'theme.dart';

/// The greeting currently on screen, if any.
///
/// A notifier rather than a `showDialog`, because the thing being modelled is
/// "what does the door currently say", which has exactly one answer at a time
/// and is replaced rather than stacked.
final gymGreetingProvider = NotifierProvider<GymGreeting, GymAnswer?>(
  GymGreeting.new,
);

class GymGreeting extends Notifier<GymAnswer?> {
  Timer? _clear;

  @override
  GymAnswer? build() {
    ref.onDispose(() => _clear?.cancel());
    return null;
  }

  /// Say this, for [seconds], and then stop saying it.
  ///
  /// A second call replaces the first outright — including its timer. Two
  /// members arriving together is the ordinary case, and the second one must
  /// get their own full few seconds rather than the tail of somebody else's.
  void show(GymAnswer answer, {required int seconds}) {
    if (!answer.speaks) return;
    _clear?.cancel();
    state = answer;
    _clear = Timer(Duration(seconds: seconds.clamp(2, 30)), () {
      state = null;
    });
  }

  /// Take it away now. Used by the Gym page when somebody touches the screen,
  /// which is the one moment there demonstrably *is* a person there.
  void dismiss() {
    _clear?.cancel();
    state = null;
  }
}

/// The layer itself. Wraps the till; draws nothing at all when the door has
/// nothing to say.
class GymGreetingLayer extends ConsumerWidget {
  const GymGreetingLayer({super.key, required this.apiBase});

  /// For the member's photograph, which is a server-relative path.
  final String apiBase;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final answer = ref.watch(gymGreetingProvider);

    return AnimatedSwitcher(
      duration: const Duration(milliseconds: 220),
      switchInCurve: Curves.easeOutCubic,
      switchOutCurve: Curves.easeInCubic,
      child: answer == null
          ? const SizedBox.shrink()
          : _GymPanel(
              // Keyed on the member and the outcome, so a second swipe by
              // somebody else animates as a change rather than editing the
              // first person's name in place under the second person's nose.
              key: ValueKey('${answer.outcome}/${answer.memberName}/'
                  '${answer.cardNumber}/${identityHashCode(answer)}'),
              answer: answer,
              apiBase: apiBase,
            ),
    );
  }
}

class _GymPanel extends StatelessWidget {
  const _GymPanel({super.key, required this.answer, required this.apiBase});

  final GymAnswer answer;
  final String apiBase;

  @override
  Widget build(BuildContext context) {
    final look = _lookFor(answer);

    // IgnorePointer is not a detail. Without it this layer would swallow every
    // tap on the till for the whole time it is up, which is a dialog by another
    // name -- and a member of staff ringing a sale up at the same counter would
    // find the screen dead for six seconds each time somebody came through the
    // door.
    return IgnorePointer(
      child: SafeArea(
        child: Align(
          alignment: Alignment.topCenter,
          child: Padding(
            padding: const EdgeInsets.all(20),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 720),
              child: Material(
                elevation: 12,
                borderRadius: BorderRadius.circular(20),
                color: look.background,
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 26,
                    vertical: 22,
                  ),
                  child: Row(
                    children: [
                      _Face(
                        answer: answer,
                        apiBase: apiBase,
                        icon: look.icon,
                        ink: look.ink,
                      ),
                      const SizedBox(width: 22),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Text(
                              look.headline,
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(
                                fontSize: 34,
                                height: 1.1,
                                fontWeight: FontWeight.w800,
                                color: look.ink,
                              ),
                            ),
                            const SizedBox(height: 6),
                            Text(
                              look.detail,
                              style: TextStyle(
                                fontSize: 17,
                                height: 1.3,
                                color: look.ink.withValues(alpha: 0.86),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// The member's photograph, or the outcome as a symbol.
///
/// The photograph is the only check there is at a door with nobody on it: the
/// member sees whose card they have just used. Where the venue has taken none,
/// a large symbol does the same job the colour does, for anybody who cannot
/// separate the green from the red.
class _Face extends StatelessWidget {
  const _Face({
    required this.answer,
    required this.apiBase,
    required this.icon,
    required this.ink,
  });

  final GymAnswer answer;
  final String apiBase;
  final IconData icon;
  final Color ink;

  @override
  Widget build(BuildContext context) {
    final url = answer.photoUrl;
    if (url == null || url.isEmpty) {
      return Icon(icon, size: 64, color: ink);
    }

    final absolute = url.startsWith('http') ? url : '$apiBase$url';
    return ClipRRect(
      borderRadius: BorderRadius.circular(14),
      child: Image.network(
        absolute,
        width: 84,
        height: 84,
        fit: BoxFit.cover,
        // A photograph that cannot be fetched must not leave a hole where the
        // member expected to see their face. The symbol is the same one a venue
        // with no photographs gets.
        errorBuilder: (_, _, _) => Icon(icon, size: 64, color: ink),
        loadingBuilder: (context, child, progress) =>
            progress == null ? child : Icon(icon, size: 64, color: ink),
      ),
    );
  }
}

/// How one outcome looks and what it says.
class _Look {
  const _Look({
    required this.background,
    required this.ink,
    required this.icon,
    required this.headline,
    required this.detail,
  });

  final Color background;
  final Color ink;
  final IconData icon;
  final String headline;
  final String detail;
}

_Look _lookFor(GymAnswer a) {
  final name = (a.memberName ?? '').trim();
  final first = name.isEmpty ? '' : name.split(' ').first;

  switch (a.outcome) {
    case GymOutcome.entered:
      final soon = a.expiringInDays;
      return _Look(
        background: Pos.green,
        ink: Colors.white,
        icon: Icons.check_circle_outline,
        headline: first.isEmpty ? 'Welcome in' : 'Welcome, $first',
        detail: soon == null
            ? 'Signed in at ${_clock()}. Swipe the same card on your way out.'
            : soon <= 0
            ? 'Signed in at ${_clock()}. Your membership runs out today — '
                  'please see us about renewing it.'
            : 'Signed in at ${_clock()}. Your membership runs out in '
                  '$soon day${soon == 1 ? '' : 's'} — please see us about '
                  'renewing it.',
      );

    case GymOutcome.left:
      final minutes = a.minutes;
      return _Look(
        background: Pos.chrome,
        ink: Colors.white,
        icon: Icons.logout,
        headline: first.isEmpty ? 'Goodbye' : 'See you soon, $first',
        detail: minutes == null || minutes <= 0
            ? 'Signed out at ${_clock()}.'
            : 'Signed out at ${_clock()} — ${_spell(minutes)} in the gym.',
      );

    case GymOutcome.expired:
      final when = a.membershipExpiry;
      final days = a.expiredDays;
      return _Look(
        background: Pos.red,
        ink: Colors.white,
        icon: Icons.event_busy,
        headline: a.refused
            ? 'Membership has run out'
            : first.isEmpty
            ? 'Membership has run out'
            : '$first — membership has run out',
        detail:
            [
              if (when != null) 'It expired on ${_pretty(when)}',
              if (days != null && days > 0) '$days day${days == 1 ? '' : 's'} ago',
            ].join(', ') +
            (a.refused
                ? '. Please see a member of staff to renew it.'
                : '. You are signed in — please see a member of staff to renew.'),
      );

    case GymOutcome.unknown:
      return _Look(
        background: Pos.amber,
        ink: Pos.onBrand,
        icon: Icons.help_outline,
        headline: 'Card not recognised',
        detail:
            'That card (${a.cardNumber ?? 'unknown'}) is not on this gym\'s '
            'member list. The reader is working — please see a member of staff.',
      );

    case GymOutcome.ignored:
      // Deliberately shown rather than silent. Somebody standing at a door who
      // gets no response at all swipes again, and again, and then goes to find
      // somebody; a line saying "already signed in" ends it.
      return _Look(
        background: Pos.chrome,
        ink: Colors.white,
        icon: Icons.done_all,
        headline: first.isEmpty ? 'Already signed in' : '$first — already in',
        detail:
            'That card was read a moment ago, so this swipe was ignored. Swipe '
            'again when you leave.',
      );

    case GymOutcome.queued:
      return _Look(
        background: Pos.chrome,
        ink: Colors.white,
        icon: Icons.cloud_off,
        headline: 'Recorded',
        detail:
            'The till cannot reach the back office at the moment, so it cannot '
            'greet you by name. Your visit has been saved and will be sent '
            'across when the connection returns.',
      );

    case GymOutcome.notGym:
      // Never drawn -- GymGreeting.show refuses it -- but the switch has to be
      // exhaustive, and a default clause here would be a silent hole the next
      // outcome falls through.
      return const _Look(
        background: Pos.chrome,
        ink: Colors.white,
        icon: Icons.help_outline,
        headline: '',
        detail: '',
      );
  }
}

String _clock() {
  final now = DateTime.now();
  return '${now.hour.toString().padLeft(2, '0')}:'
      '${now.minute.toString().padLeft(2, '0')}';
}

String _spell(int minutes) {
  if (minutes < 60) return '$minutes minute${minutes == 1 ? '' : 's'}';
  final hours = minutes ~/ 60;
  final rest = minutes % 60;
  final h = '$hours hour${hours == 1 ? '' : 's'}';
  return rest == 0 ? h : '$h $rest min';
}

/// `2026-03-04` as `4 March 2026`. A date on a screen a member is reading is a
/// date, not a database column.
String _pretty(String iso) {
  final parsed = DateTime.tryParse(iso);
  if (parsed == null) return iso;
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  return '${parsed.day} ${months[parsed.month - 1]} ${parsed.year}';
}
