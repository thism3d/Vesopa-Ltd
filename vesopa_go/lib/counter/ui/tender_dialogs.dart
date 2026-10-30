/// The till's tender dialogs on Go (vesopa_epos lib/ui/redemption_dialogs.dart
/// and the payment page's keys), as the owner asked on 2026-10-30: a gift
/// card or a deposit taken towards the bill, the gratuity, and a customer
/// found as their name is typed. Through the till's own routes
/// (vesopa_server src/commerce.js), so the back office sees the same thing.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/api.dart';
import '../../data/models.dart';
import '../../data/session.dart';
import '../../ui/pages/customers_page.dart' show GoCustomer;
import '../../ui/theme.dart';

/// A money tender found by a code (a gift card or a deposit): look it up,
/// show what it holds, take up to what is due. Answers what was taken.
Future<int?> askCodeTender(
  BuildContext context,
  WidgetRef ref, {
  required String kind,
  required int dueMinor,
  required String billId,
}) =>
    showDialog<int>(context: context, builder: (_) => _CodeTender(kind: kind, dueMinor: dueMinor, billId: billId));

class _CodeTender extends ConsumerStatefulWidget {
  const _CodeTender({required this.kind, required this.dueMinor, required this.billId});

  /// `giftcard` or `deposit`, as the till's tender methods.
  final String kind;
  final int dueMinor;
  final String billId;

  @override
  ConsumerState<_CodeTender> createState() => _CodeTenderState();
}

class _CodeTenderState extends ConsumerState<_CodeTender> {
  final _code = TextEditingController();
  Map<String, dynamic>? _found;
  String? _error;
  bool _busy = false;

  bool get _gift => widget.kind == 'giftcard';

  int get _available {
    final f = _found;
    if (f == null) return 0;
    num n(Object? v) => v is num ? v : num.tryParse('${v ?? ''}') ?? 0;
    return _gift
        ? n(f['available_minor'] ?? f['balance_minor']).toInt()
        : (n(f['amount_minor']) - n(f['redeemed_minor'])).toInt();
  }

  Future<void> _look() async {
    final code = _code.text.trim();
    if (code.isEmpty) return;
    setState(() {
      _busy = true;
      _error = null;
      _found = null;
    });
    try {
      final f = _gift ? await ref.read(apiProvider).giftCard(code) : await ref.read(apiProvider).deposit(code);
      if (mounted) setState(() => _found = f);
    } on TapApiError catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _take() async {
    final amount = _available < widget.dueMinor ? _available : widget.dueMinor;
    if (amount <= 0) return;
    setState(() => _busy = true);
    try {
      final api = ref.read(apiProvider);
      final code = _code.text.trim();
      final taken = _gift
          ? await api.redeemGiftCard(code, amountMinor: amount, orderId: widget.billId, clerk: ref.read(tapProvider).clerk?.name)
          : await api.redeemDeposit(code, amountMinor: amount, orderId: widget.billId);
      if (mounted) Navigator.pop(context, taken);
    } on TapApiError catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final f = _found;
    final name = f == null ? null : '${f['recipient_name'] ?? f['customer_name'] ?? f['label'] ?? ''}'.trim();
    return AlertDialog(
      scrollable: true,
      title: Text(_gift ? 'Gift card' : 'Redeem deposit'),
      content: SizedBox(
        width: 420,
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          TextField(
            controller: _code,
            autofocus: true,
            textCapitalization: TextCapitalization.characters,
            onSubmitted: (_) => _look(),
            decoration: InputDecoration(
              labelText: _gift ? 'Gift card number' : 'Deposit reference',
              hintText: _gift ? null : 'DEP-123456',
              suffixIcon: IconButton(onPressed: _busy ? null : _look, icon: const Icon(Icons.search_rounded)),
            ),
          ),
          if (_busy) const Padding(padding: EdgeInsets.only(top: 12), child: LinearProgressIndicator()),
          if (_error != null) Padding(padding: const EdgeInsets.only(top: 10), child: Text(_error!, style: t.bodyMedium?.copyWith(color: Tp.danger))),
          if (f != null) ...[
            const SizedBox(height: 12),
            Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(color: context.goRaised, borderRadius: BorderRadius.circular(12)),
              child: Row(children: [
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(_gift ? 'On the card' : 'Held', style: t.bodySmall),
                    if (name != null && name.isNotEmpty) Text(name, style: t.bodyMedium),
                  ]),
                ),
                Text(money(_available), style: t.titleLarge?.copyWith(fontWeight: FontWeight.w800, fontFeatures: Tp.tabular)),
              ]),
            ),
          ],
        ]),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
        FilledButton(
          onPressed: _busy || _available <= 0 ? null : _take,
          child: Text('Take ${money(_available < widget.dueMinor ? _available : widget.dueMinor)}'),
        ),
      ],
    );
  }
}

