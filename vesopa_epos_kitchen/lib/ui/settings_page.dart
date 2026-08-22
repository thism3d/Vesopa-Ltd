import 'dart:io' show Platform, exit;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:window_manager/window_manager.dart';

import '../data/providers.dart';
import '../data/screen_profile.dart';
import 'branding_page.dart';
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

                // ---- Branding ------------------------------------------
                //
                // Venue-wide, not this machine's — so it sits under its own
                // heading rather than in "On this machine" above, and it costs
                // the kitchen password to change. A panel on a wall in a room
                // full of people should not be able to restyle every screen on
                // the site on a stray tap.
                const Divider(height: 30),
                const _SectionTitle('Branding'),
                Text(
                  session.branding.isCustomised
                      ? 'These screens carry this venue’s own branding.'
                      : 'These screens carry the standard Vesopa Kitchen '
                            'branding.',
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: Kds.inkMuted,
                  ),
                ),
                const SizedBox(height: 8),
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: const Icon(Icons.palette_outlined),
                  title: const Text('Start screen & branding'),
                  subtitle: const Text(
                    'The name, the colours and the start screen, for every '
                    'kitchen screen in this venue. Needs the kitchen password.',
                    style: TextStyle(fontSize: 12.5),
                  ),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => showKitchenBranding(context),
                ),

                // ---- Closing the app -----------------------------------
                //
                // The window has no X and no minimise button (see
                // _lockWindowToKiosk in main.dart), for a sharper version of
                // the till's reason: a till that gets minimised stops taking
                // money and somebody notices in seconds, while a kitchen screen
                // that gets minimised keeps *looking* like a working computer
                // and the orders behind it are found when a customer asks where
                // their food is. That leaves this as the only way out, so it has
                // to be here and it has to be findable.
                if (_canQuit) ...[
                  const Divider(height: 30),
                  const _SectionTitle('Close this screen'),
                  Card(
                    margin: EdgeInsets.zero,
                    child: ListTile(
                      leading: const Icon(
                        Icons.power_settings_new,
                        color: Kds.late,
                      ),
                      title: const Text('Exit application'),
                      subtitle: const Text(
                        'Shuts the kitchen screen down completely. Orders will '
                        'carry on reaching the other screens and the printers, '
                        'and will be here when it is started again.',
                        style: TextStyle(fontSize: 12.5),
                      ),
                      trailing: const Icon(Icons.chevron_right),
                      onTap: () => _confirmExit(context),
                    ),
                  ),
                ],
                const SizedBox(height: 8),
              ],
            ),
          ),
        ],
      ),
    );
  }

  /// Only desktop has a window to close. Windows is the only platform this app
  /// ships on today; the check is here so the button does not have to be
  /// remembered if that ever stops being true.
  bool get _canQuit =>
      Platform.isWindows || Platform.isMacOS || Platform.isLinux;

  /// Ask before quitting.
  ///
  /// Not password-gated, unlike signing out, and the difference is worth
  /// stating: quitting is *recoverable by the person standing there* — they
  /// start the app again and the screen comes back signed in, because the
  /// token is on the machine. Signing out is not, because it throws the token
  /// away. So this asks once, plainly, and does not send anybody looking for a
  /// credential in the middle of a service.
  Future<void> _confirmExit(BuildContext context) async {
    final quit = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        icon: const Icon(
          Icons.power_settings_new,
          size: 30,
          color: Kds.late,
        ),
        title: const Text('Exit Vesopa Kitchen?'),
        content: const Text(
          'This screen will close and stop showing orders. Nothing is lost — '
          'the orders are on the server, and they will be here when somebody '
          'starts it again.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('Stay open'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            style: FilledButton.styleFrom(backgroundColor: Kds.late),
            child: const Text('Exit'),
          ),
        ],
      ),
    );

    if (quit != true) return;

    // destroy(), not close(): the window was made unclosable at startup and a
    // close request against it is simply ignored. destroy() tears it down
    // regardless, and exit(0) is the backstop if the platform channel is not
    // there for any reason.
    try {
      await windowManager.destroy();
    } catch (_) {
      exit(0);
    }
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
