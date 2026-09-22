import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../data/commerce.dart';
import '../data/tender_engine.dart';

String _money(int minor) =>
    NumberFormat.currency(locale: 'en_GB', symbol: '£').format(minor / 100);

/// What a redemption dialog agreed to take.
class RedemptionResult {
  const RedemptionResult({
    required this.amountMinor,
    required this.reference,
    this.customer,
    this.points = 0,
  });

  final int amountMinor;
  final String reference;
  final LoyaltyCustomer? customer;
  final int points;
}

/// Redeem a gift card.
///
/// The card is looked up before anything is taken, so a clerk finds out the
/// balance is short *before* telling the customer their card covers it. The
/// server is still the authority — this is a check, not a reservation.
Future<RedemptionResult?> showGiftCardDialog(
  BuildContext context, {
  required CommerceRepository commerce,
  required int outstandingMinor,
}) =>
    showDialog<RedemptionResult>(
      context: context,
      builder: (_) => _GiftCardDialog(
        commerce: commerce,
        outstandingMinor: outstandingMinor,
      ),
    );

class _GiftCardDialog extends StatefulWidget {
  const _GiftCardDialog({
    required this.commerce,
    required this.outstandingMinor,
  });

  final CommerceRepository commerce;
  final int outstandingMinor;

  @override
  State<_GiftCardDialog> createState() => _GiftCardDialogState();
}

class _GiftCardDialogState extends State<_GiftCardDialog> {
  final _code = TextEditingController();
  GiftCard? _card;
  String? _error;
  bool _busy = false;

  @override
  void dispose() {
    _code.dispose();
    super.dispose();
  }

  Future<void> _lookup() async {
    final code = _code.text.trim();
    if (code.isEmpty) return;
    setState(() {
      _busy = true;
      _error = null;
      _card = null;
    });
    try {
      final card = await widget.commerce.giftCard(code);
      if (!mounted) return;
      setState(() {
        _card = card;
        _error = card.redeemable
            ? null
            : card.expired
                ? 'This card has expired'
                : card.balanceMinor <= 0
                    ? 'This card has no balance left'
                    : 'This card is ${card.status}';
      });
    } on CommerceException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (_) {
      if (mounted) {
        setState(() => _error = 'Could not reach the server. Check the network.');
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final card = _card;
    // Never take more than the bill needs, nor more than the card holds.
    final take = card == null
        ? 0
        : card.balanceMinor < widget.outstandingMinor
            ? card.balanceMinor
            : widget.outstandingMinor;

    return AlertDialog(
      title: const Text('Gift card'),
      content: SizedBox(
        width: 380,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            TextField(
              controller: _code,
              autofocus: true,
              textCapitalization: TextCapitalization.characters,
              decoration: InputDecoration(
                labelText: 'Card code',
                hintText: 'ABCD-EFGH-JKLM',
                suffixIcon: IconButton(
                  icon: _busy
                      ? const SizedBox(
                          width: 18, height: 18,
                          child: CircularProgressIndicator(strokeWidth: 2))
                      : const Icon(Icons.search),
                  onPressed: _busy ? null : _lookup,
                ),
              ),
              onSubmitted: (_) => _lookup(),
            ),
            if (_error != null) ...[
              const SizedBox(height: 12),
              _Banner(message: _error!, isError: true),
            ],
            if (card != null && card.redeemable) ...[
              const SizedBox(height: 14),
              _BalanceCard(
                title: 'Balance on card',
                amountMinor: card.balanceMinor,
                subtitle: card.recipientName,
              ),
              const SizedBox(height: 8),
              _Banner(
                message: take < widget.outstandingMinor
                    ? 'Takes ${_money(take)} — '
                        '${_money(widget.outstandingMinor - take)} still to pay'
                    : 'Takes ${_money(take)} and settles the bill',
                isError: false,
              ),
            ],
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: card != null && card.redeemable && take > 0
              ? () => Navigator.pop(
                    context,
                    RedemptionResult(amountMinor: take, reference: card.code),
                  )
              : null,
          child: Text(take > 0 ? 'Take ${_money(take)}' : 'Take'),
        ),
      ],
    );
  }
}

/// Apply a voucher. The server decides whether it is valid and what it is
/// worth, so expiry and usage rules cannot be bypassed from the till.
Future<RedemptionResult?> showVoucherDialog(
  BuildContext context, {
  required CommerceRepository commerce,
  required int subtotalMinor,
}) =>
    showDialog<RedemptionResult>(
      context: context,
      builder: (_) => _VoucherDialog(
        commerce: commerce,
        subtotalMinor: subtotalMinor,
      ),
    );

class _VoucherDialog extends StatefulWidget {
  const _VoucherDialog({required this.commerce, required this.subtotalMinor});

