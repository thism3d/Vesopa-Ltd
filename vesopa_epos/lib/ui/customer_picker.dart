import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/customer_repository.dart';
import '../main.dart';
import 'theme.dart';
import 'widgets/pos_message.dart';

final customerRepoProvider = Provider<CustomerRepository>(
  (ref) => CustomerRepository(
    apiBase: ref.watch(apiBaseProvider),
    office: ref.watch(officeProvider),
  ),
);

/// Attach a customer to the current sale. Search the venue's customers, pick
/// one, or add a new one on the spot. Returns the chosen customer, or null.
Future<TillCustomer?> pickCustomer(BuildContext context, WidgetRef ref) {
  return showModalBottomSheet<TillCustomer>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (_) => const _CustomerPicker(),
  );
}

class _CustomerPicker extends ConsumerStatefulWidget {
  const _CustomerPicker();

  @override
  ConsumerState<_CustomerPicker> createState() => _CustomerPickerState();
}

class _CustomerPickerState extends ConsumerState<_CustomerPicker> {
  final _search = TextEditingController();
  List<TillCustomer> _results = [];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _query('');
  }

  Future<void> _query(String q) async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final results = await ref.read(customerRepoProvider).search(q);
      if (mounted) {
        setState(() {
          _results = results;
          _loading = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = '$e';
          _loading = false;
        });
      }
    }
  }

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(
        bottom: MediaQuery.of(context).viewInsets.bottom,
      ),
      child: SizedBox(
        height: MediaQuery.of(context).size.height * 0.7,
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
              child: Row(
                children: [
                  const Text(
                    'Customer',
                    style:
                        TextStyle(fontSize: 18, fontWeight: FontWeight.w700),
                  ),
                  const Spacer(),
                  TextButton.icon(
                    onPressed: _addNew,
                    icon: const Icon(Icons.person_add),
                    label: const Text('New'),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: TextField(
                controller: _search,
                autofocus: true,
                onChanged: _query,
                decoration: const InputDecoration(
                  hintText: 'Search name, phone or email',
                  prefixIcon: Icon(Icons.search),
                  border: OutlineInputBorder(),
                ),
              ),
            ),
            const SizedBox(height: 8),
            Expanded(
              child: _loading
                  ? const Center(child: CircularProgressIndicator())
                  : _error != null
                      ? Center(
                          child: Padding(
                            padding: const EdgeInsets.all(24),
                            child: Text(
                              'Customers need the network.\n$_error',
                              textAlign: TextAlign.center,
                              style:
                                  TextStyle(color: Theme.of(context).hintColor),
                            ),
                          ),
                        )
                      : _results.isEmpty
                          ? const Center(child: Text('No customers found.'))
                          : ListView.builder(
                              itemCount: _results.length,
                              itemBuilder: (context, i) {
                                final c = _results[i];
                                return ListTile(
                                  leading: CircleAvatar(
                                    backgroundColor: Pos.brandSoft,
                                    child: Text(
                                      c.name.isNotEmpty
                                          ? c.name[0].toUpperCase()
                                          : '?',
                                      style:
                                          const TextStyle(color: Pos.brandDeep),
                                    ),
                                  ),
                                  title: Text(c.name),
                                  subtitle: Text(
                                    [c.phone, c.email]
                                        .where((s) => s?.isNotEmpty ?? false)
                                        .join(' · '),
                                  ),
                                  trailing: c.hasDiscount
                                      ? Chip(
                                          label: Text(c.discountLabel),
                                          backgroundColor: Pos.brandSoft,
                                          labelStyle: const TextStyle(
                                            color: Pos.brandDeep,
                                            fontSize: 12,
                                          ),
                                        )
                                      : null,
                                  onTap: () => Navigator.pop(context, c),
                                );
                              },
                            ),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _addNew() async {
    final created = await showDialog<TillCustomer>(
      context: context,
      builder: (_) => const _NewCustomerDialog(),
    );
    if (created != null && mounted) Navigator.pop(context, created);
  }
}

class _NewCustomerDialog extends ConsumerStatefulWidget {
  const _NewCustomerDialog();

  @override
  ConsumerState<_NewCustomerDialog> createState() => _NewCustomerDialogState();
}

class _NewCustomerDialogState extends ConsumerState<_NewCustomerDialog> {
  final _name = TextEditingController();
  final _phone = TextEditingController();
  final _email = TextEditingController();
  final _discount = TextEditingController();
  String _discountType = 'none';
  bool _busy = false;

  @override
  void dispose() {
    _name.dispose();
    _phone.dispose();
    _email.dispose();
    _discount.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('New customer'),
      content: SizedBox(
        width: 380,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                controller: _name,
                autofocus: true,
                decoration: const InputDecoration(labelText: 'Name'),
              ),
              TextField(
                controller: _phone,
                keyboardType: TextInputType.phone,
                decoration: const InputDecoration(labelText: 'Phone'),
              ),
              TextField(
                controller: _email,
                keyboardType: TextInputType.emailAddress,
                decoration: const InputDecoration(labelText: 'Email'),
              ),
              const SizedBox(height: 12),
              Row(
                children: [
                  Expanded(
                    child: DropdownButtonFormField<String>(
                      initialValue: _discountType,
                      decoration:
                          const InputDecoration(labelText: 'Discount'),
                      items: const [
                        DropdownMenuItem(value: 'none', child: Text('None')),
                        DropdownMenuItem(
                            value: 'percent', child: Text('Percent %')),
                        DropdownMenuItem(
                            value: 'amount', child: Text('Amount £')),
                      ],
                      onChanged: (v) =>
                          setState(() => _discountType = v ?? 'none'),
                    ),
                  ),
                  if (_discountType != 'none') ...[
                    const SizedBox(width: 12),
                    SizedBox(
                      width: 90,
                      child: TextField(
                        controller: _discount,
                        keyboardType: const TextInputType.numberWithOptions(
                            decimal: true),
                        decoration: InputDecoration(
                          labelText: _discountType == 'percent' ? '%' : '£',
                        ),
                      ),
                    ),
                  ],
                ],
              ),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: _busy ? null : () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: _busy ? null : _save,
          child: _busy
              ? const SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Text('Add'),
        ),
      ],
    );
  }

  Future<void> _save() async {
    if (_name.text.trim().isEmpty) return;
    setState(() => _busy = true);

    // A percent is stored whole; an amount is stored in pence.
    final raw = double.tryParse(_discount.text.trim()) ?? 0;
    final value = _discountType == 'amount' ? (raw * 100).round() : raw.round();

    try {
      final repo = ref.read(customerRepoProvider);
      final id = await repo.create(
        name: _name.text.trim(),
        phone: _phone.text.trim().isEmpty ? null : _phone.text.trim(),
        email: _email.text.trim().isEmpty ? null : _email.text.trim(),
        discountType: _discountType,
        discountValue: value,
      );
      if (mounted) {
        Navigator.pop(
          context,
          TillCustomer(
            id: id,
            name: _name.text.trim(),
            phone: _phone.text.trim(),
            email: _email.text.trim(),
            discountType: _discountType,
            discountValue: value,
          ),
        );
      }
    } catch (e) {
      if (mounted) {
        setState(() => _busy = false);
        PosMessenger.error(context, '$e');
      }
    }
  }
}
