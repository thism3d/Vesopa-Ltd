/// More: this phone, Tap to Pay, staff cards, signing out.
library;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../data/api.dart';
import '../../data/models.dart';
import '../../data/session.dart';
import '../../nfc/staff_card.dart';
import '../../payments/payment_service.dart';
import '../tap_to_pay_mark.dart';
import '../theme.dart';
import '../../data/recent_venues.dart';
import '../go_frame.dart' show VenueMark;
import 'connection_page.dart';

class MorePage extends ConsumerStatefulWidget {
  const MorePage({super.key});
  @override
  ConsumerState<MorePage> createState() => _MorePageState();
}

class _MorePageState extends ConsumerState<MorePage> {
  String? _tapStatus;

  @override
  void initState() {
    super.initState();
    ref.read(paymentsProvider).whyUnavailable().then((why) {
      if (mounted) setState(() => _tapStatus = why ?? 'Ready: cards, Apple Pay and Google Pay');
    });
  }

  /// A refund, all or part, back to the card: a manager's PIN, always.
  Future<void> _refund(RecentPayment r) async {
    final amount = TextEditingController(text: ((r.totalMinor - r.refundedMinor) / 100).toStringAsFixed(2));
    final pin = TextEditingController();
    final reason = TextEditingController(text: 'Refund');
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: Text('Refund ${r.billName}'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(controller: amount, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'Amount (£)')),
          const SizedBox(height: 10),
          TextField(controller: reason, decoration: const InputDecoration(labelText: 'Reason')),
          const SizedBox(height: 10),
          TextField(controller: pin, obscureText: true, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Manager\'s PIN')),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Refund to card')),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    final notifier = ref.read(tapProvider.notifier);
    final manager = (ref.read(tapProvider).clerk?.can(TillPermission.refund) ?? false) && pin.text.trim().isEmpty
        ? ref.read(tapProvider).clerk
        : notifier.managerByPin(pin.text.trim(), TillPermission.refund);
    if (manager == null) {
      messenger.showSnackBar(const SnackBar(content: Text('That is not a manager\'s PIN. Nothing was refunded.')));
      return;
    }
    final minor = ((double.tryParse(amount.text.trim()) ?? 0) * 100).round();
    if (ref.read(tapProvider).demo) {
      notifier.refunded(r.paymentId, r.refundedMinor + minor);
      messenger.showSnackBar(SnackBar(content: Text('Demo: refunded ${money(minor)}')));
      return;
    }
    // A Dojo Pocket's payment goes back on the Pocket, not through the server.
    final pay = ref.read(paymentsProvider);
    if (r.paymentId.startsWith('pocket:') && pay is DojoTapToPay) {
      try {
        final ok = await pay.refundOnPocket(minor);
        if (ok) notifier.refunded(r.paymentId, r.refundedMinor + minor);
        messenger.showSnackBar(SnackBar(content: Text(ok ? 'Refunded ${money(minor)} to the card' : 'The Dojo app did not refund it.')));
      } on PlatformException catch (e) {
        messenger.showSnackBar(SnackBar(content: Text(e.message ?? 'The Dojo app did not refund it.')));
      }
      return;
    }
    try {
      final res = await ref.read(apiProvider).refund(r.paymentId, amountMinor: minor, approvedBy: manager.name, reason: reason.text.trim());
      notifier.refunded(r.paymentId, (res['refunded_minor'] as num?)?.toInt() ?? r.refundedMinor + minor);
      messenger.showSnackBar(SnackBar(content: Text('Refunded ${money(minor)} to the card')));
    } on TapApiError catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  Future<void> _readCard() async {
    final id = await StaffCardReader.readOnce();
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(id == null ? 'No card read' : 'Card $id: put this under the person\'s Staff card in the back office.'),
    ));
  }

  @override
  Widget build(BuildContext context) {
    final s = ref.watch(tapProvider);
    final t = Theme.of(context).textTheme;
    return ListView(padding: const EdgeInsets.all(16), children: [
      Card(
        child: ListTile(
          // The venue's own logo (the club crest at Pontardawe RFC), Go's mark
          // when it has none.
          leading: const SizedBox(width: 48, height: 48, child: Center(child: VenueMark(height: 44, maxWidth: 48))),
          title: Text(s.venue?.name ?? ''),
          subtitle: Text(s.demo
              ? 'Demo: nothing is real'
              : s.venue?.mode == VenueMode.standalone
                  ? 'Vesopa Go on its own'
                  : 'With Vesopa EPOS'),
        ),
      ),
      const SizedBox(height: 12),
      _TapToPayCard(status: _tapStatus),
      const SizedBox(height: 12),
      Card(
        child: ListTile(
          leading: const Icon(Icons.badge_rounded),
          title: const Text('Read a staff card'),
          subtitle: const Text('Find a card or fob\'s id to give someone in the back office'),
          onTap: _readCard,
        ),
      ),
      const SizedBox(height: 12),
      Card(
        child: ListTile(
          leading: const Icon(Icons.sync_rounded),
          title: const Text('Refresh staff and menu'),
          subtitle: Text([
            s.online ? 'Up to date with the back office' : 'Offline: showing the last copy',
            if (s.pendingSync > 0) '${s.pendingSync} waiting to send',
          ].join(' · ')),
          onTap: () => ref.read(tapProvider.notifier).refresh(),
        ),
      ),
      const SizedBox(height: 12),
      Card(
        child: ListTile(
          leading: const Icon(Icons.router_rounded),
          title: const Text('Network and hardware'),
          subtitle: const Text('Wi-Fi, the back office, the venue network, the card reader and printer'),
          trailing: const Icon(Icons.chevron_right_rounded),
          onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const ConnectionPage())),
        ),
      ),
      if (s.recent.isNotEmpty) ...[
        const SizedBox(height: 20),
        Text('Card payments on this phone', style: t.titleMedium),
        const SizedBox(height: 8),
        for (final r in s.recent)
          Card(
            child: ListTile(
              title: Text('${r.billName} · ${money(r.totalMinor)}'),
              subtitle: Text('${TimeOfDay.fromDateTime(r.at).format(context)} · ${r.clerk}'
                  '${r.refundedMinor > 0 ? ' · refunded ${money(r.refundedMinor)}' : ''}'),
              trailing: r.refundedMinor >= r.totalMinor ? const Text('Refunded') : const Icon(Icons.undo_rounded),
              onTap: r.refundedMinor >= r.totalMinor ? null : () => _refund(r),
            ),
          ),
      ],
      const SizedBox(height: 24),
      OutlinedButton.icon(
        onPressed: () => ref.read(tapProvider.notifier).lock(),
        icon: const Icon(Icons.lock_rounded),
        label: const Text('Sign off'),
      ),
      const SizedBox(height: 10),
      if (!s.demo)
        OutlinedButton.icon(
          onPressed: () async {
            if (s.pendingSync > 0) {
              // Never switch away from sales the back office has not had yet.
              ScaffoldMessenger.of(context).showSnackBar(SnackBar(
                content: Text('${s.pendingSync} sales are still waiting to send. Switch once they have (Refresh staff and menu).'),
              ));
              return;
            }
            final ok = await showDialog<bool>(
              context: context,
              builder: (c) => AlertDialog(
                title: const Text('Switch venue or account?'),
                content: Text('This phone signs out of ${s.venue?.name ?? 'this venue'} and gives its till licence back. '
                    'Then choose the Vesopa account and venue to sign in to.'),
                actions: [
                  TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
                  FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Switch')),
                ],
              ),
            );
            if (ok != true) return;
            RecentVenues.switchOnOpen = true;
            await ref.read(tapProvider.notifier).forgetPhone();
          },
          icon: const Icon(Icons.switch_account_rounded),
          label: const Text('Switch venue or account'),
        ),
      const SizedBox(height: 10),
      TextButton(
        onPressed: () async {
          final ok = await showDialog<bool>(
            context: context,
            builder: (c) => AlertDialog(
              title: const Text('Sign this phone out of the venue?'),
              content: const Text('It stops being one of the venue\'s tills. A manager signs it in again with Vesopa.'),
              actions: [
                TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
                FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Sign out')),
              ],
            ),
          );
          if (ok == true) await ref.read(tapProvider.notifier).forgetPhone();
        },
        child: Text('Sign this phone out of ${s.venue?.name ?? 'the venue'}', style: t.bodyMedium?.copyWith(color: Tp.danger)),
      ),
    ]);
  }
}

