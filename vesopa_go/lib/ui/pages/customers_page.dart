/// Customers, as the till's Customer key: search by name, phone, email or
/// card; add one (into the venue's loyalty scheme); change their name, phone
/// or email; and put them on the sale, which brings their loyalty points and
/// discount with them (`/till/customers`, as vesopa_epos customer_repository).
library;

import 'dart:async';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../counter/data/lite_state.dart';
import '../../data/api.dart';
import '../../data/models.dart';
import '../../data/session.dart';
import '../clerk_chip.dart' show initialsOf;
import '../product_photo.dart' show photoUrl;
import '../../nfc/card_read_sheet.dart';
import '../theme.dart';

/// One customer as `/till/customers` answers.
@immutable
class GoCustomer {
  const GoCustomer({required this.id, required this.name, this.phone, this.email, this.memberNumber, this.points = 0, this.schemeName, this.photo, this.expiry, this.discount = ''});
  final String id;
  final String name;
  final String? phone;
  final String? email;
  final String? memberNumber;
  final int points;
  final String? schemeName;
  final String? photo;
  final DateTime? expiry;
  final String discount;

  bool get expired {
    final e = expiry;
    if (e == null) return false;
    final now = DateTime.now();
    return e.isBefore(DateTime(now.year, now.month, now.day));
  }

  factory GoCustomer.fromJson(Map<String, dynamic> j) {
    final type = j['discount_type'] as String? ?? 'none';
    // The server's DECIMAL columns arrive as text ("0.00000"): read either.
    num n(Object? v) => v is num ? v : num.tryParse('${v ?? ''}') ?? 0;
    final value = n(j['discount_value']).toInt();
    final expiry = '${j['membership_expiry'] ?? ''}';
    return GoCustomer(
      id: '${j['id']}',
      name: j['name'] as String? ?? '',
      phone: j['phone'] as String?,
      email: j['email'] as String?,
      memberNumber: '${j['member_number'] ?? ''}'.trim().isEmpty ? null : '${j['member_number']}'.trim(),
      points: n(j['points_balance']).floor(),
      schemeName: j['scheme_name'] as String?,
      photo: j['photo_url'] as String?,
      expiry: expiry.length >= 10 ? DateTime.tryParse(expiry.substring(0, 10)) : null,
      discount: switch (type) { 'percent' when value > 0 => '$value% off', 'amount' when value > 0 => '${money(value)} off', _ => '' },
    );
  }
}

class CustomersPage extends ConsumerStatefulWidget {
  const CustomersPage({super.key, this.billId});

  /// The sale to put the customer on; the current counter sale when null.
  final String? billId;
  @override
  ConsumerState<CustomersPage> createState() => _CustomersPageState();
}