  final CommerceRepository commerce;
  final int subtotalMinor;

  @override
  State<_VoucherDialog> createState() => _VoucherDialogState();
}

class _VoucherDialogState extends State<_VoucherDialog> {
  final _code = TextEditingController();
  VoucherCheck? _check;
  String? _error;
  bool _busy = false;

  @override
  void dispose() {
    _code.dispose();
    super.dispose();
  }

  Future<void> _validate() async {
    final code = _code.text.trim();
    if (code.isEmpty) return;
    setState(() {
      _busy = true;
      _error = null;
      _check = null;
    });
    try {
      final check = await widget.commerce.checkVoucher(
        code: code,
        subtotalMinor: widget.subtotalMinor,
      );
      if (!mounted) return;
      setState(() {
        _check = check;
        _error = check.valid ? null : check.problem;
      });
    } on CommerceException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (_) {
      if (mounted) setState(() => _error = 'Could not reach the server.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final check = _check;
    return AlertDialog(
      title: const Text('Voucher'),
      content: SizedBox(
        width: 380,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            TextField(
              controller: _code,
              autofocus: true,
              textCapitalization: TextCapitalization.characters,
              decoration: InputDecoration(
                labelText: 'Voucher code',
                suffixIcon: IconButton(
                  icon: _busy
                      ? const SizedBox(
                          width: 18, height: 18,
                          child: CircularProgressIndicator(strokeWidth: 2))
                      : const Icon(Icons.search),
                  onPressed: _busy ? null : _validate,
                ),
              ),
              onSubmitted: (_) => _validate(),
            ),
            if (_error != null) ...[
              const SizedBox(height: 12),
              _Banner(message: _error!, isError: true),
            ],
            if (check != null && check.valid) ...[
              const SizedBox(height: 14),
              _BalanceCard(
                title: check.name ?? 'Voucher',
                amountMinor: check.discountMinor,
                subtitle: 'Comes off the bill',
              ),
            ],
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: check != null && check.valid && check.discountMinor > 0
              ? () => Navigator.pop(
                    context,
                    RedemptionResult(
                      amountMinor: check.discountMinor,
                      reference: check.code,
                    ),
                  )
              : null,
          child: const Text('Apply'),
        ),
      ],
    );
  }
}

/// Redeem a deposit taken earlier against this bill.
Future<RedemptionResult?> showDepositDialog(
  BuildContext context, {
  required CommerceRepository commerce,
  required int outstandingMinor,
}) =>
    showDialog<RedemptionResult>(
      context: context,
      builder: (_) => _DepositDialog(
        commerce: commerce,
        outstandingMinor: outstandingMinor,
      ),
    );

class _DepositDialog extends StatefulWidget {
  const _DepositDialog({
    required this.commerce,
    required this.outstandingMinor,
  });

  final CommerceRepository commerce;
  final int outstandingMinor;

  @override
  State<_DepositDialog> createState() => _DepositDialogState();
}

class _DepositDialogState extends State<_DepositDialog> {
  final _reference = TextEditingController();
  Deposit? _deposit;
  String? _error;
  bool _busy = false;

  @override
  void dispose() {
    _reference.dispose();
    super.dispose();
  }

