/// Members: the front desk of a venue running the Memberships module.
///
/// Find a member, see where their membership stands, and do the six things a
/// front desk does with one — join, renew, freeze, unfreeze, cancel, and
/// reinstate or approve. And a second tab for today's classes: who is booked,
/// and checking people in as they arrive.
///
/// WHERE THE MONEY GOES
///
/// Joining and renewing cost money, and money at this till is a line on the
/// bill. So Join and Renew do not post anything: they put the fee on the bill
/// in front of the clerk, attach the member, and go to the Sale screen. The
/// join or renewal is posted from the settle path once the bill is paid —
/// exactly where the old swipe-and-renew has always posted it, for the reasons
/// written at the top of data/membership.dart. A voided bill leaves no member
/// behind.
///
/// Only a plan that costs nothing is posted at once, because there is no money
/// to wait for. The same for a family member, whose payer pays.
///
/// Everything else here — freezing, cancelling, approving, booking a class —
/// moves no money and goes straight to the back office, and is said out loud
/// when it cannot.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../data/commerce.dart' show LoyaltyCustomer;
import '../data/customer_repository.dart';
import '../data/local/database.dart';
import '../data/membership.dart';
import '../data/memberships_api.dart';
import '../data/swipe_cards.dart';
import '../data/till_permissions.dart';
import '../data/training_mode.dart';
import '../main.dart';
import 'customer_picker.dart';
import 'membership_gate.dart';
import 'membership_prompt.dart';
import 'permission_gate.dart';
import '../data/price_level_controller.dart';
import 'sale_page.dart' show productsProvider;
import 'theme.dart';
import 'widgets/pos_message.dart';
import 'widgets/pos_text_field.dart';

String _money(int minor) => '£${(minor / 100).toStringAsFixed(2)}';

String _date(DateTime? d) => d == null ? '—' : DateFormat('d MMM yyyy').format(d);

String _time(DateTime? d) => d == null ? '' : DateFormat('HH:mm').format(d);

Color _stateColour(MemberState s) => switch (s) {
  MemberState.active => Pos.green,
  MemberState.pending => Pos.amber,
  MemberState.frozen => Pos.blue,
  MemberState.expired => Pos.red,
  MemberState.cancelled => Pos.graphite,
  MemberState.none => Pos.graphite,
};

/// A card the class sheet is waiting for, taken before anything else in
/// `handleSwipedCard` looks at it — the same arrangement as the staff sheet's
/// StaffCardCapture, so a member swiping in for a class is not attached to a
/// bill or greeted at the gym door instead.
class MemberCardCapture {
  MemberCardCapture._();

  static Completer<SwipedCard?>? _waiting;

  static bool get isWaiting => _waiting != null;

  /// Offer a card to whatever is waiting. True when it was taken.
  static bool offer(SwipedCard card) {
    final waiting = _waiting;
    if (waiting == null || waiting.isCompleted) return false;
    _waiting = null;
    waiting.complete(card);
    return true;
  }

  /// The next card read, or null when [stop] is called first.
  static Future<SwipedCard?> next() {
    _waiting?.complete(null);
    final completer = Completer<SwipedCard?>();
    _waiting = completer;
    return completer.future;
  }

  static void stop() {
    final waiting = _waiting;
    _waiting = null;
    if (waiting != null && !waiting.isCompleted) waiting.complete(null);
  }
}

/// Practice changes nothing real. A trainee freezing a real member's
/// membership is exactly the mistake training mode exists to prevent.
bool _refusedInTraining(BuildContext context, WidgetRef ref) {
  if (!ref.read(trainingModeProvider)) return false;
  PosMessenger.error(
    context,
    'Not in training mode. This changes a real membership, so practice '
    'cannot do it.',
  );
  return true;
}

class MembershipsPage extends ConsumerStatefulWidget {
  const MembershipsPage({
    super.key,
    required this.orderId,
    required this.onGoToSale,
  });

  /// The bill in front of the clerk. A join or renewal puts its fee here.
  final String orderId;

  /// Back to the Sale screen, to take the money.
  final VoidCallback onGoToSale;

  @override
  ConsumerState<MembershipsPage> createState() => _MembershipsPageState();
}

