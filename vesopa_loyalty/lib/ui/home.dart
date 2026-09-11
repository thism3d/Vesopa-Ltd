import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/session.dart';
import '../platform/push.dart';
import 'card_page.dart';
import 'history_page.dart';
import 'inbox_page.dart';
import 'venue_page.dart';
import 'widgets.dart';

/// The app, signed in: the card, what has happened on it, the venue's news,
/// and the venue itself.
class HomePage extends ConsumerStatefulWidget {
  const HomePage({super.key});

  @override
  ConsumerState<HomePage> createState() => _HomePageState();
}

class _HomePageState extends ConsumerState<HomePage> with WidgetsBindingObserver {
  var _tab = 0;

  static const _inbox = 2;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    // Opened from a notification: straight to the news.
    if (openedAt().startsWith('/inbox')) _tab = _inbox;
    onOpenRequest((hash) {
      if (!mounted) return;
      ref.invalidate(messagesProvider);
      setState(() => _tab = _inbox);
    });
    unawaited(_refresh());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      ref.invalidate(meProvider);
      ref.invalidate(messagesProvider);
      unawaited(_refresh());
    }
  }

  Future<void> _refresh() async {
    final brand = ref.read(brandProvider).value;
    if (brand == null) return;
    final near = await refreshChannels(ref.read(apiProvider), brand, ref.read(configProvider).slug);
    if (near && mounted) {
      // At the venue: whatever they sent to people here now is in the news.
      ref.invalidate(messagesProvider);
    }
  }

  @override
  Widget build(BuildContext context) {
    final brand = ref.watch(brandProvider).requireValue;
    final unread = (ref.watch(messagesProvider).value?['unread'] as num?)?.toInt() ?? 0;
    const pages = [CardPage(), HistoryPage(), InboxPage(), VenuePage()];
    return Scaffold(
      appBar: AppBar(
        titleSpacing: 12,
        title: Row(
          children: [
            VenueLogo(brand: brand, size: 34),
            const SizedBox(width: 10),
            Expanded(child: Text(brand.name, overflow: TextOverflow.ellipsis)),
          ],
        ),
      ),
      body: SafeArea(child: IndexedStack(index: _tab, children: pages)),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (i) => setState(() => _tab = i),
        destinations: [
          const NavigationDestination(icon: Icon(Icons.qr_code_2_outlined), selectedIcon: Icon(Icons.qr_code_2), label: 'Card'),
          const NavigationDestination(icon: Icon(Icons.receipt_long_outlined), selectedIcon: Icon(Icons.receipt_long), label: 'Activity'),
          NavigationDestination(
            icon: Badge(isLabelVisible: unread > 0, label: Text('$unread'), child: const Icon(Icons.notifications_none)),
            selectedIcon: Badge(isLabelVisible: unread > 0, label: Text('$unread'), child: const Icon(Icons.notifications)),
            label: 'News',
          ),
          const NavigationDestination(icon: Icon(Icons.storefront_outlined), selectedIcon: Icon(Icons.storefront), label: 'Venue'),
        ],
      ),
    );
  }
}
