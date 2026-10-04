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
        ListTile(
          contentPadding: EdgeInsets.zero,
          leading: Icon(stateIcon, color: bad ? theme.colorScheme.error : null),
          title: Text(plan != null ? planName : 'No membership'),
          subtitle: Text(membershipStateText(m)),
        ),
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
        if (m['joined_on'] != null && state != 'none')
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
      builder: (dialog) => AlertDialog(
        title: Text(kind == 'join' ? 'Join $planName' : 'Renew $planName'),
        content: Text(
          '$breakdown.\n\nYou pay on Dojo\'s secure payment page, which opens in your browser. '
          'Come back to the app when you have paid and your membership will update.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialog, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(dialog, true), child: Text('Pay ${money(amount)}')),
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
