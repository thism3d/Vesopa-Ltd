/// Finishing a venue's sign-up (owner, 2026-11-17): the business, the owner's
/// identity, Stripe's checks of the business and its bank, and the licence.
///
/// Opened straight after "Register a new venue", and from More, "Account
/// checks". Every step is Stripe's own native screen (packages/stripe_onboarding);
/// the server (vesopa_server/src/go_onboarding.js) makes each session and says
/// where the venue stands:
///
///   test    no live card payments until Stripe lets the venue take cards
///   capped  live, at most £250 a payment and £1,000 a day, until every
///           check has passed
///   live    every check passed: no limits
library;

import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:stripe_onboarding/stripe_onboarding.dart';

import '../../data/api.dart';
import '../../data/session.dart';
import '../theme.dart';

String _pounds(num minor) {
  final p = minor / 100;
  return p == p.roundToDouble() ? '£${p.toStringAsFixed(0)}' : '£${p.toStringAsFixed(2)}';
}

/// Where a venue that signed up in Go or on go.vesopa.com stands, read once
/// a device is signed in. Until its sign-up is finished and the owner's PIN
/// is set, Go opens here and nowhere else (main.dart; owner, 2026-11-17:
/// "without completing the registration always leave that account ... where
/// registration started"). Null when not signed in, in the demo, or the back
/// office cannot be reached (a venue must still work offline).
final onboardingGateProvider = FutureProvider<Map<String, dynamic>?>((ref) async {
  final signedOn = ref.watch(tapProvider.select((s) => s.phase == Phase.locked || s.phase == Phase.ready));
  final demo = ref.watch(tapProvider.select((s) => s.demo));
  ref.watch(tapProvider.select((s) => s.venue?.name));
  if (!signedOn || demo) return null;
  try {
    return await ref.read(apiProvider).onboardingStatus();
  } on TapApiError {
    return null;
  }
});

/// Whether Go must stay on the sign-up for this venue.
bool holdForSignup(Map<String, dynamic>? gate) => gate != null && gate['signed_up'] == true && gate['ready_to_use'] != true;

class OnboardingPage extends ConsumerStatefulWidget {
  const OnboardingPage({super.key, this.justRegistered = false, this.gate = false});

  /// Straight after registering: says so.
  final bool justRegistered;

  /// Shown instead of the venue until the sign-up is finished: no way past it
  /// but finishing, or signing this device out.
  final bool gate;

  @override
  ConsumerState<OnboardingPage> createState() => _OnboardingPageState();
}

class _OnboardingPageState extends ConsumerState<OnboardingPage> {
  Map<String, dynamic>? _status;
  String? _error;
  String? _busy;

  TapApi get _api => ref.read(apiProvider);

  @override
  void initState() {
    super.initState();
    _load(refresh: true);
  }

  Future<void> _load({bool refresh = false}) async {
    try {
      final s = await _api.onboardingStatus(refresh: refresh);
      if (mounted) setState(() {
        _status = s;
        _error = null;
      });
    } on TapApiError catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  /// Runs one step, shows what went wrong, and reads the status again.
  Future<void> _step(String name, Future<String?> Function() run) async {
    setState(() {
      _busy = name;
      _error = null;
    });
    try {
      final problem = await run();
      if (problem != null && mounted) setState(() => _error = problem);
    } on TapApiError catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      await _load(refresh: true);
      if (mounted) setState(() => _busy = null);
    }
  }

  // ---- The steps ----

