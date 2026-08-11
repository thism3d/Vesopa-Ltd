import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/session_controller.dart';
import '../data/staff_session.dart';
import '../data/sync_service.dart';
import '../main.dart';
import 'layout.dart';
import 'about_page.dart';
import 'functions_page.dart';
import 'logout_dialog.dart';
import 'nav_panel_controller.dart';
import 'placeholder_page.dart';
import 'products_page.dart';
import 'settings_page.dart';
import 'receipts_page.dart';
import 'reports_page.dart';
import 'sale_page.dart';
import 'tables_page.dart';
import 'theme.dart';
import 'widgets/nav_rail.dart';

/// The till frame: fixed nav rail on the left, the selected page beside it.
class PosShell extends ConsumerStatefulWidget {
  const PosShell({super.key});

  @override
  ConsumerState<PosShell> createState() => _PosShellState();
}

class _PosShellState extends ConsumerState<PosShell> {
  int _index = 0;
  String? _orderId;

  /// Lets the desktop title bar's Settings button open the nav drawer, which is
  /// otherwise only reachable from an AppBar's automatic hamburger.
  final _scaffold = GlobalKey<ScaffoldState>();

  @override
  void initState() {
    super.initState();
    // Start syncing only once the terminal knows which venue it belongs to —
    // before sign-in there is no catalogue to pull.
    ref.read(syncServiceProvider).start();
    _newOrder();
  }

  Future<void> _newOrder() async {
    final id = await ref.read(orderRepositoryProvider).openOrder();
    if (mounted) setState(() => _orderId = id);
  }

  /// Sign out. The dialog verifies the password against the live server and
  /// refuses while this terminal still holds sales the server has never seen.
  Future<void> _logout() async {
    final done = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (_) => const LogoutDialog(),
    );

