import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/providers.dart';
import '../data/ticket.dart';
import '../printing/kitchen_print.dart';
import 'completed_board.dart';
import 'counts_board.dart';
import 'info_page.dart';
import 'open_board.dart';
import 'settings_page.dart';
import 'theme.dart';
import 'widgets/brand_mark.dart';

/// The chrome, and everything that lives in it.
///
/// One bar across the top and nothing else, exactly as the reference:
///
/// ```
///   ☰      [ 3 Open ] [ Counts ] [ 35 Completed ]      🖨  ⚙  💬  ⏻
/// ```
///
/// The counted tabs carry their number *in the label* rather than in a badge,
/// which is the reference's decision and worth copying: `0 Open` reads as a
/// sentence from across a kitchen, where a badge stuck on a word does not.
///
/// The screen has no room for anything else. Every other surface in this app —
/// settings, the info panel, a ticket's detail — is reached from these four
/// keys or the hamburger, and comes back off the screen when it is finished
/// with. A kitchen board that can be navigated *away* from is a board that will
/// be left somewhere else at the wrong moment.
class KitchenShell extends ConsumerStatefulWidget {
  const KitchenShell({super.key});

  @override
  ConsumerState<KitchenShell> createState() => _KitchenShellState();
}

enum _Tab { open, counts, completed }

class _KitchenShellState extends ConsumerState<KitchenShell> {
  _Tab _tab = _Tab.open;

  /// Flashes the board when an order arrives, so the movement is visible from
  /// the other side of the kitchen even with the sound off.
  bool _flash = false;

  @override
  void initState() {
    super.initState();

    // Wired in `initState` rather than in the notifier so the board has no
    // opinion about how a new ticket is announced — it knows one arrived, and
    // the shell decides what that sounds and looks like.
    ref.read(ticketBoardProvider.notifier).onNewTicket = _announce;

    // Started after the first frame: `start` reads the session, and a provider
    // read during the build that mounts this widget is a rebuild during a
    // build.
    WidgetsBinding.instance.addPostFrameCallback((_) => _startBoard());
  }

  Future<void> _startBoard() async {
    final session = ref.read(kitchenSessionProvider).value;
    if (session?.office == null) return;
    await ref
        .read(ticketBoardProvider.notifier)
        .start(session!.office!, ref.read(wsUrlProvider));
  }

  void _announce(Ticket ticket) {
    if (!mounted) return;

    if (ref.read(kitchenSessionProvider).value?.sound ?? true) {
      // The system alert, not a bundled sound file.
      //
      // A kitchen is loud, and the noise that actually gets heard is the one
      // the venue has already set the volume for. Shipping a chime would mean
      // shipping a volume control for it, and then explaining to a chef why
      // the Windows volume slider does not affect it.
      SystemSound.play(SystemSoundType.alert);
    }

    setState(() => _flash = true);
    Future.delayed(const Duration(milliseconds: 700), () {
      if (mounted) setState(() => _flash = false);
    });
  }

  @override
  Widget build(BuildContext context) {
    final board = ref.watch(ticketBoardProvider);
    final session = ref.watch(kitchenSessionProvider).value;
    final profile = session?.screen;
    if (session == null || profile == null) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }

    final openCount = board.open(profile).length;
    final doneCount = board.completed(profile).length;

    return Scaffold(
      drawer: _Drawer(onPick: (tab) => setState(() => _tab = tab)),
      body: SafeArea(
        child: Column(
          children: [
            _Header(
              tab: _tab,
              openCount: openCount,
              completedCount: doneCount,
              onTab: (tab) => setState(() => _tab = tab),
              onPrint: () => printTickets(
                context,
                tickets: _tab == _Tab.completed
                    ? board.completed(profile)
                    : board.open(profile),
                profile: profile,
                labelFor: session.labelFor,
                venueName: session.officeName,
                heading: _tab == _Tab.completed
                    ? 'Completed orders'
                    : 'Kitchen board',
              ),
              onSettings: () => showKitchenSettings(context),
              onInfo: () => showKitchenInfo(context),
              onSignOut: () => _confirmSignOut(context),
            ),

            // A persistent bar, not a toast.
            //
            // A toast that a chef missed is worse than no warning at all: it
            // leaves them believing a board that has stopped moving. This
            // stays up for exactly as long as the problem does.
            if (!board.online) const _OfflineBar(),

            Expanded(
              child: AnimatedContainer(
                duration: const Duration(milliseconds: 220),
                color: _flash ? Kds.selectedTrack : Kds.canvas,
                child: switch (_tab) {
                  _Tab.open => const OpenBoard(),
                  _Tab.counts => const CountsBoard(),
                  _Tab.completed => const CompletedBoard(),
                },
              ),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _confirmSignOut(BuildContext context) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Sign this screen out?'),
        // Said plainly, because it is the only irreversible key on the header
        // and the person reaching for it may have meant the one next to it.
        // Signing back in needs the venue's office email and the kitchen
        // password, which is not something a chef mid-service will have.
        content: const Text(
          'The board will stop showing orders until somebody signs it back in '
          'with the venue’s kitchen login. Orders already sent are not lost — '
          'they will be here when it is.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('Stay signed in'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('Sign out'),
          ),
        ],
      ),
    );

    if (confirmed == true) {
      await ref.read(kitchenSessionProvider.notifier).signOut();
    }
  }
}

class _Header extends StatelessWidget {
  const _Header({
    required this.tab,
    required this.openCount,
    required this.completedCount,
    required this.onTab,
    required this.onPrint,
    required this.onSettings,
    required this.onInfo,
    required this.onSignOut,
  });