  Future<void> _business() async {
    final saved = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (_) => _BusinessSheet(status: _status ?? const {}),
    );
    if (saved == true) await _load();
  }

  Future<String?> _identity() async {
    final Map<String, dynamic> s;
    try {
      s = await _api.identitySession();
    } on TapApiError catch (e) {
      return _identityProblem(e.message);
    }
    // Stripe will not run Identity for Vesopa's account: the owner's ID is
    // checked in step 3 instead, and the sign-up goes on (server: via_connect).
    if (s['via_connect'] == true) return null;
    final r = await StripeOnboarding.verifyIdentity(
      sessionId: s['id'] as String,
      ephemeralKeySecret: s['ephemeral_key_secret'] as String,
      publishableKey: s['publishable_key'] as String? ?? '',
    );
    if (r.end == StripeFlowEnd.failed) return _identityProblem(r.message);
    return null;
  }

  /// Stripe's own words when it will not run an ID check at all ("For more
  /// information on Stripe Identity supported use-cases and locations…")
  /// describe Vesopa's Stripe account, not the person in front of the
  /// screen, so they are put in words that person can act on.
  static String _identityProblem(String? stripe) {
    final m = stripe ?? '';
    if (m.contains('identity/use-cases') || m.toLowerCase().contains('not enabled for identity') || m.toLowerCase().contains('identity is not')) {
      return 'ID checks are not open for Vesopa yet, so your ID cannot be checked right now. '
          'Skip this step for now; Vesopa has been told.';
    }
    return m.isEmpty ? 'Your ID could not be checked. Try again.' : m;
  }

  Future<String?> _stripe() async {
    final first = await _api.stripeOnboardingSession();
    var handed = false;
    final r = await StripeOnboarding.accountOnboarding(
      publishableKey: first['publishable_key'] as String? ?? '',
      fetchClientSecret: () async {
        if (!handed) {
          handed = true;
          return first['client_secret'] as String?;
        }
        try {
          return (await _api.stripeOnboardingSession())['client_secret'] as String?;
        } on TapApiError {
          return null;
        }
      },
    );
    if (r.end == StripeFlowEnd.failed) return r.message ?? 'The secure checks could not open. Try again.';
    return null;
  }

  Future<String?> _licence() async {
    final s = await _api.licenceSession();
    if (s['done'] == true) return null;
    final r = await StripeOnboarding.collectCard(
      publishableKey: s['publishable_key'] as String? ?? '',
      setupIntentClientSecret: s['setup_intent_client_secret'] as String,
      merchantName: s['merchant_name'] as String? ?? 'Vesopa Software Ltd',
    );
    if (r.end == StripeFlowEnd.failed) return r.message ?? 'The card was not saved. Try again.';
    return null;
  }

  Future<void> _ownerPin() async {
    final done = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (_) => const _OwnerPinSheet(),
    );
    if (done == true) await _load();
  }

  /// Everything done: into the venue (the gate lifts and staff reload, so the
  /// owner's PIN works on the PIN pad at once).
  Future<void> _start() async {
    await ref.read(tapProvider.notifier).refresh();
    ref.invalidate(onboardingGateProvider);
    if (!widget.gate && mounted && Navigator.of(context).canPop()) Navigator.of(context).pop();
  }

  // ---- The pages ----

  /// Which page is showing: 0 business, 1 identity, 2 Stripe's checks,
  /// 3 licence, 4 manager PIN, 5 all done. Follows the server's "next" until
  /// the owner picks a page from the progress bar.
  int? _page;
  int _shown = 0;

  static const _pages = ['business', 'identity', 'stripe', 'licence', 'pin'];

  int _target(Map<String, dynamic> s) {
    if (s['ready_to_use'] == true) return 5;
    final next = s['next'] as String?;
    if (next == null) return 4;
    return _pages.indexOf(next).clamp(0, 4);
  }

  Future<void> _skip(String step) async {
    setState(() => _busy = 'skip');
    try {
      final s = await _api.onboardingSkip(step);
      if (mounted) setState(() {
        _status = s;
        _page = null;
      });
    } on TapApiError catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  /// One page's work: busy while Stripe's own screen is open, then the
  /// account is read again and the next page slides in.
  Future<void> _go(String name, Future<String?> Function() run) async {
    await _step(name, run);
    if (mounted) setState(() => _page = null);
  }

  @override
  Widget build(BuildContext context) {
    final s = _status;
    final reduce = MediaQuery.of(context).disableAnimations;
    if (s == null) {
      return Scaffold(
        backgroundColor: context.goDeep,
        body: Center(
          child: _error == null
              ? const CircularProgressIndicator()
              : Padding(
                  padding: const EdgeInsets.all(32),
                  child: Column(mainAxisSize: MainAxisSize.min, children: [
                    Text(_error!, textAlign: TextAlign.center),
                    const SizedBox(height: 16),
                    FilledButton(onPressed: () => _load(refresh: true), child: const Text('Try again')),
                  ]),
                ),
        ),
      );
    }
    final target = _target(s);
    final page = (_page ?? target).clamp(0, 5);
    final forward = page >= _shown;
    _shown = page;
    final steps = (s['steps'] as Map?)?.cast<String, dynamic>() ?? const {};
    final skipped = ((s['skipped'] as List?) ?? const []).cast<String>();
    final states = [for (var i = 0; i < 5; i++) _stateOf(i, s, steps, skipped)];

    return Scaffold(
      backgroundColor: context.goDeep,
      appBar: AppBar(
        backgroundColor: context.goDeep,
        title: Text(page == 5 ? 'All set' : 'Set up Vesopa Go'),
        automaticallyImplyLeading: !widget.gate,
        actions: [
          IconButton(
            tooltip: 'Check again',
            onPressed: _busy == null ? () => _load(refresh: true) : null,
            icon: const Icon(Icons.refresh_rounded),
          ),
          if (widget.gate)
            PopupMenuButton<String>(
              onSelected: (_) => ref.read(tapProvider.notifier).forgetPhone(),
              itemBuilder: (_) => const [PopupMenuItem(value: 'out', child: Text('Sign this device out'))],
            ),
        ],
      ),
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 620),
            child: Column(children: [
              if (page < 5)
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 4, 20, 0),
                  child: _Progress(
                    states: states,
                    page: page,
                    onTap: (i) => setState(() => _page = i),
                    enabled: (i) => i == 0 || steps['business'] == true,
                  ),
                ),
              Expanded(
                child: AnimatedSwitcher(
                  duration: reduce ? Duration.zero : const Duration(milliseconds: 420),
                  switchInCurve: const Cubic(0.2, 0, 0, 1),
                  switchOutCurve: Curves.easeIn,
                  transitionBuilder: (child, a) {
                    final dx = (child.key == ValueKey(page)) == forward ? 0.12 : -0.12;
                    return FadeTransition(
                      opacity: a,
                      child: SlideTransition(position: Tween(begin: Offset(dx, 0), end: Offset.zero).animate(a), child: child),
                    );
                  },
                  child: KeyedSubtree(
                    key: ValueKey(page),
                    child: page == 5 ? _AllSet(status: s, onStart: _start) : _pageFor(page, s, steps, skipped, states[page]),
                  ),
                ),
              ),
            ]),
          ),
        ),
      ),
    );
  }

  _State _stateOf(int i, Map<String, dynamic> s, Map<String, dynamic> steps, List<String> skipped) {
    final licence = ((s['licence'] as Map?)?['status']) as String?;
    switch (i) {
      case 0:
        return steps['business'] == true ? _State.done : _State.todo;
      case 1:
        final id = steps['identity'] as String? ?? 'not_started';
        if (id == 'verified' || (id == 'via_connect' && steps['stripe'] == 'complete')) return _State.done;
        if (id == 'processing' || id == 'via_connect') return _State.waiting;
        if (skipped.contains('identity')) return _State.skipped;
        return s['identity_error'] != null ? _State.problem : _State.todo;
      case 2:
        final st = steps['stripe'] as String? ?? 'not_started';
        if (st == 'complete') return _State.done;
        if (skipped.contains('stripe')) return _State.skipped;
        if (st == 'more_needed') return _State.problem;
        if (st == 'in_review') return (s['requirements_due'] ?? 0) == 0 ? _State.waiting : _State.problem;
        return _State.todo;
      case 3:
        if (licence == 'trialing' || licence == 'active') return _State.done;
        if (licence == 'past_due' || licence == 'unpaid') return _State.problem;
        return _State.todo;
      default:
        return s['owner_pin_set'] == true ? _State.done : _State.todo;
    }
  }

  Widget _pageFor(int i, Map<String, dynamic> s, Map<String, dynamic> steps, List<String> skipped, _State state) {
    final licence = (s['licence'] as Map?)?.cast<String, dynamic>() ?? const {};
    final businessDone = steps['business'] == true;
    final complete = s['complete'] == true;
    final mode = _ModeLine(mode: s['mode'] as String? ?? 'test', limits: (s['limits'] as Map?)?.cast<String, dynamic>());
    Widget? skipButton(String step) => state == _State.done || state == _State.waiting
        ? null
        : skipped.contains(step)
            ? null
            : TextButton(onPressed: _busy == null ? () => _skip(step) : null, child: const Text('Skip for now'));
    switch (i) {
      case 0:
        return _StepPage(
          icon: Icons.storefront_rounded,
          title: 'Your business',
          body: businessDone
              ? '${_typeLabel(s)} · ${(s['business'] as Map?)?['legal_name'] ?? ''}'
              : 'Tell us what kind of business it is, its legal name and the card takings you expect. It takes a minute.',
          state: state,
          top: widget.justRegistered || widget.gate ? mode : null,
          error: _error,
          primary: businessDone ? 'Continue' : 'Start',
          busy: false,
          onPrimary: _busy != null
              ? null
              : businessDone
                  ? () => setState(() => _page = 1)
                  : _business,
          secondary: [
            if (businessDone && steps['stripe'] == 'not_started') TextButton(onPressed: _business, child: const Text('Change the details')),
          ],
        );
      case 1:
        final id = steps['identity'] as String? ?? 'not_started';
        return _StepPage(
          icon: Icons.badge_rounded,
          title: 'Verify your identity',
          body: switch (id) {
            'verified' => 'Verified. Thank you.',
            'processing' => 'Your ID is being checked. This usually takes a minute or two; you can carry on meanwhile.',
            'via_connect' => steps['stripe'] == 'complete'
                ? 'Checked with your business and bank checks.'
                : 'Your photo ID is checked in the next step, with the business and bank checks.',
            'requires_input' when s['identity_error'] != null => s['identity_error'] as String,
            _ => skipped.contains('identity')
                ? 'Left for later. Card payments stay limited until your identity is verified.'
                : 'A photo of your passport, driving licence or ID card, and a quick selfie. Have it with you.',
          },
          state: state,
          error: _error,
          bullets: id == 'verified' || id == 'via_connect' ? null : const [
            (Icons.photo_camera_rounded, 'Your ID, photographed in the app'),
            (Icons.face_retouching_natural_rounded, 'A live selfie to match it'),
            (Icons.lock_rounded, 'Sent securely to our payments partner, never kept on this device'),
          ],
          primary: state == _State.done || state == _State.waiting ? 'Continue' : (s['identity_error'] != null ? 'Try again' : 'Verify my identity'),
          busy: _busy == 'identity',
          onPrimary: _busy != null || !businessDone
              ? null
              : state == _State.done || state == _State.waiting
                  ? () => setState(() => _page = 2)
                  : () => _go('identity', _identity),
          secondary: [?skipButton('identity')],
        );
      case 2:
        final st = steps['stripe'] as String? ?? 'not_started';
        final checklist = (s['checklist'] as Map?)?.cast<String, dynamic>();
        return _StepPage(
          icon: Icons.account_balance_rounded,
          title: 'Business and bank checks',
          body: switch (st) {
            'complete' => 'Your business and the bank account your takings are paid into are verified.',
            'in_review' => (s['requirements_due'] ?? 0) == 0
                ? 'Everything is sent and being reviewed. We\'ll tell you here if anything else is needed.'
                : 'A few things are still needed. Continue to add them.',
            'more_needed' => 'A little more information is needed before every limit comes off.',
            _ => skipped.contains('stripe')
                ? 'Left for later. Card payments stay limited until these checks are done.'
                : 'Your business details, its owners and directors, and the bank account your takings are paid into.',
          },
          state: state,
          error: _error,
          extra: checklist == null || st == 'not_started' ? null : _Checklist(checklist: checklist),
          primary: st == 'complete'
              ? 'Continue'
              : st == 'not_started'
                  ? 'Start the checks'
                  : 'Continue the checks',
          busy: _busy == 'stripe',
          onPrimary: _busy != null || !businessDone
              ? null
              : st == 'complete'
                  ? () => setState(() => _page = 3)
                  : () => _go('stripe', _stripe),
          secondary: [
            if (st != 'not_started' && st != 'complete')
              TextButton.icon(
                onPressed: _busy == null ? () => _load(refresh: true) : null,
                icon: const Icon(Icons.refresh_rounded),
                label: const Text('Check again'),
              ),
            if (st == 'in_review' && (s['requirements_due'] ?? 0) == 0)
              TextButton(onPressed: () => setState(() => _page = 3), child: const Text('Carry on meanwhile')),
            ?skipButton('stripe'),
          ],
        );
      case 3:
        final status = licence['status'] as String?;
        return _StepPage(
          icon: Icons.workspace_premium_rounded,
          title: 'Start your free trial',
          body: switch (status) {
            'trialing' => 'Free until ${_date(licence['trial_end'])}, then ${_pounds(licence['amount_minor'] ?? 2900)} a month. Cancel any time.',
            'active' => 'Your licence is active: ${_pounds(licence['amount_minor'] ?? 2900)} a month.',
            'past_due' || 'unpaid' => 'The last payment did not go through. Add another card.',
            _ => '${licence['trial_days'] ?? 14} days free, then ${_pounds(licence['amount_minor'] ?? 2900)} a month. '
                'Add a card now; nothing is taken until the free days end.',
          },
          state: state,
          error: _error,
          bullets: state == _State.done ? null : const [
            (Icons.point_of_sale_rounded, 'EPOS on your phones and tablets'),
            (Icons.soup_kitchen_rounded, 'Kitchen screens and customer displays on any screen or TV'),
            (Icons.contactless_rounded, 'Card payments with Vesopa Tap to Pay and card readers'),
          ],
          primary: state == _State.done ? 'Continue' : 'Add a card or wallet',
          busy: _busy == 'licence',
          onPrimary: _busy != null || !businessDone
              ? null
              : state == _State.done
                  ? () => setState(() => _page = 4)
                  : () => _go('licence', _licence),
        );
      default:
        final pinSet = s['owner_pin_set'] == true;
        return _StepPage(
          icon: Icons.pin_rounded,
          title: 'Your manager PIN',
          body: pinSet
              ? 'Set. Staff sign in with their own PIN; add them in the back office, Staff.'
              : complete
                  ? 'Choose the PIN you sign in to EPOS with. You become the venue\'s first manager.'
                  : 'Once the steps before are done or left for later, choose the PIN you sign in to EPOS with.',
          state: state,
          error: _error,
          primary: pinSet ? 'Finish' : 'Set my PIN',
          busy: false,
          onPrimary: _busy != null || !complete
              ? null
              : pinSet
                  ? () async {
                      await _load(refresh: true);
                      if (mounted) setState(() => _page = 5);
                    }
                  : () async {
                      await _ownerPin();
                      if (mounted) setState(() => _page = null);
                    },
          secondary: [
            if (!complete)
              TextButton(onPressed: () => setState(() => _page = _target(s)), child: const Text('Back to what is left')),
          ],
        );
    }
  }

  String _typeLabel(Map<String, dynamic>? s) {
    final id = (s?['business'] as Map?)?['type'];
    for (final b in (s?['business_types'] as List? ?? const [])) {
      if ((b as Map)['id'] == id) return b['label'] as String;
    }
    return '';
  }

  String _date(Object? iso) {
    final d = DateTime.tryParse('${iso ?? ''}')?.toLocal();
    if (d == null) return 'the trial ends';
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return '${d.day} ${months[d.month - 1]}';
  }
}

