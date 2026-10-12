import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../data/session.dart';
import '../data/venue_style.dart';
import '../platform/push.dart';
import 'rugby_animation.dart';
import 'venue_intro.dart';

/// A venue app's welcome: a few pages, once, between the crest and sign-in.
///
/// ONLY IN A VENUE'S OWN PHONE OR DESKTOP BUILD. The shared Store app goes
/// straight to Continue with Vesopa and the browser to the venue's sign-in,
/// as they always did.
///
/// WHY NOTIFICATIONS ARE ASKED FOR HERE, BEFORE ANYBODY HAS SIGNED IN. The
/// moment the app explains what the notifications are for is the moment a
/// member is likeliest to say yes, and a question the platform only lets us
/// put once is wasted on a member who has not been told. There is no account
/// yet to give the token to, so only the question is put here
/// ([pushAskPermission]); a yes is recorded as the member's choice
/// ([Choices.setNotifications]) and the first start after signing in hands
/// the token to the server, exactly as if they had switched notifications on
/// under Venue (data/session.dart, refreshChannels).
class Onboarding {
  Onboarding._();

  static const _seen = 'welcome_seen';

  /// Whether this build has a welcome at all.
  static bool get enabled => !kIsWeb && VenueStyle.enabled;

  static Future<bool> seen() async {
    try {
      return (await SharedPreferences.getInstance()).getBool(_seen) ?? false;
    } catch (_) {
      // Storage that will not open costs the welcome, never the sign-in.
      return true;
    }
  }

  static Future<void> markSeen() async {
    try {
      await (await SharedPreferences.getInstance()).setBool(_seen, true);
    } catch (_) {
      // Shown again next time, which is the lesser harm.
    }
  }
}

/// [child] (the sign-in page), with the welcome in front of it the first
/// time the app is opened.
class OnboardingGate extends StatefulWidget {
  const OnboardingGate({
    super.key,
    required this.child,
    required this.slug,
    required this.venueName,
    this.canNotify = true,
    this.wallet,
    this.askPermission = pushAskPermission,
  });

  final Widget child;

  /// The venue, for the member's notifications choice (Choices).
  final String slug;
  final String venueName;

  /// Whether this device can have notifications (pushAvailable).
  final bool canNotify;

  /// Whether to show Apple Wallet and the Apple Watch: by default, on an
  /// iPhone only.
  final bool? wallet;

  /// The platform's question. A parameter so a test can answer it.
  final Future<bool> Function() askPermission;

  @override
  State<OnboardingGate> createState() => _OnboardingGateState();
}

class _OnboardingGateState extends State<OnboardingGate> {
  bool? _show;

  @override
  void initState() {
    super.initState();
    Onboarding.seen().then((seen) {
      if (mounted) setState(() => _show = !seen);
    });
  }

  Future<void> _finish() async {
    await Onboarding.markSeen();
    if (mounted) setState(() => _show = false);
  }

  @override
  Widget build(BuildContext context) {
    final Widget page = switch (_show) {
      // A moment, reading one setting: the club colour rather than a flash
      // of the sign-in page the welcome is about to cover.
      null => const ClubGradient(key: ValueKey('wait')),
      true => OnboardingPage(
        key: const ValueKey('welcome'),
        venueName: widget.venueName,
        canNotify: widget.canNotify,
        wallet: widget.wallet ?? (!kIsWeb && defaultTargetPlatform == TargetPlatform.iOS),
        askPermission: widget.askPermission,
        onNotifications: (on) async {
          if (on) await (await Choices.of(widget.slug)).setNotifications(true);
        },
        onDone: _finish,
      ),
      false => KeyedSubtree(key: const ValueKey('app'), child: widget.child),
    };
    return AnimatedSwitcher(
      duration: const Duration(milliseconds: 450),
      switchInCurve: Curves.easeOutCubic,
      switchOutCurve: Curves.easeInCubic,
      transitionBuilder: (child, a) => FadeTransition(
        opacity: a,
        child: ScaleTransition(scale: Tween(begin: 0.97, end: 1.0).animate(a), child: child),
      ),
      child: page,
    );
  }
}

/// One page of the welcome.
typedef _Page = ({String key, String title, String body, Widget picture});

/// The welcome itself: pages to swipe, dots, Skip and Next.
class OnboardingPage extends StatefulWidget {
  const OnboardingPage({
    super.key,
    required this.venueName,
    required this.onDone,
    required this.askPermission,
    this.onNotifications,
    this.canNotify = true,
    this.wallet = false,
  });

  final String venueName;
  final VoidCallback onDone;
  final Future<bool> Function() askPermission;