class _MembershipsPageState extends ConsumerState<MembershipsPage> {
  @override
  Widget build(BuildContext context) {
    ref.watch(tillModulesRevisionProvider);
    if (!ref.watch(tillModulesProvider).memberships) {
      return const _ModuleOff();
    }
    return DefaultTabController(
      length: 2,
      child: Column(
        children: [
          const Material(
            child: TabBar(
              tabs: [
                Tab(icon: Icon(Icons.card_membership), text: 'Members'),
                Tab(icon: Icon(Icons.event), text: 'Classes today'),
              ],
            ),
          ),
          Expanded(
            child: TabBarView(
              children: [
                _MembersTab(
                  orderId: widget.orderId,
                  onGoToSale: widget.onGoToSale,
                ),
                _ClassesTab(orderId: widget.orderId),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _ModuleOff extends StatelessWidget {
  const _ModuleOff();

  @override
  Widget build(BuildContext context) => const Center(
    child: Padding(
      padding: EdgeInsets.all(40),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.card_membership, size: 56, color: Pos.graphite),
          SizedBox(height: 16),
          Text(
            'Memberships are switched off',
            style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700),
          ),
          SizedBox(height: 8),
          Text(
            'A manager switches the Memberships module on in the back office '
            'under Modules. This page appears on every till in the venue when '
            'they do.',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 13.5, color: Pos.graphite),
          ),
        ],
      ),
    ),
  );
}

// -----------------------------------------------------------------------------
// Members
// -----------------------------------------------------------------------------

class _MembersTab extends ConsumerStatefulWidget {
  const _MembersTab({required this.orderId, required this.onGoToSale});

  final String orderId;
  final VoidCallback onGoToSale;

  @override
  ConsumerState<_MembersTab> createState() => _MembersTabState();
}

class _MembersTabState extends ConsumerState<_MembersTab> {
  final _search = TextEditingController();
  Timer? _debounce;
  List<Member>? _members;
  String? _error;
  bool _loading = false;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _search.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    try {
      final list = await ref
          .read(membershipsRepositoryProvider)
          .search(_search.text);
      if (!mounted) return;
      setState(() {
        _members = list;
        _error = null;
        _loading = false;
      });
    } on MembershipsException catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.message;
        _loading = false;
      });
    }
  }

  void _typed(String _) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 300), () {
      if (mounted) unawaited(_load());
    });
  }

  Future<void> _open(String id) async {
    await showMemberSheet(
      context,
      ref,
      memberId: id,
      orderId: widget.orderId,
      onGoToSale: widget.onGoToSale,
    );
    if (mounted) unawaited(_load());
  }

  Future<void> _join() async {
    final joined = await joinMembership(
      context,
      ref,
      orderId: widget.orderId,
      onGoToSale: widget.onGoToSale,
    );
    if (!mounted) return;
    if (joined != null) {
      unawaited(_load());
      await _open(joined);
    }
  }

  @override
  Widget build(BuildContext context) {
    // Somebody else changed a member -- another till, the back office, the
    // member in the app. The list follows.
    ref.listen(syncEventsProvider, (_, next) {
      if (next.value?.type == 'memberships') unawaited(_load());
    });

    final members = _members ?? const <Member>[];
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 16, 20, 0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: PosTextField(
                  controller: _search,
                  onChanged: _typed,
                  onSubmitted: (_) => _load(),
                  submitLabel: 'Search',
                  decoration: const InputDecoration(
                    hintText: 'Search name, card, phone or email',
                    prefixIcon: Icon(Icons.search),
                    border: OutlineInputBorder(),
                  ),
                ),
              ),
              const SizedBox(width: 12),
              FilledButton.icon(
                onPressed: _join,
                icon: const Icon(Icons.person_add),
                label: const Text('Join'),
                style: FilledButton.styleFrom(
                  minimumSize: const Size(0, 52),
                ),
              ),
              IconButton(
                onPressed: _load,
                icon: const Icon(Icons.refresh),
                tooltip: 'Refresh',
              ),
            ],
          ),
          const SizedBox(height: 12),
          if (_loading) const LinearProgressIndicator(minHeight: 2),
          Expanded(
            child: _error != null && _members == null
                ? _Message(icon: Icons.wifi_off, text: _error!)
                : _members == null
                ? const SizedBox.shrink()
                : members.isEmpty
                ? _Message(
                    icon: Icons.person_search,
                    text: _search.text.trim().isEmpty
                        ? 'No members yet. Press Join to add the first.'
                        : 'Nobody matches "${_search.text.trim()}".',
                  )
                : RefreshIndicator(
                    onRefresh: _load,
                    child: ListView.separated(
                      itemCount: members.length,
                      separatorBuilder: (_, _) => const Divider(height: 1),
                      itemBuilder: (_, i) => _MemberRow(
                        member: members[i],
                        onTap: () => _open(members[i].id),
                      ),
                    ),
                  ),
          ),
        ],
      ),
    );
  }
}

class _Message extends StatelessWidget {
  const _Message({required this.icon, required this.text});

  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(32),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 40, color: Pos.graphite),
          const SizedBox(height: 12),
          Text(
            text,
            textAlign: TextAlign.center,
            style: const TextStyle(color: Pos.graphite),
          ),
        ],
      ),
    ),
  );
}

class _StateChip extends StatelessWidget {
  const _StateChip(this.state);

  final MemberState state;

  @override
  Widget build(BuildContext context) {
    final colour = _stateColour(state);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: colour.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: colour.withValues(alpha: 0.5)),
      ),
      // The word as well as the colour: a red chip and a grey one are the same
      // chip to one man in twelve.
      child: Text(
        state.label,
        style: TextStyle(
          color: colour,
          fontWeight: FontWeight.w700,
          fontSize: 12.5,
        ),
      ),
    );
  }
}

class _MemberRow extends StatelessWidget {
  const _MemberRow({required this.member, required this.onTap});

  final Member member;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final m = member;
    final initials = m.name
        .split(' ')
        .where((w) => w.isNotEmpty)
        .take(2)
        .map((w) => w[0].toUpperCase())
        .join();
    return ListTile(
      onTap: onTap,
      leading: CircleAvatar(
        backgroundColor: _stateColour(m.state).withValues(alpha: 0.18),
        child: Text(initials),
      ),
      title: Text(
        m.name,
        style: const TextStyle(fontWeight: FontWeight.w600),
      ),
      subtitle: Text(
        [
          if (m.memberNumber != null) 'No. ${m.memberNumber}',
          m.plan?.name ?? 'No plan',
          if (m.expiry != null) 'to ${_date(m.expiry)}',
          if (m.isFamilyMember) 'family',
        ].join(' · '),
      ),
      trailing: _StateChip(m.state),
    );
  }
}

