import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../brand.dart';
import '../data/session.dart';
import 'account_page.dart';
import 'cars_page.dart';
import 'membership_page.dart';
import 'visits_page.dart';
import 'widgets.dart';

/// Signed in: four tabs.
class HomePage extends ConsumerStatefulWidget {
  const HomePage({super.key});

  @override
  ConsumerState<HomePage> createState() => _HomePageState();
}

class _HomePageState extends ConsumerState<HomePage> with WidgetsBindingObserver {
  int _tab = 0;

  static const _names = ['membership', 'cars', 'visits', 'account'];

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    WidgetsBinding.instance.addPostFrameCallback((_) => ref.read(activityLogProvider).screen(_names[_tab]));
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // Send what is queued before the app is put away.
    if (state == AppLifecycleState.paused || state == AppLifecycleState.hidden) {
      ref.read(activityLogProvider).flush();
    }
    // Back in front: the barrier may have opened meanwhile.
    if (state == AppLifecycleState.resumed) {
      ref.invalidate(accountProvider);
      ref.invalidate(visitsProvider);
    }
  }

  void _go(int i) {
    setState(() => _tab = i);
    ref.read(activityLogProvider).screen(_names[i]);
  }

  static const _tabs = [
    (icon: Icons.badge_outlined, selected: Icons.badge, label: 'Membership'),
    (icon: Icons.directions_car_outlined, selected: Icons.directions_car, label: 'My cars'),
    (icon: Icons.history, selected: Icons.history, label: 'Visits'),
    (icon: Icons.person_outline, selected: Icons.person, label: 'Account'),
  ];

  @override
  Widget build(BuildContext context) {
    final pages = [
      MembershipPage(onAddCar: () => _go(1), onSeeVisits: () => _go(2)),
      const CarsPage(),
      const VisitsPage(),
      const AccountPage(),
    ];
    final stack = IndexedStack(index: _tab, children: pages);

    // Desktop and tablet: a navy side rail and the page in a wide centred area.
    if (isWide(context)) {
      return Scaffold(
        body: Row(
          children: [
            _SideRail(selected: _tab, onSelect: _go, extended: MediaQuery.sizeOf(context).width >= 1200),
            Expanded(
              child: SafeArea(
                left: false,
                child: Align(
                  alignment: Alignment.topCenter,
                  child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 1180), child: stack),
                ),
              ),
            ),
          ],
        ),
      );
    }

    return Scaffold(
      body: SafeArea(
        child: Align(
          alignment: Alignment.topCenter,
          child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 720), child: stack),
        ),
      ),
      bottomNavigationBar: DecoratedBox(
        decoration: const BoxDecoration(
          border: Border(top: BorderSide(color: MetricBrand.line)),
        ),
        child: NavigationBar(
          selectedIndex: _tab,
          onDestinationSelected: _go,
          destinations: [for (final t in _tabs) NavigationDestination(icon: Icon(t.icon), selectedIcon: Icon(t.selected), label: t.label)],
        ),
      ),
    );
  }
}

/// The wide layout's navigation: Metric's navy, the logo on top, the four
/// tabs, and "Powered by Vesopa" at the foot. Labels beside the icons from
/// 1200px, under them below that.
class _SideRail extends StatelessWidget {
  const _SideRail({required this.selected, required this.onSelect, required this.extended});

  final int selected;
  final ValueChanged<int> onSelect;
  final bool extended;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: extended ? 248 : 112,
      decoration: const BoxDecoration(
        gradient: LinearGradient(colors: [MetricBrand.navy900, MetricBrand.navy], begin: Alignment.topCenter, end: Alignment.bottomCenter),
      ),
      child: SafeArea(
        right: false,
        child: Padding(
          padding: EdgeInsets.symmetric(horizontal: extended ? 18 : 12, vertical: 24),
          child: Column(
            crossAxisAlignment: extended ? CrossAxisAlignment.start : CrossAxisAlignment.center,
            children: [
              Padding(
                padding: EdgeInsets.only(left: extended ? 8 : 0),
                child: extended
                    ? const MetricLogo(height: 30, white: true)
                    : Container(
                        padding: const EdgeInsets.all(7),
                        decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(14)),
                        child: Image.asset(MetricBrand.icon, width: 34, height: 34),
                      ),
              ),
              const SizedBox(height: 12),
              Container(
                margin: EdgeInsets.only(left: extended ? 8 : 0),
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(99),
                  border: Border.all(color: MetricBrand.green.withValues(alpha: 0.6)),
                ),
                child: Text(
                  extended ? 'MEMBERSHIP' : 'MEMBER',
                  style: const TextStyle(color: MetricBrand.green, fontSize: 10, fontWeight: FontWeight.w800, letterSpacing: 1.6),
                ),
              ),
              const SizedBox(height: 32),
              for (var i = 0; i < _HomePageState._tabs.length; i++) ...[
                _RailItem(
                  key: Key('rail-$i'),
                  icon: i == selected ? _HomePageState._tabs[i].selected : _HomePageState._tabs[i].icon,
                  label: _HomePageState._tabs[i].label,
                  selected: i == selected,
                  extended: extended,
                  onTap: () => onSelect(i),
                ),
                const SizedBox(height: 6),
              ],
              const Spacer(),
              Padding(
                padding: EdgeInsets.only(left: extended ? 8 : 0),
                child: Text(
                  extended ? 'Powered by Vesopa' : 'Vesopa',
                  style: TextStyle(color: Colors.white.withValues(alpha: 0.55), fontSize: 12),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _RailItem extends StatelessWidget {
  const _RailItem({
    super.key,
    required this.icon,
    required this.label,
    required this.selected,
    required this.extended,
    required this.onTap,
  });

  final IconData icon;
  final String label;
  final bool selected;
  final bool extended;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final colour = selected ? Colors.white : Colors.white.withValues(alpha: 0.72);
    final text = Text(
      label,
      style: TextStyle(color: colour, fontWeight: selected ? FontWeight.w800 : FontWeight.w600, fontSize: extended ? 15 : 11),
    );
    return Material(
      color: selected ? Colors.white.withValues(alpha: 0.12) : Colors.transparent,
      borderRadius: BorderRadius.circular(14),
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: onTap,
        child: Container(
          width: double.infinity,
          padding: EdgeInsets.symmetric(horizontal: extended ? 14 : 4, vertical: extended ? 13 : 10),
          decoration: selected
              ? const BoxDecoration(
                  border: Border(left: BorderSide(color: MetricBrand.green, width: 3)),
                  borderRadius: BorderRadius.all(Radius.circular(14)),
                )
              : null,
          child: extended
              ? Row(
                  children: [
                    Icon(icon, color: selected ? MetricBrand.green : colour, size: 22),
                    const SizedBox(width: 14),
                    text,
                  ],
                )
              : Column(
                  children: [
                    Icon(icon, color: selected ? MetricBrand.green : colour, size: 24),
                    const SizedBox(height: 4),
                    text,
                  ],
                ),
        ),
      ),
    );
  }
}
