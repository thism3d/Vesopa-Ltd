import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/local/database.dart';
import '../../data/screens.dart';
import '../../data/staff_session.dart';
import '../../main.dart';
import '../sale_page.dart' show productsProvider;

import '../clock_sheet.dart';
import '../shell.dart' show StaffChip, SyncStatusBadge;
import '../sign_on_pad.dart';
import '../theme.dart';
import 'nav_rail.dart';
import 'programmed_bar.dart';
import 'print_status.dart';

/// The one bar the till wears, on every screen.
///
/// It replaces the fixed strip that used to sit above everything — the gear,
/// the section name, the shift chip and the online badge — which the venue
/// asked to have gone. Two bars, one above the other, both saying who was
/// signed on and whether the till was online, was one bar too many; and the
/// venue could only ever get rid of the top one on the sale screen, because
/// nothing else drew any chrome at all.
///
/// So the programmed bar became the only bar, and everything the fixed one was
/// carrying had to find a home:
///
///   * **The way between sections** is [PageSelector], pinned at the left of
///     every top bar and not something a layout can delete. That is the one
///     thing a bar must never be able to lose: a venue that programmed a top
///     bar without a `go_settings` key on it, on a terminal with the rail
///     tucked away, would have arranged a till nobody could navigate — and
///     would find out at a counter.
///   * **Who is on shift, and whether the till is live**, are keys the venue
///     can place (`staff_name`, `sign_off`, `sync_status`, `print_status`).
///     Until they do, this draws them itself; see [trailing].
///
/// [body] is whatever the caller has to put in the middle — the sale page's
/// programmed bar and its live strip of open bills, or nothing. The height
/// follows the body, so a two-row bar is two rows tall and a bare one is the
/// same 46px the old fixed bar was.
class TillTopBar extends ConsumerWidget {
  const TillTopBar({
    super.key,
    required this.section,
    required this.onSelectSection,
    required this.onOpenMenu,
    required this.onSignOn,
    required this.onSignOff,
    this.body,
    this.trailing = true,
  });

  /// The section showing, which is what the selector names.
  final NavDestination section;

  /// Go to another section, by its index in [navDestinations].
  final ValueChanged<int> onSelectSection;

  /// Open the side menu, or null when the rail is already on screen — a key
  /// that opens a copy of what is visible beside it is noise.
  final VoidCallback? onOpenMenu;

  /// Exactly one of these is non-null when sign-on is available. Both null
  /// means this terminal has no staff list.
  final VoidCallback? onSignOn;
  final VoidCallback? onSignOff;

  /// The venue's own bar, when there is one to draw.
  final Widget? body;

  /// Whether to draw the shift chip and the badges at the right.
  ///
  /// False when [body] is a bar the venue laid out themselves: at that point
  /// they have said what goes on their top bar, and every one of these is a key
  /// they can place. Drawing them anyway would put the online badge twice on
  /// the bar of any venue that placed one, and would leave the rest of them
  /// fighting the layout for width.
  final bool trailing;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);

    final chrome = Material(
      color: theme.posChrome,
      child: DecoratedBox(
        decoration: BoxDecoration(
          // The light bar sits on a white page and needs a hairline to read as
          // a bar at all; the dark one separates by contrast on its own.
          border: theme.isDark
              ? null
              : Border(bottom: BorderSide(color: theme.posLine)),
        ),
        child: Row(
          children: [
            PageSelector(
              section: section,
              onSelectSection: onSelectSection,
              onOpenMenu: onOpenMenu,
              onSignOn: onSignOn,
              onSignOff: onSignOff,
            ),
            Expanded(child: body ?? const SizedBox.shrink()),
            if (trailing) ...[
              StaffChip(onSignOn: onSignOn, onSignOff: onSignOff),
              // Whether the kitchen actually got the last ticket. Beside the
              // sync badge because it answers the same shape of question —
              // "did what I just did land?" — and draws nothing at all when
              // there is nothing to report.
              const PrintStatusBadge(),
              // The clerk needs to know at a glance whether the till is live
              // with the back office or working offline with a backlog.
              const SyncStatusBadge(),
              const SizedBox(width: 14),
            ],
          ],
        ),
      ),
    );

    // A bare bar keeps the height the fixed one had, so nothing below it moves
    // when a venue turns their own bar off. A bar with a body is as tall as the
    // body wants to be — a venue's two-row bar is two rows.
    return body == null ? SizedBox(height: 46, child: chrome) : chrome;
  }
}