enum _State { todo, waiting, problem, skipped, done }

extension on _State {
  (IconData, Color, String) look(BuildContext context) => switch (this) {
        _State.done => (Icons.check_rounded, Tp.green, 'Done'),
        _State.waiting => (Icons.hourglass_top_rounded, Tp.amber, 'Being checked'),
        _State.problem => (Icons.priority_high_rounded, Tp.danger, 'Needs you'),
        _State.skipped => (Icons.schedule_rounded, Tp.amber, 'Left for later'),
        _State.todo => (Icons.circle_outlined, context.goMuted, 'To do'),
      };
}

/// -*-*-*-*-: one segment a step, filling as each is done, the current one
/// lit. A tap goes to that step.
class _Progress extends StatelessWidget {
  const _Progress({required this.states, required this.page, required this.onTap, required this.enabled});
  final List<_State> states;
  final int page;
  final ValueChanged<int> onTap;
  final bool Function(int) enabled;

  static const _names = ['Business', 'Identity', 'Checks', 'Trial', 'PIN'];

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final done = states.where((s) => s == _State.done).length;
    final wide = MediaQuery.sizeOf(context).width >= 520;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Row(children: [
        for (var i = 0; i < states.length; i++) ...[
          if (i > 0) const SizedBox(width: 6),
          Expanded(
            child: Semantics(
              button: true,
              label: 'Step ${i + 1}, ${_names[i]}: ${states[i].look(context).$3}',
              child: InkWell(
                borderRadius: BorderRadius.circular(8),
                onTap: enabled(i) ? () => onTap(i) : null,
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 10),
                  child: Column(children: [
                    AnimatedContainer(
                      duration: const Duration(milliseconds: 400),
                      curve: const Cubic(0.2, 0, 0, 1),
                      height: i == page ? 8 : 6,
                      decoration: BoxDecoration(
                        borderRadius: BorderRadius.circular(99),
                        color: switch (states[i]) {
                          _State.done => context.goLimeInk,
                          _State.waiting || _State.skipped => Tp.amber.withValues(alpha: 0.8),
                          _State.problem => Tp.danger,
                          _State.todo => i == page ? context.goLimeInk.withValues(alpha: 0.45) : context.goLine,
                        },
                      ),
                    ),
                    if (wide) ...[
                      const SizedBox(height: 6),
                      Text(_names[i],
                          style: t.labelSmall?.copyWith(
                            color: i == page ? context.goText : context.goMuted,
                            fontWeight: i == page ? FontWeight.w800 : FontWeight.w500,
                          )),
                    ],
                  ]),
                ),
              ),
            ),
          ),
        ],
      ]),
      Text('Step ${page + 1} of ${states.length} · $done done',
          textAlign: TextAlign.center, style: t.labelMedium?.copyWith(color: context.goMuted)),
    ]);
  }
}