class _CustomersPageState extends ConsumerState<CustomersPage> {
  final _q = TextEditingController();
  Timer? _debounce;
  List<GoCustomer> _found = const [];
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _search();
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _q.dispose();
    super.dispose();
  }

  Future<void> _search() async {
    if (ref.read(tapProvider).demo) {
      setState(() => _found = const [GoCustomer(id: 'demo-1', name: 'Rhys Morgan', phone: '07700 900123', memberNumber: 'VK1001', points: 240, schemeName: 'Vesopa Kitchen Rewards')]);
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final rows = await ref.read(apiProvider).customers(_q.text);
      if (mounted) setState(() => _found = [for (final r in rows) GoCustomer.fromJson(Map<String, dynamic>.from(r as Map))]);
    } on TapApiError catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (e) {
      // A row Go could not read says so, rather than "Nobody matches".
      if (mounted) setState(() => _error = 'Could not read the customers ($e).');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _typed(String _) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 300), _search);
  }

  /// A member's card tapped, or the code on it or in their app scanned.
  /// Found: straight onto the sale. Not found: searched for, so the clerk
  /// sees why.
  Future<void> _scanCard() async {
    final code = await readCard(
      context,
      title: 'Scan or tap their card',
      hint: 'Hold their card against the back of the phone',
      cameraHint: 'The code on their card, or the one their app shows',
    );
    if (code == null || !mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    if (!ref.read(tapProvider).demo) {
      try {
        final member = await ref.read(apiProvider).member(code);
        if (!mounted) return;
        final billId = widget.billId ?? ref.read(currentSaleProvider.notifier).ensure();
        ref.read(tapProvider.notifier).setMember(billId, member);
        Navigator.of(context).maybePop();
        messenger.showSnackBar(SnackBar(content: Text('${member.name} is on the sale')));
        return;
      } on TapApiError catch (_) {
        // Not a member number: look for it as a name, phone or card instead.
      }
    }
    if (!mounted) return;
    _q.text = code;
    await _search();
  }

  /// Onto the sale, with their loyalty account (points, discount) as the till does.
  Future<void> _attach(GoCustomer c) async {
    final messenger = ScaffoldMessenger.of(context);
    if (c.expired) {
      messenger.showSnackBar(SnackBar(content: Text('${c.name}\'s membership has run out. Renew it before they use it.')));
      return;
    }
    final number = c.memberNumber;
    if (number == null) {
      messenger.showSnackBar(SnackBar(content: Text('${c.name} has no loyalty card yet.')));
      return;
    }
    final billId = widget.billId ?? ref.read(currentSaleProvider.notifier).ensure();
    try {
      final member = ref.read(tapProvider).demo
          ? Member(id: c.id, name: c.name, number: number, pointsBalance: c.points.toDouble())
          : await ref.read(apiProvider).member(number);
      ref.read(tapProvider.notifier).setMember(billId, member);
      if (mounted) {
        Navigator.of(context).maybePop();
        messenger.showSnackBar(SnackBar(content: Text('${c.name} is on the sale · ${c.points} points')));
      }
    } on TapApiError catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  Future<void> _editor({GoCustomer? c}) async {
    final name = TextEditingController(text: c?.name ?? '');
    final phone = TextEditingController(text: c?.phone ?? '');
    final email = TextEditingController(text: c?.email ?? '');
    var marketing = false;
    final ok = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (s) => StatefulBuilder(
        builder: (s, set) => Padding(
          padding: EdgeInsets.fromLTRB(20, 0, 20, 20 + MediaQuery.viewInsetsOf(s).bottom),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text(c == null ? 'New customer' : 'Edit ${c.name}', style: Theme.of(s).textTheme.titleLarge),
            const SizedBox(height: 12),
            TextField(controller: name, autofocus: true, textCapitalization: TextCapitalization.words, decoration: const InputDecoration(labelText: 'Name')),
            const SizedBox(height: 10),
            TextField(controller: phone, keyboardType: TextInputType.phone, decoration: const InputDecoration(labelText: 'Mobile')),
            const SizedBox(height: 10),
            TextField(controller: email, keyboardType: TextInputType.emailAddress, decoration: const InputDecoration(labelText: 'Email')),
            if (c == null)
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text('Happy to hear about offers'),
                value: marketing,
                onChanged: (v) => set(() => marketing = v),
              ),
            const SizedBox(height: 12),
            FilledButton(onPressed: () => Navigator.pop(s, true), child: Text(c == null ? 'Add and join loyalty' : 'Save')),
          ]),
        ),
      ),
    );
    if (ok != true || name.text.trim().isEmpty || !mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    if (ref.read(tapProvider).demo) {
      messenger.showSnackBar(const SnackBar(content: Text('Demo: customers are not saved')));
      return;
    }
    try {
      final api = ref.read(apiProvider);
      if (c == null) {
        await api.createCustomer(name: name.text.trim(), phone: phone.text.trim(), email: email.text.trim(), marketing: marketing);
        _q.text = name.text.trim();
      } else {
        await api.updateCustomer(c.id, name: name.text.trim(), phone: phone.text.trim(), email: email.text.trim());
      }
      await _search();
    } on TapApiError catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Scaffold(
      appBar: widget.billId == null ? null : AppBar(title: const Text('Customer')),
      floatingActionButton: FloatingActionButton.extended(onPressed: () => _editor(), icon: const Icon(Icons.person_add_alt_1_rounded), label: const Text('New customer')),
      body: Column(children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
          child: TextField(
            controller: _q,
            onChanged: _typed,
            textInputAction: TextInputAction.search,
            onSubmitted: (_) => _search(),
            decoration: InputDecoration(
              prefixIcon: const Icon(Icons.search_rounded),
              hintText: 'Name, mobile, email or card number',
              // Their card or the code their app shows: tapped or scanned,
              // and they are on the sale (2026-11-16).
              suffixIcon: _busy
                  ? const Padding(padding: EdgeInsets.all(14), child: SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)))
                  : IconButton(tooltip: 'Scan or tap their card', onPressed: _scanCard, icon: const Icon(Icons.qr_code_scanner_rounded)),
            ),
          ),
        ),
        if (_error != null) Padding(padding: const EdgeInsets.all(12), child: Text(_error!, style: t.bodyMedium?.copyWith(color: Tp.danger))),
        Expanded(
          child: _found.isEmpty && !_busy
              ? Center(child: Text(_q.text.isEmpty ? 'Search for a customer' : 'Nobody matches', style: t.bodyLarge))
              : ListView.separated(
                  padding: const EdgeInsets.only(bottom: 96),
                  itemCount: _found.length,
                  separatorBuilder: (_, _) => const Divider(height: 1, indent: 16, endIndent: 16),
                  itemBuilder: (_, i) => _CustomerRow(
                    customer: _found[i],
                    onEdit: () => _editor(c: _found[i]),
                    onAttach: () => _attach(_found[i]),
                  ),
                ),
        ),
      ]),
    );
  }
}

