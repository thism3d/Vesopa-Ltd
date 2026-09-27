import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../brand.dart';
import '../data/session.dart';
import 'account_page.dart';
import 'cars_page.dart';
import 'membership_page.dart';
import 'visits_page.dart';

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

  @override
  Widget build(BuildContext context) {
    final pages = [
      MembershipPage(onAddCar: () => _go(1)),
      const CarsPage(),
      const VisitsPage(),
      const AccountPage(),
    ];
    return Scaffold(
      body: SafeArea(child: IndexedStack(index: _tab, children: pages)),
      bottomNavigationBar: DecoratedBox(
        decoration: const BoxDecoration(border: Border(top: BorderSide(color: MetricBrand.line))),
        child: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: _go,
        destinations: const [
          NavigationDestination(icon: Icon(Icons.badge_outlined), selectedIcon: Icon(Icons.badge), label: 'Membership'),
          NavigationDestination(icon: Icon(Icons.directions_car_outlined), selectedIcon: Icon(Icons.directions_car), label: 'My cars'),
          NavigationDestination(icon: Icon(Icons.history), label: 'Visits'),
          NavigationDestination(icon: Icon(Icons.person_outline), selectedIcon: Icon(Icons.person), label: 'Account'),
        ],
        ),
      ),
    );
  }
}