/// One step: an illustration, what it is, what to do, one main button.
class _StepPage extends StatelessWidget {
  const _StepPage({
    required this.icon,
    required this.title,
    required this.body,
    required this.state,
    required this.primary,
    required this.busy,
    required this.onPrimary,
    this.secondary = const [],
    this.bullets,
    this.extra,
    this.top,
    this.error,
  });
  final IconData icon;
  final String title;
  final String body;
  final _State state;
  final String primary;
  final bool busy;
  final VoidCallback? onPrimary;
  final List<Widget> secondary;
  final List<(IconData, String)>? bullets;
  final Widget? extra;
  final Widget? top;
  final String? error;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final (badge, colour, label) = state.look(context);
    return ListView(padding: const EdgeInsets.fromLTRB(24, 12, 24, 28), children: [
      if (top != null) ...[top!, const SizedBox(height: 18)],
      Center(child: _Hero(icon: icon, badge: state == _State.todo ? null : badge, colour: colour)),
      const SizedBox(height: 22),
      Text(title, textAlign: TextAlign.center, style: t.headlineSmall?.copyWith(fontWeight: FontWeight.w800, letterSpacing: -0.2)),
      const SizedBox(height: 8),
      Center(
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
          decoration: BoxDecoration(color: colour.withValues(alpha: 0.14), borderRadius: BorderRadius.circular(99)),
          child: Text(label, style: t.labelLarge?.copyWith(color: state == _State.todo ? context.goMuted : colour, fontWeight: FontWeight.w700)),
        ),
      ),
      const SizedBox(height: 14),
      Text(body, textAlign: TextAlign.center, style: t.bodyLarge?.copyWith(color: context.goMuted, height: 1.4)),
      if (bullets != null) ...[
        const SizedBox(height: 20),
        for (final (i, words) in bullets!)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 6),
            child: Row(children: [
              Container(
                width: 40,
                height: 40,
                decoration: BoxDecoration(color: context.goLimeInk.withValues(alpha: 0.14), borderRadius: BorderRadius.circular(12)),
                child: Icon(i, color: context.goLimeInk, size: 22),
              ),
              const SizedBox(width: 14),
              Expanded(child: Text(words, style: t.bodyLarge)),
            ]),
          ),
      ],
      if (extra != null) ...[const SizedBox(height: 18), extra!],
      if (error != null) ...[
        const SizedBox(height: 16),
        Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(color: Tp.danger.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(14)),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            const Icon(Icons.error_outline_rounded, color: Tp.danger),
            const SizedBox(width: 10),
            Expanded(child: Text(error!, style: t.bodyMedium)),
          ]),
        ),
      ],
      const SizedBox(height: 26),
      SizedBox(
        height: 56,
        child: FilledButton(
          onPressed: busy ? null : onPrimary,
          child: busy
              ? const Row(mainAxisSize: MainAxisSize.min, children: [
                  SizedBox.square(dimension: 18, child: CircularProgressIndicator(strokeWidth: 2.4)),
                  SizedBox(width: 12),
                  Text('Waiting for the secure screen…'),
                ])
              : Text(primary, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
        ),
      ),
      for (final b in secondary) Padding(padding: const EdgeInsets.only(top: 6), child: b),
      const SizedBox(height: 18),
      Text('Your ID, selfie, bank and card details go straight to our regulated payments partner and are never stored by Vesopa or on this device.',
          textAlign: TextAlign.center, style: t.bodySmall?.copyWith(color: context.goMuted)),
    ]);
  }
}

