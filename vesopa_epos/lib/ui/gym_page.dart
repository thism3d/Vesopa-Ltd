/// The gym board: who is in, and who has been and gone.
///
/// "On the gym page it would show who is currently in the gym — turn them
/// green, red if they have been and gone."
///
/// WHAT THIS SCREEN IS FOR, AND WHO IS LOOKING AT IT
///
/// Two different people, at two different distances, which is the only
/// interesting thing about its layout:
///
///   * a member of staff who has walked over to ask "how many are in?" and is
///     reading it from a few feet away — so the count is the biggest thing on
///     the page and the colour of a row is legible before any of its text is;
///   * and whoever is doing the fire roll call, who needs the names of exactly
///     the people who are still inside — so the ones who are in are listed
///     first, always, whatever else is on screen.
///
/// COLOUR IS NEVER THE ONLY SIGNAL
///
/// Green in, red gone, as asked. But roughly one man in twelve cannot separate
/// those two hues, and this is a screen glanced at from across a room — the
/// worst possible case for colour alone. So every row also carries the word: a
/// filled dot and "In the gym" against a time of departure. The colour makes it
/// fast for most people; the words make it possible for everybody.
///
/// IT REFRESHES ITSELF
///
/// Because it is meant to be left up. Twenty seconds is fast enough that
/// somebody walking in appears while they are still taking their coat off, and
/// slow enough to be nothing at all on the server. It stops the moment the page
/// is left, so a till parked on the Sale screen is not polling a door all night.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/gym.dart';
import '../main.dart';
import 'gym_greeting.dart';
import 'theme.dart';

class GymPage extends ConsumerStatefulWidget {
  const GymPage({super.key});

  @override
  ConsumerState<GymPage> createState() => _GymPageState();
}

class _GymPageState extends ConsumerState<GymPage> {
  static const _refresh = Duration(seconds: 20);

  Timer? _timer;
  List<GymVisit>? _visits;

  /// Null visits and this false is "still loading"; null visits and this true
  /// is "we asked and could not be told". They are drawn differently, because
  /// "nobody is in the gym" and "we cannot say who is in the gym" are not the
  /// same sentence and only one of them means somebody should go and look.
  bool _asked = false;
  int _queued = 0;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
    _timer = Timer.periodic(_refresh, (_) => unawaited(_load()));
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    final gym = ref.read(gymRepositoryProvider);
    final visits = await gym.board();
    final queued = await gym.pending();
    if (!mounted) return;
    setState(() {
      _visits = visits;
      _asked = true;
      _queued = queued;
    });
  }

  @override
  Widget build(BuildContext context) {
    final gym = ref.watch(gymRepositoryProvider);
    // Watched so the page rebuilds when the rules are re-read -- a manager
    // switching the gym off in the back office has to empty this screen without
    // anybody restarting a till.
    ref.watch(gymSettingsRevisionProvider);

    if (!gym.settings.enabled) {
      return const _GymOff();
    }

    final visits = _visits ?? const <GymVisit>[];
    final inGym = visits.where((v) => v.inGym).toList();
    final been = visits.where((v) => !v.inGym).toList();

    return GestureDetector(
      // Somebody has touched the screen, so there demonstrably IS a person
      // here -- which is the one moment the greeting can be taken away early
      // rather than waiting out its few seconds.
      behavior: HitTestBehavior.translucent,
      onTap: () => ref.read(gymGreetingProvider.notifier).dismiss(),
      child: RefreshIndicator(
        onRefresh: _load,
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
                        'Gym',
                        style: TextStyle(
                          fontSize: 24,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      SizedBox(height: 4),
                      Text(
                        'Members swipe in at the door and swipe the same card '
                        'on the way out.',
                        style: TextStyle(fontSize: 13),
                      ),
                    ],
                  ),
                ),
                IconButton(
                  onPressed: _load,
                  icon: const Icon(Icons.refresh),
                  tooltip: 'Refresh',
                ),
              ],
            ),
            const SizedBox(height: 20),

            _Counts(inGym: inGym.length, been: been.length),

            if (_queued > 0) ...[
              const SizedBox(height: 14),
              _Note(
                icon: Icons.cloud_off,
                tone: Pos.amber,
                text:
                    '$_queued swipe${_queued == 1 ? '' : 's'} ${_queued == 1 ? 'is' : 'are'} '
                    'waiting to reach the back office. The door is still '
                    'working — the board will catch up when the connection '
                    'returns.',
              ),
            ],

            if (_visits == null && _asked) ...[
              const SizedBox(height: 14),
              const _Note(
                icon: Icons.wifi_off,
                tone: Pos.red,
                text:
                    'The till cannot reach the back office, so it cannot say '
                    'who is in the gym. Members can still swipe in and out.',
              ),
            ],

            const SizedBox(height: 24),
            _Section(
              title: 'In the gym now',
              count: inGym.length,
              empty: _visits == null
                  ? 'Not known just now.'
                  : 'Nobody is in the gym.',
              visits: inGym,
            ),

            const SizedBox(height: 24),
            _Section(
              title: 'Been and gone today',
              count: been.length,
              empty: 'Nobody has left yet today.',
              visits: been,
            ),

            const SizedBox(height: 24),
            const Text(
              'This board is today. Everything further back — how often each '
              'member comes, who is about to expire — is in the back office '
              'under Gym.',
              style: TextStyle(fontSize: 12.5, color: Pos.graphite),
            ),
          ],
        ),
      ),
    );
  }
}