  Future<void> _lookup() async {
    final reference = _reference.text.trim();
    if (reference.isEmpty) return;
    setState(() {
      _busy = true;
      _error = null;
      _deposit = null;
    });
    try {
      final deposit = await widget.commerce.deposit(reference);
      if (!mounted) return;
      setState(() {
        _deposit = deposit;
        _error = deposit.redeemable
            ? null
            : 'This deposit is ${deposit.status}';
      });
    } on CommerceException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (_) {
      if (mounted) setState(() => _error = 'Could not reach the server.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final deposit = _deposit;
    final take = deposit == null
        ? 0
        : deposit.remainingMinor < widget.outstandingMinor
            ? deposit.remainingMinor
            : widget.outstandingMinor;

    return AlertDialog(
      title: const Text('Redeem deposit'),
      content: SizedBox(
        width: 380,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            TextField(
              controller: _reference,
              autofocus: true,
              textCapitalization: TextCapitalization.characters,
              decoration: InputDecoration(
                labelText: 'Deposit reference',
                hintText: 'DEP-123456',
                suffixIcon: IconButton(
                  icon: _busy
                      ? const SizedBox(
                          width: 18, height: 18,
                          child: CircularProgressIndicator(strokeWidth: 2))
                      : const Icon(Icons.search),
                  onPressed: _busy ? null : _lookup,
                ),
              ),
              onSubmitted: (_) => _lookup(),
            ),
            if (_error != null) ...[
              const SizedBox(height: 12),
              _Banner(message: _error!, isError: true),
            ],
            if (deposit != null && deposit.redeemable) ...[
              const SizedBox(height: 14),
              _BalanceCard(
                title: deposit.customerName ?? 'Deposit',
                amountMinor: deposit.remainingMinor,
                subtitle: deposit.description,
              ),
            ],
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: deposit != null && deposit.redeemable && take > 0
              ? () => Navigator.pop(
                    context,
                    RedemptionResult(
                      amountMinor: take,
                      reference: deposit.reference,
                    ),
                  )
              : null,
          child: Text(take > 0 ? 'Redeem ${_money(take)}' : 'Redeem'),
        ),
      ],
    );
  }
}

/// Find a loyalty member and spend their points.
///
/// Modelled on how UK hospitality schemes are actually operated (ICRTouch's
/// TouchPoint/TouchLoyalty being the reference point): points accrue on spend,
/// the venue sets what they are worth and the minimum that can be cashed in,
/// and at the counter the clerk and the customer *agree an amount* — "put a
/// fiver of your points against it" — rather than being offered one
/// all-or-nothing button. So this screen lets the clerk choose how many points
/// to spend, in the scheme's own steps.
///
/// A member is found by phone, name or card number, because all three happen:
/// nobody carries a card, except the customers who do. Enrolling is offered
/// inline when there is no match, because the moment to sign someone up is
/// while they are standing there.
Future<RedemptionResult?> showLoyaltyDialog(
  BuildContext context, {
  required CommerceRepository commerce,
  required int outstandingMinor,
  bool redeem = true,
  int spendMinor = 0,
}) =>
    showDialog<RedemptionResult>(
      context: context,
      builder: (_) => _LoyaltyDialog(
        commerce: commerce,
        outstandingMinor: outstandingMinor,
        redeem: redeem,
        spendMinor: spendMinor,
      ),
    );

class _LoyaltyDialog extends StatefulWidget {
  const _LoyaltyDialog({
    required this.commerce,
    required this.outstandingMinor,
    required this.redeem,
    required this.spendMinor,
  });

  final CommerceRepository commerce;
  final int outstandingMinor;
  final bool redeem;

  /// The goods on this bill, for showing what the sale will earn.
  final int spendMinor;

  @override
  State<_LoyaltyDialog> createState() => _LoyaltyDialogState();
}

class _LoyaltyDialogState extends State<_LoyaltyDialog> {
  final _search = TextEditingController();
  final _name = TextEditingController();
  final _phone = TextEditingController();

  List<LoyaltyCustomer> _matches = const [];
  LoyaltyCustomer? _customer;

  /// How many points the clerk has agreed to spend. Null until they choose, so
  /// the dialog can default to the whole redeemable balance without that
  /// looking like a decision the customer made.
  int? _points;

  String? _error;
  bool _busy = false;
  bool _enrolling = false;