/// The step's picture: its icon in a lit disc, with the state in the corner.
class _Hero extends StatelessWidget {
  const _Hero({required this.icon, required this.badge, required this.colour});
  final IconData icon;
  final IconData? badge;
  final Color colour;

  @override
  Widget build(BuildContext context) {
    final lime = context.goLimeInk;
    return TweenAnimationBuilder<double>(
      tween: Tween(begin: 0.85, end: 1),
      duration: MediaQuery.of(context).disableAnimations ? Duration.zero : const Duration(milliseconds: 600),
      curve: Curves.elasticOut,
      builder: (context, v, child) => Transform.scale(scale: v, child: child),
      child: SizedBox.square(
        dimension: 132,
        child: Stack(clipBehavior: Clip.none, children: [
          Container(
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              gradient: RadialGradient(colors: [lime.withValues(alpha: 0.38), lime.withValues(alpha: 0.06)]),
              border: Border.all(color: lime.withValues(alpha: 0.35), width: 1.5),
            ),
            child: Center(child: Icon(icon, size: 60, color: lime)),
          ),
          if (badge != null)
            Positioned(
              right: 2,
              bottom: 2,
              child: Container(
                width: 40,
                height: 40,
                decoration: BoxDecoration(color: colour, shape: BoxShape.circle, border: Border.all(color: context.goDeep, width: 4)),
                child: Icon(badge, size: 20, color: Colors.white),
              ),
            ),
        ]),
      ),
    );
  }
}