/// The venue has no gym. Says what the page is rather than showing an empty
/// board, because a manager who has just heard about the feature will look here
/// first and needs to be told where the switch is.
class _GymOff extends StatelessWidget {
  const _GymOff();

  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(40),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.fitness_center, size: 56, color: Pos.graphite),
          const SizedBox(height: 16),
          const Text(
            'The gym is switched off',
            style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 8),
          const Text(
            'Turn it on in the back office under Gym, and give gym cards a '
            'prefix of their own. This page fills in on every till in the '
            'venue within a couple of minutes.',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 13.5, color: Pos.graphite),
          ),
        ],
      ),
    ),
  );
}

/// The two numbers, large.
class _Counts extends StatelessWidget {
  const _Counts({required this.inGym, required this.been});

  final int inGym;
  final int been;

  @override
  Widget build(BuildContext context) => Row(
    children: [
      Expanded(
        child: _Count(
          label: 'In the gym now',
          value: inGym,
          colour: Pos.green,
          icon: Icons.fitness_center,
        ),
      ),
      const SizedBox(width: 16),
      Expanded(
        child: _Count(
          label: 'Been and gone',
          value: been,
          colour: Pos.graphite,
          icon: Icons.logout,
        ),
      ),
    ],
  );
}

class _Count extends StatelessWidget {
  const _Count({
    required this.label,
    required this.value,
    required this.colour,
    required this.icon,
  });

  final String label;
  final int value;
  final Color colour;
  final IconData icon;

  @override
  Widget build(BuildContext context) => Card(
    margin: EdgeInsets.zero,
    child: Padding(
      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 18),
      child: Row(
        children: [
          Icon(icon, color: colour, size: 30),
          const SizedBox(width: 16),
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                '$value',
                style: TextStyle(
                  fontSize: 34,
                  height: 1,
                  fontWeight: FontWeight.w800,
                  color: colour,
                ),
              ),
              const SizedBox(height: 2),
              Text(
                label,
                style: const TextStyle(fontSize: 12.5, color: Pos.graphite),
              ),
            ],
          ),
        ],
      ),
    ),
  );
}

class _Section extends StatelessWidget {
  const _Section({
    required this.title,
    required this.count,
    required this.empty,
    required this.visits,
  });

  final String title;
  final int count;
  final String empty;
  final List<GymVisit> visits;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(
        count > 0 ? '$title ($count)' : title,
        style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700),
      ),
      const SizedBox(height: 10),
      if (visits.isEmpty)
        Text(empty, style: const TextStyle(fontSize: 13, color: Pos.graphite))
      else
        Card(
          margin: EdgeInsets.zero,
          child: Column(
            children: [
              for (final visit in visits) _VisitRow(visit: visit),
            ],
          ),
        ),
    ],
  );
}

class _VisitRow extends StatelessWidget {
  const _VisitRow({required this.visit});

  final GymVisit visit;

  @override
  Widget build(BuildContext context) {
    final here = visit.inGym;
    final colour = here ? Pos.green : Pos.red;

    return ListTile(
      leading: Container(
        width: 14,
        height: 14,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          color: here ? Pos.green : Pos.red.withValues(alpha: 0.55),
        ),
      ),
      title: Row(
        children: [
          Flexible(
            child: Text(
              visit.memberName.isEmpty ? 'Unknown card' : visit.memberName,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontWeight: FontWeight.w600),
            ),
          ),
          if (visit.memberNo != null) ...[
            const SizedBox(width: 8),
            Text(
              '#${visit.memberNo}',
              style: const TextStyle(fontSize: 12, color: Pos.graphite),
            ),
          ],
          if (visit.expired) ...[
            const SizedBox(width: 8),
            const _Tag(text: 'expired', colour: Pos.red),
          ],
        ],
      ),
      subtitle: Text(
        here
            ? 'In since ${_clock(visit.enteredAt)} — ${_spell(visit.minutes)}'
            : 'In ${_clock(visit.enteredAt)}, out ${_clock(visit.leftAt)}'
                  '${visit.closedBy == 'auto' ? ' (not swiped out)' : ''}'
                  ' — ${_spell(visit.minutes)}',
        style: const TextStyle(fontSize: 12.5),
      ),
      // The word, beside the colour. This is the line that makes the board
      // readable to somebody who cannot tell the two dots apart.
      trailing: Text(
        here ? 'In the gym' : 'Gone',
        style: TextStyle(
          fontSize: 13,
          fontWeight: FontWeight.w700,
          color: colour,
        ),
      ),
    );
  }
}

class _Tag extends StatelessWidget {
  const _Tag({required this.text, required this.colour});

  final String text;
  final Color colour;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
    decoration: BoxDecoration(
      color: colour.withValues(alpha: 0.14),
      borderRadius: BorderRadius.circular(999),
    ),
    child: Text(
      text,
      style: TextStyle(
        fontSize: 11,
        fontWeight: FontWeight.w700,
        color: colour,
      ),
    ),
  );
}

class _Note extends StatelessWidget {
  const _Note({required this.icon, required this.tone, required this.text});

  final IconData icon;
  final Color tone;
  final String text;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
    decoration: BoxDecoration(
      color: tone.withValues(alpha: 0.12),
      borderRadius: BorderRadius.circular(12),
    ),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, size: 20, color: tone),
        const SizedBox(width: 12),
        Expanded(
          child: Text(text, style: const TextStyle(fontSize: 12.5)),
        ),
      ],
    ),
  );
}

String _clock(DateTime? at) {
  if (at == null) return '—';
  return '${at.hour.toString().padLeft(2, '0')}:'
      '${at.minute.toString().padLeft(2, '0')}';
}

String _spell(int minutes) {
  if (minutes <= 0) return 'just now';
  if (minutes < 60) return '$minutes min';
  final hours = minutes ~/ 60;
  final rest = minutes % 60;
  return rest == 0 ? '${hours}h' : '${hours}h ${rest}m';
}