  final _Tab tab;
  final int openCount;
  final int completedCount;
  final ValueChanged<_Tab> onTab;
  final VoidCallback onPrint;
  final VoidCallback onSettings;
  final VoidCallback onInfo;
  final VoidCallback onSignOut;

  @override
  Widget build(BuildContext context) {
    return Container(
      height: 58,
      color: Kds.card,
      padding: const EdgeInsets.symmetric(horizontal: 8),
      child: Row(
        children: [
          Builder(
            builder: (context) => IconButton(
              icon: const Icon(Icons.menu),
              tooltip: 'Menu',
              onPressed: () => Scaffold.of(context).openDrawer(),
            ),
          ),

          Expanded(
            child: Center(
              child: _Segments(
                tab: tab,
                openCount: openCount,
                completedCount: completedCount,
                onTab: onTab,
              ),
            ),
          ),

          IconButton(
            icon: const Icon(Icons.print_outlined),
            tooltip: 'Print what is on this board',
            onPressed: onPrint,
          ),
          IconButton(
            icon: const Icon(Icons.settings_outlined),
            tooltip: 'This screen',
            onPressed: onSettings,
          ),
          IconButton(
            icon: const Icon(Icons.chat_bubble_outline),
            tooltip: 'About this screen, and support',
            onPressed: onInfo,
          ),
          IconButton(
            icon: const Icon(Icons.logout),
            tooltip: 'Sign out',
            onPressed: onSignOut,
          ),
        ],
      ),
    );
  }
}

/// The segmented control, drawn by hand.
///
/// Material's `SegmentedButton` would do the job and would not look like the
/// reference: it insists on an equal width per segment and on a check mark
/// against the selected one, and here the labels are three very different
/// lengths and the count *is* the state. Fifty lines is cheaper than fighting
/// it.
class _Segments extends StatelessWidget {
  const _Segments({
    required this.tab,
    required this.openCount,
    required this.completedCount,
    required this.onTab,
  });

  final _Tab tab;
  final int openCount;
  final int completedCount;
  final ValueChanged<_Tab> onTab;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: Kds.selectedTrack,
        borderRadius: BorderRadius.circular(9),
      ),
      padding: const EdgeInsets.all(3),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          _Segment(
            label: '$openCount Open',
            selected: tab == _Tab.open,
            onTap: () => onTab(_Tab.open),
          ),
          _Segment(
            label: 'Counts',
            selected: tab == _Tab.counts,
            onTap: () => onTab(_Tab.counts),
          ),
          _Segment(
            label: '$completedCount Completed',
            selected: tab == _Tab.completed,
            onTap: () => onTab(_Tab.completed),
          ),
        ],
      ),
    );
  }
}

class _Segment extends StatelessWidget {
  const _Segment({
    required this.label,
    required this.selected,
    required this.onTap,
  });

  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: selected ? Kds.selected : Colors.transparent,
      borderRadius: BorderRadius.circular(7),
      child: InkWell(
        borderRadius: BorderRadius.circular(7),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 9),
          child: Text(
            label,
            style: TextStyle(
              fontSize: 15,
              fontWeight: FontWeight.w700,
              color: selected ? Colors.white : Kds.inkMuted,
            ),
          ),
        ),
      ),
    );
  }
}

class _OfflineBar extends ConsumerWidget {
  const _OfflineBar();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final board = ref.watch(ticketBoardProvider);

    return Container(
      width: double.infinity,
      color: Kds.offline,
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
      child: Row(
        children: [
          const Icon(Icons.cloud_off, size: 18, color: Colors.white),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              board.queuedActions > 0
                  ? 'Not connected to the back office. New orders will not '
                        'appear, and ${board.queuedActions} '
                        '${board.queuedActions == 1 ? 'change' : 'changes'} '
                        'made here will be sent when the link comes back.'
                  : 'Not connected to the back office. What is on this board '
                        'is still what was ordered, but new orders will not '
                        'appear until the link comes back.',
              style: const TextStyle(color: Colors.white, fontSize: 13.5),
            ),
          ),
          TextButton(
            onPressed: () => ref.read(ticketBoardProvider.notifier).refresh(),
            style: TextButton.styleFrom(foregroundColor: Colors.white),
            child: const Text('Try now'),
          ),
        ],
      ),
    );
  }
}