/// Where the venue stands: test, live with limits, or live.
class _ModeLine extends StatelessWidget {
  const _ModeLine({required this.mode, required this.limits});
  final String mode;
  final Map<String, dynamic>? limits;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final (icon, colour, words) = switch (mode) {
      'live' => (Icons.verified_rounded, Tp.green, 'Live: every check has passed.'),
      'capped' => (
          Icons.speed_rounded,
          Tp.amber,
          'Live, up to ${_pounds(limits?['per_payment_minor'] ?? 25000)} a payment and ${_pounds(limits?['per_day_minor'] ?? 100000)} a day until every check has passed.'
        ),
      _ => (Icons.science_rounded, Tp.blue, 'Test mode: card payments are pretend until your business is checked.'),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: BoxDecoration(color: colour.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(14)),
      child: Row(children: [
        Icon(icon, color: colour, size: 20),
        const SizedBox(width: 10),
        Expanded(child: Text(words, style: t.bodyMedium)),
      ]),
    );
  }
}

/// What the payments partner still wants, as a checklist (owner, 2026-11-18:
/// "show the steps or not done yet, checklist").
class _Checklist extends StatelessWidget {
  const _Checklist({required this.checklist});
  final Map<String, dynamic> checklist;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final rows = ((checklist['rows'] as List?) ?? const []).cast<Map>();
    final reviewing = (checklist['stripe_reviewing'] as num?)?.toInt() ?? 0;
    final other = (checklist['other_due'] as num?)?.toInt() ?? 0;
    return Container(
      padding: const EdgeInsets.fromLTRB(16, 10, 16, 10),
      decoration: BoxDecoration(color: context.goCard, borderRadius: BorderRadius.circular(18), border: Border.all(color: context.goLine)),
      child: Column(children: [
        for (final r in rows)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 8),
            child: Row(children: [
              AnimatedSwitcher(
                duration: const Duration(milliseconds: 300),
                child: Icon(
                  r['done'] == true ? Icons.check_circle_rounded : Icons.radio_button_unchecked_rounded,
                  key: ValueKey(r['done']),
                  color: r['done'] == true ? Tp.green : context.goMuted,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(child: Text('${r['label']}', style: t.bodyLarge)),
              if (r['done'] != true)
                Text((r['due'] as num? ?? 0) > 0 ? 'Needed' : 'Waiting', style: t.labelMedium?.copyWith(color: Tp.amber, fontWeight: FontWeight.w700)),
            ]),
          ),
        if (other > 0 || reviewing > 0)
          Padding(
            padding: const EdgeInsets.only(top: 6, bottom: 4),
            child: Text(
              [
                if (other > 0) '$other other item${other == 1 ? '' : 's'} to add.',
                if (reviewing > 0) 'Being reviewed: we\'ll tell you here when it is done.',
              ].join(' '),
              style: t.bodySmall?.copyWith(color: context.goMuted),
            ),
          ),
      ]),
    );
  }
}

/// Done: a burst of colour, what is open now, and in.
class _AllSet extends StatefulWidget {
  const _AllSet({required this.status, required this.onStart});
  final Map<String, dynamic> status;
  final Future<void> Function() onStart;
  @override
  State<_AllSet> createState() => _AllSetState();
}

class _AllSetState extends State<_AllSet> with SingleTickerProviderStateMixin {
  late final AnimationController _burst = AnimationController(vsync: this, duration: const Duration(milliseconds: 2600));
  bool _going = false;