/// One customer. Wide screens keep the buttons on the right; on a small phone
/// they sit under the name at full width, so the name is never squeezed and
/// both buttons stay a full finger tall (the owner, 2026-11-16).
class _CustomerRow extends StatelessWidget {
  const _CustomerRow({required this.customer, required this.onEdit, required this.onAttach});
  final GoCustomer customer;
  final VoidCallback onEdit;
  final VoidCallback onAttach;

  @override
  Widget build(BuildContext context) {
    final c = customer;
    final t = Theme.of(context).textTheme;
    final details = [
      if (c.memberNumber != null) c.memberNumber!,
      if (c.phone != null && c.phone!.isNotEmpty) c.phone!,
      if (c.schemeName != null) '${c.points} points',
      if (c.discount.isNotEmpty) c.discount,
      if (c.expired) 'Membership ended',
    ].join(' · ');
    final who = Row(children: [
      CircleAvatar(
        radius: 22,
        backgroundColor: context.goRaised,
        foregroundImage: c.photo == null || c.photo!.isEmpty ? null : CachedNetworkImageProvider(photoUrl(c.photo!)),
        child: Text(initialsOf(c.name)),
      ),
      const SizedBox(width: 12),
      Expanded(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(c.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: t.titleMedium?.copyWith(fontWeight: FontWeight.w700)),
          if (details.isNotEmpty)
            Text(details, maxLines: 2, overflow: TextOverflow.ellipsis, style: t.bodyMedium?.copyWith(color: c.expired ? Tp.danger : context.goMuted)),
        ]),
      ),
    ]);
    final edit = OutlinedButton.icon(onPressed: onEdit, icon: const Icon(Icons.edit_rounded, size: 18), label: const Text('Edit'));
    final attach = FilledButton.icon(onPressed: onAttach, icon: const Icon(Icons.add_rounded, size: 18), label: const Text('Add to sale'));
    return LayoutBuilder(
      builder: (context, box) {
        final narrow = box.maxWidth < 520 || MediaQuery.textScalerOf(context).scale(1) > 1.3;
        return Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
          child: narrow
              ? Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                  who,
                  const SizedBox(height: 10),
                  Row(children: [
                    Expanded(child: edit),
                    const SizedBox(width: 10),
                    Expanded(flex: 2, child: attach),
                  ]),
                ])
              : Row(children: [
                  Expanded(child: who),
                  const SizedBox(width: 12),
                  edit,
                  const SizedBox(width: 8),
                  attach,
                ]),
        );
      },
    );
  }
}