  @override
  void dispose() {
    _search.dispose();
    _name.dispose();
    _phone.dispose();
    super.dispose();
  }

  /// Look the member up. A number is tried as a phone first — that is the exact
  /// match and the common case — then falls back to the broader search, so
  /// "07…" finds the person even when the number was stored with spaces.
  Future<void> _lookup() async {
    final term = _search.text.trim();
    if (term.length < 2) return;
    setState(() {
      _busy = true;
      _error = null;
      _customer = null;
      _matches = const [];
      _enrolling = false;
      _points = null;
    });

    try {
      final looksLikeNumber = RegExp(r'^[\d +()-]+$').hasMatch(term);
      if (looksLikeNumber) {
        try {
          final exact = await widget.commerce.loyaltyByPhone(term);
          if (mounted) setState(() => _select(exact));
          return;
        } on CommerceException {
          // Not this number exactly; fall through to the search below.
        }
      }

      final found = await widget.commerce.searchLoyalty(term);
      if (!mounted) return;
      if (found.isEmpty) {
        setState(() {
          // Not found is an opportunity, not a failure.
          _enrolling = true;
          // Carry what they typed into the right field, so enrolling is one
          // more tap rather than typing the number out again.
          if (looksLikeNumber) {
            _phone.text = term;
          } else {
            _name.text = term;
          }
        });
      } else if (found.length == 1) {
        setState(() => _select(found.first));
      } else {
        setState(() => _matches = found);
      }
    } catch (_) {
      if (mounted) setState(() => _error = 'Could not reach the server.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// Choose a member and default the redemption to everything they can spend
  /// against this bill — the common case, still adjustable.
  void _select(LoyaltyCustomer customer) {
    _customer = customer;
    _matches = const [];
    _error = null;
    _points = widget.redeem
        ? customer.maxRedeemableAgainst(widget.outstandingMinor)
        : 0;
  }

  Future<void> _enrol() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final customer = await widget.commerce.enrol(
        phone: _phone.text.trim(),
        name: _name.text.trim().isEmpty ? 'Guest' : _name.text.trim(),
      );
      if (mounted) {
        setState(() {
          _select(customer);
          _enrolling = false;
        });
      }
    } on CommerceException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (_) {
      if (mounted) setState(() => _error = 'Could not reach the server.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final customer = _customer;
    final max = customer?.maxRedeemableAgainst(widget.outstandingMinor) ?? 0;
    final chosen = (_points ?? max).clamp(0, max);
    final worth = customer?.valueOf(chosen) ?? 0;

    return AlertDialog(
      title: Text(widget.redeem ? 'Loyalty points' : 'Attach customer'),
      content: SizedBox(
        width: 430,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              TextField(
                controller: _search,
                autofocus: true,
                textInputAction: TextInputAction.search,
                decoration: InputDecoration(
                  labelText: 'Phone, name or card number',
                  hintText: 'Search the loyalty scheme',
                  suffixIcon: IconButton(
                    icon: _busy
                        ? const SizedBox(
                            width: 18, height: 18,
                            child: CircularProgressIndicator(strokeWidth: 2))
                        : const Icon(Icons.search),
                    onPressed: _busy ? null : _lookup,
                  ),
                ),
                onSubmitted: (_) => _lookup(),
              ),

              // More than one match: let the clerk pick rather than guessing at
              // the first, which is how the wrong customer gets the points.
              if (_matches.isNotEmpty) ...[
                const SizedBox(height: 10),
                Text('${_matches.length} members match',
                    style: theme.textTheme.bodySmall),
                ConstrainedBox(
                  constraints: const BoxConstraints(maxHeight: 220),
                  child: ListView(
                    shrinkWrap: true,
                    children: [
                      for (final match in _matches)
                        ListTile(
                          dense: true,
                          contentPadding: EdgeInsets.zero,
                          leading: const Icon(Icons.person_outline),
                          title: Text(match.name),
                          subtitle: Text(
                            [
                              if (match.phone?.isNotEmpty ?? false) match.phone!,
                              '${match.pointsBalance} pts',
                              if (match.tierName?.isNotEmpty ?? false)
                                match.tierName!,
                            ].join(' · '),
                            style: const TextStyle(fontSize: 11.5),
                          ),
                          onTap: () => setState(() => _select(match)),
                        ),
                    ],
                  ),
                ),
              ],

              if (_enrolling) ...[
                const SizedBox(height: 12),
                const _Banner(
                  message: 'Not a member yet — sign them up?',
                  isError: false,
                ),
                const SizedBox(height: 10),
                TextField(
                  controller: _name,
                  decoration: const InputDecoration(labelText: 'Name'),
                ),
                const SizedBox(height: 10),
                TextField(
                  controller: _phone,
                  keyboardType: TextInputType.phone,
                  decoration: const InputDecoration(labelText: 'Phone number'),
                ),
                const SizedBox(height: 10),
                FilledButton.tonalIcon(
                  onPressed: _busy ? null : _enrol,
                  icon: const Icon(Icons.person_add_alt),
                  label: const Text('Enrol this customer'),
                ),
              ] else if (_error != null) ...[
                const SizedBox(height: 12),
                _Banner(message: _error!, isError: true),
              ],

              if (customer != null) ...[
                const SizedBox(height: 14),
                _MemberCard(
                  customer: customer,
                  willEarn: customer.pointsFor(widget.spendMinor),
                ),

                if (widget.redeem) ...[
                  const SizedBox(height: 14),
                  if (!customer.enabled)
                    const _Banner(
                      message: 'The loyalty scheme is switched off.',
                      isError: true,
                    )
                  else if (max <= 0)
                    _Banner(
                      message: customer.pointsBalance <
                              customer.minRedeemPoints
                          ? '${customer.minRedeemPoints} points are needed to '
                              'redeem — they have ${customer.pointsBalance}.'
                          : 'Nothing left to redeem against this bill.',
                      isError: false,
                    )
                  else
                    _PointsChooser(
                      customer: customer,
                      options: customer.redemptionOptions(
                        widget.outstandingMinor,
                      ),
                      selected: chosen,
                      onChanged: (points) => setState(() => _points = points),
                    ),
                ],
              ],
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        // Attaching without redeeming still earns points on the sale, which is
        // the whole reason a customer gives their number at the counter.
        if (customer != null && widget.redeem)
          TextButton(
            onPressed: () => Navigator.pop(
              context,
              RedemptionResult(
                amountMinor: 0,
                reference: customer.phone ?? '',
                customer: customer,
              ),
            ),
            child: const Text('Earn only'),
          ),
        FilledButton(
          onPressed: customer == null
              ? null
              : !widget.redeem
                  ? () => Navigator.pop(
                        context,
                        RedemptionResult(
                          amountMinor: 0,
                          reference: customer.phone ?? '',
                          customer: customer,
                        ),
                      )
                  : chosen > 0
                      ? () => Navigator.pop(
                            context,
                            RedemptionResult(
                              amountMinor: worth,
                              reference: customer.phone ?? '',
                              customer: customer,
                              points: chosen,
                            ),
                          )
                      : null,
          child: Text(
            !widget.redeem
                ? 'Attach'
                : worth > 0
                    ? 'Spend $chosen pts (${_money(worth)})'
                    : 'Spend points',
          ),
        ),
      ],
    );
  }
}

/// Who the member is and where they stand — balance, tier, and what this sale
/// will add. The last of those is what a clerk reads out to close the loop
/// ("that's another 24 points"), and it was missing entirely before.
class _MemberCard extends StatelessWidget {
  const _MemberCard({required this.customer, required this.willEarn});

  final LoyaltyCustomer customer;
  final int willEarn;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;

    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: scheme.primaryContainer,
        borderRadius: BorderRadius.circular(10),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  customer.name,
                  style: theme.textTheme.titleMedium
                      ?.copyWith(fontWeight: FontWeight.bold),
                ),
              ),
              if (customer.tierName?.isNotEmpty ?? false)
                Chip(
                  visualDensity: VisualDensity.compact,
                  label: Text(
                    customer.tierMultiplier > 1
                        ? '${customer.tierName} '
                            '×${customer.tierMultiplier.toStringAsFixed(
                                customer.tierMultiplier % 1 == 0 ? 0 : 1)}'
                        : customer.tierName!,
                  ),
                ),
            ],
          ),
          const SizedBox(height: 8),
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(
                '${customer.pointsBalance}',
                style: theme.textTheme.headlineSmall?.copyWith(
                  fontWeight: FontWeight.w800,
                  color: scheme.onPrimaryContainer,
                ),
              ),
              const SizedBox(width: 6),
              Padding(
                padding: const EdgeInsets.only(bottom: 3),
                child: Text(
                  'points · worth ${_money(customer.pointsValueMinor)}',
                  style: theme.textTheme.bodySmall,
                ),
              ),
            ],
          ),
          if (willEarn > 0) ...[
            const SizedBox(height: 4),
            Text(
              'This sale earns $willEarn more.',
              style: theme.textTheme.bodySmall?.copyWith(
                fontWeight: FontWeight.w600,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// How many points to spend.
///
/// Offered in the scheme's own redemption steps, so a till can never hand back
/// a fraction of a step the back office would refuse. The whole redeemable
/// balance is preselected because that is what most customers ask for; the
/// smaller amounts exist because some want to keep a balance.
class _PointsChooser extends StatelessWidget {
  const _PointsChooser({
    required this.customer,
    required this.options,
    required this.selected,
    required this.onChanged,
  });

  final LoyaltyCustomer customer;
  final List<int> options;
  final int selected;
  final void Function(int points) onChanged;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final max = options.isEmpty ? 0 : options.last;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text('Spend how many points?', style: theme.textTheme.labelLarge),
        const SizedBox(height: 8),

        // A long ladder of steps would be an unusable wall of chips on a till,
        // so past a handful it becomes a slider with the steps as its
        // divisions — same values, one gesture.
        if (options.length <= 6)
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final points in options)
                ChoiceChip(
                  label: Text('$points · ${_money(customer.valueOf(points))}'),
                  selected: selected == points,
                  onSelected: (_) => onChanged(points),
                ),
            ],
          )
        else
          Column(
            children: [
              Slider(
                value: selected.toDouble().clamp(
                      options.first.toDouble(),
                      max.toDouble(),
                    ),
                min: options.first.toDouble(),
                max: max.toDouble(),
                divisions: options.length - 1,
                label: '$selected pts',
                onChanged: (value) {
                  // Snap to a real option: the slider is a way of picking one
                  // of these, not a continuous amount.
                  final nearest = options.reduce(
                    (a, b) => (a - value).abs() < (b - value).abs() ? a : b,
                  );
                  onChanged(nearest);
                },
              ),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text('${options.first} pts',
                      style: theme.textTheme.bodySmall),
                  TextButton(
                    onPressed: () => onChanged(max),
                    child: const Text('Use all'),
                  ),
                  Text('$max pts', style: theme.textTheme.bodySmall),
                ],
              ),
            ],
          ),

        const SizedBox(height: 10),
        Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: scheme.surfaceContainerHighest,
            borderRadius: BorderRadius.circular(9),
          ),
          child: Column(
            children: [
              Row(
                children: [
                  const Expanded(child: Text('Comes off the bill')),
                  Text(
                    '-${_money(customer.valueOf(selected))}',
                    style: const TextStyle(
                        fontWeight: FontWeight.bold, fontSize: 17),
                  ),
                ],
              ),
              const SizedBox(height: 4),
              Row(
                children: [
                  Expanded(
                    child: Text('Points left afterwards',
                        style: theme.textTheme.bodySmall),
                  ),
                  Text('${customer.pointsBalance - selected}',
                      style: theme.textTheme.bodySmall),
                ],
              ),
            ],
          ),
        ),
      ],
    );
  }
}