/// The way between sections, pinned at the left of every top bar.
///
/// One control rather than the gear and the section name it replaces, because
/// they were always the same thought half a second apart: "where am I, and how
/// do I get somewhere else". Pressing it says both.
///
/// Fixed, and deliberately not something a programmed bar can remove. Every
/// other key on the bar is the venue's to arrange; this one is the till's, for
/// the same reason a fire door is not a decorating decision.
class PageSelector extends ConsumerWidget {
  const PageSelector({
    super.key,
    required this.section,
    required this.onSelectSection,
    required this.onOpenMenu,
    required this.onSignOn,
    required this.onSignOff,
  });

  final NavDestination section;
  final ValueChanged<int> onSelectSection;
  final VoidCallback? onOpenMenu;
  final VoidCallback? onSignOn;
  final VoidCallback? onSignOff;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final ink = theme.posOnChrome;

    return Padding(
      padding: const EdgeInsets.fromLTRB(6, 6, 8, 6),
      child: Material(
        color: Colors.white.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(8),
        child: InkWell(
          borderRadius: BorderRadius.circular(8),
          onTap: () => _open(context, ref),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 9),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(section.icon, color: theme.posBrandOnChrome, size: 18),
                const SizedBox(width: 8),
                // Bounded so the selector cannot grow with the section name and
                // eat the bar the venue laid out beside it.
                ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 96),
                  child: Text(
                    section.label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      color: ink,
                      fontSize: 14,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                const SizedBox(width: 4),
                Icon(
                  Icons.expand_more,
                  size: 18,
                  color: ink.withValues(alpha: 0.7),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  /// Every section, plus the two things the gear used to be the only way to.
  ///
  /// A menu rather than a row of keys: eight sections across the left of a bar
  /// would leave a venue nothing to lay out, and this has to cost as little of
  /// the bar as it can while still being impossible to lose.
  Future<void> _open(BuildContext context, WidgetRef ref) async {
    final box = context.findRenderObject() as RenderBox?;
    final overlay =
        Overlay.of(context).context.findRenderObject() as RenderBox?;
    if (box == null || overlay == null) return;

    final origin = box.localToGlobal(Offset.zero, ancestor: overlay);
    final position = RelativeRect.fromLTRB(
      origin.dx,
      origin.dy + box.size.height,
      overlay.size.width - origin.dx - box.size.width,
      0,
    );

    final signedOn = onSignOff != null;
    final canSignOn = onSignOn != null || onSignOff != null;

    final chosen = await showMenu<String>(
      context: context,
      position: position,
      items: [
        for (var i = 0; i < navDestinations.length; i++)
          PopupMenuItem<String>(
            value: 'go:$i',
            child: Row(
              children: [
                Icon(
                  navDestinations[i].icon,
                  size: 18,
                  color: i == navDestinations.indexOf(section)
                      ? Pos.brandDeep
                      : null,
                ),
                const SizedBox(width: 12),
                Text(navDestinations[i].label),
              ],
            ),
          ),
        if (onOpenMenu != null) ...[
          const PopupMenuDivider(),
          const PopupMenuItem<String>(
            value: 'menu',
            child: Row(
              children: [
                Icon(Icons.menu, size: 18),
                SizedBox(width: 12),
                Text('Settings & menu'),
              ],
            ),
          ),
        ],
        // Handing the till to the next person is a mid-service action and has
        // to be reachable from wherever whoever is handing it over happens to
        // be standing. It was on the fixed bar; it cannot only be on a bar the
        // venue might not have laid out.
        if (canSignOn) ...[
          const PopupMenuDivider(),
          PopupMenuItem<String>(
            value: 'shift',
            child: Row(
              children: [
                Icon(signedOn ? Icons.logout : Icons.login, size: 18),
                const SizedBox(width: 12),
                Text(signedOn ? 'Sign off' : 'Sign on'),
              ],
            ),
          ),
        ],
      ],
    );

    if (chosen == null) return;
    if (chosen == 'menu') return onOpenMenu?.call();
    if (chosen == 'shift') return (onSignOff ?? onSignOn)?.call();
    if (chosen.startsWith('go:')) {
      onSelectSection(int.parse(chosen.substring(3)));
    }
  }
}

/// The venue's own top bar, drawn on a section that is not the sale screen.
///
/// The top bar is the till's only bar now, so it goes everywhere — a venue that
/// has arranged their chrome should meet it on Reports and Settings too, not
/// only where the products are. What changes off the sale screen is what the
/// keys can do: there is no bill in front of the clerk, so the ones that act on
/// one are drawn and dimmed. See [ProgrammedBar.onSaleScreen].
///
/// Answers null — through [of] — when the venue has not laid a top bar out, so
/// the caller falls back to [TillTopBar]'s own trailing badges.
class VenueTopBarBody extends ConsumerWidget {
  const VenueTopBarBody({
    super.key,
    required this.bar,
    required this.orderId,
    required this.sectionName,
    required this.onSwitchOrder,
    required this.onNavigate,
  });

  final TillScreen bar;

  /// The bill on the till, so the open-bills strip and the total still read
  /// true from a screen that is not showing it. That is the point of putting
  /// the bar everywhere: a clerk on the Reports page can see a table waiting
  /// and press it.
  final String orderId;

  /// What the `screen_name` key says here. On the sale screen it names the page
  /// of products showing; everywhere else the honest answer is the section, and
  /// naming a page of products nobody is looking at would be worse than blank.
  final String sectionName;

  final void Function(String orderId) onSwitchOrder;

  /// Where a `go_*` key goes, by section label.
  final void Function(String label) onNavigate;

  /// The venue's top bar for this terminal, or null for the built-in one.
  ///
  /// Resolved from the venue's *home* screen, not from whatever sale page a
  /// clerk last opened: a per-page bar belongs to that page, and wearing the
  /// drinks page's bar on the Settings screen would be the till answering a
  /// question nobody asked.
  static TillScreen? of(WidgetRef ref) {
    final screens = ref.watch(screensProvider).value;
    if (screens == null) return null;
    final settings = ref.watch(tillSettingsProvider);
    return screens.barFor(
      screens.byId(settings.homeScreenId),
      ScreenSurface.topBar,
      settings.topBarScreenId,
    );
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final screens = ref.watch(screensProvider).value ?? ScreenSet.empty;
    final settings = ref.watch(tillSettingsProvider);
    final products = ref.watch(productsProvider).value ?? const <Product>[];
    final order = ref.watch(shellOrderProvider(orderId)).value;

    return ProgrammedBar(
      bar: bar,
      screens: screens,
      products: {for (final p in products) p.pluId: p},
      showPrices: settings.buttonsShowPrices,
      onSaleScreen: false,
      live: BarLive(
        currentOrderId: orderId,
        currentOrder: order,
        totalMinor: order?.totalMinor ?? 0,
        // Not a sale screen, so the `screen_name` key names the section rather
        // than a page of products that is not on show.
        screenName: sectionName,
        onSwitchOrder: onSwitchOrder,
      ),
      // Dimmed rather than wired: nothing here can ring anything up. The
      // callbacks are still required, and are still the honest no-ops.
      onProduct: (_) {},
      onPage: (_) {},
      // A modifier acts on the bill, and there is no bill in front of the clerk
      // on Reports or Settings — the key is drawn and dimmed by the bar itself
      // for the same reason Pay and Void are, so this is never reached here.
      onModifier: (_) {},
      onFunction: (key) async {
        if (key == 'sign_off') {
          return ref.read(staffSessionProvider.notifier).signOff();
        }
        // Handing the till over and the time clock both work from any section,
        // which is why the bar lists them among the keys it keeps live off the
        // sale screen. Neither touches the bill.
        if (key == 'sign_on') {
          await showSignOnPad(context, ref);
          return;
        }
        if (key == 'clock_in_out') {
          if (!context.mounted) return;
          return showClockSheet(context, ref);
        }
        const sections = <String, String>{
          'go_sale': 'Sale',
          'go_tables': 'Table',
          'go_receipts': 'Receipts',
          'go_reports': 'Reports',
          'go_products': 'Product',
          'go_functions': 'Functions',
          'go_settings': 'Settings',
        };
        final section = sections[key];
        if (section != null) onNavigate(section);
      },
    );
  }
}

/// The bill on the till, watched so the bar's live keys stay true.
///
/// Its own provider rather than a StreamBuilder in the bar, so switching bill
/// does not tear the bar down and rebuild it — and so the sale page and the bar
/// are reading one stream rather than two that can disagree by a frame.
final shellOrderProvider = StreamProvider.family<Order?, String>(
  (ref, orderId) => ref.watch(orderRepositoryProvider).watchOrder(orderId),
);