  @override
  void initState() {
    super.initState();
    HapticFeedback.mediumImpact();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && !MediaQuery.of(context).disableAnimations) _burst.forward();
    });
  }

  @override
  void dispose() {
    _burst.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final s = widget.status;
    final pending = ((s['pending'] as List?) ?? const []).cast<String>();
    final licence = (s['licence'] as Map?)?.cast<String, dynamic>() ?? const {};
    final end = DateTime.tryParse('${licence['trial_end'] ?? ''}')?.toLocal();
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    Widget open(IconData i, String words) => Expanded(
          child: Container(
            padding: const EdgeInsets.symmetric(vertical: 16, horizontal: 8),
            decoration: BoxDecoration(color: context.goCard, borderRadius: BorderRadius.circular(18), border: Border.all(color: context.goLine)),
            child: Column(children: [
              Icon(i, color: context.goLimeInk, size: 30),
              const SizedBox(height: 8),
              Text(words, textAlign: TextAlign.center, style: t.labelLarge),
            ]),
          ),
        );
    return Stack(children: [
      ListView(padding: const EdgeInsets.fromLTRB(24, 24, 24, 28), children: [
        Center(
          child: TweenAnimationBuilder<double>(
            tween: Tween(begin: 0, end: 1),
            duration: MediaQuery.of(context).disableAnimations ? Duration.zero : const Duration(milliseconds: 900),
            curve: Curves.elasticOut,
            builder: (context, v, child) => Transform.scale(scale: v, child: child),
            child: Container(
              width: 128,
              height: 128,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: context.goLimeInk,
                boxShadow: [BoxShadow(color: context.goLimeInk.withValues(alpha: 0.45), blurRadius: 40, spreadRadius: 4)],
              ),
              child: Icon(Icons.check_rounded, size: 76, color: Tp.onLime),
            ),
          ),
        ),
        const SizedBox(height: 26),
        Text('You\'re all set!', textAlign: TextAlign.center, style: t.headlineMedium?.copyWith(fontWeight: FontWeight.w900)),
        const SizedBox(height: 10),
        Text(
          end == null
              ? 'Your venue is ready on Vesopa Go.'
              : 'Your 14 days free run until ${end.day} ${months[end.month - 1]}. We\'ve emailed you the details.',
          textAlign: TextAlign.center,
          style: t.bodyLarge?.copyWith(color: context.goMuted),
        ),
        const SizedBox(height: 24),
        Row(children: [
          open(Icons.point_of_sale_rounded, 'EPOS'),
          const SizedBox(width: 10),
          open(Icons.soup_kitchen_rounded, 'Kitchen'),
          const SizedBox(width: 10),
          open(Icons.cast_rounded, 'Display'),
          const SizedBox(width: 10),
          open(Icons.contactless_rounded, 'Card terminal'),
        ]),
        if (pending.isNotEmpty) ...[
          const SizedBox(height: 18),
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(color: Tp.amber.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(14)),
            child: Row(children: [
              const Icon(Icons.schedule_rounded, color: Tp.amber),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  'Still to finish: ${pending.map((p) => p == 'identity' ? 'your identity' : 'the business and bank checks').join(' and ')}. '
                  'Card payments stay limited until then; More, Account checks takes you back.',
                  style: t.bodyMedium,
                ),
              ),
            ]),
          ),
        ],
        const SizedBox(height: 28),
        SizedBox(
          height: 56,
          child: FilledButton.icon(
            onPressed: _going
                ? null
                : () async {
                    setState(() => _going = true);
                    await widget.onStart();
                    if (mounted) setState(() => _going = false);
                  },
            icon: const Icon(Icons.arrow_forward_rounded),
            label: const Text('Start using Vesopa Go', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
          ),
        ),
      ]),
      IgnorePointer(
        child: AnimatedBuilder(
          animation: _burst,
          builder: (context, _) => CustomPaint(size: Size.infinite, painter: _Confetti(_burst.value, context.goLimeInk)),
        ),
      ),
    ]);
  }
}

/// Confetti from the top, in the brand's lime, white and amber.
class _Confetti extends CustomPainter {
  _Confetti(this.t, this.lime);
  final double t;
  final Color lime;

  @override
  void paint(Canvas canvas, Size size) {
    if (t == 0 || t == 1) return;
    final colours = [lime, Colors.white, Tp.amber, lime.withValues(alpha: 0.6)];
    final paint = Paint();
    for (var i = 0; i < 70; i++) {
      final seed = (i * 7919) % 1000 / 1000;
      final seed2 = (i * 104729) % 1000 / 1000;
      final x = size.width * seed + 30 * math.sin((t * 6 + i) * 1.3);
      final y = -20 + (size.height + 40) * (t * (0.7 + seed2 * 0.6)) % (size.height + 40);
      paint.color = colours[i % colours.length].withValues(alpha: (1 - t).clamp(0, 1));
      canvas.save();
      canvas.translate(x, y);
      canvas.rotate(t * 12 + i);
      canvas.drawRRect(RRect.fromRectAndRadius(const Rect.fromLTWH(-4, -7, 8, 14), const Radius.circular(2)), paint);
      canvas.restore();
    }
  }

  @override
  bool shouldRepaint(_Confetti old) => old.t != t;
}

/// Step 1: the kind of business, its legal name, expected takings.
class _BusinessSheet extends ConsumerStatefulWidget {
  const _BusinessSheet({required this.status});
  final Map<String, dynamic> status;
  @override
  ConsumerState<_BusinessSheet> createState() => _BusinessSheetState();
}

class _BusinessSheetState extends ConsumerState<_BusinessSheet> {
  final _form = GlobalKey<FormState>();
  late String? _type = (widget.status['business'] as Map?)?['type'] as String?;
  late final _legal = TextEditingController(text: (widget.status['business'] as Map?)?['legal_name'] as String? ?? '');
  late final _monthly = TextEditingController(text: _poundsText((widget.status['business'] as Map?)?['expected_monthly_minor']));
  late final _average = TextEditingController(text: _poundsText((widget.status['business'] as Map?)?['average_sale_minor']));
  bool _busy = false;
  String? _error;

  static String _poundsText(Object? minor) => minor is num ? (minor / 100).toStringAsFixed(minor % 100 == 0 ? 0 : 2) : '';
  static int? _minor(String text) {
    final v = double.tryParse(text.replaceAll(RegExp(r'[£,\s]'), ''));
    return v == null ? null : (v * 100).round();
  }