/// Choose a gratuity. Returns the rate in tenths of a percent, or 0 to remove.
Future<int?> showGratuityDialog(
  BuildContext context, {
  required TenderSettings settings,
  required int baseMinor,
  int currentBp = 0,
}) =>
    showDialog<int>(
      context: context,
      builder: (_) => _GratuityDialog(
        settings: settings,
        baseMinor: baseMinor,
        currentBp: currentBp,
      ),
    );

class _GratuityDialog extends StatefulWidget {
  const _GratuityDialog({
    required this.settings,
    required this.baseMinor,
    required this.currentBp,
  });

  final TenderSettings settings;
  final int baseMinor;
  final int currentBp;

  @override
  State<_GratuityDialog> createState() => _GratuityDialogState();
}

class _GratuityDialogState extends State<_GratuityDialog> {
  late int _bp = widget.currentBp;
  final _custom = TextEditingController();

  @override
  void dispose() {
    _custom.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final amount = TenderSettings.gratuityOn(widget.baseMinor, _bp);
    // A custom cash amount is entered as money, then converted back to a rate
    // so the receipt can still print the percentage.
    final customMinor = (double.tryParse(_custom.text) ?? 0) * 100;

    return AlertDialog(
      title: const Text('Gratuity'),
      content: SizedBox(
        width: 380,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('On ${_money(widget.baseMinor)}',
                style: Theme.of(context).textTheme.bodySmall),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final percent in widget.settings.gratuityPresets)
                  ChoiceChip(
                    label: Text('${percent.toStringAsFixed(
                        percent % 1 == 0 ? 0 : 1)}%'),
                    selected: _bp == (percent * 10).round(),
                    onSelected: (_) => setState(() {
                      _bp = (percent * 10).round();
                      _custom.clear();
                    }),
                  ),
                ChoiceChip(
                  label: const Text('None'),
                  selected: _bp == 0,
                  onSelected: (_) => setState(() {
                    _bp = 0;
                    _custom.clear();
                  }),
                ),
              ],
            ),
            const SizedBox(height: 14),
            TextField(
              controller: _custom,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              decoration: const InputDecoration(
                labelText: 'Or a set amount (£)',
                prefixText: '£ ',
              ),
              onChanged: (_) => setState(() {
                final minor = (double.tryParse(_custom.text) ?? 0) * 100;
                _bp = widget.baseMinor > 0
                    ? (minor * 1000 / widget.baseMinor).round()
                    : 0;
              }),
            ),
            const SizedBox(height: 14),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: Theme.of(context).colorScheme.surfaceContainerHighest,
                borderRadius: BorderRadius.circular(9),
              ),
              child: Row(
                children: [
                  const Expanded(child: Text('Gratuity')),
                  Text(
                    _money(customMinor > 0 ? customMinor.round() : amount),
                    style: const TextStyle(
                        fontWeight: FontWeight.bold, fontSize: 17),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: () => Navigator.pop(context, _bp),
          child: const Text('Apply'),
        ),
      ],
    );
  }
}

