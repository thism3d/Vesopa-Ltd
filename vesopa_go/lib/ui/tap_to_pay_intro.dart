/// Tap to Pay on iPhone, introduced (Apple's App Requirements and Review
/// guide v1.8, 2026-11-04):
///
///   3.1 / 3.2 / 6.2  a full-screen introduction, seen by every eligible user
///                    at least once, in Apple's approved words
///   3.4 / 3.5        a clear action to set it up (Apple's own terms screen)
///   3.8 / 3.8.1      only a manager accepts the terms; anyone else is told
///                    to ask one
///   3.9.1            a progress screen while the iPhone is being configured
///   4.2              Apple's merchant education straight after the terms
///   3.9              then an invitation to try it
///   5.12             notifications asked for here, well before checkout
///
/// No pictures of iPhones or Tap to Pay are drawn (Apple's marketing rules):
/// the words, and the wave.3.right.circle symbol Apple asks for.
library;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../data/session.dart';
import '../data/till_permissions.dart';
import '../payments/payment_service.dart';
import 'tap_to_pay_mark.dart';
import 'theme.dart';

/// Apple's approved copy (Tap to Pay on iPhone Marketing Guide).
const ttpHeadline = 'Tap to Pay on iPhone';
const ttpBody = 'Accept physical debit and credit cards as well as Apple Pay and other digital wallets. Right on your iPhone.';
const ttpLegal = 'Some contactless cards may not be accepted. Transaction limits may apply. '
    'The Contactless Symbol is a trademark owned by and used with permission of EMVCo, LLC.';

/// Shows the introduction once on this iPhone for this venue.
Future<void> maybeShowTapToPayIntro(BuildContext context, WidgetRef ref) async {
  if (kIsWeb || defaultTargetPlatform != TargetPlatform.iOS) return;
  if (MediaQuery.sizeOf(context).shortestSide >= 600) return; // iPhone only
  final pay = ref.read(paymentsProvider);
  if (pay is! DojoTapToPay) return;
  final office = ref.read(tapProvider).venue?.office ?? '';
  final key = 'go_ttp_intro_$office';
  final prefs = await SharedPreferences.getInstance();
  if (prefs.getBool(key) == true || !context.mounted) return;
  if (await pay.whyUnavailable() != null || !context.mounted) return;
  await prefs.setBool(key, true);
  await showTapToPayIntro(context);
}

/// The introduction, full screen; also opened from Settings.
Future<void> showTapToPayIntro(BuildContext context) => Navigator.of(context).push(MaterialPageRoute<void>(
      fullscreenDialog: true,
      builder: (_) => const TapToPayIntroPage(),
    ));

enum _Stage { intro, preparing, ready, problem }

class TapToPayIntroPage extends ConsumerStatefulWidget {
  const TapToPayIntroPage({super.key});
  @override
  ConsumerState<TapToPayIntroPage> createState() => _TapToPayIntroPageState();
}

class _TapToPayIntroPageState extends ConsumerState<TapToPayIntroPage> {
  _Stage _stage = _Stage.intro;
  bool? _linked;
  String? _problem;

  bool get _manager => ref.read(tapProvider).clerk?.can(TillPermission.isManager) ?? false;

  @override
  void initState() {
    super.initState();
    final pay = ref.read(paymentsProvider);
    if (pay is DojoTapToPay) {
      pay.isLinked().then((v) {
        if (mounted) setState(() => _linked = v);
      });
    }
  }

  Future<void> _setUp() async {
    final pay = ref.read(paymentsProvider);
    if (pay is! DojoTapToPay) return;
    setState(() => _stage = _Stage.preparing);
    await pay.askNotifications();
    final why = await pay.setUp();
    if (!mounted) return;
    if (why != null) {
      setState(() {
        _stage = _Stage.problem;
        _problem = why;
      });
      return;
    }
    _linked = true;
    // Apple 4.2: education straight after the terms.
    await pay.showGuide();
    final p = await SharedPreferences.getInstance();
    await p.setBool('go_ttp_guide_seen', true);
    if (mounted) setState(() => _stage = _Stage.ready);
  }

