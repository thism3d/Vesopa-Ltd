/// The kiosk's one screen, and the two things that watch over it.
///
/// Everything a customer sees is drawn from two pieces of state -- the
/// session's phase and the order flow's step -- so there is no navigation
/// stack to get lost in. Two watchers sit over every screen:
///
///   * the IDLE TIMER. A basket left on the screen is the next customer's
///     problem and the last customer's privacy. After the venue's idle time
///     (less fifteen seconds) the kiosk asks "Still there?" with a countdown;
///     any touch answers it. Never while money is moving, never on the number.
///   * the STAFF CORNER. Held for three seconds, the bottom-left corner opens
///     the passcode pad, and through it Settings. Invisible, on every screen,
///     including the ones that say the kiosk is closed.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/order_flow.dart';
import '../data/session.dart';
import 'pages/ordering.dart';
import 'pages/paying.dart';
import 'pages/settings.dart';
import 'pages/setup.dart';
import 'theme.dart';

class ExpressApp extends ConsumerWidget {
  const ExpressApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final accent = ref.watch(kioskSessionProvider.select((s) => s.config?.accent)) ?? Xp.lime;
    final contrast = ref.watch(orderFlowProvider.select((f) => f.contrast));
    return MaterialApp(
      title: 'Vesopa Express',
      debugShowCheckedModeBanner: false,
      theme: Xp.theme(contrast: contrast, accent: accent),
      // Type is sized for a kiosk read at arm's length. A Windows display scale
      // set for somebody's desktop must not reflow it past what fits.
      builder: (context, child) => MediaQuery.withClampedTextScaling(
        maxScaleFactor: 1.25,
        child: child ?? const SizedBox.shrink(),
      ),
      home: const KioskShell(),
    );
  }
}

class KioskShell extends ConsumerStatefulWidget {
  const KioskShell({super.key});

  @override
  ConsumerState<KioskShell> createState() => _KioskShellState();
}

class _KioskShellState extends ConsumerState<KioskShell> {
  Timer? _idle;
  Timer? _countdownTimer;
  int? _countdown;
  Timer? _corner;

  static const _warning = 15;

  bool _watched(FlowStep step) =>
      step != FlowStep.attract && step != FlowStep.paying && step != FlowStep.done;

  void _touched() {
    _countdownTimer?.cancel();
    if (_countdown != null) setState(() => _countdown = null);
    _arm();
  }

  void _arm() {
    _idle?.cancel();
    final step = ref.read(orderFlowProvider).step;
    if (!_watched(step) || ref.read(kioskSessionProvider).phase != Phase.ready) return;
    final total = ref.read(kioskSessionProvider).config?.idleSeconds ?? 60;
    _idle = Timer(Duration(seconds: (total - _warning).clamp(5, 600)), _warn);
  }

  void _warn() {
    if (!mounted || !_watched(ref.read(orderFlowProvider).step)) return;
    setState(() => _countdown = _warning);
    _countdownTimer = Timer.periodic(const Duration(seconds: 1), (t) {
      if (!mounted) return t.cancel();
      final left = (_countdown ?? 1) - 1;
      if (left <= 0) {
        t.cancel();
        setState(() => _countdown = null);
        ref.read(orderFlowProvider.notifier).idleReset();
      } else {
        setState(() => _countdown = left);
      }
    });
  }

  void _cornerDown(PointerDownEvent _) {
    _corner?.cancel();
    _corner = Timer(const Duration(seconds: 3), () {
      if (!mounted) return;
      Navigator.of(context).push(MaterialPageRoute(builder: (_) => const StaffGate()));
    });
  }

  void _cornerUp([Object? _]) => _corner?.cancel();

