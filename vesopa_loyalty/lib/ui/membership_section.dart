import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../data/api.dart';
import '../data/membership.dart';
import '../data/session.dart';
import 'widgets.dart';

/// The Membership card on the account page, for a venue that runs
/// memberships (see membershipProvider): the plan, its state, the family on
/// it, and joining or renewing online.
///
/// PAYING IS DOJO'S PAGE, NOT OURS. The app asks the server for a checkout,
/// opens it in the browser, and asks again when the member comes back; the
/// membership moves only when Dojo says the money is in. No card number ever
/// passes through the app.
class MembershipSection extends ConsumerWidget {
  const MembershipSection({super.key, required this.membership, required this.tillRenew});

  final Map<String, dynamic> membership;

  /// What renewing at the till means, for a venue not taking money online.
  final Future<void> Function(BuildContext context) tillRenew;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final m = membership;
    final theme = Theme.of(context);
    final state = '${m['state'] ?? 'none'}';
    final plan = m['plan'] is Map ? Map<String, dynamic>.from(m['plan'] as Map) : null;
    final payer = m['payer'] != false;
    final online = m['can_pay_online'] == true;
    final renewMinor = (m['renew_minor'] as num?)?.toInt();
    final family = ((m['family'] as List?) ?? const []).whereType<Map>().toList();
    final forSale = ((m['plans_for_sale'] as List?) ?? const []).whereType<Map>().map(Map<String, dynamic>.from).toList();
    final pending = ref.watch(pendingPaymentProvider);
    final bad = state == 'expired' || state == 'cancelled';
    final canRenew = payer && plan != null && const ['active', 'frozen', 'expired'].contains(state);
    final frozenFrom = m['frozen_from'];
    final planName = plan == null ? '' : '${plan['name']}';
    // The ring and "member since" for a membership with a plan and a term.
    final header = plan != null && const ['active', 'frozen', 'expired'].contains(state);
    final benefits = plan == null || state == 'none'
        ? const <(IconData, String)>[]
        : planBenefits(plan, freezeUsed: (m['freeze_days_used'] as num?)?.toInt());
    final history = ((m['history'] as List?) ?? const []).whereType<Map>().map(Map<String, dynamic>.from).toList();

    final stateIcon = switch (state) {
      'active' => Icons.verified_outlined,
      'frozen' => Icons.ac_unit,
      'pending' => Icons.hourglass_top,
      'expired' => Icons.event_busy,
      'cancelled' => Icons.block,
      _ => Icons.card_membership,
    };