  Future<void> _guide() async {
    final pay = ref.read(paymentsProvider);
    if (pay is DojoTapToPay) await pay.showGuide();
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final ink = context.goLimeInk;
    Widget body;
    List<Widget> buttons;
    switch (_stage) {
      case _Stage.preparing:
        // Apple 3.9.1: the user sees that Tap to Pay is not ready yet.
        body = Column(mainAxisSize: MainAxisSize.min, children: [
          const SizedBox(width: 56, height: 56, child: CircularProgressIndicator(strokeWidth: 5)),
          const SizedBox(height: 24),
          Text('Getting Tap to Pay on iPhone ready', textAlign: TextAlign.center, style: t.titleLarge?.copyWith(fontWeight: FontWeight.w700)),
          const SizedBox(height: 8),
          Text('Accept the terms when they appear. Setting up this iPhone can take a minute the first time; keep Vesopa Go open.',
              textAlign: TextAlign.center, style: t.bodyMedium?.copyWith(color: context.goMuted)),
        ]);
        buttons = const [];
      case _Stage.ready:
        // Apple 3.9: invite them to try it.
        body = Column(mainAxisSize: MainAxisSize.min, children: [
          TapToPayMark(size: 72, color: ink),
          const SizedBox(height: 24),
          Text('Tap to Pay on iPhone is ready', textAlign: TextAlign.center, style: t.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
          const SizedBox(height: 10),
          Text('Try it now: ring up an item, choose Tap to Pay on iPhone at checkout and ask the customer to hold their card or device near the top of this iPhone.',
              textAlign: TextAlign.center, style: t.bodyLarge),
        ]);
        buttons = [
          FilledButton(key: const ValueKey('ttp-try'), onPressed: () => Navigator.pop(context), child: const Text('Try it now')),
          TextButton(onPressed: _guide, child: const Text('How to use Tap to Pay on iPhone')),
        ];
      case _Stage.problem:
        body = Column(mainAxisSize: MainAxisSize.min, children: [
          Icon(Icons.info_outline_rounded, size: 56, color: context.goMuted),
          const SizedBox(height: 18),
          Text("Tap to Pay on iPhone isn't ready yet", textAlign: TextAlign.center, style: t.titleLarge?.copyWith(fontWeight: FontWeight.w700)),
          const SizedBox(height: 8),
          Text(_problem ?? '', textAlign: TextAlign.center, style: t.bodyMedium),
        ]);
        buttons = [
          FilledButton(onPressed: _setUp, child: const Text('Try again')),
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Not now')),
        ];
      case _Stage.intro:
        final notAdmin = _linked == false && !_manager;
        body = Column(mainAxisSize: MainAxisSize.min, children: [
          TapToPayMark(size: 72, color: ink),
          const SizedBox(height: 24),
          Text(ttpHeadline, textAlign: TextAlign.center, style: t.headlineMedium?.copyWith(fontWeight: FontWeight.w800)),
          const SizedBox(height: 12),
          Text(ttpBody, textAlign: TextAlign.center, style: t.titleMedium),
          if (notAdmin) ...[
            const SizedBox(height: 16),
            Text(DojoTapToPay.notAdmin, textAlign: TextAlign.center, style: t.bodyMedium?.copyWith(color: context.goMuted)),
          ],
        ]);
        buttons = [
          if (_linked == true)
            FilledButton(key: const ValueKey('ttp-guide'), onPressed: () async {
              await _guide();
              if (context.mounted) Navigator.pop(context);
            }, child: const Text('How to use Tap to Pay on iPhone'))
          else if (!notAdmin)
            FilledButton.icon(
              key: const ValueKey('ttp-setup'),
              // Never waits on the "already accepted?" check (2026-11-04: it
              // can hang on Dojo, which left this button grey): set-up asks
              // again itself and shows Apple's terms when they are needed.
              onPressed: _setUp,
              icon: const TapToPayMark(size: 20),
              label: const Text('Set up Tap to Pay on iPhone'),
            )
          else
            FilledButton(onPressed: () => Navigator.pop(context), child: const Text('OK')),
          TextButton(key: const ValueKey('ttp-later'), onPressed: () => Navigator.pop(context), child: const Text('Not now')),
        ];
    }
    return Scaffold(
      backgroundColor: context.goDeep,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(28, 12, 28, 20),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Expanded(child: Center(child: SingleChildScrollView(child: body))),
            for (final b in buttons) Padding(padding: const EdgeInsets.only(top: 10), child: SizedBox(height: 52, child: b)),
            if (_stage == _Stage.intro) ...[
              const SizedBox(height: 14),
              Text(ttpLegal, textAlign: TextAlign.center, style: t.bodySmall?.copyWith(color: context.goMuted)),
            ],
          ]),
        ),
      ),
    );
  }
}