/// The member card, with what can be done to this membership today.
Future<void> showMemberSheet(
  BuildContext context,
  WidgetRef ref, {
  required String memberId,
  required String orderId,
  required VoidCallback onGoToSale,
}) => showModalBottomSheet<void>(
  context: context,
  isScrollControlled: true,
  showDragHandle: true,
  builder: (_) => _MemberSheet(
    memberId: memberId,
    orderId: orderId,
    onGoToSale: onGoToSale,
  ),
);

class _MemberSheet extends ConsumerStatefulWidget {
  const _MemberSheet({
    required this.memberId,
    required this.orderId,
    required this.onGoToSale,
  });

  final String memberId;
  final String orderId;
  final VoidCallback onGoToSale;

  @override
  ConsumerState<_MemberSheet> createState() => _MemberSheetState();
}

class _MemberSheetState extends ConsumerState<_MemberSheet> {
  Member? _member;
  String? _error;
  bool _busy = false;

  MembershipsRepository get _api => ref.read(membershipsRepositoryProvider);
  String? get _staff => ref.read(servedByProvider);

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    try {
      final m = await _api.member(widget.memberId);
      if (mounted) setState(() => _member = m);
    } on MembershipsException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  /// Run one change against the back office, and show what came back.
  Future<void> _do(
    Future<Member> Function() change, {
    required String done,
  }) async {
    if (_refusedInTraining(context, ref)) return;
    setState(() => _busy = true);
    try {
      final m = await change();
      if (!mounted) return;
      setState(() {
        _member = m;
        _busy = false;
      });
      PosMessenger.success(context, done);
    } on MembershipsException catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      PosMessenger.error(context, e.message);
    }
  }

  Future<void> _renew(Member m) async {
    final plan = m.plan;
    if (plan == null) {
      PosMessenger.error(
        context,
        '${m.name} has no plan. Change it in the back office first.',
      );
      return;
    }
    if (plan.feeMinor <= 0) {
      await _do(
        () => _api.renew(m.id, amountMinor: 0, staff: _staff),
        done: 'Renewed. There is no fee on ${plan.name}.',
      );
      return;
    }
    final customer = await _tillCustomerFor(ref, m);
    if (!mounted) return;
    final charged = await chargeMembershipOnBill(
      context,
      ref,
      orderId: widget.orderId,
      customer: customer,
      plan: plan,
      join: false,
    );
    if (!charged || !mounted) return;
    Navigator.of(context).pop();
    widget.onGoToSale();
  }

  Future<void> _freeze(Member m) async {
    final left = m.freezeDaysLeft;
    if ((m.plan?.freezeDaysPerYear ?? 0) <= 0) {
      PosMessenger.error(context, '${m.plan?.name ?? 'This plan'} does not allow freezing.');
      return;
    }
    if (left <= 0) {
      PosMessenger.error(
        context,
        'All ${m.plan!.freezeDaysPerYear} freeze days this year have been used.',
      );
      return;
    }
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final range = await showDateRangePicker(
      context: context,
      firstDate: today,
      lastDate: today.add(const Duration(days: 366)),
      initialDateRange: DateTimeRange(
        start: today,
        end: today.add(Duration(days: (left - 1).clamp(0, 13))),
      ),
      helpText: 'Freeze from and to ($left day${left == 1 ? '' : 's'} left)',
      saveText: 'Freeze',
    );
    if (range == null || !mounted) return;
    await _do(
      () => _api.freeze(
        m.id,
        from: range.start,
        until: range.end,
        staff: _staff,
      ),
      done:
          'Frozen from ${_date(range.start)} to ${_date(range.end)}. The '
          'expiry moves on by the same number of days.',
    );
  }

  Future<void> _cancel(Member m) async {
    final now = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('Cancel ${m.name}\'s membership?'),
        content: Text(
          m.expiry == null
              ? 'Ending it at once is the only choice: there is no expiry date.'
              : 'Let it run to ${_date(m.expiry)} and stop there, or end it '
                    'today. Nothing is refunded here.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('Keep it'),
          ),
          if (m.expiry != null)
            OutlinedButton(
              onPressed: () => Navigator.of(context).pop(false),
              child: Text('At ${_date(m.expiry)}'),
            ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: Pos.red),
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('End today'),
          ),
        ],
      ),
    );
    if (now == null || !mounted) return;
    // Cancelling is a manager's decision -- the same override the void and the
    // refund use, answered with a PIN or a card.
    if (!await allowed(context, ref, TillPermission.isManager)) return;
    if (!mounted) return;
    await _do(
      () => _api.cancel(m.id, now: now, staff: _staff),
      done: now
          ? 'Cancelled. The card stops working today.'
          : 'Cancelled. The card works until ${_date(m.expiry)}.',
    );
  }

  Future<void> _addFamily(Member m) async {
    if (_refusedInTraining(context, ref)) return;
    final c = await pickCustomer(context, ref);
    if (c == null || !mounted) return;
    await _do(() async {
      await _api.join(familyHeadId: m.id, customerId: c.id, staff: _staff);
      return _api.member(m.id);
    }, done: '${c.name} is on ${m.name}\'s family plan.');
  }

  @override
  Widget build(BuildContext context) {
    final m = _member;
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.only(
          bottom: MediaQuery.of(context).viewInsets.bottom,
        ),
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxHeight: MediaQuery.of(context).size.height * 0.85,
          ),
          child: m == null
              ? SizedBox(
                  height: 220,
                  child: _error != null
                      ? _Message(icon: Icons.error_outline, text: _error!)
                      : const Center(child: CircularProgressIndicator()),
                )
              : ListView(
                  shrinkWrap: true,
                  padding: const EdgeInsets.fromLTRB(24, 0, 24, 24),
                  children: [
                    _card(m),
                    const SizedBox(height: 16),
                    if (_busy) const LinearProgressIndicator(minHeight: 2),
                    _actions(m),
                    if (m.family.length > 1 ||
                        (m.plan?.familySize ?? 1) > 1) ...[
                      const SizedBox(height: 20),
                      _family(m),
                    ],
                    if (m.history.isNotEmpty) ...[
                      const SizedBox(height: 20),
                      _history(m),
                    ],
                  ],
                ),
        ),
      ),
    );
  }

  Widget _card(Member m) {
    final plan = m.plan;
    final rows = <(String, String)>[
      if (m.memberNumber != null) ('Member no.', m.memberNumber!),
      ('Plan', plan == null ? 'None' : plan.name),
      if (plan != null)
        (
          'Fee',
          '${_money(plan.feeMinor)} / ${plan.termMonths} month'
              '${plan.termMonths == 1 ? '' : 's'}',
        ),
      ('Expires', _date(m.expiry)),
      if (m.daysLeft != null && m.state == MemberState.active)
        ('Days left', '${m.daysLeft}'),
      if (m.frozenFrom != null)
        ('Frozen', '${_date(m.frozenFrom)} to ${_date(m.frozenUntil)}'),
      if ((plan?.freezeDaysPerYear ?? 0) > 0)
        (
          'Freeze days',
          '${m.freezeDaysLeft} of ${plan!.freezeDaysPerYear} left this year',
        ),
      if (plan != null)
        (
          'Includes',
          [
            if (plan.includesGym) 'gym',
            if (plan.includesClasses) 'classes',
          ].join(' and ').ifEmpty('neither gym nor classes'),
        ),
      if (m.phone != null) ('Phone', m.phone!),
      if (m.email != null) ('Email', m.email!),
    ];
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    m.name,
                    style: const TextStyle(
                      fontSize: 22,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
                _StateChip(m.state),
              ],
            ),
            if (m.freezeScheduled)
              const Padding(
                padding: EdgeInsets.only(top: 6),
                child: Text(
                  'A freeze is booked to start later.',
                  style: TextStyle(color: Pos.blue),
                ),
              ),
            if (m.isFamilyMember)
              const Padding(
                padding: EdgeInsets.only(top: 6),
                child: Text(
                  'On a family plan. Renewing, freezing and cancelling are '
                  'done on the payer, and everybody on the plan moves '
                  'together.',
                  style: TextStyle(color: Pos.graphite, fontSize: 12.5),
                ),
              ),
            const SizedBox(height: 14),
            for (final (label, value) in rows)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 3),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    SizedBox(
                      width: 120,
                      child: Text(
                        label,
                        style: const TextStyle(color: Pos.graphite),
                      ),
                    ),
                    Expanded(
                      child: Text(
                        value,
                        style: const TextStyle(fontWeight: FontWeight.w600),
                      ),
                    ),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _actions(Member m) {
    final s = m.state;
    final frozen = s == MemberState.frozen || m.freezeScheduled;
    final fee = m.plan?.feeMinor ?? 0;
    final buttons = <Widget>[
      if (s != MemberState.cancelled && s != MemberState.none)
        FilledButton.icon(
          onPressed: _busy ? null : () => _renew(m),
          icon: const Icon(Icons.autorenew),
          label: Text(fee > 0 ? 'Renew — ${_money(fee)}' : 'Renew'),
        ),
      if (s == MemberState.pending)
        FilledButton.tonalIcon(
          onPressed: _busy
              ? null
              : () => _do(
                  () => _api.reinstate(m.id, staff: _staff),
                  done: '${m.name} is approved.',
                ),
          icon: const Icon(Icons.verified),
          label: const Text('Approve'),
        ),
      if (s == MemberState.cancelled)
        FilledButton.tonalIcon(
          onPressed: _busy
              ? null
              : () => _do(
                  () => _api.reinstate(m.id, staff: _staff),
                  done: '${m.name}\'s membership is back on.',
                ),
          icon: const Icon(Icons.restore),
          label: const Text('Reinstate'),
        ),
      if (frozen)
        OutlinedButton.icon(
          onPressed: _busy
              ? null
              : () => _do(
                  () => _api.unfreeze(m.id, staff: _staff),
                  done: 'Unfrozen. Any days not used come off the expiry.',
                ),
          icon: const Icon(Icons.wb_sunny_outlined),
          label: const Text('Unfreeze'),
        ),
      if (!frozen && (s == MemberState.active || s == MemberState.expired))
        OutlinedButton.icon(
          onPressed: _busy ? null : () => _freeze(m),
          icon: const Icon(Icons.ac_unit),
          label: const Text('Freeze'),
        ),
      if (m.familyHasRoom && s != MemberState.cancelled)
        OutlinedButton.icon(
          onPressed: _busy ? null : () => _addFamily(m),
          icon: const Icon(Icons.group_add),
          label: const Text('Add family'),
        ),
      if (s != MemberState.cancelled && s != MemberState.none)
        OutlinedButton.icon(
          style: OutlinedButton.styleFrom(foregroundColor: Pos.red),
          onPressed: _busy ? null : () => _cancel(m),
          icon: const Icon(Icons.cancel_outlined),
          label: const Text('Cancel'),
        ),
    ];
    return Wrap(spacing: 10, runSpacing: 10, children: buttons);
  }

  Widget _family(Member m) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(
        'Family (${m.family.length} of ${m.plan?.familySize ?? m.family.length})',
        style: const TextStyle(fontWeight: FontWeight.w700),
      ),
      const SizedBox(height: 6),
      for (final f in m.family)
        ListTile(
          dense: true,
          contentPadding: EdgeInsets.zero,
          leading: Icon(f.payer ? Icons.account_balance_wallet : Icons.person),
          title: Text(f.name),
          subtitle: Text(
            [
              if (f.payer) 'Pays',
              if (f.memberNumber != null) 'No. ${f.memberNumber}',
            ].join(' · '),
          ),
          trailing: _StateChip(f.state),
        ),
    ],
  );

  Widget _history(Member m) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      const Text('History', style: TextStyle(fontWeight: FontWeight.w700)),
      const SizedBox(height: 6),
      for (final e in m.history.take(8))
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 2),
          child: Text(
            [
              if (e.at != null) DateFormat('d MMM yyyy').format(e.at!),
              e.kind,
              if (e.amountMinor != null && e.amountMinor! > 0)
                _money(e.amountMinor!),
              if (e.expiryAfter != null) 'to ${_date(e.expiryAfter)}',
              if (e.note != null) e.note!,
            ].join(' · '),
            style: const TextStyle(fontSize: 12.5, color: Pos.graphite),
          ),
        ),
    ],
  );
}

