import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/session.dart';
import '../platform/push.dart';
import 'account_page.dart';
import 'card_page.dart';
import 'history_page.dart';
import 'inbox_page.dart';
import 'venue_page.dart';
import 'widgets.dart';

/// The app, signed in: the card, what has happened on it, the venue's news,
/// the member's own account, and the venue itself.
///
/// THE NAVIGATION CHANGES SHAPE WITH THE WINDOW, because the same build is a
/// phone app, a Windows app on a desk and a browser tab on a laptop:
///
///   under 700   a bottom bar, thumbs-first
///   700–1200    a rail down the left, icons and short labels
///   over 1200   the rail opens out with the labels beside the icons
///
/// The breakpoints are Material's, not invented here.
///
/// NOTIFICATIONS LIVE AT THE TOP RIGHT, where every other app on the device
/// puts them, rather than being a destination among the others. News is
/// something that arrives; the card, the activity and the account are places
/// somebody goes. Making it a tab meant an unread badge sat in the same row as
/// the card and read like a fifth section of the app.
class HomePage extends ConsumerStatefulWidget {
  const HomePage({super.key});

  @override
  ConsumerState<HomePage> createState() => _HomePageState();
}

class _HomePageState extends ConsumerState<HomePage> with WidgetsBindingObserver {
  var _tab = 0;

  static const _pages = [CardPage(), HistoryPage(), AccountPage(), VenuePage()];
  static const _destinations = [
    (Icons.qr_code_2_outlined, Icons.qr_code_2, 'Card'),
    (Icons.receipt_long_outlined, Icons.receipt_long, 'Activity'),
    (Icons.person_outline, Icons.person, 'Account'),
    (Icons.storefront_outlined, Icons.storefront, 'Venue'),
  ];

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    // Opened from a notification: straight to the news.
    if (openedAt().startsWith('/inbox')) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _openNews());
    }
    onOpenRequest((hash) {
      if (!mounted) return;
      ref.invalidate(messagesProvider);
      _openNews();
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

  /// The news, over the top of wherever they were.
  ///
  /// A sheet rather than a page push: somebody reading a notification is
  /// interrupting themselves, and they should land back where they were with
  /// one dismissal rather than a back button and a guess.
  void _openNews() {
    if (!mounted) return;
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      useSafeArea: true,
      builder: (sheet) => FractionallySizedBox(
        heightFactor: 0.92,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 8),
              child: Text(
                'News',
                style: Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800),
              ),
            ),
            const Expanded(child: InboxPage()),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final brand = ref.watch(brandProvider).requireValue;
    final unread = (ref.watch(messagesProvider).value?['unread'] as num?)?.toInt() ?? 0;
    final width = MediaQuery.of(context).size.width;
    final rail = width >= 700;
    final wideRail = width >= 1200;

    final appBar = AppBar(
      titleSpacing: 12,
      title: Row(
        children: [
          VenueLogo(brand: brand, size: 34),
          const SizedBox(width: 10),
          Expanded(child: Text(brand.name, overflow: TextOverflow.ellipsis)),
        ],
      ),
      actions: [
        IconButton(
          onPressed: _openNews,
          tooltip: unread > 0 ? '$unread unread' : 'News',
          icon: Badge(
            isLabelVisible: unread > 0,
            label: Text('$unread'),
            child: Icon(unread > 0 ? Icons.notifications_active : Icons.notifications_none),
          ),
        ),
        const SizedBox(width: 4),
      ],
    );

    final body = SafeArea(child: IndexedStack(index: _tab, children: _pages));

    if (!rail) {
      return Scaffold(
        appBar: appBar,
        body: body,
        bottomNavigationBar: NavigationBar(
          selectedIndex: _tab,
          onDestinationSelected: (i) => setState(() => _tab = i),
          destinations: [
            for (final (icon, selected, label) in _destinations)
              NavigationDestination(icon: Icon(icon), selectedIcon: Icon(selected), label: label),
          ],
        ),
      );
    }

    return Scaffold(
      appBar: appBar,
      body: Row(
        children: [
          NavigationRail(
            selectedIndex: _tab,
            onDestinationSelected: (i) => setState(() => _tab = i),
            extended: wideRail,
            labelType: wideRail ? NavigationRailLabelType.none : NavigationRailLabelType.all,
            destinations: [
              for (final (icon, selected, label) in _destinations)
                NavigationRailDestination(
                  icon: Icon(icon),
                  selectedIcon: Icon(selected),
                  label: Text(label),
                ),
            ],
          ),
          const VerticalDivider(width: 1),
          Expanded(child: body),
        ],
      ),
    );
  }
}