/// Choose how to split a bill.
Future<SplitChoice?> showSplitDialog(
  BuildContext context, {
  required TenderState state,
}) =>
    showDialog<SplitChoice>(
      context: context,
      builder: (_) => _SplitDialog(state: state),
    );

/// How the clerk decided to split.
class SplitChoice {
  const SplitChoice({required this.mode, this.ways = 0, this.groups});

  final SplitMode mode;
  final int ways;
  final List<List<String>>? groups;
}

class _SplitDialog extends StatefulWidget {
  const _SplitDialog({required this.state});

  final TenderState state;

  @override
  State<_SplitDialog> createState() => _SplitDialogState();
}

class _SplitDialogState extends State<_SplitDialog> {
  int _ways = 2;

  /// For an item split: which share each line has been assigned to.
  final Map<String, int> _assignment = {};
  bool _byItem = false;

  @override
  Widget build(BuildContext context) {
    final outstanding = widget.state.outstandingMinor;
    final each = _ways > 0 ? outstanding ~/ _ways : 0;

    return AlertDialog(
      title: const Text('Split the bill'),
      content: SizedBox(
        width: 440,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              SegmentedButton<bool>(
                segments: const [
                  ButtonSegment(value: false, label: Text('Equally')),
                  ButtonSegment(value: true, label: Text('By item')),
                ],
                selected: {_byItem},
                onSelectionChanged: (s) => setState(() => _byItem = s.first),
              ),
              const SizedBox(height: 16),

              if (!_byItem) ...[
                Text('${_money(outstanding)} between $_ways',
                    style: Theme.of(context).textTheme.bodyMedium),
                const SizedBox(height: 8),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    for (final ways in [2, 3, 4, 5, 6, 8])
                      ChoiceChip(
                        label: Text('$ways'),
                        selected: _ways == ways,
                        onSelected: (_) => setState(() => _ways = ways),
                      ),
                  ],
                ),
                const SizedBox(height: 14),
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color:
                        Theme.of(context).colorScheme.surfaceContainerHighest,
                    borderRadius: BorderRadius.circular(9),
                  ),
                  child: Row(
                    children: [
                      const Expanded(child: Text('Each pays about')),
                      Text(_money(each),
                          style: const TextStyle(
                              fontWeight: FontWeight.bold, fontSize: 17)),
                    ],
                  ),
                ),
              ] else ...[
                Text(
                  'Tap an item to move it between shares.',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
                const SizedBox(height: 10),
                for (final line in widget.state.totals.lines)
                  ListTile(
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    title: Text(line.name),
                    subtitle: Text(_money(line.netMinor)),
                    trailing: Wrap(
                      spacing: 4,
                      children: [
                        for (var share = 0; share < _ways; share++)
                          ChoiceChip(
                            label: Text('${share + 1}'),
                            selected: (_assignment[line.id] ?? 0) == share,
                            onSelected: (_) =>
                                setState(() => _assignment[line.id] = share),
                          ),
                      ],
                    ),
                  ),
                const SizedBox(height: 8),
                Row(
                  children: [
                    const Text('Shares: '),
                    for (final ways in [2, 3, 4])
                      Padding(
                        padding: const EdgeInsets.only(left: 6),
                        child: ChoiceChip(
                          label: Text('$ways'),
                          selected: _ways == ways,
                          onSelected: (_) => setState(() => _ways = ways),
                        ),
                      ),
                  ],
                ),
              ],
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: () {
            if (_byItem) {
              // Group the lines by the share they were assigned to. Anything
              // untouched stays on share 1.
              final groups = List.generate(_ways, (i) => <String>[]);
              for (final line in widget.state.totals.lines) {
                groups[_assignment[line.id] ?? 0].add(line.id);
              }
              Navigator.pop(context,
                  SplitChoice(mode: SplitMode.byItem, groups: groups));
            } else {
              Navigator.pop(
                  context, SplitChoice(mode: SplitMode.equally, ways: _ways));
            }
          },
          child: const Text('Split'),
        ),
      ],
    );
  }
}