  @override
  void dispose() {
    _idle?.cancel();
    _countdownTimer?.cancel();
    _corner?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    ref.listen(orderFlowProvider.select((f) => f.step), (_, _) => _touched());
    final session = ref.watch(kioskSessionProvider);

    final Widget page = switch (session.phase) {
      Phase.booting => const SplashPage(),
      Phase.setup => const SetupPage(),
      Phase.choosePasscode => const ChoosePasscodePage(),
      Phase.off => const ClosedPage(kind: ClosedKind.off),
      Phase.offline => const ClosedPage(kind: ClosedKind.offline),
      Phase.ready => session.menu.isEmpty
          ? const ClosedPage(kind: ClosedKind.noMenu)
          : const _FlowView(),
    };

    return Scaffold(
      body: Listener(
        behavior: HitTestBehavior.translucent,
        onPointerDown: (_) => _touched(),
        child: Stack(
          children: [
            Positioned.fill(child: page),
            if (_countdown != null)
              Positioned.fill(child: _StillThere(seconds: _countdown!, onTap: _touched)),
            Positioned(
              left: 0,
              bottom: 0,
              width: 88,
              height: 88,
              child: Listener(
                behavior: HitTestBehavior.translucent,
                onPointerDown: _cornerDown,
                onPointerUp: _cornerUp,
                onPointerCancel: _cornerUp,
                child: const SizedBox.expand(),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// The customer's screens, one per step, cross-faded.
class _FlowView extends ConsumerWidget {
  const _FlowView();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final step = ref.watch(orderFlowProvider.select((f) => f.step));
    final Widget page = switch (step) {
      FlowStep.attract => const AttractPage(),
      FlowStep.orderType => const OrderTypePage(),
      FlowStep.menu => const MenuPage(),
      FlowStep.basket => const BasketPage(),
      FlowStep.details => const NamePage(),
      FlowStep.payMethod => const PayMethodPage(),
      FlowStep.paying => const PayingPage(),
      FlowStep.done => const DonePage(),
    };
    return AnimatedSwitcher(
      duration: const Duration(milliseconds: 260),
      switchInCurve: Curves.easeOutCubic,
      transitionBuilder: (child, animation) => FadeTransition(
        opacity: animation,
        child: SlideTransition(
          position: Tween(begin: const Offset(0, .015), end: Offset.zero).animate(animation),
          child: child,
        ),
      ),
      child: KeyedSubtree(key: ValueKey(step), child: page),
    );
  }
}

class _StillThere extends ConsumerWidget {
  const _StillThere({required this.seconds, required this.onTap});

  final int seconds;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = ref.watch(orderFlowProvider.select((f) => f.s));
    final skin = XpSkin.of(context);
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onTap,
      child: Container(
        color: Colors.black.withValues(alpha: .62),
        alignment: Alignment.center,
        child: Container(
          width: 520,
          margin: const EdgeInsets.all(24),
          padding: const EdgeInsets.all(36),
          decoration: BoxDecoration(color: skin.card, borderRadius: BorderRadius.circular(Xp.radius)),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(s('still_there'), style: Theme.of(context).textTheme.headlineLarge, textAlign: TextAlign.center),
              const SizedBox(height: 12),
              Text('${s('still_there_sub')} $seconds ${s('seconds')}',
                  style: Theme.of(context).textTheme.bodyLarge?.copyWith(color: skin.inkSoft),
                  textAlign: TextAlign.center),
              const SizedBox(height: 26),
              SizedBox(
                width: 120,
                height: 120,
                child: Stack(
                  alignment: Alignment.center,
                  children: [
                    SizedBox.expand(
                      child: CircularProgressIndicator(
                        value: seconds / 15,
                        strokeWidth: 8,
                        color: Xp.lime,
                        backgroundColor: skin.line,
                      ),
                    ),
                    Text('$seconds', style: const TextStyle(fontFamily: Xp.numerals, fontSize: 40, fontWeight: FontWeight.w800)),
                  ],
                ),
              ),
              const SizedBox(height: 26),
              FilledButton(onPressed: onTap, child: Text(s('tap_continue'))),
            ],
          ),
        ),
      ),
    );
  }
}