extension on String {
  String ifEmpty(String other) => isEmpty ? other : this;
}

/// The till's own picture of a member, for the bill: their discount, scheme
/// and card come from the customer search, which is what every other way onto
/// a bill reads.
Future<TillCustomer> _tillCustomerFor(WidgetRef ref, Member m) async {
  try {
    final found = await ref
        .read(customerRepoProvider)
        .search(m.cardNumber ?? m.memberNumber ?? m.name);
    for (final c in found) {
      if (c.id == m.id) return c;
    }
  } catch (_) {
    // Fall through to what the member card already knows.
  }
  return TillCustomer(
    id: m.id,
    name: m.name,
    phone: m.phone,
    email: m.email,
    cardNumber: m.cardNumber,
    membershipExpiry: m.expiry,
    photoUrl: m.photoUrl,
    memberNumber: m.memberNumber,
  );
}

/// Join a plan: pick it, pick the person, and either post it (no fee) or put
/// the fee on the bill. Returns the member's id when it was posted at once.
Future<String?> joinMembership(
  BuildContext context,
  WidgetRef ref, {
  required String orderId,
  required VoidCallback onGoToSale,
}) async {
  final api = ref.read(membershipsRepositoryProvider);
  List<MemberPlan> plans;
  try {
    plans = (await api.plans()).where((p) => p.active).toList();
  } on MembershipsException catch (e) {
    if (context.mounted) PosMessenger.error(context, e.message);
    return null;
  }
  if (!context.mounted) return null;
  if (plans.isEmpty) {
    PosMessenger.error(
      context,
      'There are no plans taking new members. Add one in the back office '
      'under Memberships.',
    );
    return null;
  }

  final plan = await showDialog<MemberPlan>(
    context: context,
    builder: (context) => SimpleDialog(
      title: const Text('Which plan?'),
      children: [
        for (final p in plans)
          SimpleDialogOption(
            onPressed: () => Navigator.of(context).pop(p),
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 6),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    p.name,
                    style: const TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  Text(
                    [
                      '${_money(p.feeMinor)} for ${p.termMonths} month'
                          '${p.termMonths == 1 ? '' : 's'}',
                      if (p.joiningFeeMinor > 0)
                        '+ ${_money(p.joiningFeeMinor)} joining fee',
                      if (p.familySize > 1) 'covers ${p.familySize}',
                      if (p.includesGym) 'gym',
                      if (p.includesClasses) 'classes',
                    ].join(' · '),
                    style: const TextStyle(color: Pos.graphite),
                  ),
                ],
              ),
            ),
          ),
      ],
    ),
  );
  if (plan == null || !context.mounted) return null;

  // Somebody the venue knows, or a new customer -- the same picker the
  // Customer key uses, with its own New button.
  final customer = await pickCustomer(context, ref);
  if (customer == null || !context.mounted) return null;

  if (plan.joinTotalMinor <= 0) {
    if (_refusedInTraining(context, ref)) return null;
    try {
      final m = await api.join(
        schemeId: plan.id,
        customerId: customer.id,
        amountMinor: 0,
        staff: ref.read(servedByProvider),
      );
      if (context.mounted) {
        PosMessenger.success(context, '${m.name} has joined ${plan.name}.');
      }
      return m.id;
    } on MembershipsException catch (e) {
      if (context.mounted) PosMessenger.error(context, e.message);
      return null;
    }
  }

  final charged = await chargeMembershipOnBill(
    context,
    ref,
    orderId: orderId,
    customer: customer,
    plan: plan,
    join: true,
  );
  if (charged) onGoToSale();
  return null;
}

