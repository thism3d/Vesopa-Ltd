import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../brand.dart';
import '../data/session.dart';
import 'scene.dart';
import 'widgets.dart';

/// The front door, and the onboarding.
///
/// The top is the moving car park (scene.dart): a car arrives, is recognised
/// and the barrier lifts. Under it, four short slides say how membership works,
/// turning by themselves or by a swipe, and Continue with Vesopa is always in
/// reach, so the tour never stands between somebody and signing in. Continue
/// with Vesopa also makes a Vesopa account for somebody who has none.
class SignInPage extends ConsumerStatefulWidget {
  const SignInPage({super.key});

  @override
  ConsumerState<SignInPage> createState() => _SignInPageState();
}

class _Slide {
  const _Slide(this.icon, this.kicker, this.title, this.body);

  final IconData icon;
  final String kicker;
  final String title;
  final String body;
}

const _slides = [
  _Slide(Icons.workspace_premium_rounded, 'Metric Membership', 'Your car is your pass.',
      'The barrier opens for you on the way in and on the way out. No tickets, no fobs, no queue.'),
  _Slide(Icons.pin_rounded, 'Step 1', 'Add your registration.',
      'Register up to three cars. Swap them any time, straight from your phone.'),
  _Slide(Icons.center_focus_strong_rounded, 'Step 2', 'Drive up. We do the rest.',
      'The camera reads your plate, recognises your membership and lifts the barrier in a moment.'),
  _Slide(Icons.verified_user_rounded, 'Step 3', 'Every visit, in your pocket.',
      'See when you arrived and left, and manage your membership wherever you are.'),
];