  Future<void> _save() async {
    if (!_form.currentState!.validate()) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(apiProvider).saveBusiness(
            type: _type!,
            legalName: _legal.text.trim(),
            expectedMonthlyMinor: _minor(_monthly.text)!,
            averageSaleMinor: _minor(_average.text)!,
          );
      if (mounted) Navigator.of(context).pop(true);
    } on TapApiError catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final types = (widget.status['business_types'] as List? ?? const []).cast<Map>();
    final sole = _type == 'sole_trader';
    final money = [FilteringTextInputFormatter.allow(RegExp(r'[0-9.,£]'))];
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: Form(
        key: _form,
        child: ListView(shrinkWrap: true, padding: const EdgeInsets.all(24), children: [
          Text('Your business', style: t.titleLarge),
          const SizedBox(height: 16),
          RadioGroup<String>(
            groupValue: _type,
            onChanged: (v) => setState(() => _type = v),
            child: Column(children: [
              for (final b in types)
                RadioListTile<String>(
                  value: b['id'] as String,
                  title: Text(b['label'] as String),
                  contentPadding: EdgeInsets.zero,
                ),
            ]),
          ),
          if (_type == null) Text('Choose one', style: t.bodySmall?.copyWith(color: Tp.danger)),
          const SizedBox(height: 12),
          TextFormField(
            controller: _legal,
            textCapitalization: TextCapitalization.words,
            decoration: InputDecoration(
              labelText: sole ? 'Your full legal name' : 'Registered business name',
              helperText: sole ? 'As it is on your ID' : _type == 'non_profit' ? 'As registered (charity or club name)' : 'As on Companies House',
            ),
            validator: (v) => (v ?? '').trim().length < 2 ? 'Fill this in' : null,
          ),
          const SizedBox(height: 12),
          TextFormField(
            controller: _monthly,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            inputFormatters: money,
            decoration: const InputDecoration(labelText: 'Card takings you expect a month', prefixText: '£ '),
            validator: (v) => (_minor(v ?? '') ?? 0) < 100 ? 'Roughly how much a month, by card' : null,
          ),
          const SizedBox(height: 12),
          TextFormField(
            controller: _average,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            inputFormatters: money,
            decoration: const InputDecoration(labelText: 'Average sale', prefixText: '£ '),
            validator: (v) {
              final a = _minor(v ?? '') ?? 0;
              if (a < 50) return 'Roughly how much a customer spends';
              if (a > (_minor(_monthly.text) ?? 0)) return 'More than a month\'s takings?';
              return null;
            },
          ),
          const SizedBox(height: 16),
          if (_error != null) ...[Text(_error!, style: t.bodyMedium?.copyWith(color: Tp.danger)), const SizedBox(height: 12)],
          FilledButton(onPressed: _busy || _type == null ? null : _save, child: Text(_busy ? 'Saving…' : 'Save')),
        ]),
      ),
    );
  }
}


/// Step 5: the owner's name and manager PIN, typed twice.
class _OwnerPinSheet extends ConsumerStatefulWidget {
  const _OwnerPinSheet();
  @override
  ConsumerState<_OwnerPinSheet> createState() => _OwnerPinSheetState();
}

class _OwnerPinSheetState extends ConsumerState<_OwnerPinSheet> {
  final _form = GlobalKey<FormState>();
  final _name = TextEditingController();
  final _pin = TextEditingController();
  final _again = TextEditingController();
  bool _busy = false;
  String? _error;

  Future<void> _save() async {
    if (!_form.currentState!.validate()) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(apiProvider).setOwnerPin(name: _name.text.trim(), pin: _pin.text);
      if (mounted) Navigator.of(context).pop(true);
    } on TapApiError catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final digits = [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(6)];
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: Form(
        key: _form,
        child: ListView(shrinkWrap: true, padding: const EdgeInsets.all(24), children: [
          Text('Your manager PIN', style: t.titleLarge),
          const SizedBox(height: 6),
          Text('You sign in to EPOS with this. Keep it to yourself; give staff their own PINs in the back office.', style: t.bodyMedium),
          const SizedBox(height: 16),
          TextFormField(
            controller: _name,
            textCapitalization: TextCapitalization.words,
            decoration: const InputDecoration(labelText: 'Your name, as staff will see it'),
            validator: (v) => (v ?? '').trim().length < 2 ? 'Fill this in' : null,
          ),
          const SizedBox(height: 12),
          TextFormField(
            controller: _pin,
            obscureText: true,
            keyboardType: TextInputType.number,
            inputFormatters: digits,
            decoration: const InputDecoration(labelText: 'PIN (4 to 6 digits)'),
            validator: (v) {
              final p = v ?? '';
              if (!RegExp(r'^\d{4,6}$').hasMatch(p)) return '4 to 6 digits';
              if (RegExp(r'^(\d)\1+$').hasMatch(p) || '0123456789'.contains(p) || '9876543210'.contains(p)) {
                return 'Too easy to guess';
              }
              return null;
            },
          ),
          const SizedBox(height: 12),
          TextFormField(
            controller: _again,
            obscureText: true,
            keyboardType: TextInputType.number,
            inputFormatters: digits,
            decoration: const InputDecoration(labelText: 'The same PIN again'),
            validator: (v) => v != _pin.text ? 'The two PINs are different' : null,
          ),
          const SizedBox(height: 16),
          if (_error != null) ...[Text(_error!, style: t.bodyMedium?.copyWith(color: Tp.danger)), const SizedBox(height: 12)],
          FilledButton(onPressed: _busy ? null : _save, child: Text(_busy ? 'Saving…' : 'Set my PIN')),
        ]),
      ),
    );
  }
}
