import 'package:flutter/material.dart';

import '../theme.dart';

class NavDestination {
  const NavDestination(this.icon, this.label);
  final IconData icon;
  final String label;
}

/// The sections every till has.
///
/// Still a const, and still the list everything defaults to. What a venue
/// *actually* sees comes from [navDestinationsFor], which is the same list with
/// the sections that venue runs added to it.
const navDestinations = <NavDestination>[
  NavDestination(Icons.sell, 'Sale'),
  NavDestination(Icons.grid_view, 'Table'),
  NavDestination(Icons.receipt_long, 'Receipts'),
  NavDestination(Icons.bar_chart, 'Reports'),
  NavDestination(Icons.shopping_bag, 'Product'),
  NavDestination(Icons.exit_to_app, 'Functions'),
  NavDestination(Icons.settings, 'Settings'),
  NavDestination(Icons.info, 'About'),
];

/// The gym door, for a venue that has one.
const gymDestination = NavDestination(Icons.fitness_center, 'Gym');

/// The sections THIS venue sees.
///
/// The gym is switched on in the back office and is off by default, so for
/// almost every venue on this platform this returns exactly the list above --
/// "if disabled nothing of gym options appears in the till", which was asked
/// for in those words.
///
/// Placed after Reports rather than at the end. The order of a rail is a claim
/// about how often each thing is used, and at a gym the board is looked at far
/// more than Products or Functions ever are; putting it last would file the
/// venue's main screen below two they may never open.
List<NavDestination> navDestinationsFor({required bool gym}) {
  if (!gym) return navDestinations;
  final after = navDestinations.indexWhere((d) => d.label == 'Reports');
  return [
    ...navDestinations.take(after + 1),
    gymDestination,
    ...navDestinations.skip(after + 1),
  ];
}

/// Left-hand navigation, with Logout pinned to the bottom as in the mockups.
///
/// Starting and ending a shift are not here — they live in the top bar, which
/// is on every screen. See [StaffChip].
class PosNavRail extends StatelessWidget {
  const PosNavRail({
    super.key,
    required this.selected,
    required this.onSelect,
    required this.onLogout,
    this.destinations = navDestinations,
  });

  final int selected;
  final ValueChanged<int> onSelect;

  /// What this venue's rail carries. Defaults to the sections every till has,
  /// so nothing that does not care has to be changed -- see
  /// [navDestinationsFor].
  final List<NavDestination> destinations;

  /// De-commission this terminal from the venue. Needs a password, and is a
  /// different act from ending a shift — which is why it is the only exit left
  /// on the rail rather than one of three that read alike.
  final VoidCallback onLogout;

  @override
  Widget build(BuildContext context) {
    // Inside a Drawer the parent already sets the width, so don't fight it.
    final inDrawer = Scaffold.maybeOf(context)?.hasDrawer ?? false;

    return Container(
      width: inDrawer ? null : 208,
      color: Theme.of(context).posRail,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // The drawer opens on a blank list otherwise — the brand belongs at
          // the top of it, the way the desktop rail has it.
          if (inDrawer)
            const _DrawerBrand()
          else
            const SizedBox(height: 16),
          for (var i = 0; i < destinations.length; i++)
            _NavItem(
              destination: destinations[i],
              active: i == selected,
              onTap: () => onSelect(i),
            ),
          const Spacer(),

          // Logout, and only Logout.
          //
          // The shift keys used to sit here too, above a rule meant to keep
          // them apart. They have moved to the top bar, where they are on every
          // screen instead of only the ones with the rail open — so a copy here
          // would be a second button for an action already on screen.
          //
          // It was worse than a duplicate: the rail's copy was labelled "Sign
          // Out" while calling sign *off*. Two labels, one action, sitting one
          // row above the genuine "Logout" that de-commissions the terminal and
          // wants a password. Whichever of the three an operator learned, the
          // other two were a trap.
          _NavItem(
            destination: const NavDestination(Icons.logout, 'Logout'),
            active: false,
            onTap: onLogout,
          ),
          const SizedBox(height: 16),
        ],
      ),
    );
  }
}

/// The logo at the top of the drawer. Just the mark — no wordmark text beside
/// it, since the logo already carries the name.
///
/// The full-colour logo is drawn for print on white; on a dark rail its black
/// wordmark disappears, so the monochrome variant is used instead.
class _DrawerBrand extends StatelessWidget {
  const _DrawerBrand();

  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;

    return Container(
      color: dark ? Pos.chrome : Colors.white,
      padding: const EdgeInsets.fromLTRB(20, 52, 20, 24),
      alignment: Alignment.centerLeft,
      child: Image.asset(
        dark
            ? 'assets/brand/vesopa_logo_on_dark.png'
            : 'assets/brand/vesopa_logo.png',
        height: 34,
        fit: BoxFit.contain,
        alignment: Alignment.centerLeft,
        errorBuilder: (_, _, _) => const SizedBox.shrink(),
      ),
    );
  }
}

class _NavItem extends StatelessWidget {
  const _NavItem({
    required this.destination,
    required this.active,
    required this.onTap,
  });

  final NavDestination destination;
  final bool active;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
        child: Row(
          children: [
            Container(
              width: 44,
              height: 32,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                // The active item gets a filled pill behind its icon.
                color: active ? Pos.brandSoft : Colors.transparent,
                borderRadius: BorderRadius.circular(16),
              ),
              child: Icon(
                destination.icon,
                size: 20,
                // Reads from the theme, so the labels stay legible in dark
                // mode instead of turning black-on-black.
                color: active
                    ? Pos.brandDeep
                    : Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(width: 16),
            Text(
              destination.label,
              style: TextStyle(
                fontSize: 15,
                color: active
                    ? Pos.brandDeep
                    : Theme.of(context).colorScheme.onSurface,
                fontWeight: active ? FontWeight.w600 : FontWeight.normal,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