class _Banner extends StatelessWidget {
  const _Banner({required this.message, required this.isError});

  final String message;
  final bool isError;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
      decoration: BoxDecoration(
        color: isError ? scheme.errorContainer : scheme.secondaryContainer,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        children: [
          Icon(
            isError ? Icons.error_outline : Icons.info_outline,
            size: 17,
            color: isError ? scheme.onErrorContainer : scheme.onSecondaryContainer,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              message,
              style: TextStyle(
                fontSize: 13,
                color: isError
                    ? scheme.onErrorContainer
                    : scheme.onSecondaryContainer,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _BalanceCard extends StatelessWidget {
  const _BalanceCard({
    required this.title,
    required this.amountMinor,
    this.subtitle,
  });

  final String title;
  final int amountMinor;
  final String? subtitle;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: scheme.primaryContainer,
        borderRadius: BorderRadius.circular(10),
      ),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title,
                    style: TextStyle(
                        fontWeight: FontWeight.w600,
                        color: scheme.onPrimaryContainer)),
                if (subtitle?.isNotEmpty ?? false)
                  Text(subtitle!,
                      style: TextStyle(
                          fontSize: 12,
                          color: scheme.onPrimaryContainer
                              .withValues(alpha: 0.75))),
              ],
            ),
          ),
          Text(
            _money(amountMinor),
            style: TextStyle(
              fontSize: 20,
              fontWeight: FontWeight.w800,
              color: scheme.onPrimaryContainer,
            ),
          ),
        ],
      ),
    );
  }
}
