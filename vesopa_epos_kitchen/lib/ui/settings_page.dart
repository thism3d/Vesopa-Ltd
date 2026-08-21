import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/providers.dart';
import '../data/screen_profile.dart';
import 'theme.dart';

/// What *this* machine is, as against what the venue has set up.
///
/// The split is the point of this screen and is stated on it: which board this
/// panel draws, and whether it makes a noise, are facts about where it is
/// standing. Everything else — which stations a board watches, when a ticket
/// turns amber, how long recall lasts — belongs to the venue and is set in the
/// back office, so that "the grill screen" means one thing in the building
/// rather than one thing per panel.
///
/// It is shown read-only here rather than hidden, because the person standing
/// in front of a board that is behaving oddly needs to be able to see why
/// without ringing anybody.
Future<void> showKitchenSettings(BuildContext context) => showDialog<void>(
  context: context,
  builder: (_) => const Dialog(child: _SettingsSheet()),
);

class _SettingsSheet extends ConsumerWidget {
  const _SettingsSheet();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(kitchenSessionProvider).value;
    final board = ref.watch(ticketBoardProvider);
    if (session == null) return const SizedBox.shrink();

    final notifier = ref.read(kitchenSessionProvider.notifier);
    final current = session.screen;

    return ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 620, maxHeight: 760),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          AppBar(
            title: const Text('This screen'),
            automaticallyImplyLeading: false,
            actions: [
              IconButton(
                icon: const Icon(Icons.close),
                onPressed: () => Navigator.of(context).pop(),
              ),
            ],
          ),
          Flexible(
            child: ListView(
              padding: const EdgeInsets.fromLTRB(18, 12, 18, 18),
              children: [
                const _SectionTitle('Which board is this?'),
                Text(
                  'Set once, when the screen is put on the wall. It decides '
                  'which stations’ orders appear here — and nothing else on '
                  'this panel changes it.',
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: Kds.inkMuted,
                  ),
                ),
                const SizedBox(height: 10),

                // The built-in profile has no row in the database, so its
                // negative id stands in for "unset" — which is why the tile
                // reports `null` rather than its own id when chosen.
                RadioGroup<int>(
                  groupValue: current.id,
                  onChanged: (id) => notifier.chooseScreen(
                    id == null || id < 0 ? null : id,
                  ),
                  child: Column(
                    children: [
                      for (final profile in session.choices)
                        RadioListTile<int>(
                          value: profile.id,
                          title: Text(profile.name),
                          subtitle: Text(
                            _describe(profile, session.labelFor),
                          ),
                        ),
                    ],
                  ),
                ),

                if (session.screens.isEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 6),
                    child: Text(
                      'This venue has not set up any named screens yet. Add '
                      'them in the back office under Kitchen screens — until '
                      'then this panel shows every station, which is right for '
                      'a kitchen with one screen.',
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ),

                const Divider(height: 30),
                const _SectionTitle('On this machine'),
                SwitchListTile(
                  value: session.sound,
                  onChanged: (on) => notifier.setSound(on),
                  title: const Text('Sound a chime for new orders'),
                  subtitle: Text(
                    session.soundOverride == null
                        ? 'Following the “${current.name}” setting from the '
                              'back office.'
                        : 'Set on this machine, overriding the back office.',
                  ),
                  contentPadding: EdgeInsets.zero,
                ),
                if (session.soundOverride != null)
                  Align(
                    alignment: Alignment.centerLeft,
                    child: TextButton(
                      onPressed: () => notifier.setSound(null),
                      child: const Text('Follow the back office again'),
                    ),
                  ),

                const Divider(height: 30),
                const _SectionTitle('Set in the back office'),
                Text(
                  'These belong to the venue, so every screen agrees. Change '
                  'them under Kitchen screens.',
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: Kds.inkMuted,
                  ),
                ),
                const SizedBox(height: 8),
                _Fact('Stations', _describe(current, session.labelFor)),
                _Fact('Turns amber after', _minutes(current.warn)),
                _Fact('Turns red after', _minutes(current.late)),
                _Fact('Orders stay recallable for', _minutes(current.recallWindow)),
                _Fact(
                  'Columns',
                  current.columns == 0
                      ? 'As many as fit'
                      : '${current.columns}',
                ),

                const Divider(height: 30),
                const _SectionTitle('Connection'),
                _Fact(
                  'Back office',
                  board.online ? 'Connected' : 'Not reachable',
                ),
                _Fact(
                  'Board last updated',
                  board.lastUpdated == null
                      ? 'Never'
                      : _ago(DateTime.now().difference(board.lastUpdated!)),
                ),
                if (board.queuedActions > 0)
                  _Fact(
                    'Waiting to send',
                    board.queuedActions == 1
                        ? '1 change made while offline'
                        : '${board.queuedActions} changes made while offline',
                  ),
                const SizedBox(height: 8),
                Align(
                  alignment: Alignment.centerLeft,
                  child: OutlinedButton.icon(
                    onPressed: () =>
                        ref.read(ticketBoardProvider.notifier).refresh(),
                    icon: const Icon(Icons.refresh),
                    label: const Text('Refresh now'),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  static String _describe(
    ScreenProfile profile,
    String Function(String) labelFor,
  ) => profile.stations.isEmpty
      ? 'Every station'
      : profile.stations.map(labelFor).join(', ');

  static String _minutes(Duration d) {
    if (d.inMinutes < 60) return '${d.inMinutes} minutes';
    if (d.inMinutes == 60) return 'an hour';
    if (d.inMinutes % 60 == 0) return '${d.inHours} hours';
    return '${d.inHours}h ${d.inMinutes.remainder(60)}m';
  }

  static String _ago(Duration d) {
    if (d.inSeconds < 10) return 'just now';
    if (d.inSeconds < 60) return '${d.inSeconds} seconds ago';
    if (d.inMinutes < 60) return '${d.inMinutes} minutes ago';
    return '${d.inHours} hours ago';
  }
}

class _SectionTitle extends StatelessWidget {
  const _SectionTitle(this.text);
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 4),
    child: Text(
      text,
      style: Theme.of(
        context,
      ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700),
    ),
  );
}

class _Fact extends StatelessWidget {
  const _Fact(this.label, this.value);
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 3),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 220,
          child: Text(label, style: const TextStyle(color: Kds.inkMuted)),
        ),
        Expanded(
          child: Text(
            value,
            style: const TextStyle(fontWeight: FontWeight.w600),
          ),
        ),
      ],
    ),
  );
}
