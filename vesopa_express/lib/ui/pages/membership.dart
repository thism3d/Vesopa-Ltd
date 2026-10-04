/// Memberships: renew one, or join.
///
/// Offered only where the server says the venue has Memberships (see
/// KioskConfig.memberships), from the first question's third answer. One page
/// with its own small steps, because none of them is worth surviving a restart:
/// until Pay is pressed nothing has happened, and once it is pressed the order
/// is an ordinary kiosk order that the payment and thank-you screens -- and the
/// restart logic in OrderFlow -- already look after.
///
/// THE SERVER DECIDES WHAT IT COSTS. The kiosk sends "renew this member" or
/// "join this plan, as this person"; the price on the Pay button is the one the
/// server quoted, and the one on the card machine is the one the server
/// charges.
///
/// A SCREEN IN A PUBLIC ROOM. Finding a member shows a first name, a plan, a
/// state, a date and a price -- the server sends nothing more -- and nothing
/// typed here outlives the page.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/api.dart';
import '../../data/basket.dart';
import '../../data/models.dart';
import '../../data/order_flow.dart';
import '../../data/session.dart';
import '../theme.dart';
import '../widgets/common.dart';
import 'ordering.dart';

enum _Step { choose, findCard, findContact, confirm, plans, details }

/// Which of the join form's fields the keyboard is typing into.
enum _Field { name, email, phone, contact, surname }

class MembershipPage extends ConsumerStatefulWidget {
  const MembershipPage({super.key});

  @override
  ConsumerState<MembershipPage> createState() => _MembershipPageState();
}

class _MembershipPageState extends ConsumerState<MembershipPage> {
  _Step _step = _Step.choose;
  bool _loading = false;
  String? _error;

  // Renewing.
  String _card = '';
  String _contact = '';
  String _surname = '';
  MemberFound? _member;

  // Joining.
  List<MembershipPlan>? _plans;
  MembershipPlan? _plan;
  String _name = '';
  String _email = '';
  String _phone = '';

  _Field _field = _Field.name;

  final _scanner = FocusNode(debugLabel: 'card scanner');

  ExpressApi get _api => ref.read(apiProvider);

  @override
  void dispose() {
    _scanner.dispose();
    super.dispose();
  }

  void _go(_Step step, {_Field? field}) {
    ref.read(orderFlowProvider.notifier).clearError();
    setState(() {
      _step = step;
      _error = null;
      if (field != null) _field = field;
    });
    if (step == _Step.findCard) _scanner.requestFocus();
  }

  void _back() {
    switch (_step) {
      case _Step.choose:
        ref.read(orderFlowProvider.notifier).leaveMembership();
      case _Step.findCard || _Step.plans:
        _go(_Step.choose);
      case _Step.findContact:
        _go(_Step.findCard);
      case _Step.confirm:
        _go(_Step.findCard);
      case _Step.details:
        _go(_Step.plans);
    }
  }

  String _message(Object e) {
    final s = ref.read(orderFlowProvider).s;
    if (e is ExpressApiError && !e.offline) return e.message;
    return s('error_generic');
  }