    if (done == true) {
      // Wipe this venue's cached catalogue and deals. Without this, a terminal
      // re-commissioned to another office would open showing the previous
      // office's products.
      final db = ref.read(databaseProvider);
      await db.delete(db.products).go();
      await db.delete(db.mixMatchProducts).go();
      await db.delete(db.mixMatchDeals).go();

      // Clearing the session drops the app back to the sign-in screen, which is
      // what the next person on this terminal should see.
      await ref.read(sessionControllerProvider.notifier).signOut();
    }
  }

  @override
  Widget build(BuildContext context) {
    // Pull the venue's receipt branding down once the till is running, so the
    // first receipt of the day already carries the logo and footer. Watched
    // here rather than at print time: printing must read a cache, never wait
    // on the network.
    ref.watch(brandingRefreshProvider);
    ref.watch(commerceRefreshProvider);

    final orderId = _orderId;
    final body = orderId == null
        ? const Center(child: CircularProgressIndicator())
        : _page(orderId);

    // Whether the side menu is fixed on screen or opens from the menu key is
    // the operator's choice now — see NavPanelMode. Default (auto) is fixed on
    // a desktop-width screen and tucked away below it.
    final navMode =
        ref.watch(navPanelControllerProvider).value ?? NavPanelMode.auto;
    final pinned = navMode.isPinnedOn(context.layout);

    // The drawer, for when the rail is not fixed. A fixed rail costs ~208px of
    // width permanently, on the screen where the product grid and the bill are
    // already competing for room; behind a menu key it costs nothing until it
    // is wanted.
    //
    // Built only when it will be used: a Scaffold with a drawer it never opens
    // still swallows the edge swipe, which on the Sale screen is the gesture
    // that scrolls the category rail.
    // Staff sign-on is offered wherever there is somebody to sign on — that is,
    // wherever the venue has staff with PINs.
    //
    // It used to also require the idle screen's PIN lock to be on, which tied
    // two separate decisions together: a venue can perfectly well want its
    // sales attributed to whoever rang them up without wanting the screen to
    // lock between customers. What the check does still guard is the case with
    // no answer — a till with no staff list, where a Sign On key would open a
    // PIN pad that could never accept a PIN.
    final staffSession = ref.watch(staffSessionProvider);
    final usesSignOn = ref.watch(canSignOnProvider);
    final onSignOff = usesSignOn && staffSession.signedOn
        ? () => ref.read(staffSessionProvider.notifier).signOff()
        : null;
    // The same slot, carrying whichever of the pair currently applies.
    final onSignOn = usesSignOn && !staffSession.signedOn
        ? () => ref.read(staffSessionProvider.notifier).promptSignOn()
        : null;

    final drawer = pinned
        ? null
        : Drawer(
            child: SafeArea(
              child: PosNavRail(
                selected: _index,
                onSelect: (i) {
                  setState(() => _index = i);
                  Navigator.of(context).pop();
                },
                onLogout: () {
                  Navigator.of(context).pop();
                  _logout();
                },
                onSignOff: onSignOff == null
                    ? null
                    : () {
                        Navigator.of(context).pop();
                        onSignOff();
                      },
                onSignOn: onSignOn == null
                    ? null
                    : () {
                        Navigator.of(context).pop();
                        onSignOn();
                      },
              ),
            ),
          );

    // The fixed rail has no drawer to close, so selecting must not pop — that
    // would take the current route off the navigator instead.
    final fixedRail = PosNavRail(
      selected: _index,
      onSelect: (i) => setState(() => _index = i),
      onLogout: _logout,
      onSignOff: onSignOff,
      onSignOn: onSignOn,
    );

    if (context.useCompactNav && !pinned) {
      return Scaffold(
        key: _scaffold,
        appBar: AppBar(
          // Colours come from appBarTheme, which now follows the theme. They
          // were hardcoded to the dark chrome here, which is why picking Day
          // left a black bar over a white screen.
          leading: IconButton(
            icon: const Icon(Icons.settings),
            tooltip: 'Settings & menu',
            onPressed: () => _scaffold.currentState?.openDrawer(),
          ),
          title: Row(
            children: [
              Icon(
                navDestinations[_index].icon,
                size: 20,
                color: Theme.of(context).posBrandOnChrome,
              ),
              const SizedBox(width: 10),
              Text(navDestinations[_index].label),
            ],
          ),
          actions: [
            // The same pair as the desktop bar. A tablet till is still a till,
            // and "hand it to the next person" is a mid-service action there
            // too — burying it in the drawer means it does not get used.
            StaffChip(onSignOn: onSignOn, onSignOff: onSignOff, compact: true),
            const Padding(
              padding: EdgeInsets.only(right: 12),
              child: Center(child: SyncStatusBadge()),
            ),
          ],
          elevation: 0,
        ),
        drawer: drawer,
        body: body,
      );
    }

    return Scaffold(
      key: _scaffold,
      drawer: drawer,
      body: Column(
        children: [
          _TitleBar(
            section: navDestinations[_index],
            // No menu key when the rail is already on screen: a button that
            // opens a copy of what is visible beside it is noise.
            onOpenMenu: pinned
                ? null
                : () => _scaffold.currentState?.openDrawer(),
            onSignOn: onSignOn,
            onSignOff: onSignOff,
          ),
          Expanded(
            child: pinned
                ? Row(
                    children: [
                      fixedRail,
                      VerticalDivider(
                        width: 1,
                        thickness: 1,
                        color: Theme.of(context).posLine,
                      ),
                      Expanded(child: body),
                    ],
                  )
                : body,
          ),
        ],
      ),
    );
  }

  /// Bring a parked bill onto the till and show it on the sale screen. Recalls
  /// it (flips it back to open) so it is no longer counted as a separate booked
  /// table while it is the active bill.
  Future<void> _switchToOrder(String id) async {
    await ref.read(tableRepositoryProvider).recall(id);
    if (!mounted) return;
    setState(() {
      _orderId = id;
      _index = navDestinations.indexWhere((d) => d.label == 'Sale');
    });
  }

  Widget _page(String orderId) {
    // Routed by label rather than index, so adding a nav item cannot silently
    // shift what each screen points to.
    switch (navDestinations[_index].label) {
      case 'Sale':
        return SalePage(
          orderId: orderId,
          onNewOrder: _newOrder,
          onSwitchOrder: _switchToOrder,
        );
      case 'Table':
        return TablesPage(currentOrderId: orderId, onRecall: _switchToOrder);
      case 'Receipts':
        return const ReceiptsPage();
      case 'Settings':
        return const SettingsPage();
      case 'Reports':
        return const ReportsPage();
      case 'Product':
        return const ProductsPage();
      case 'Functions':
        return FunctionsPage(
          orderId: orderId,
          onGoToReports: () => _goTo('Reports'),
          onGoToReceipts: () => _goTo('Receipts'),
          onGoToTables: () => _goTo('Table'),
        );
      default:
        return _sectionInfo(_index);
    }
  }

  /// Jump to another nav section by its label, from a button inside a page.
  void _goTo(String label) {
    final i = navDestinations.indexWhere((d) => d.label == label);
    if (i != -1) setState(() => _index = i);
  }

  /// Sections driven from the back office. Each explains what it does rather
  /// than showing an empty screen.
  Widget _sectionInfo(int index) {
    switch (navDestinations[index].label) {
      case 'Product':
        return PlaceholderPage(
          title: 'Products',
          icon: Icons.shopping_bag,
          description:
              'Your catalogue, synced from the back office and cached on this '
              'terminal so it keeps selling with no network. Tap a product on '
              'the Sale screen to add it to the bill.',
          points: const [
            'Assign products to specific buttons and colours',
            'Products with a picture show the picture on the button',
            'Set prices, VAT rates and stock levels',
            'Route items to a kitchen or bar printer',
          ],
          action: ('Go to Sale', () => _goTo('Sale')),
        );
      case 'Settings':
        return const PlaceholderPage(
          title: 'Settings',
          icon: Icons.settings,
          description: 'Printers, tax rates and terminal configuration.',
          points: [
            'Receipt printer: network (any platform) or serial (desktop only)',
            'Kitchen and bar printer routing',
            'Card terminal and tax rates',
          ],
        );
      case 'About':
        return const AboutPage();
      default:
        return PlaceholderPage(
          title: navDestinations[index].label,
          icon: navDestinations[index].icon,
          description: 'Managed from the Vesopa Back Office.',
        );
    }
  }
}