/// Tap to Pay on iPhone in Settings, as Apple's guidelines ask: set it up
/// (Apple's terms, accepted by the venue's account holder) before the first
/// customer, see whether it is ready, and Apple's own guide to taking a
/// payment, always here. The guide opens by itself after the first set-up.
class _TapToPayCard extends ConsumerStatefulWidget {
  const _TapToPayCard({this.status});
  final String? status;

  @override
  ConsumerState<_TapToPayCard> createState() => _TapToPayCardState();
}

class _TapToPayCardState extends ConsumerState<_TapToPayCard> {
  bool? _linked;
  bool _busy = false;
  String? _note;

  bool get _iPhone => !kIsWeb && defaultTargetPlatform == TargetPlatform.iOS;

  @override
  void initState() {
    super.initState();
    final pay = ref.read(paymentsProvider);
    if (pay is DojoTapToPay && _iPhone) {
      pay.isLinked().then((v) {
        if (mounted) setState(() => _linked = v);
      });
    }
  }

  Future<void> _setUp() async {
    final pay = ref.read(paymentsProvider);
    if (pay is! DojoTapToPay) return;
    setState(() {
      _busy = true;
      _note = 'Setting up Tap to Pay on iPhone…';
    });
    final why = await pay.setUp();
    if (!mounted) return;
    setState(() {
      _busy = false;
      _note = why ?? 'Ready. Customers can tap a card, phone or watch on the top of this iPhone.';
      if (why == null) _linked = true;
    });
    if (why == null) {
      final p = await SharedPreferences.getInstance();
      if (p.getBool('go_ttp_guide_seen') != true) {
        await p.setBool('go_ttp_guide_seen', true);
        await _guide();
      }
    }
  }