    return SettingsCard(
      title: 'Membership',
      children: [
        if (header)
          _StatusHeader(membership: m, plan: plan, icon: stateIcon)
        else
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: Icon(stateIcon, color: bad ? theme.colorScheme.error : null),
            title: Text(plan != null ? planName : 'No membership'),
            subtitle: Text(membershipStateText(m)),
          ),
        if (renewalDue(m) && payer && pending == null) _RenewalReminder(daysLeft: (m['days_left'] as num).toInt()),
        if (state == 'active' && frozenFrom != null && m['frozen_until'] != null)
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.ac_unit),
            title: const Text('Freeze booked'),
            subtitle: Text('${dayText(frozenFrom)} to ${dayText(m['frozen_until'])}'),
          ),
        if (m['member_number'] != null)
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.badge_outlined),
            title: const Text('Member number'),
            subtitle: Text('${m['member_number']}'),
          ),
        if (m['joined_on'] != null && state != 'none' && !header)
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.event_note_outlined),
            title: const Text('Joined'),
            subtitle: Text(dayText(m['joined_on'])),
          ),
        if (family.length > 1)
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.family_restroom),
            title: const Text('Family on this membership'),
            subtitle: Text([
              for (final f in family)
                '${f['name'] ?? 'Member'}${f['payer'] == true ? ' (pays)' : ''}'
                    '${f['state'] != null && f['state'] != state ? ' - ${f['state']}' : ''}',
            ].join('\n')),
          ),
        if (benefits.isNotEmpty) _Benefits(lines: benefits),
        if (!payer && state != 'none')
          const ListTile(
            contentPadding: EdgeInsets.zero,
            leading: Icon(Icons.info_outline),
            title: Text('Paid by the head of your family plan'),
          ),
        if (pending != null) _PendingPayment(paymentId: pending),
        if (canRenew && pending == null) ...[
          if (online && renewMinor != null && renewMinor >= 50)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: FilledButton.icon(
                onPressed: () => _pay(context, ref, kind: 'renew', amount: renewMinor, planName: planName),
                icon: const Icon(Icons.autorenew),
                label: Text('${state == 'expired' ? 'Renew' : 'Renew early'} for ${money(renewMinor)}'),
              ),
            )
          else
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: FilledButton.tonalIcon(
                onPressed: () => tillRenew(context),
                icon: const Icon(Icons.autorenew),
                label: Text(state == 'expired' ? 'Renew my membership' : 'How to renew'),
              ),
            ),
        ],
        if (history.isNotEmpty) _History(events: history),
        if (forSale.isNotEmpty && payer && pending == null) ...[
          const SizedBox(height: 10),
          Text(
            state == 'expired' ? 'Or choose another plan' : 'Join',
            style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700),
          ),
          for (final p in forSale) _PlanTile(plan: p, online: online, onJoin: (amount) => _pay(
            context, ref, kind: 'join', schemeId: (p['id'] as num?)?.toInt(), amount: amount, planName: '${p['name']}',
            fee: (p['fee_minor'] as num?)?.toInt() ?? 0, joiningFee: (p['joining_fee_minor'] as num?)?.toInt() ?? 0,
          )),
          if (!online)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text('Ask at the venue to join.', style: theme.textTheme.bodySmall),
            ),
        ],
      ],
    );
  }

  /// Confirm the price, start a Dojo checkout and open it in the browser.
  Future<void> _pay(
    BuildContext context,
    WidgetRef ref, {
    required String kind,
    int? schemeId,
    required int amount,
    required String planName,
    int fee = 0,
    int joiningFee = 0,
  }) async {
    final breakdown = kind == 'join' && joiningFee > 0
        ? '${money(fee)} membership + ${money(joiningFee)} joining fee = ${money(amount)}'
        : money(amount);
    final go = await showDialog<bool>(
      context: context,
      builder: (dialog) => AlertDialog.adaptive(
        title: Text(kind == 'join' ? 'Join $planName' : 'Renew $planName'),
        content: Text(
          '$breakdown.\n\nYou pay on Dojo\'s secure payment page, which opens in your browser. '
          'Come back to the app when you have paid and your membership will update.',
        ),
        actions: [
          DialogAction(onPressed: () => Navigator.pop(dialog, false), child: const Text('Cancel')),
          DialogAction(primary: true, onPressed: () => Navigator.pop(dialog, true), child: Text('Pay ${money(amount)}')),
        ],
      ),
    );
    if (go != true || !context.mounted) return;
    await runWithFeedback(context, ref, () async {
      final r = await ref.read(apiProvider).membershipCheckout(kind: kind, schemeId: schemeId);
      final url = r['url'] as String?;
      final id = r['payment_id'] as String?;
      if (url == null || id == null) throw ApiError('The payment could not be started. Please try again.');
      await ref.read(pendingPaymentProvider.notifier).set(id);
      final opened = await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
      if (!opened) throw ApiError('The payment page could not be opened.');
    }, done: 'Finish paying in your browser, then come back here.');
  }
}

/// Whether to nudge the member to renew: active, an end date within a month.
bool renewalDue(Map<String, dynamic> m) {
  final left = (m['days_left'] as num?)?.toInt();
  return m['state'] == 'active' && m['plan'] is Map && left != null && left >= 0 && left <= 30;
}

/// How far through its current term a membership is, 0 to 1, from its end
/// date and the plan's length. Null where there is no end date to count to.
double? termProgress({required String? expiry, required int? termMonths, required DateTime today}) {
  final end = expiry == null ? null : DateTime.tryParse(expiry);
  if (end == null || termMonths == null || termMonths <= 0) return null;
  final start = DateTime(end.year, end.month - termMonths, end.day);
  final total = end.difference(start).inDays;
  if (total <= 0) return null;
  final done = DateTime(today.year, today.month, today.day).difference(start).inDays;
  return (done / total).clamp(0.0, 1.0);
}

/// What the plan includes, in plain words, from what the server says of it.
/// [freezeUsed] is the days frozen in the last year (/me/membership).
List<(IconData, String)> planBenefits(Map<String, dynamic> plan, {int? freezeUsed}) {
  final credits = (plan['class_credits_per_month'] as num?)?.toInt();
  final family = (plan['family_size'] as num?)?.toInt() ?? 1;
  final freeze = (plan['freeze_days_per_year'] as num?)?.toInt() ?? 0;
  final term = (plan['term_months'] as num?)?.toInt();
  final description = '${plan['description'] ?? ''}'.trim();
  return [
    if (description.isNotEmpty) (Icons.star_outline, description),
    if (term != null && term > 0) (Icons.event_repeat, 'Runs for $term month${term == 1 ? '' : 's'} at a time'),
    if (plan['includes_gym'] == true) (Icons.fitness_center, 'Gym included'),
    if (plan['includes_classes'] == true)
      (Icons.event_available, credits != null && credits > 0 ? '$credits class${credits == 1 ? '' : 'es'} a month' : 'Classes included'),
    if (family > 1) (Icons.family_restroom, 'Covers up to $family people'),
    if (freeze > 0)
      (
        Icons.ac_unit,
        freezeUsed != null
            ? '${math.max(0, freeze - freezeUsed)} of $freeze freeze days left this year'
            : 'Up to $freeze days a year to freeze it',
      ),
  ];
}