/// The hamburger.
///
/// What is behind it and what is not is the whole design of it: the four keys
/// on the right of the header are the ones somebody reaches for mid-service,
/// and everything in here is something they do once a shift or once a month.
class _Drawer extends ConsumerWidget {
  const _Drawer({required this.onPick});

  final ValueChanged<_Tab> onPick;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(kitchenSessionProvider).value;
    final board = ref.watch(ticketBoardProvider);
    if (session == null) return const Drawer(child: SizedBox.shrink());

    final profile = session.screen;

    return Drawer(
      child: SafeArea(
        child: ListView(
          padding: EdgeInsets.zero,
          children: [
            Container(
              color: Kds.chromeHeader,
              padding: const EdgeInsets.fromLTRB(18, 20, 18, 18),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      // The mark sits on the drawer's near-black header, which
                      // is the colour it was drawn for — so it needs no plate
                      // behind it here.
                      const BrandMark(size: 34),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Text(
                          profile.name,
                          style: const TextStyle(
                            color: Colors.white,
                            fontSize: 21,
                            fontWeight: FontWeight.w700,
                          ),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 6),
                  Text(
                    session.officeName ?? session.office ?? '',
                    style: const TextStyle(
                      color: Color(0xFFB9BFCB),
                      fontSize: 13.5,
                    ),
                  ),
                  const SizedBox(height: 10),
                  Row(
                    children: [
                      Icon(
                        board.online ? Icons.cloud_done : Icons.cloud_off,
                        size: 15,
                        color: board.online ? Kds.brand : Kds.warn,
                      ),
                      const SizedBox(width: 6),
                      Text(
                        board.online ? 'Connected' : 'Not connected',
                        style: TextStyle(
                          color: board.online ? Kds.brand : Kds.warn,
                          fontSize: 12.5,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),

            ListTile(
              leading: const Icon(Icons.receipt_long),
              title: const Text('Open orders'),
              trailing: Text('${board.open(profile).length}'),
              onTap: () {
                onPick(_Tab.open);
                Navigator.of(context).pop();
              },
            ),
            ListTile(
              leading: const Icon(Icons.inventory_2_outlined),
              title: const Text('Counts'),
              subtitle: const Text('Everything outstanding, added up'),
              onTap: () {
                onPick(_Tab.counts);
                Navigator.of(context).pop();
              },
            ),
            ListTile(
              leading: const Icon(Icons.history),
              title: const Text('Completed'),
              trailing: Text('${board.completed(profile).length}'),
              onTap: () {
                onPick(_Tab.completed);
                Navigator.of(context).pop();
              },
            ),

            const Divider(),

            ListTile(
              leading: const Icon(Icons.refresh),
              title: const Text('Refresh the board'),
              subtitle: Text(
                board.lastUpdated == null
                    ? 'Never updated'
                    : 'Updated ${_ago(DateTime.now().difference(board.lastUpdated!))}',
              ),
              onTap: () {
                ref.read(ticketBoardProvider.notifier).refresh();
                Navigator.of(context).pop();
              },
            ),
            ListTile(
              leading: Icon(
                session.sound ? Icons.volume_up : Icons.volume_off,
              ),
              title: Text(
                session.sound ? 'Chime is on' : 'Chime is off',
              ),
              subtitle: const Text('For new orders arriving'),
              onTap: () => ref
                  .read(kitchenSessionProvider.notifier)
                  .setSound(!session.sound),
            ),
            ListTile(
              leading: const Icon(Icons.tv_outlined),
              title: const Text('This screen'),
              subtitle: Text(
                profile.stations.isEmpty
                    ? 'Watching every station'
                    : 'Watching ${profile.stations.map(session.labelFor).join(', ')}',
              ),
              onTap: () {
                Navigator.of(context).pop();
                showKitchenSettings(context);
              },
            ),
            ListTile(
              leading: const Icon(Icons.chat_bubble_outline),
              title: const Text('About & support'),
              onTap: () {
                Navigator.of(context).pop();
                showKitchenInfo(context);
              },
            ),
          ],
        ),
      ),
    );
  }

  static String _ago(Duration d) {
    if (d.inSeconds < 10) return 'just now';
    if (d.inSeconds < 60) return '${d.inSeconds}s ago';
    if (d.inMinutes < 60) return '${d.inMinutes}m ago';
    return '${d.inHours}h ago';
  }
}
