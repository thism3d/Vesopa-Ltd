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

class OnboardingPage extends ConsumerStatefulWidget {
  const OnboardingPage({super.key, this.justRegistered = false});

  /// Straight after registering: says so, and offers to finish later.
  final bool justRegistered;

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
    final s = await _api.identitySession();
    final r = await StripeOnboarding.verifyIdentity(
      sessionId: s['id'] as String,
      ephemeralKeySecret: s['ephemeral_key_secret'] as String,
      publishableKey: s['publishable_key'] as String? ?? '',
    );
    if (r.end == StripeFlowEnd.failed) return r.message ?? 'Stripe could not check your ID. Try again.';
    return null;
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
    if (r.end == StripeFlowEnd.failed) return r.message ?? 'Stripe\'s checks could not open. Try again.';
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

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final s = _status;
    final steps = (s?['steps'] as Map?)?.cast<String, dynamic>() ?? const {};
    final next = s?['next'] as String?;
    final mode = s?['mode'] as String? ?? 'test';
    final limits = (s?['limits'] as Map?)?.cast<String, dynamic>();
    final licence = (s?['licence'] as Map?)?.cast<String, dynamic>() ?? const {};
    final identity = steps['identity'] as String? ?? 'not_started';
    final stripe = steps['stripe'] as String? ?? 'not_started';
    final businessDone = steps['business'] == true;

    return Scaffold(
      appBar: AppBar(title: const Text('Account checks')),
      body: s == null && _error == null
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: () => _load(refresh: true),
              child: ListView(padding: const EdgeInsets.all(16), children: [
                if (widget.justRegistered) ...[
                  Text('Your venue is ready to use.', style: t.titleLarge),
                  const SizedBox(height: 6),
                  Text('To take real card payments, Stripe, who process them, and Vesopa need to check who you are '
                      'and your business. It takes a few minutes; you can stop and finish later from More.', style: t.bodyMedium),
                  const SizedBox(height: 16),
                ],
                _ModeCard(mode: mode, limits: limits),
                const SizedBox(height: 16),
                if (_error != null) ...[
                  Text(_error!, style: t.bodyMedium?.copyWith(color: Tp.danger)),
                  const SizedBox(height: 12),
                ],
                _StepCard(
                  number: 1,
                  title: 'Your business',
                  detail: businessDone
                      ? '${_typeLabel(s)} · ${(s?['business'] as Map?)?['legal_name'] ?? ''}'
                      : 'What kind of business it is, its legal name, and the card takings you expect.',
                  state: businessDone ? _State.done : _State.todo,
                  current: next == 'business',
                  action: businessDone ? 'Change' : 'Start',
                  busy: false,
                  onPressed: _busy == null && stripe == 'not_started' ? _business : null,
                ),
                _StepCard(
                  number: 2,
                  title: 'Your identity',
                  detail: switch (identity) {
                    'verified' => 'Verified by Stripe.',
                    'processing' => 'Stripe is checking your ID. This usually takes a minute or two.',
                    'requires_input' when s?['identity_error'] != null => s!['identity_error'] as String,
                    _ => 'A photo of your passport, driving licence or ID card, and a live selfie. Have it with you.',
                  },
                  state: identity == 'verified'
                      ? _State.done
                      : identity == 'processing'
                          ? _State.waiting
                          : s?['identity_error'] != null
                              ? _State.problem
                              : _State.todo,
                  current: next == 'identity',
                  action: identity == 'requires_input' && s?['identity_error'] != null ? 'Try again' : 'Verify my identity',
                  busy: _busy == 'identity',
                  onPressed: _busy == null && businessDone && identity != 'verified' && identity != 'processing'
                      ? () => _step('identity', _identity)
                      : null,
                ),
                _StepCard(
                  number: 3,
                  title: 'Business and bank checks',
                  detail: switch (stripe) {
                    'complete' => 'Stripe has checked the business and the bank account it pays into.',
                    'in_review' => 'Stripe is reviewing what you sent. We\'ll tell you here if they need anything.',
                    'more_needed' => 'Stripe needs a little more information before every limit comes off.',
                    _ => 'Stripe checks the business, its directors and owners, and the bank account your takings are paid into.',
                  },
                  state: stripe == 'complete'
                      ? _State.done
                      : stripe == 'in_review' && (s?['requirements_due'] ?? 0) == 0
                          ? _State.waiting
                          : stripe == 'more_needed'
                              ? _State.problem
                              : _State.todo,
                  current: next == 'stripe',
                  action: stripe == 'not_started' ? 'Start' : 'Continue',
                  busy: _busy == 'stripe',
                  onPressed: _busy == null && businessDone && stripe != 'complete' ? () => _step('stripe', _stripe) : null,
                ),
                _StepCard(
                  number: 4,
                  title: 'Your Vesopa licence',
                  detail: switch (licence['status']) {
                    'trialing' => 'Free until ${_date(licence['trial_end'])}, then ${_pounds(licence['amount_minor'] ?? 2900)} a month. Cancel any time.',
                    'active' => '${_pounds(licence['amount_minor'] ?? 2900)} a month.',
                    'past_due' || 'unpaid' => 'The last payment did not go through. Add another card.',
                    _ => '${licence['trial_days'] ?? 14} days free, then ${_pounds(licence['amount_minor'] ?? 2900)} a month. '
                        'Add a card now; nothing is taken until the free days end.',
                  },
                  state: licence['status'] == 'trialing' || licence['status'] == 'active'
                      ? _State.done
                      : licence['status'] == 'past_due' || licence['status'] == 'unpaid'
                          ? _State.problem
                          : _State.todo,
                  current: next == 'licence',
                  action: 'Add a card',
                  busy: _busy == 'licence',
                  onPressed: _busy == null && businessDone && licence['status'] != 'trialing' && licence['status'] != 'active'
                      ? () => _step('licence', _licence)
                      : null,
                ),
                const SizedBox(height: 8),
                Text('Your ID, selfie and card details go straight to Stripe and are never stored by Vesopa or on this phone.',
                    style: t.bodySmall?.copyWith(color: Tp.muted)),
                if (widget.justRegistered) ...[
                  const SizedBox(height: 16),
                  TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Finish later')),
                ],
              ]),
            ),
    );
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