/// Put a plan's fee on the bill and the member on it, the way the old
/// swipe-and-renew does: the line is the renewal, and it is posted when the
/// bill is paid. Returns whether the fee went on.
///
/// The fee is the venue's flagged "Renews membership" product of the same name
/// when there is one, so it carries that product's VAT and department; a plain
/// line at the plan's fee otherwise, exactly as `membershipProduct` rings it.
/// A joining fee is its own line, so the receipt says what each part was for.
Future<bool> chargeMembershipOnBill(
  BuildContext context,
  WidgetRef ref, {
  required String orderId,
  required TillCustomer customer,
  required MemberPlan plan,
  required bool join,
}) async {
  final orders = ref.read(orderRepositoryProvider);
  final order = await orders.watchOrder(orderId).first;
  final lines = await orders.watchLines(orderId).first;
  if (!context.mounted) return false;

  // One person per bill. The settle path posts the membership for whoever is
  // on it, so a fee rung up for somebody else would join the wrong person.
  final on = order.customerId;
  if (on != null && on.isNotEmpty && on != customer.id) {
    PosMessenger.error(
      context,
      'This bill is for ${order.customerName ?? 'another customer'}. Pay or '
      'park it first, then try again.',
    );
    return false;
  }

  final catalogue = ref.read(productsProvider).value ?? const <Product>[];
  final settings = await ref
      .read(commerceRepositoryProvider)
      .membershipSettings();
  if (!context.mounted) return false;
  final renewing = renewingPlus(catalogue, legacyPlu: settings.plu);
  if (billRenewsMembership(lines, renewing: renewing) ||
      lines.any((l) => membershipLineIntent(l.notes) != null)) {
    PosMessenger.error(
      context,
      'There is already a membership fee on this bill.',
    );
    return false;
  }

  final note = membershipLineNote(
    join: join,
    planId: plan.id,
    planName: plan.name,
  );
  final by = ref.read(servedByProvider);
  final named = catalogue
      .where(
        (p) =>
            p.renewsMembership &&
            p.name.trim().toLowerCase() == plan.name.trim().toLowerCase(),
      )
      .firstOrNull;
  if (named != null || plan.feeMinor > 0) {
    await orders.addLine(
      orderId,
      named ??
          membershipProduct(
            feeMinor: plan.feeMinor,
          ).copyWith(name: '${plan.name} membership'),
      addedBy: by,
      consolidate: false,
      notes: note,
    );
  }
  if (join && plan.joiningFeeMinor > 0) {
    await orders.addLine(
      orderId,
      membershipProduct(
        feeMinor: plan.joiningFeeMinor,
      ).copyWith(name: 'Joining fee — ${plan.name}'),
      addedBy: by,
      consolidate: false,
      notes: note,
    );
  }
  if (!context.mounted) return false;

  // Through the one membership gate every door onto a bill uses. The fee is
  // already on, so an expired card is let through as "renewing" rather than
  // offered a second fee.
  final member = ExpiredMember.fromTill(
    customer,
    feeMinor: plan.feeMinor,
    termMonths: plan.termMonths,
    renewalDate: plan.seasonEnds,
  );
  final gate = await checkMembership(
    context,
    ref,
    orderId: orderId,
    member: member,
  );
  if (!context.mounted) return false;
  final scheme = ref
      .read(commerceRepositoryProvider)
      .schemeById(customer.schemeId);
  await orders.attachCustomer(
    orderId,
    id: customer.id,
    name: customer.name,
    membershipExpiry: gate == MembershipGate.renewing
        ? null
        : customer.membershipExpiry,
    discountType: customer.discountType,
    discountValue: customer.discountValue,
    phone: customer.phone,
    email: customer.email,
    cardNumber: customer.cardNumber,
    pointsBalance: customer.pointsBalance,
    scheme: scheme,
    memberNumber: customer.memberNumber,
    revertLevel: ref.read(currentPriceLevelProvider),
  );
  if (!context.mounted) return false;

  final total = plan.feeMinor + (join ? plan.joiningFeeMinor : 0);
  PosMessenger.success(
    context,
    '${customer.name}: ${plan.name} ${join ? 'joining' : 'renewal'} is on '
    'the bill (${_money(total)}). It is recorded when the bill is paid.',
  );
  return true;
}