/// The plan, at a glance: a ring for how much of the term is left, the days
/// in the middle of it, and when they joined.
class _StatusHeader extends StatelessWidget {
  const _StatusHeader({required this.membership, required this.plan, required this.icon});

  final Map<String, dynamic> membership;
  final Map<String, dynamic>? plan;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final m = membership;
    final state = '${m['state']}';
    final daysLeft = (m['days_left'] as num?)?.toInt();
    final progress = termProgress(
      expiry: m['expiry'] as String?,
      termMonths: (plan?['term_months'] as num?)?.toInt(),
      today: DateTime.now(),
    );
    final expired = state == 'expired';
    final colour = expired
        ? theme.colorScheme.error
        : daysLeft != null && daysLeft <= 30
            ? Colors.orange.shade700
            : theme.colorScheme.primary;
    final joined = m['joined_on'];
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Row(
        children: [
          Semantics(
            label: daysLeft == null ? null : expired ? 'Expired' : '$daysLeft days left',
            child: SizedBox(
              width: 76,
              height: 76,
              child: Stack(
                alignment: Alignment.center,
                children: [
                  SizedBox.expand(
                    child: CircularProgressIndicator(
                      // What is left, so the ring empties as the term runs out.
                      value: progress == null ? 1 : expired ? 0 : 1 - progress,
                      strokeWidth: 7,
                      strokeCap: StrokeCap.round,
                      color: colour,
                      backgroundColor: colour.withValues(alpha: 0.15),
                    ),
                  ),
                  if (daysLeft != null && !expired && state != 'frozen')
                    ExcludeSemantics(
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text('$daysLeft', style: theme.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800, height: 1)),
                          Text(daysLeft == 1 ? 'day' : 'days', style: theme.textTheme.labelSmall),
                        ],
                      ),
                    )
                  else
                    Icon(icon, color: colour),
                ],
              ),
            ),
          ),
          const SizedBox(width: 16),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('${plan?['name'] ?? ''}', style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800)),
                const SizedBox(height: 2),
                Text(membershipStateText(m)),
                if (joined != null)
                  Text(
                    'Member since ${dayText(joined)}',
                    style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// A gentle nudge in the last month, before the card stops working.
class _RenewalReminder extends StatelessWidget {
  const _RenewalReminder({required this.daysLeft});

  final int daysLeft;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(top: 4, bottom: 6),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: Colors.orange.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Row(
        children: [
          Icon(Icons.notifications_active_outlined, color: Colors.orange.shade800),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              daysLeft == 0
                  ? 'Your membership ends today. Renew to keep your card working.'
                  : 'Your membership ends in $daysLeft day${daysLeft == 1 ? '' : 's'}. '
                      'Renew early and you lose nothing: the new term starts when this one ends.',
            ),
          ),
        ],
      ),
    );
  }
}

/// What the plan includes.
class _Benefits extends StatelessWidget {
  const _Benefits({required this.lines});

  final List<(IconData, String)> lines;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(top: 6, bottom: 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('What your membership includes', style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700)),
          const SizedBox(height: 6),
          for (final (icon, text) in lines)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(icon, size: 20),
                  const SizedBox(width: 12),
                  Expanded(child: Text(text)),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

/// The membership's own record: joined, renewed, frozen, and what was paid.
/// The server sends the latest twenty.
class _History extends StatelessWidget {
  const _History({required this.events});

  final List<Map<String, dynamic>> events;

  static (IconData, String) _what(Object? kind) => switch (kind) {
    'join' => (Icons.how_to_reg_outlined, 'Joined'),
    'renew' => (Icons.autorenew, 'Renewed'),
    'freeze' => (Icons.ac_unit, 'Frozen'),
    'unfreeze' => (Icons.wb_sunny_outlined, 'Freeze ended'),
    'plan' => (Icons.swap_horiz, 'Plan changed'),
    'cancel' => (Icons.block, 'Cancelled'),
    'leave' => (Icons.logout, 'Left the family plan'),
    _ => (Icons.history, 'Updated'),
  };

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Theme(
      data: theme.copyWith(dividerColor: Colors.transparent),
      child: ExpansionTile(
        tilePadding: EdgeInsets.zero,
        childrenPadding: EdgeInsets.zero,
        leading: const Icon(Icons.history),
        title: const Text('Membership history'),
        subtitle: Text('${events.length} update${events.length == 1 ? '' : 's'}'),
        children: [
          for (final e in events) _row(theme, e),
        ],
      ),
    );
  }