enum _State { todo, waiting, problem, done }

class _ModeCard extends StatelessWidget {
  const _ModeCard({required this.mode, required this.limits});
  final String mode;
  final Map<String, dynamic>? limits;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final (icon, colour, title, body) = switch (mode) {
      'live' => (Icons.verified_rounded, Tp.green, 'Live', 'Every check has passed. Card payments have no Vesopa limits.'),
      'capped' => (
          Icons.speed_rounded,
          Tp.amber,
          'Live, with limits',
          'Up to ${_pounds(limits?['per_payment_minor'] ?? 25000)} a payment and ${_pounds(limits?['per_day_minor'] ?? 100000)} '
              'a day until every check below has passed.'
        ),
      _ => (
          Icons.science_rounded,
          Tp.blue,
          'Test mode',
          'Everything works, but card payments are pretend until Stripe has checked your business.'
        ),
    };
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Icon(icon, color: colour, size: 28),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(title, style: t.titleMedium),
              const SizedBox(height: 4),
              Text(body, style: t.bodyMedium),
            ]),
          ),
        ]),
      ),
    );
  }
}

class _StepCard extends StatelessWidget {
  const _StepCard({
    required this.number,
    required this.title,
    required this.detail,
    required this.state,
    required this.current,
    required this.action,
    required this.busy,
    required this.onPressed,
  });
  final int number;
  final String title;
  final String detail;
  final _State state;
  final bool current;
  final String action;
  final bool busy;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final (icon, colour, label) = switch (state) {
      _State.done => (Icons.check_circle_rounded, Tp.green, 'Done'),
      _State.waiting => (Icons.hourglass_top_rounded, Tp.amber, 'Being checked'),
      _State.problem => (Icons.error_rounded, Tp.danger, 'Needs you'),
      _State.todo => (Icons.radio_button_unchecked_rounded, Tp.muted, 'To do'),
    };
    return Card(
      shape: current
          ? RoundedRectangleBorder(borderRadius: BorderRadius.circular(Tp.radius), side: const BorderSide(color: Tp.brandLime, width: 2))
          : null,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Icon(icon, color: colour),
            const SizedBox(width: 10),
            Expanded(child: Text('$number. $title', style: t.titleMedium)),
            Text(label, style: t.labelMedium?.copyWith(color: colour)),
          ]),
          const SizedBox(height: 8),
          Text(detail, style: t.bodyMedium),
          if (state != _State.done || action == 'Change') ...[
            const SizedBox(height: 12),
            Align(
              alignment: Alignment.centerRight,
              child: current
                  ? FilledButton(onPressed: busy ? null : onPressed, child: Text(busy ? 'Opening…' : action))
                  : OutlinedButton(onPressed: busy ? null : onPressed, child: Text(busy ? 'Opening…' : action)),
            ),
          ],
        ]),
      ),
    );
  }
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