// -----------------------------------------------------------------------------
// Classes today
// -----------------------------------------------------------------------------

class _ClassesTab extends ConsumerStatefulWidget {
  const _ClassesTab({required this.orderId});

  final String orderId;

  @override
  ConsumerState<_ClassesTab> createState() => _ClassesTabState();
}

class _ClassesTabState extends ConsumerState<_ClassesTab> {
  List<ClassSession>? _sessions;
  String? _error;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    try {
      final list = await ref
          .read(membershipsRepositoryProvider)
          .sessions(DateTime.now());
      if (mounted) {
        setState(() {
          _sessions = list;
          _error = null;
        });
      }
    } on MembershipsException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  Future<void> _open(ClassSession s) async {
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => _SessionSheet(sessionId: s.id, orderId: widget.orderId),
    );
    if (mounted) unawaited(_load());
  }

  @override
  Widget build(BuildContext context) {
    ref.listen(syncEventsProvider, (_, next) {
      if (next.value?.type == 'classes') unawaited(_load());
    });
    final sessions = _sessions;
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 16, 20, 0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  DateFormat('EEEE d MMMM').format(DateTime.now()),
                  style: const TextStyle(
                    fontSize: 20,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
              IconButton(
                onPressed: _load,
                icon: const Icon(Icons.refresh),
                tooltip: 'Refresh',
              ),
            ],
          ),
          const SizedBox(height: 8),
          Expanded(
            child: sessions == null
                ? (_error != null
                      ? _Message(icon: Icons.wifi_off, text: _error!)
                      : const Center(child: CircularProgressIndicator()))
                : sessions.isEmpty
                ? const _Message(
                    icon: Icons.event_busy,
                    text:
                        'No classes today. The timetable is set in the back '
                        'office under Classes.',
                  )
                : RefreshIndicator(
                    onRefresh: _load,
                    child: ListView.separated(
                      itemCount: sessions.length,
                      separatorBuilder: (_, _) => const SizedBox(height: 8),
                      itemBuilder: (_, i) => _SessionRow(
                        session: sessions[i],
                        onTap: () => _open(sessions[i]),
                      ),
                    ),
                  ),
          ),
        ],
      ),
    );
  }
}