  Future<void> _guide() async {
    final pay = ref.read(paymentsProvider);
    if (pay is! DojoTapToPay) return;
    final why = await pay.showGuide();
    if (why != null && mounted) setState(() => _note = why);
    // Apple (HIG, Educating merchants): at the end of the tutorial, a chance
    // to accept the terms for whoever has not yet.
    if (why == null && mounted && _linked != true) {
      final go = await showDialog<bool>(
        context: context,
        builder: (c) => AlertDialog(
          title: const Text('Set up Tap to Pay on iPhone?'),
          content: const Text("A manager accepts Apple's Tap to Pay terms once, then any iPhone at the venue can take payments."),
          actions: [
            TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Not now')),
            FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Set up')),
          ],
        ),
      );
      if (go == true && mounted) await _setUp();
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final tablet = MediaQuery.sizeOf(context).shortestSide >= 600;
    if (!_iPhone || tablet) {
      return Card(
        child: ListTile(
          leading: Icon(Icons.contactless_rounded, color: context.goLimeInk),
          title: const Text('Tap to Pay'),
          subtitle: Text(_iPhone
              ? 'Tap to Pay on iPhone works on iPhone only, not iPad. Use the card machine or QR Pay here.'
              : (widget.status ?? 'Checking…')),
        ),
      );
    }
    return Card(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            TapToPayMark(size: 30, color: context.goLimeInk),
            const SizedBox(width: 14),
            Expanded(child: Text('Tap to Pay on iPhone', style: t.titleMedium?.copyWith(fontWeight: FontWeight.w700))),
          ]),
          const SizedBox(height: 8),
          Text(
            _linked == true
                ? 'Set up. Customers tap a contactless card, iPhone, Android phone or watch on the top of this iPhone.'
                : _linked == false
                    ? "Not set up yet. The venue's account holder accepts Apple's terms once, then any iPhone at the venue can take payments."
                    : (widget.status ?? 'Checking…'),
            style: t.bodyMedium,
          ),
          if (_note != null) Padding(padding: const EdgeInsets.only(top: 6), child: Text(_note!, style: t.bodySmall?.copyWith(color: context.goMuted))),
          const SizedBox(height: 12),
          Wrap(spacing: 10, runSpacing: 10, children: [
            if (_linked != true)
              FilledButton.icon(
                onPressed: _busy ? null : _setUp,
                icon: const TapToPayMark(size: 20),
                label: const Text('Set up Tap to Pay on iPhone'),
              ),
            OutlinedButton.icon(
              onPressed: _guide,
              icon: const Icon(Icons.school_rounded),
              label: const Text('How to use Tap to Pay on iPhone'),
            ),
          ]),
        ]),
      ),
    );
  }
}