  /// The member's answer, once the platform has had it.
  final Future<void> Function(bool on)? onNotifications;
  final bool canNotify;
  final bool wallet;

  @override
  State<OnboardingPage> createState() => _OnboardingPageState();
}

class _OnboardingPageState extends State<OnboardingPage> {
  final _pages = PageController();
  var _at = 0;

  /// Null until the notifications question has been answered.
  bool? _notifications;
  var _asking = false;

  @override
  void dispose() {
    _pages.dispose();
    super.dispose();
  }

  List<_Page> _list(BuildContext context) {
    final name = widget.venueName.isEmpty ? 'the club' : widget.venueName;
    return [
      (
        key: 'welcome',
        title: 'Welcome to $name',
        body: 'Your membership card, club news and offers, all in one place.',
        picture: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Image.asset(
              VenueIntro.crestAsset,
              height: 84,
              filterQuality: FilterQuality.medium,
              errorBuilder: (_, _, _) => const SizedBox.shrink(),
            ),
            const SizedBox(height: 12),
            KickAnimation(size: 150, accent: VenueStyle.club),
          ],
        ),
      ),
      (
        key: 'card',
        title: 'Your card at the bar',
        body: 'Show the QR code on your Card tab at the bar. One scan and the till knows your membership and your points.',
        picture: const _CardPicture(),
      ),
      if (widget.canNotify)
        (
          key: 'news',
          title: 'Club news as it happens',
          body: 'Match days, fixtures, events and offers. Turn on notifications and we\'ll let you know. It\'s all in the News too.',
          picture: _Badge(icon: _notifications == true ? Icons.notifications_active : Icons.notifications_none),
        ),
      if (widget.wallet)
        (
          key: 'wallet',
          title: 'In your Wallet and on your wrist',
          body: 'Add your card to Apple Wallet from the Card tab, and it\'s on your Apple Watch too. Just show it at the bar.',
          picture: const Row(
            mainAxisSize: MainAxisSize.min,
            children: [_Badge(icon: Icons.wallet), SizedBox(width: 16), _Badge(icon: Icons.watch)],
          ),
        ),
    ];
  }

  void _next(int count) {
    if (_at >= count - 1) return widget.onDone();
    final quiet = MediaQuery.maybeOf(context)?.disableAnimations ?? false;
    if (quiet) {
      _pages.jumpToPage(_at + 1);
    } else {
      _pages.nextPage(duration: const Duration(milliseconds: 420), curve: Curves.easeOutCubic);
    }
  }

  Future<void> _ask(int count) async {
    setState(() => _asking = true);
    var on = false;
    try {
      on = await widget.askPermission();
      await widget.onNotifications?.call(on);
    } catch (_) {
      // Treated as a no: they can switch it on under Venue later.
    }
    if (!mounted) return;
    setState(() {
      _asking = false;
      _notifications = on;
    });
    _next(count);
  }

  @override
  Widget build(BuildContext context) {
    final pages = _list(context);
    final page = pages[_at.clamp(0, pages.length - 1)];
    final last = _at >= pages.length - 1;
    final text = Theme.of(context).textTheme;
    final askingNow = page.key == 'news' && _notifications == null;

    return Theme(
      // White on the club colour, whatever the device's mode, as the sign-in
      // page that follows.
      data: Theme.of(context).copyWith(
        filledButtonTheme: FilledButtonThemeData(
          style: FilledButton.styleFrom(
            backgroundColor: Colors.white,
            foregroundColor: VenueStyle.club,
            minimumSize: const Size(0, 52),
            textStyle: text.titleMedium?.copyWith(fontWeight: FontWeight.w700),
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
          ),
        ),
        textButtonTheme: TextButtonThemeData(
          style: TextButton.styleFrom(foregroundColor: Colors.white, textStyle: text.titleSmall?.copyWith(fontWeight: FontWeight.w600)),
        ),
      ),
      child: Builder(
        builder: (context) => ClubGradient(
          child: Scaffold(
            backgroundColor: Colors.transparent,
            body: SafeArea(
              child: Column(
                children: [
                  Align(
                    alignment: Alignment.centerRight,
                    child: AnimatedOpacity(
                      opacity: last ? 0 : 1,
                      duration: const Duration(milliseconds: 200),
                      child: TextButton(onPressed: last ? null : widget.onDone, child: const Text('Skip')),
                    ),
                  ),
                  Expanded(
                    child: PageView(
                      controller: _pages,
                      onPageChanged: (i) => setState(() => _at = i),
                      children: [for (final p in pages) _PageBody(page: p, key: ValueKey(p.key))],
                    ),
                  ),
                  _Dots(count: pages.length, at: _at),
                  Padding(
                    padding: const EdgeInsets.fromLTRB(24, 20, 24, 12),
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 440),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          if (askingNow) ...[
                            FilledButton(
                              onPressed: _asking ? null : () => _ask(pages.length),
                              child: const Text('Turn on notifications'),
                            ),
                            TextButton(
                              onPressed: _asking
                                  ? null
                                  : () {
                                      setState(() => _notifications = false);
                                      _next(pages.length);
                                    },
                              child: const Text('Not now'),
                            ),
                          ] else ...[
                            FilledButton(onPressed: () => _next(pages.length), child: Text(last ? 'Get started' : 'Next')),
                            // Keeps the button where it was on the page before.
                            SizedBox(
                              height: 48,
                              child: Center(
                                child: page.key == 'news' && _notifications != null
                                    ? Text(
                                        _notifications! ? 'Notifications are on.' : 'You can turn them on any time under Venue.',
                                        style: text.bodyMedium?.copyWith(color: Colors.white.withValues(alpha: 0.85)),
                                      )
                                    : null,
                              ),
                            ),
                          ],
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _PageBody extends StatelessWidget {
  const _PageBody({super.key, required this.page});

  final _Page page;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.symmetric(horizontal: 32),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 440),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              page.picture,
              const SizedBox(height: 36),
              Text(
                page.title,
                textAlign: TextAlign.center,
                style: text.headlineSmall?.copyWith(color: Colors.white, fontWeight: FontWeight.w800),
              ),
              const SizedBox(height: 12),
              Text(
                page.body,
                textAlign: TextAlign.center,
                style: text.bodyLarge?.copyWith(color: Colors.white.withValues(alpha: 0.88), height: 1.4),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Where we are: a dot per page, the current one long.
class _Dots extends StatelessWidget {
  const _Dots({required this.count, required this.at});

  final int count;
  final int at;

  @override
  Widget build(BuildContext context) => Semantics(
    label: 'Page ${at + 1} of $count',
    child: Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        for (var i = 0; i < count; i++)
          AnimatedContainer(
            duration: const Duration(milliseconds: 250),
            curve: Curves.easeOutCubic,
            margin: const EdgeInsets.symmetric(horizontal: 4),
            width: i == at ? 22 : 8,
            height: 8,
            decoration: BoxDecoration(
              color: Colors.white.withValues(alpha: i == at ? 1 : 0.4),
              borderRadius: BorderRadius.circular(4),
            ),
          ),
      ],
    ),
  );
}

/// An icon in a soft white disc.
class _Badge extends StatelessWidget {
  const _Badge({required this.icon});

  final IconData icon;

  @override
  Widget build(BuildContext context) => Container(
    width: 120,
    height: 120,
    decoration: BoxDecoration(
      shape: BoxShape.circle,
      color: Colors.white.withValues(alpha: 0.14),
      border: Border.all(color: Colors.white.withValues(alpha: 0.35), width: 2),
    ),
    child: AnimatedSwitcher(
      duration: const Duration(milliseconds: 300),
      child: Icon(icon, key: ValueKey(icon), size: 56, color: Colors.white),
    ),
  );
}

/// The membership card as it looks on the Card tab, in miniature.
class _CardPicture extends StatelessWidget {
  const _CardPicture();

  @override
  Widget build(BuildContext context) => Transform.rotate(
    angle: -0.06,
    child: Container(
      width: 220,
      height: 140,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(18),
        boxShadow: const [BoxShadow(blurRadius: 24, color: Colors.black38, offset: Offset(0, 10))],
      ),
      child: Row(
        children: [
          Icon(Icons.qr_code_2, size: 104, color: VenueStyle.deep),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Text('MEMBER', style: TextStyle(color: VenueStyle.club, fontWeight: FontWeight.w800, letterSpacing: 1.5, fontSize: 12)),
                const SizedBox(height: 8),
                for (final w in [70.0, 48.0])
                  Container(
                    margin: const EdgeInsets.only(bottom: 6),
                    width: w,
                    height: 6,
                    decoration: BoxDecoration(color: VenueStyle.club.withValues(alpha: 0.2), borderRadius: BorderRadius.circular(3)),
                  ),
              ],
            ),
          ),
        ],
      ),
    ),
  );
}

/// The club's waiting moment: a kick at the posts on the club colour, where
/// the shared app has a spinner.
class ClubWaiting extends StatelessWidget {
  const ClubWaiting({super.key});

  @override
  Widget build(BuildContext context) {
    if (!VenueStyle.enabled) {
      return const Scaffold(body: Center(child: CircularProgressIndicator.adaptive()));
    }
    return ClubGradient(
      child: Center(child: KickAnimation(size: 140, accent: VenueStyle.club)),
    );
  }
}