/// The till's Gratuity: a percentage of the bill, none, or an amount.
/// Answers the gratuity in pence; null when cancelled.
Future<int?> askGratuity(BuildContext context, {required int onMinor, required List<double> percents, int current = 0}) =>
    showDialog<int>(context: context, builder: (_) => _Gratuity(onMinor: onMinor, percents: percents, current: current));

class _Gratuity extends StatefulWidget {
  const _Gratuity({required this.onMinor, required this.percents, required this.current});
  final int onMinor;
  final List<double> percents;
  final int current;
  @override
  State<_Gratuity> createState() => _GratuityState();
}

class _GratuityState extends State<_Gratuity> {
  late int _tip = widget.current;
  final _amount = TextEditingController();

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    String pc(double p) => p % 1 == 0 ? '${p.toInt()}%' : '$p%';
    int of(double p) => (widget.onMinor * p / 100).round();
    return AlertDialog(
      scrollable: true,
      title: const Text('Gratuity'),
      content: SizedBox(
        width: 420,
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('On ${money(widget.onMinor)}', style: t.bodySmall),
          const SizedBox(height: 12),
          Wrap(spacing: 8, runSpacing: 8, children: [
            for (final p in widget.percents)
              ChoiceChip(
                label: Text(pc(p)),
                selected: _tip == of(p) && _tip > 0,
                onSelected: (_) => setState(() {
                  _tip = of(p);
                  _amount.clear();
                }),
              ),
            ChoiceChip(
              label: const Text('None'),
              selected: _tip == 0,
              onSelected: (_) => setState(() {
                _tip = 0;
                _amount.clear();
              }),
            ),
          ]),
          const SizedBox(height: 12),
          TextField(
            controller: _amount,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            onChanged: (v) => setState(() => _tip = ((double.tryParse(v.trim()) ?? 0) * 100).round().clamp(0, 1000000)),
            decoration: const InputDecoration(labelText: 'Or a set amount', prefixText: '£ '),
          ),
          const SizedBox(height: 12),
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(color: context.goRaised, borderRadius: BorderRadius.circular(12)),
            child: Row(children: [
              Expanded(child: Text('Gratuity', style: t.bodyMedium)),
              Text(money(_tip), style: t.titleMedium?.copyWith(fontWeight: FontWeight.w800, fontFeatures: Tp.tabular)),
            ]),
          ),
        ]),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
        FilledButton(onPressed: () => Navigator.pop(context, _tip), child: const Text('Apply')),
      ],
    );
  }
}

/// The till's Attach customer: phone, name or card number, the matches as it
/// is typed. Answers the chosen customer.
Future<GoCustomer?> askCustomer(BuildContext context) => showDialog<GoCustomer>(context: context, builder: (_) => const _AttachCustomer());

class _AttachCustomer extends ConsumerStatefulWidget {
  const _AttachCustomer();
  @override
  ConsumerState<_AttachCustomer> createState() => _AttachCustomerState();
}

class _AttachCustomerState extends ConsumerState<_AttachCustomer> {
  final _q = TextEditingController();
  Timer? _debounce;
  List<GoCustomer> _found = const [];
  GoCustomer? _picked;
  String? _error;
  bool _busy = false;
  int _asked = 0;

  @override
  void dispose() {
    _debounce?.cancel();
    super.dispose();
  }

  void _typed(String _) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 250), _search);
  }

  Future<void> _search() async {
    final q = _q.text.trim();
    if (q.length < 2) {
      setState(() => _found = const []);
      return;
    }
    final ask = ++_asked;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final rows = await ref.read(apiProvider).customers(q);
      if (!mounted || ask != _asked) return;
      setState(() => _found = [for (final r in rows) GoCustomer.fromJson(Map<String, dynamic>.from(r as Map))]);
    } on TapApiError catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (e) {
      if (mounted) setState(() => _error = 'Could not read the customers ($e).');
    } finally {
      if (mounted && ask == _asked) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return AlertDialog(
      title: const Text('Attach customer'),
      content: SizedBox(
        width: 460,
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          TextField(
            controller: _q,
            autofocus: true,
            onChanged: _typed,
            onSubmitted: (_) => _search(),
            decoration: const InputDecoration(labelText: 'Phone, name or card number', suffixIcon: Icon(Icons.search_rounded)),
          ),
          if (_busy) const LinearProgressIndicator(minHeight: 2),
          if (_error != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_error!, style: t.bodySmall?.copyWith(color: Tp.danger))),
          if (_q.text.trim().length >= 2 && !_busy && _error == null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(_found.isEmpty ? 'Nobody matches' : '${_found.length} ${_found.length == 1 ? 'member matches' : 'members match'}', style: t.bodySmall),
            ),
          Flexible(
            child: ListView(shrinkWrap: true, children: [
              for (final c in _found)
                RadioListTile<GoCustomer>(
                  value: c,
                  // ignore: deprecated_member_use
                  groupValue: _picked,
                  // ignore: deprecated_member_use
                  onChanged: (v) => setState(() => _picked = v),
                  title: Text(c.name),
                  subtitle: Text([
                    if ((c.memberNumber ?? '').isNotEmpty) 'Member ${c.memberNumber}',
                    if ((c.phone ?? '').isNotEmpty) c.phone!,
                    '${c.points} pts',
                  ].join(' · ')),
                ),
            ]),
          ),
        ]),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
        FilledButton(onPressed: _picked == null ? null : () => Navigator.pop(context, _picked), child: const Text('Attach')),
      ],
    );
  }
}