  Future<void> _find({bool byCard = true}) async {
    if (_loading) return;
    final contact = _contact.trim();
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final found = byCard
          ? await _api.findMember(cardNumber: _card)
          : await _api.findMember(
              email: contact.contains('@') ? contact.toLowerCase() : null,
              phone: contact.contains('@') ? null : contact,
              surname: _surname.trim(),
            );
      if (!mounted) return;
      setState(() {
        _member = found;
        _loading = false;
      });
      _go(_Step.confirm);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = _message(e);
      });
      if (e is ExpressApiError && e.status == 404 && e.code != 'member_not_found') {
        // Memberships were switched off under us: the config says so now.
        await ref.read(kioskSessionProvider.notifier).refresh(withMenu: false);
      }
    }
  }

  Future<void> _loadPlans() async {
    _go(_Step.plans);
    if (_plans != null) return;
    setState(() => _loading = true);
    try {
      final plans = await _api.membershipPlans();
      if (mounted) setState(() => _plans = plans);
    } catch (e) {
      if (mounted) setState(() => _error = _message(e));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  // ---- Typing ---------------------------------------------------------------

  String _valueOf(_Field f) => switch (f) {
    _Field.name => _name,
    _Field.email => _email,
    _Field.phone => _phone,
    _Field.contact => _contact,
    _Field.surname => _surname,
  };

  void _set(_Field f, String v) => setState(() {
    switch (f) {
      case _Field.name:
        _name = v;
      case _Field.email:
        _email = v;
      case _Field.phone:
        _phone = v;
      case _Field.contact:
        _contact = v;
      case _Field.surname:
        _surname = v;
    }
    _error = null;
  });

  void _type(String k) {
    final now = _valueOf(_field);
    if (now.length >= 80) return;
    var next = now + k;
    if (_field == _Field.name || _field == _Field.surname) {
      // Capital at the start of each word, as the name page does.
      next = next
          .split(' ')
          .map((w) => w.isEmpty ? w : w[0].toUpperCase() + w.substring(1).toLowerCase())
          .join(' ')
          .trimLeft();
    } else {
      next = next.toLowerCase().replaceAll(' ', '');
    }
    _set(_field, next);
  }

  void _backspace() {
    final now = _valueOf(_field);
    if (now.isNotEmpty) _set(_field, now.substring(0, now.length - 1));
  }

  /// A card reader or barcode scanner types the number and presses Enter.
  KeyEventResult _scanned(FocusNode node, KeyEvent e) {
    if (e is! KeyDownEvent || _step != _Step.findCard) return KeyEventResult.ignored;
    if (e.logicalKey == LogicalKeyboardKey.enter || e.logicalKey == LogicalKeyboardKey.numpadEnter) {
      if (_card.isNotEmpty) _find();
      return KeyEventResult.handled;
    }
    if (e.logicalKey == LogicalKeyboardKey.backspace) {
      if (_card.isNotEmpty) setState(() => _card = _card.substring(0, _card.length - 1));
      return KeyEventResult.handled;
    }
    final ch = e.character ?? '';
    if (RegExp(r'^\d$').hasMatch(ch) && _card.length < 32) {
      setState(() {
        _card += ch;
        _error = null;
      });
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  // ---- Paying ----------------------------------------------------------------

  Future<void> _payRenewal() async {
    final m = _member;
    if (m == null || !m.canRenew) return;
    await ref.read(orderFlowProvider.notifier).placeMembership(kind: 'renew', memberToken: m.token);
  }

  bool get _detailsOk =>
      _name.trim().split(RegExp(r'\s+')).where((w) => w.isNotEmpty).length >= 2 &&
      RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+$').hasMatch(_email) &&
      _phone.replaceAll(RegExp(r'\D'), '').length >= 7;

  Future<void> _payJoin() async {
    final plan = _plan;
    if (plan == null || !_detailsOk) return;
    await ref.read(orderFlowProvider.notifier).placeMembership(
      kind: 'join',
      schemeId: plan.id,
      name: _name.trim(),
      email: _email.trim(),
      phone: _phone.trim(),
    );
  }

  // ---- Drawing ---------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    final flow = ref.watch(orderFlowProvider);
    final s = flow.s;
    final error = _error ?? flow.error;

    final body = switch (_step) {
      _Step.choose => _choose(context),
      _Step.findCard => _findCard(context),
      _Step.findContact => _findContact(context),
      _Step.confirm => _confirm(context),
      _Step.plans => _planList(context),
      _Step.details => _details(context),
    };

    return FlowScaffold(
      body: Focus(
        focusNode: _scanner,
        autofocus: true,
        onKeyEvent: _scanned,
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(28),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 900),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  body,
                  if (error != null) ...[
                    const SizedBox(height: 16),
                    Text(error,
                        key: const ValueKey('membership-error'),
                        textAlign: TextAlign.center,
                        style: const TextStyle(color: Xp.danger, fontWeight: FontWeight.w700, fontSize: 17)),
                  ],
                  const SizedBox(height: 24),
                  Align(
                    alignment: Alignment.centerLeft,
                    child: OutlinedButton(onPressed: flow.busy ? null : _back, child: Text(s('back'))),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _title(BuildContext context, String text, [String? sub]) => Column(
    children: [
      Text(text, textAlign: TextAlign.center, style: Theme.of(context).textTheme.displayMedium),
      if (sub != null) ...[
        const SizedBox(height: 10),
        Text(sub,
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.titleMedium?.copyWith(color: XpSkin.of(context).muted)),
      ],
      const SizedBox(height: 28),
    ],
  );

  Widget _choose(BuildContext context) {
    final s = ref.read(orderFlowProvider).s;
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        _title(context, s('memberships')),
        Flex(
          direction: MediaQuery.sizeOf(context).width < 720 ? Axis.vertical : Axis.horizontal,
          mainAxisSize: MainAxisSize.min,
          children: [
            BigChoice(
              key: const ValueKey('membership-renew'),
              icon: Icons.autorenew_rounded,
              label: s('renew_membership'),
              sub: s('renew_membership_sub'),
              onTap: () => _go(_Step.findCard),
            ),
            const SizedBox(width: 28, height: 18),
            BigChoice(
              key: const ValueKey('membership-join'),
              icon: Icons.person_add_alt_1_rounded,
              label: s('join_membership'),
              sub: s('join_membership_sub'),
              onTap: _loadPlans,
            ),
          ],
        ),
      ],
    );
  }

  Widget _box(BuildContext context, String value, String hint, {bool active = true, VoidCallback? onTap, Key? key}) {
    final skin = XpSkin.of(context);
    return GestureDetector(
      key: key,
      onTap: onTap,
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 16),
        decoration: BoxDecoration(
          color: skin.card,
          borderRadius: BorderRadius.circular(Xp.radius),
          border: Border.all(color: active ? Xp.lime : skin.line, width: active ? 3 : 2),
        ),
        child: Text(
          value.isEmpty ? hint : value,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(
            fontSize: 30,
            fontWeight: FontWeight.w800,
            color: value.isEmpty ? skin.muted : skin.ink,
          ),
        ),
      ),
    );
  }

  Widget _busyOr(Widget child) => _loading
      ? const Padding(padding: EdgeInsets.all(30), child: CircularProgressIndicator())
      : child;

  Widget _findCard(BuildContext context) {
    final s = ref.read(orderFlowProvider).s;
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        _title(context, s('scan_card'), s('scan_card_sub')),
        _box(context, _card, s('card_number'), key: const ValueKey('membership-card')),
        const SizedBox(height: 20),
        _busyOr(DigitPad(
          okLabel: s('find'),
          onDigit: (d) {
            if (_card.length >= 32) return;
            setState(() {
              _card += d;
              _error = null;
            });
          },
          onBack: () {
            if (_card.isNotEmpty) setState(() => _card = _card.substring(0, _card.length - 1));
          },
          onOk: _card.isEmpty ? null : () => _find(),
        )),
        const SizedBox(height: 16),
        TextButton(
          key: const ValueKey('membership-by-contact'),
          onPressed: () => _go(_Step.findContact, field: _Field.contact),
          child: Text(s('find_by_contact'), style: const TextStyle(fontSize: 18)),
        ),
      ],
    );
  }

  Widget _findContact(BuildContext context) {
    final s = ref.read(orderFlowProvider).s;
    final ready = _contact.trim().length >= 5 && _surname.trim().length >= 2;
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        _title(context, s('find_membership'), s('find_membership_sub')),
        _box(context, _contact, s('email_or_phone'),
            active: _field == _Field.contact, onTap: () => setState(() => _field = _Field.contact)),
        const SizedBox(height: 12),
        _box(context, _surname, s('surname'),
            active: _field == _Field.surname, onTap: () => setState(() => _field = _Field.surname)),
        const SizedBox(height: 18),
        LetterBoard(
          extraRows: _field == _Field.surname ? const [] : const ['1234567890', '@._-+'],
          onKey: _type,
          onBack: _backspace,
        ),
        const SizedBox(height: 18),
        _busyOr(SizedBox(
          width: double.infinity,
          child: FilledButton(
            onPressed: ready ? () => _find(byCard: false) : null,
            child: Text(s('find')),
          ),
        )),
        TextButton(
          onPressed: () => _go(_Step.findCard),
          child: Text(s('find_by_card'), style: const TextStyle(fontSize: 18)),
        ),
      ],
    );
  }

  Widget _confirm(BuildContext context) {
    final flow = ref.read(orderFlowProvider);
    final s = flow.s;
    final m = _member;
    if (m == null) return const SizedBox.shrink();
    final skin = XpSkin.of(context);
    final text = Theme.of(context).textTheme;
    final date = readableDate(m.expiry);
    final when = m.expiry == null
        ? null
        : (m.state == 'expired' ? s('member_ran_out') : s('member_runs_to')).replaceAll('{date}', date);
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        _title(context, s('hello_name').replaceAll('{name}', m.firstName ?? '')),
        Container(
          key: const ValueKey('membership-found'),
          width: double.infinity,
          padding: const EdgeInsets.all(26),
          decoration: BoxDecoration(
            color: skin.card,
            borderRadius: BorderRadius.circular(Xp.radius),
            border: Border.all(color: skin.line, width: 2),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(children: [
                Expanded(child: Text(m.planName ?? s('memberships'), style: text.headlineMedium)),
                Pill(s('member_state_${m.state}'),
                    color: m.state == 'active' ? Xp.lime : Xp.amber, textColor: Xp.ink),
              ]),
              if (when != null) ...[
                const SizedBox(height: 10),
                Text(when, style: text.titleLarge?.copyWith(color: skin.inkSoft)),
              ],
            ],
          ),
        ),
        const SizedBox(height: 24),
        if (m.canRenew && m.renewMinor != null)
          SizedBox(
            width: double.infinity,
            child: FilledButton(
              key: const ValueKey('membership-pay-renew'),
              onPressed: flow.busy ? null : _payRenewal,
              child: flow.busy
                  ? const SizedBox(width: 26, height: 26, child: CircularProgressIndicator(strokeWidth: 3))
                  : Text(s('renew_for').replaceAll('{price}', money(m.renewMinor!))),
            ),
          )
        else
          Text(m.reason ?? s('error_generic'),
              textAlign: TextAlign.center,
              style: text.titleMedium?.copyWith(fontWeight: FontWeight.w700)),
      ],
    );
  }

  Widget _planList(BuildContext context) {
    final s = ref.read(orderFlowProvider).s;
    final skin = XpSkin.of(context);
    final text = Theme.of(context).textTheme;
    final plans = _plans;
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        _title(context, s('choose_plan')),
        if (_loading || plans == null)
          _busyOr(const SizedBox.shrink())
        else if (plans.isEmpty)
          Text(s('no_plans'), textAlign: TextAlign.center, style: text.titleMedium)
        else
          for (final p in plans)
            Padding(
              padding: const EdgeInsets.only(bottom: 14),
              child: Material(
                color: skin.card,
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(Xp.radius),
                  side: BorderSide(color: skin.line, width: 2),
                ),
                child: InkWell(
                  key: ValueKey('membership-plan-${p.id}'),
                  borderRadius: BorderRadius.circular(Xp.radius),
                  onTap: () {
                    setState(() => _plan = p);
                    _go(_Step.details, field: _Field.name);
                  },
                  child: Padding(
                    padding: const EdgeInsets.all(22),
                    child: Row(
                      children: [
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(p.name, style: text.headlineSmall),
                              if (p.description != null) ...[
                                const SizedBox(height: 4),
                                Text(p.description!, style: text.bodyMedium?.copyWith(color: skin.muted)),
                              ],
                              const SizedBox(height: 6),
                              Text(_then(p), style: text.bodyMedium?.copyWith(color: skin.inkSoft)),
                              if (p.joiningFeeMinor > 0)
                                Text(s('includes_joining').replaceAll('{price}', money(p.joiningFeeMinor)),
                                    style: text.bodyMedium?.copyWith(color: skin.muted)),
                            ],
                          ),
                        ),
                        const SizedBox(width: 16),
                        Column(
                          crossAxisAlignment: CrossAxisAlignment.end,
                          children: [
                            Text(money(p.joinMinor),
                                style: const TextStyle(
                                    fontFamily: Xp.numerals, fontSize: 30, fontWeight: FontWeight.w800)),
                            Text(s('today'), style: text.bodyMedium?.copyWith(color: skin.muted)),
                          ],
                        ),
                        Icon(Icons.chevron_right_rounded, size: 34, color: skin.muted),
                      ],
                    ),
                  ),
                ),
              ),
            ),
      ],
    );
  }

  String _then(MembershipPlan p) {
    final s = ref.read(orderFlowProvider).s;
    final key = p.termMonths == 1 ? 'plan_then_month' : p.termMonths == 12 ? 'plan_then_year' : 'plan_then_months';
    return s(key).replaceAll('{price}', money(p.feeMinor)).replaceAll('{n}', '${p.termMonths}');
  }

  Widget _details(BuildContext context) {
    final flow = ref.read(orderFlowProvider);
    final s = flow.s;
    final plan = _plan;
    if (plan == null) return const SizedBox.shrink();
    Widget field(_Field f, String value, String hint) => Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: _box(context, value, hint,
          key: ValueKey('membership-field-${f.name}'),
          active: _field == f,
          onTap: () => setState(() => _field = f)),
    );
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        _title(context, s('your_details'), plan.name),
        field(_Field.name, _name, s('full_name')),
        field(_Field.email, _email, s('email')),
        field(_Field.phone, _phone, s('phone')),
        const SizedBox(height: 8),
        if (_field == _Field.phone)
          DigitPad(
            okLabel: s('next'),
            onDigit: _type,
            onBack: _backspace,
            onOk: () => setState(() => _field = _Field.name),
          )
        else
          LetterBoard(
            extraRows: _field == _Field.email ? const ['1234567890', '@._-+'] : const [],
            onKey: _type,
            onBack: _backspace,
          ),
        const SizedBox(height: 18),
        SizedBox(
          width: double.infinity,
          child: FilledButton(
            key: const ValueKey('membership-pay-join'),
            onPressed: _detailsOk && !flow.busy ? _payJoin : null,
            child: flow.busy
                ? const SizedBox(width: 26, height: 26, child: CircularProgressIndicator(strokeWidth: 3))
                : Text(s('join_for').replaceAll('{price}', money(plan.joinMinor))),
          ),
        ),
      ],
    );
  }
}