/// The desktop title bar: the Settings key that opens the nav, the section the
/// clerk is in, and the sync badge.
///
/// Taller than the 22px strip it replaces, because it now carries a real touch
/// target — but it buys back the ~210px the fixed nav rail used to take off the
/// width of every screen, which is the trade Meirion asked for.
class _TitleBar extends StatelessWidget {
  const _TitleBar({
    required this.section,
    required this.onOpenMenu,
    required this.onSignOn,
    required this.onSignOff,
  });

  final NavDestination section;

  /// Null when the nav rail is fixed on screen and there is no drawer to open.
  final VoidCallback? onOpenMenu;

  /// Whichever of the shift pair currently applies — see [StaffChip].
  final VoidCallback? onSignOn;
  final VoidCallback? onSignOff;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    // Follows the theme rather than being hardcoded to the dark chrome — the
    // reason the bar stayed black with Day selected. See PosColors.posChrome.
    final ink = theme.posOnChrome;

    return Material(
      color: theme.posChrome,
      child: DecoratedBox(
        decoration: BoxDecoration(
          // The light bar sits on a white page and needs a hairline to read as
          // a bar at all; the dark one separates by contrast on its own.
          border: theme.isDark
              ? null
              : Border(bottom: BorderSide(color: theme.posLine)),
        ),
        child: SizedBox(
          height: 46,
          child: Row(
            children: [
              const SizedBox(width: 4),
              if (onOpenMenu != null)
                IconButton(
                  icon: Icon(Icons.settings, color: ink, size: 22),
                  tooltip: 'Settings & menu',
                  onPressed: onOpenMenu,
                )
              else
                const SizedBox(width: 12),
              const SizedBox(width: 2),
              Icon(section.icon, color: theme.posBrandOnChrome, size: 18),
              const SizedBox(width: 9),
              Text(
                section.label,
                style: TextStyle(
                  color: ink,
                  fontSize: 15,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const Spacer(),
              // Whose shift this is, and the key that ends it. It settles the
              // question the moment it is asked — "am I about to ring this
              // onto my own name or the last person's?" — which matters once
              // the check shows attribution.
              StaffChip(onSignOn: onSignOn, onSignOff: onSignOff),
              // The clerk needs to know at a glance whether the till is live with
              // the back office or working offline with a backlog to send.
              const SyncStatusBadge(),
              const SizedBox(width: 14),
            ],
          ),
        ),
      ),
    );
  }
}

/// Who is on shift, and the key that ends or starts it.
///
/// Lives in the top bar, which is the one piece of chrome on every screen —
/// so Sign On and Sign Off are reachable from the Sale screen, the Tables
/// plan, Reports, Settings and everywhere else without going hunting. That was
/// the point of the request: a shift change happens wherever the person
/// handing over happens to be standing.
///
/// The name and the key are one control rather than two, because they answer
/// the same question. "Am I about to ring this onto my own name?" and "how do
/// I stop being the name?" are the same thought half a second apart, and
/// putting the answer anywhere but next to the name makes it a search.
///
/// Draws nothing when the terminal has nobody to sign on — see the note in the
/// shell's build about why that is the only case still guarded.
class StaffChip extends ConsumerWidget {
  const StaffChip({
    super.key,
    required this.onSignOn,
    required this.onSignOff,
    this.compact = false,
  });

  /// Exactly one of these is non-null when sign-on is available: whichever of
  /// the pair currently applies. Both null means this terminal has no staff
  /// list, and the chip draws nothing.
  final VoidCallback? onSignOn;
  final VoidCallback? onSignOff;

  /// The app-bar variant, which has less width to spend.
  final bool compact;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (onSignOn == null && onSignOff == null) return const SizedBox.shrink();

    final theme = Theme.of(context);
    final signedOn = onSignOff != null;
    final name = ref.watch(staffSessionProvider).name;