class _SignInPageState extends ConsumerState<SignInPage> {
  final _pages = PageController();
  int _page = 0;
  Timer? _auto;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _error = ref.read(sessionProvider.notifier).lastSignInError;
    ref.read(sessionProvider.notifier).lastSignInError = null;
    _auto = Timer.periodic(const Duration(seconds: 6), (_) {
      if (!mounted || !_pages.hasClients) return;
      _pages.animateToPage((_page + 1) % _slides.length, duration: const Duration(milliseconds: 600), curve: Curves.easeInOutCubic);
    });
    WidgetsBinding.instance.addPostFrameCallback((_) => ref.read(activityLogProvider).screen('welcome'));
  }

  @override
  void dispose() {
    _auto?.cancel();
    _pages.dispose();
    super.dispose();
  }

  Future<void> _go() async {
    ref.read(activityLogProvider).tap('continue_with_vesopa', {'slide': _page});
    setState(() {
      _busy = true;
      _error = null;
    });
    final error = await ref.read(sessionProvider.notifier).continueWithVesopa();
    if (!mounted) return;
    setState(() {
      _busy = false;
      _error = error;
    });
  }

  @override
  Widget build(BuildContext context) {
    final size = MediaQuery.sizeOf(context);
    final wide = size.width >= 900;
    final hero = Stack(
      fit: StackFit.expand,
      children: [
        const CarParkScene(),
        SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(24, 20, 24, 0),
            child: Align(
              alignment: wide ? Alignment.topLeft : Alignment.topCenter,
              child: const _HeroBrand(),
            ),
          ),
        ),
      ],
    );
    final panel = _Panel(
      pages: _pages,
      page: _page,
      onPage: (i) {
        setState(() => _page = i);
        ref.read(activityLogProvider).screen('welcome_slide_${i + 1}');
      },
      busy: _busy,
      error: _error,
      onContinue: _go,
    );

    if (wide) {
      return Scaffold(
        backgroundColor: MetricBrand.navy,
        body: Row(
          children: [
            Expanded(flex: 3, child: hero),
            SizedBox(width: 480, child: ColoredBox(color: Colors.white, child: SafeArea(child: Center(child: panel)))),
          ],
        ),
      );
    }
    return Scaffold(
      backgroundColor: Colors.white,
      body: Column(
        children: [
          SizedBox(height: (size.height * 0.46).clamp(260.0, 460.0), child: hero),
          Expanded(
            child: Transform.translate(
              offset: const Offset(0, -24),
              child: Container(
                decoration: const BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.vertical(top: Radius.circular(28)),
                  boxShadow: [BoxShadow(color: Color(0x33001A63), blurRadius: 24, offset: Offset(0, -6))],
                ),
                child: SafeArea(top: false, child: panel),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _HeroBrand extends StatelessWidget {
  const _HeroBrand();

  @override
  Widget build(BuildContext context) => Row(
    mainAxisSize: MainAxisSize.min,
    children: [
      const MetricLogo(height: 34, white: true),
      const SizedBox(width: 12),
      Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
        decoration: BoxDecoration(
          color: MetricBrand.green.withValues(alpha: 0.16),
          borderRadius: BorderRadius.circular(99),
          border: Border.all(color: MetricBrand.green.withValues(alpha: 0.6)),
        ),
        child: const Text('MEMBERSHIP', style: TextStyle(color: MetricBrand.green, fontSize: 11, fontWeight: FontWeight.w800, letterSpacing: 1.8)),
      ),
    ],
  );
}

class _Panel extends StatelessWidget {
  const _Panel({
    required this.pages,
    required this.page,
    required this.onPage,
    required this.busy,
    required this.error,
    required this.onContinue,
  });

  final PageController pages;
  final int page;
  final ValueChanged<int> onPage;
  final bool busy;
  final String? error;
  final VoidCallback onContinue;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 440),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(28, 20, 28, 16),
        child: Column(
          mainAxisSize: MainAxisSize.max,
          children: [
            Expanded(
              child: PageView.builder(
                controller: pages,
                onPageChanged: onPage,
                itemCount: _slides.length,
                itemBuilder: (context, i) => _SlideView(slide: _slides[i]),
              ),
            ),
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                for (var i = 0; i < _slides.length; i++)
                  GestureDetector(
                    onTap: () => pages.animateToPage(i, duration: const Duration(milliseconds: 500), curve: Curves.easeInOutCubic),
                    child: AnimatedContainer(
                      duration: const Duration(milliseconds: 300),
                      margin: const EdgeInsets.symmetric(horizontal: 4),
                      width: i == page ? 26 : 8,
                      height: 8,
                      decoration: BoxDecoration(
                        color: i == page ? MetricBrand.green : MetricBrand.line,
                        borderRadius: BorderRadius.circular(99),
                      ),
                    ),
                  ),
              ],
            ),
            const SizedBox(height: 20),
            if (error != null) ...[
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(color: MetricBrand.red50, borderRadius: BorderRadius.circular(12)),
                child: Text(error!, textAlign: TextAlign.center, style: const TextStyle(color: MetricBrand.red)),
              ),
              const SizedBox(height: 12),
            ],
            _VesopaButton(busy: busy, onPressed: onContinue),
            const SizedBox(height: 12),
            Text(
              'New here? Continue with Vesopa creates your account in a minute.',
              textAlign: TextAlign.center,
              style: text.bodySmall?.copyWith(color: MetricBrand.slate),
            ),
            const SizedBox(height: 14),
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                const Icon(Icons.support_agent_rounded, size: 16, color: MetricBrand.muted),
                const SizedBox(width: 6),
                InkWell(
                  onTap: () => launchUrl(Uri.parse('tel:${MetricBrand.phone.replaceAll(' ', '')}')),
                  child: Text('Help: ${MetricBrand.phone}', style: text.bodySmall?.copyWith(color: MetricBrand.navy, fontWeight: FontWeight.w600)),
                ),
                const SizedBox(width: 10),
                Text('·  Powered by Vesopa', style: text.bodySmall?.copyWith(color: MetricBrand.muted)),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _SlideView extends StatelessWidget {
  const _SlideView({required this.slide});

  final _Slide slide;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return LayoutBuilder(
      builder: (context, box) => SingleChildScrollView(
        physics: const NeverScrollableScrollPhysics(),
        child: ConstrainedBox(
          constraints: BoxConstraints(minHeight: box.maxHeight),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Container(
                width: 56,
                height: 56,
                decoration: BoxDecoration(
                  gradient: const LinearGradient(colors: [MetricBrand.navy, MetricBrand.navy600], begin: Alignment.topLeft, end: Alignment.bottomRight),
                  borderRadius: BorderRadius.circular(18),
                  boxShadow: const [BoxShadow(color: Color(0x40002788), blurRadius: 14, offset: Offset(0, 6))],
                ),
                child: Icon(slide.icon, color: MetricBrand.green, size: 28),
              ),
              const SizedBox(height: 16),
              Text(slide.kicker.toUpperCase(),
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: MetricBrand.greenDark, fontWeight: FontWeight.w800, letterSpacing: 1.6, fontSize: 12)),
              const SizedBox(height: 8),
              Text(
                slide.title,
                textAlign: TextAlign.center,
                style: text.headlineSmall?.copyWith(color: MetricBrand.ink, fontWeight: FontWeight.w800, height: 1.15),
              ),
              const SizedBox(height: 10),
              Text(
                slide.body,
                textAlign: TextAlign.center,
                style: text.bodyLarge?.copyWith(color: MetricBrand.slate, height: 1.45),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _VesopaButton extends StatelessWidget {
  const _VesopaButton({required this.busy, required this.onPressed});

  final bool busy;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) => SizedBox(
    width: double.infinity,
    height: 56,
    child: DecoratedBox(
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(16),
        gradient: const LinearGradient(colors: [MetricBrand.navy, MetricBrand.navy600]),
        boxShadow: const [BoxShadow(color: Color(0x4D002788), blurRadius: 18, offset: Offset(0, 8))],
      ),
      child: Material(
        type: MaterialType.transparency,
        child: InkWell(
          key: const Key('continue-with-vesopa'),
          borderRadius: BorderRadius.circular(16),
          onTap: busy ? null : onPressed,
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              if (busy)
                const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
              else
                ClipRRect(borderRadius: BorderRadius.circular(5), child: Image.asset('assets/vesopa-mark.png', width: 24, height: 24)),
              const SizedBox(width: 12),
              Text(
                busy ? 'Waiting for Vesopa…' : 'Continue with Vesopa',
                style: const TextStyle(color: Colors.white, fontSize: 16.5, fontWeight: FontWeight.w700, letterSpacing: 0.2),
              ),
              if (!busy) ...[
                const SizedBox(width: 8),
                const Icon(Icons.arrow_forward_rounded, color: MetricBrand.green, size: 20),
              ],
            ],
          ),
        ),
      ),
    ),
  );
}