  Widget _row(ThemeData theme, Map<String, dynamic> e) {
    final (icon, label) = _what(e['kind']);
    final amount = (e['amount_minor'] as num?)?.toInt();
    final details = [
      when(e['at'], time: false),
      if (e['expiry_after'] != null && const ['join', 'renew', 'plan'].contains(e['kind']))
        'runs to ${dayText(e['expiry_after'])}',
      if (e['via'] == 'online') 'paid online',
    ];
    return ListTile(
      contentPadding: EdgeInsets.zero,
      dense: true,
      leading: Icon(icon, size: 20),
      title: Text(label),
      subtitle: Text(details.join(' · ')),
      trailing: amount != null && amount > 0
          ? Text(money(amount), style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700))
          : null,
    );
  }
}

/// A plan on sale: its price, what it includes, and the way to join.
class _PlanTile extends StatelessWidget {
  const _PlanTile({required this.plan, required this.online, required this.onJoin});

  final Map<String, dynamic> plan;
  final bool online;
  final void Function(int amount) onJoin;

  @override
  Widget build(BuildContext context) {
    final fee = (plan['fee_minor'] as num?)?.toInt() ?? 0;
    final joining = (plan['joining_fee_minor'] as num?)?.toInt() ?? 0;
    final amount = (plan['join_minor'] as num?)?.toInt() ?? fee + joining;
    final term = (plan['term_months'] as num?)?.toInt();
    final lines = [
      '${money(fee)}${term != null && term > 0 ? ' for $term month${term == 1 ? '' : 's'}' : ''}'
          '${joining > 0 ? ' + ${money(joining)} joining fee' : ''}',
      if (plan['includes_classes'] == true) 'Includes classes',
      if ((plan['description'] as String?)?.isNotEmpty == true) '${plan['description']}',
    ];
    return ListTile(
      contentPadding: EdgeInsets.zero,
      leading: const Icon(Icons.card_membership),
      title: Text('${plan['name']}'),
      subtitle: Text(lines.join('\n')),
      isThreeLine: lines.length > 1,
      trailing: online && amount >= 50
          ? FilledButton(onPressed: () => onJoin(amount), child: const Text('Join'))
          : null,
    );
  }
}

/// A payment the member went off to make and has not been confirmed yet.
class _PendingPayment extends ConsumerWidget {
  const _PendingPayment({required this.paymentId});

  final String paymentId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Padding(
      padding: const EdgeInsets.only(top: 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const ListTile(
            contentPadding: EdgeInsets.zero,
            leading: Icon(Icons.hourglass_bottom),
            title: Text('Payment started'),
            subtitle: Text('Paid already? Check it to update your membership.'),
          ),
          Wrap(
            spacing: 8,
            children: [
              FilledButton.tonal(
                onPressed: () => checkPendingPayment(context, ref),
                child: const Text('Check payment'),
              ),
              TextButton(
                onPressed: () => ref.read(pendingPaymentProvider.notifier).set(null),
                child: const Text('I did not pay'),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// Ask the server whether the payment the member went off to make went
/// through. [quiet] for the check made on coming back to the app: a member
/// who closed the payment page without paying does not need telling so.
Future<void> checkPendingPayment(BuildContext context, WidgetRef ref, {bool quiet = false}) async {
  final id = ref.read(pendingPaymentProvider);
  if (id == null) return;
  final messenger = ScaffoldMessenger.maybeOf(context);
  void say(String text) =>
      messenger?.showSnackBar(SnackBar(content: Text(text), behavior: SnackBarBehavior.floating));
  try {
    final paid = await ref.read(apiProvider).checkMembershipPayment(id);
    if (paid) {
      await ref.read(pendingPaymentProvider.notifier).set(null);
      ref
        ..invalidate(membershipProvider)
        ..invalidate(meProvider)
        ..invalidate(classesProvider);
      say('Payment received. Your membership is up to date.');
    } else if (!quiet) {
      say('That payment has not gone through yet.');
    }
  } on ApiError catch (e) {
    if (e.status == 404) await ref.read(pendingPaymentProvider.notifier).set(null);
    if (!quiet) say(e.message);
  } catch (_) {
    if (!quiet) say('That did not work. Please try again.');
  }
}