class _SessionRow extends StatelessWidget {
  const _SessionRow({required this.session, required this.onTap});

  final ClassSession session;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final s = session;
    final full = s.booked >= s.capacity && s.capacity > 0;
    return Card(
      margin: EdgeInsets.zero,
      child: ListTile(
        onTap: s.cancelled ? null : onTap,
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
        leading: Container(
          width: 6,
          color: Pos.parseColor(s.colour) ?? Pos.brand,
        ),
        title: Text(
          '${_time(s.startsAt)}  ${s.name}',
          style: TextStyle(
            fontWeight: FontWeight.w700,
            decoration: s.cancelled ? TextDecoration.lineThrough : null,
          ),
        ),
        subtitle: Text(
          [
            if (s.cancelled) 'Cancelled',
            if (s.instructor != null) s.instructor!,
            if (s.room != null) s.room!,
            if (s.dropInMinor != null) 'drop-in ${_money(s.dropInMinor!)}',
          ].join(' · '),
        ),
        trailing: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Text(
              '${s.booked} / ${s.capacity}',
              style: TextStyle(
                fontSize: 18,
                fontWeight: FontWeight.w800,
                color: full ? Pos.red : null,
              ),
            ),
            Text(
              [
                '${s.attended} in',
                if (s.waiting > 0) '${s.waiting} waiting',
              ].join(' · '),
              style: const TextStyle(fontSize: 12, color: Pos.graphite),
            ),
          ],
        ),
      ),
    );
  }
}

class _SessionSheet extends ConsumerStatefulWidget {
  const _SessionSheet({required this.sessionId, required this.orderId});

  final int sessionId;
  final String orderId;

  @override
  ConsumerState<_SessionSheet> createState() => _SessionSheetState();
}

class _SessionSheetState extends ConsumerState<_SessionSheet> {
  ClassSession? _session;
  String? _error;
  bool _busy = false;
  bool _waitingForCard = false;