    // Signed on: the name, then a quiet Sign Off. Signed off: one lime key,
    // because at that moment starting a shift is the only thing the terminal
    // is for and it should look like the way forward.
    return Padding(
      padding: EdgeInsets.only(right: compact ? 4 : 12),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (signedOn && name != null) ...[
            Icon(
              Icons.how_to_reg_outlined,
              size: 15,
              color: theme.posBrandOnChrome,
            ),
            const SizedBox(width: 6),
            // Bounded so a long name cannot push the sync badge off a narrow
            // bar — the badge is the one thing here that must never vanish.
            ConstrainedBox(
              constraints: BoxConstraints(maxWidth: compact ? 90 : 160),
              child: Text(
                name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: theme.posOnChrome,
                  fontSize: 12.5,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
            const SizedBox(width: 8),
          ],
          _ShiftKey(
            label: signedOn ? 'Sign Off' : 'Sign On',
            icon: signedOn ? Icons.logout : Icons.login,
            // Sign Off is a quiet outline: it is pressed a handful of times a
            // shift and must not compete with the section it sits beside.
            filled: !signedOn,
            compact: compact,
            onTap: onSignOff ?? onSignOn!,
          ),
        ],
      ),
    );
  }
}

/// One key on the top bar, in the two weights [StaffChip] uses.
class _ShiftKey extends StatelessWidget {
  const _ShiftKey({
    required this.label,
    required this.icon,
    required this.filled,
    required this.compact,
    required this.onTap,
  });

  final String label;
  final IconData icon;
  final bool filled;
  final bool compact;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    // On the lime fill the ink must be the dark one — see Pos.onBrand. On the
    // outline it follows the bar, which is white in Night and near-black in
    // Day.
    final ink = filled ? Pos.onBrand : theme.posOnChrome;

    return Material(
      color: filled ? Pos.brand : Colors.transparent,
      borderRadius: BorderRadius.circular(7),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(7),
        child: Container(
          height: 32,
          padding: EdgeInsets.symmetric(horizontal: compact ? 9 : 12),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(7),
            border: filled
                ? null
                : Border.all(color: theme.posOnChrome.withValues(alpha: 0.28)),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon, size: 15, color: ink),
              // The label is dropped on a narrow app bar, where the two icons
              // are distinct enough on their own and the room is better spent
              // on the section title.
              if (!compact) ...[
                const SizedBox(width: 7),
                Text(
                  label,
                  style: TextStyle(
                    color: ink,
                    fontSize: 12.5,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// Online/offline + backlog indicator, driven by [syncStatusProvider].
///
/// Green when the terminal is live with the back office and nothing is queued;
/// amber while a backlog is draining; grey/red when offline. It reassures the
/// clerk that a sale rung up offline is safely queued and will sync, rather
/// than leaving them guessing whether the till is talking to the server.
class SyncStatusBadge extends ConsumerWidget {
  const SyncStatusBadge({super.key, this.compact = false});

  /// The slim variant for the desktop title bar; the app bar uses the fuller
  /// one with a label.
  final bool compact;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // Fall back to the service's current snapshot until the first stream event,
    // so the badge is never blank.
    final status =
        ref.watch(syncStatusProvider).value ??
        ref.watch(syncServiceProvider).currentStatus;

    final (color, label, icon) = switch (status) {
      SyncStatus(online: false) => (
        Pos.red,
        status.hasBacklog ? 'Offline · ${status.pending}' : 'Offline',
        Icons.cloud_off,
      ),
      SyncStatus(hasBacklog: true) => (
        Pos.amber,
        'Syncing ${status.pending}',
        Icons.cloud_sync,
      ),
      _ => (Pos.green, 'Online', Icons.cloud_done),
    };

    // The compact variant sits on the title bar, which is no longer always
    // dark — white here would be white-on-near-white in Day.
    final foreground = compact ? Theme.of(context).posOnChrome : color;

    return Tooltip(
      message: switch (status) {
        SyncStatus(online: false) when status.hasBacklog =>
          '${status.pending} sale(s) queued — will sync when back online.',
        SyncStatus(online: false) =>
          'Working offline. Sales are saved locally.',
        SyncStatus(hasBacklog: true) =>
          'Sending ${status.pending} queued sale(s) to the back office.',
        _ => 'Live with the back office. All sales synced.',
      },
      child: Container(
        padding: EdgeInsets.symmetric(
          horizontal: compact ? 6 : 10,
          vertical: 4,
        ),
        decoration: BoxDecoration(
          color: compact ? null : color.withValues(alpha: 0.15),
          borderRadius: BorderRadius.circular(12),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: compact ? 13 : 16, color: foreground),
            SizedBox(width: compact ? 5 : 7),
            Text(
              label,
              style: TextStyle(
                color: foreground,
                fontSize: compact ? 11 : 13,
                fontWeight: FontWeight.w600,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