/// Attach customer, as the till's key: find them, then their loyalty account
/// (points, discount) goes onto [billId].
Future<void> attachCustomer(BuildContext context, WidgetRef ref, String billId) async {
  final c = await askCustomer(context);
  if (c == null || !context.mounted) return;
  final messenger = ScaffoldMessenger.of(context);
  if (c.expired) {
    messenger.showSnackBar(SnackBar(content: Text("${c.name}'s membership has run out. Renew it before they use it.")));
    return;
  }
  final number = c.memberNumber;
  if (number == null) {
    messenger.showSnackBar(SnackBar(content: Text('${c.name} has no loyalty card yet.')));
    return;
  }
  try {
    final member = await ref.read(apiProvider).member(number);
    ref.read(tapProvider.notifier).setMember(billId, member);
    messenger.showSnackBar(SnackBar(content: Text('${c.name} is on the bill · ${c.points} points')));
  } on TapApiError catch (e) {
    messenger.showSnackBar(SnackBar(content: Text(e.message)));
  }
}

/// The till's Points: the member's balance and what it is worth, taken
/// towards the bill (up to what is due). Answers the pence taken.
Future<int?> askPoints(BuildContext context, WidgetRef ref, {required Member member, required int dueMinor, required String billId}) =>
    showDialog<int>(context: context, builder: (_) => _Points(member: member, dueMinor: dueMinor, billId: billId));

class _Points extends ConsumerStatefulWidget {
  const _Points({required this.member, required this.dueMinor, required this.billId});
  final Member member;
  final int dueMinor;
  final String billId;
  @override
  ConsumerState<_Points> createState() => _PointsState();
}

class _PointsState extends ConsumerState<_Points> {
  bool _busy = false;
  String? _error;

  int get _take => widget.member.balanceWorthMinor < widget.dueMinor ? widget.member.balanceWorthMinor : widget.dueMinor;

  Future<void> _spend() async {
    final m = widget.member;
    if (_take <= 0 || m.pointValueMinor <= 0) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(apiProvider).redeemPoints(m.id, points: _take / m.pointValueMinor, valueMinor: _take, orderId: widget.billId);
      if (mounted) Navigator.pop(context, _take);
    } on TapApiError catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final m = widget.member;
    final pts = m.pointsBalance % 1 == 0 ? m.pointsBalance.toInt().toString() : m.pointsBalance.toStringAsFixed(2);
    return AlertDialog(
      scrollable: true,
      title: const Text('Loyalty points'),
      content: SizedBox(
        width: 420,
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text(m.name, style: t.titleMedium),
          if (m.number.isNotEmpty) Text('Member ${m.number}', style: t.bodySmall),
          const SizedBox(height: 12),
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(color: context.goRaised, borderRadius: BorderRadius.circular(12)),
            child: Row(children: [
              Expanded(child: Text('$pts points', style: t.bodyLarge)),
              Text('worth ${money(m.balanceWorthMinor)}', style: t.titleMedium?.copyWith(fontWeight: FontWeight.w800, fontFeatures: Tp.tabular)),
            ]),
          ),
          if (_busy) const Padding(padding: EdgeInsets.only(top: 12), child: LinearProgressIndicator()),
          if (_error != null) Padding(padding: const EdgeInsets.only(top: 10), child: Text(_error!, style: t.bodyMedium?.copyWith(color: Tp.danger))),
        ]),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
        FilledButton(onPressed: _busy || _take <= 0 ? null : _spend, child: Text(_take <= 0 ? 'No points to spend' : 'Take ${money(_take)}')),
      ],
    );
  }
}