  MembershipsRepository get _api => ref.read(membershipsRepositoryProvider);

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  @override
  void dispose() {
    MemberCardCapture.stop();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final s = await _api.session(widget.sessionId);
      if (mounted) setState(() => _session = s);
    } on MembershipsException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  /// Check somebody in, or book them a place, offering the drop-in when their
  /// membership does not cover the class.
  Future<void> _admit(
    String customerId,
    String name, {
    required bool checkIn,
  }) async {
    if (_refusedInTraining(context, ref)) return;
    final s = _session;
    if (s == null) return;
    setState(() => _busy = true);
    var dropIn = false;
    try {
      try {
        await (checkIn
            ? _api.checkIn(s.id, customerId)
            : _api.book(s.id, customerId));
      } on MembershipsException catch (e) {
        if (!needsDropIn(e)) rethrow;
        if (!mounted) return;
        final price = s.dropInMinor ?? 0;
        final yes = await showDialog<bool>(
          context: context,
          builder: (context) => AlertDialog(
            title: Text('$name as a drop-in?'),
            content: Text(
              'Their membership does not cover ${s.name}.'
              '${price > 0 ? ' The drop-in, ${_money(price)}, goes on the current bill.' : ''}',
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.of(context).pop(false),
                child: const Text('No'),
              ),
              FilledButton(
                onPressed: () => Navigator.of(context).pop(true),
                child: Text(price > 0 ? 'Drop-in — ${_money(price)}' : 'Drop-in'),
              ),
            ],
          ),
        );
        if (yes != true) return;
        dropIn = true;
        await (checkIn
            ? _api.checkIn(s.id, customerId, dropIn: true)
            : _api.book(s.id, customerId, dropIn: true));
        if (price > 0) {
          // The drop-in is a sale like any other. Its own PLU, never a
          // renewing one, so paying for a class renews nobody.
          await ref.read(orderRepositoryProvider).addLine(
            widget.orderId,
            membershipProduct(feeMinor: price).copyWith(
              pluId: classDropInPlu,
              name: 'Drop-in — ${s.name}',
              renewsMembership: false,
            ),
            addedBy: ref.read(servedByProvider),
            consolidate: false,
          );
        }
      }
      if (!mounted) return;
      PosMessenger.success(
        context,
        '$name ${checkIn ? 'is checked in' : 'is booked'}'
        '${dropIn ? ' as a drop-in' : ''}.',
      );
      await _load();
    } on MembershipsException catch (e) {
      if (mounted) PosMessenger.error(context, e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _find({required bool checkIn}) async {
    final c = await pickCustomer(context, ref);
    if (c == null || !mounted) return;
    await _admit(c.id, c.name, checkIn: checkIn);
  }

  Future<void> _swipe() async {
    setState(() => _waitingForCard = true);
    final card = await MemberCardCapture.next();
    if (!mounted) return;
    setState(() => _waitingForCard = false);
    if (card == null || card.number.isEmpty) return;
    LoyaltyCustomer? found;
    try {
      found = await ref
          .read(commerceRepositoryProvider)
          .loyaltyByCard(card.number);
    } catch (_) {
      found = null;
    }
    if (!mounted) return;
    if (found == null) {
      PosMessenger.error(
        context,
        'Card ${card.number} does not belong to anybody here, or the back '
        'office could not be reached.',
      );
      return;
    }
    await _admit(found.id, found.name, checkIn: true);
  }

  Future<void> _unbook(ClassBooking b) async {
    if (_refusedInTraining(context, ref)) return;
    setState(() => _busy = true);
    try {
      await _api.unbook(widget.sessionId, b.customerId);
      if (mounted) PosMessenger.info(context, '${b.name}\'s booking is cancelled.');
      await _load();
    } on MembershipsException catch (e) {
      if (mounted) PosMessenger.error(context, e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = _session;
    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxHeight: MediaQuery.of(context).size.height * 0.85,
        ),
        child: s == null
            ? SizedBox(
                height: 220,
                child: _error != null
                    ? _Message(icon: Icons.error_outline, text: _error!)
                    : const Center(child: CircularProgressIndicator()),
              )
            : ListView(
                shrinkWrap: true,
                padding: const EdgeInsets.fromLTRB(24, 0, 24, 24),
                children: [
                  Text(
                    '${_time(s.startsAt)}  ${s.name}',
                    style: const TextStyle(
                      fontSize: 22,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    [
                      '${s.booked} of ${s.capacity} booked',
                      '${s.attended} checked in',
                      if (s.waiting > 0) '${s.waiting} waiting',
                      if (s.dropInMinor != null)
                        'drop-in ${_money(s.dropInMinor!)}'
                      else
                        'members only',
                    ].join(' · '),
                    style: const TextStyle(color: Pos.graphite),
                  ),
                  const SizedBox(height: 16),
                  Wrap(
                    spacing: 10,
                    runSpacing: 10,
                    children: [
                      FilledButton.icon(
                        onPressed: _busy ? null : () => _find(checkIn: true),
                        icon: const Icon(Icons.how_to_reg),
                        label: const Text('Check in'),
                      ),
                      OutlinedButton.icon(
                        onPressed: _busy || _waitingForCard ? null : _swipe,
                        icon: const Icon(Icons.credit_card),
                        label: Text(
                          _waitingForCard ? 'Swipe the card now…' : 'Swipe card',
                        ),
                      ),
                      OutlinedButton.icon(
                        onPressed: _busy ? null : () => _find(checkIn: false),
                        icon: const Icon(Icons.event_available),
                        label: const Text('Book a place'),
                      ),
                    ],
                  ),
                  if (_busy) ...[
                    const SizedBox(height: 12),
                    const LinearProgressIndicator(minHeight: 2),
                  ],
                  const SizedBox(height: 16),
                  if (s.bookings.isEmpty)
                    const Padding(
                      padding: EdgeInsets.symmetric(vertical: 24),
                      child: Text(
                        'Nobody is booked yet.',
                        textAlign: TextAlign.center,
                        style: TextStyle(color: Pos.graphite),
                      ),
                    ),
                  for (final b in s.bookings)
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      leading: Icon(
                        b.attended
                            ? Icons.check_circle
                            : b.status == 'waitlist'
                            ? Icons.hourglass_top
                            : Icons.radio_button_unchecked,
                        color: b.attended ? Pos.green : Pos.graphite,
                      ),
                      title: Text(b.name),
                      subtitle: Text(
                        [
                          switch (b.status) {
                            'attended' => 'Checked in',
                            'waitlist' => 'Waiting list',
                            'no_show' => 'Did not come',
                            _ => 'Booked',
                          },
                          if (b.memberNumber != null) 'No. ${b.memberNumber}',
                          if (b.via != null) 'via ${b.via}',
                        ].join(' · '),
                      ),
                      trailing: b.attended
                          ? null
                          : Wrap(
                              spacing: 6,
                              children: [
                                if (b.status != 'waitlist')
                                  FilledButton.tonal(
                                    onPressed: _busy
                                        ? null
                                        : () => _admit(
                                            b.customerId,
                                            b.name,
                                            checkIn: true,
                                          ),
                                    child: const Text('Check in'),
                                  ),
                                IconButton(
                                  tooltip: 'Cancel booking',
                                  onPressed: _busy ? null : () => _unbook(b),
                                  icon: const Icon(Icons.close),
                                ),
                              ],
                            ),
                    ),
                ],
              ),
      ),
    );
  }
}
