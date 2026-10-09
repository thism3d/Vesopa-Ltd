import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../main.dart';
import '../payments/connect_pac.dart';
import '../payments/card_log.dart';
import '../payments/payment_provider.dart';
import 'dojo_refund.dart';
import 'theme.dart';
import '../data/till_permissions.dart';
import 'permission_gate.dart';

String _money(int minor) =>
    NumberFormat.currency(locale: 'en_GB', symbol: '£').format(minor / 100);

/// The card machine's own functions: its reports, and a refund back to a card.
///
/// These belong to the reader rather than to a sale, which is why they live
/// here and not on the payment screen. On a Pay-At-Counter integration the PDQ
/// cannot start its own end-of-day — the till has to ask for it — so a venue
/// with no button for this cannot cash the machine up at all.
class CardMachinePage extends ConsumerStatefulWidget {
  const CardMachinePage({super.key});

  @override
  ConsumerState<CardMachinePage> createState() => _CardMachinePageState();
}

class _CardMachinePageState extends ConsumerState<CardMachinePage> {
  bool _busy = false;
  ConnectReportResult? _report;
  String? _status;

  /// The reader, when this till talks to a Connect one.
  ///
  /// Only Connect exposes the PDQ's own *reports* — end of day, X balance — to
  /// the till. A Dojo reader is cashed up from Dojo's portal, so those keys are
  /// hidden rather than shown and left to fail.
  ConnectPacProvider? get _connect {
    final provider = ref.read(dojoProvider);
    return provider is ConnectPacProvider ? provider : null;
  }

  /// The Dojo reader, when there is one.
  ///
  /// Refunds are the part both platforms can do, so this page offers them for
  /// either. Null when the till has no reader configured — the keyed fallbacks
  /// (the drop-in, the hosted checkout) present a card for a *sale* and have
  /// nowhere to send a refund.
  DojoProvider? get _dojo {
    final provider = ref.read(dojoProvider);
    return provider is DojoProvider ? provider : null;
  }

  /// Whether this till can refund at all — i.e. whether there is a reader.
  bool get _canRefund => _connect != null || _dojo != null;

  Future<void> _run(ConnectReport report) async {
    final connect = _connect;
    if (connect == null || _busy) return;

    setState(() {
      _busy = true;
      _report = null;
      _status = 'Asking the card machine for the ${report.label} report…';
    });

    final result = await connect.runReport(report);
    if (!mounted) return;
    setState(() {
      _busy = false;
      _report = result;
      _status = result.finished
          ? null
          : result.message ?? 'The report did not finish.';
    });
  }

  /// Refund to a card. Deliberately behind its own confirmation with the amount
  /// spelled out: this hands money back, and a mis-key here is not recoverable
  /// from the till.
  Future<void> _refund() async {
    // Money back out of the till, and the key a venue is most likely to
    // withhold. A manager can approve one without the clerk signing off.
    if (!await allowed(context, ref, TillPermission.refund)) return;
    if (!mounted) return;

    if (_busy) return;

    final amount = await _askAmount();
    if (amount == null || !mounted) return;

    final confirmed = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (context) => AlertDialog(
        icon: const Icon(Icons.undo, size: 30),
        title: const Text('Refund to card'),
        content: Text(
          'This gives ${_money(amount)} back to the customer\'s card.\n\n'
          'They will need to present the card on the machine.\n\n'
          // Said plainly because it is true and because it is the whole risk:
          // an unlinked refund references no sale, so nothing checks this
          // amount against anything that was ever taken.
          'This refund is not linked to a sale, so nothing checks the amount. '
          'Make sure it is right.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: Text('Refund ${_money(amount)}'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;

    setState(() {
      _busy = true;
      _status = 'Ask the customer to present their card…';
    });

    final connect = _connect;
    if (connect != null) {
      connect.onProgress = (p) {
        if (mounted) setState(() => _status = p.prompt);
      };
      final result = await connect.refund(amount);
      connect.onProgress = null;
      if (!mounted) return;
      setState(() {
        _busy = false;
        _status = result.approved
            ? 'Refunded ${_money(result.amountMinor)}.'
            : result.message ?? 'The refund was not completed.';
      });
      return;
    }

    await _refundOnDojo(amount);
  }

  /// Refund on a Dojo reader, not linked to any sale (Dojo's "Unlinked
  /// refund" scenarios): the customer presents a card and the amount goes
  /// back on it. Followed exactly like a sale, signature check included, and
  /// logged whatever the result.
  Future<void> _refundOnDojo(int amount) async {
    final dojo = _dojo;
    if (dojo == null) return;
    final result = await runRefundOnMachine(context, dojo, amountMinor: amount);
    await CardLog.instance.add(CardLogEntry.fromResult(
      result,
      kind: 'unlinked_refund',
      terminalId: dojo.terminalId,
      softwareHouseId: dojo.softwareHouseId,
      resellerId: dojo.resellerId,
      staff: ref.read(servedByProvider),
    ));
    if (!mounted) return;
    setState(() {
      _busy = false;
      _status = result.message;
    });
    await showRefundResult(context, result);
  }

  Future<int?> _askAmount() async {
    final controller = TextEditingController();
    return showDialog<int>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Refund how much?'),
        content: TextField(
          controller: controller,
          autofocus: true,
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          decoration: const InputDecoration(
            labelText: 'Amount',
            prefixText: '£ ',
            border: OutlineInputBorder(),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () {
              final pounds = double.tryParse(controller.text.trim()) ?? 0;
              final minor = (pounds * 100).round();
              Navigator.pop(context, minor > 0 ? minor : null);
            },
            child: const Text('Continue'),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final connect = _connect;

    return Scaffold(
      appBar: AppBar(title: const Text('Card machine')),
      body: !_canRefund
          ? Center(
              child: Padding(
                padding: const EdgeInsets.all(28),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Icon(Icons.point_of_sale, size: 44),
                    const SizedBox(height: 14),
                    Text(
                      'No card machine on this till',
                      style: theme.textTheme.titleMedium,
                      textAlign: TextAlign.center,
                    ),
                    const SizedBox(height: 8),
                    Text(
                      'These functions run on the reader itself, so they need '
                      'one paired to this till. Set the card machine up in '
                      'Settings and they appear here.',
                      style: theme.textTheme.bodySmall,
                      textAlign: TextAlign.center,
                    ),
                  ],
                ),
              ),
            )
          : ListView(
              padding: const EdgeInsets.all(20),
              children: [
                Text(
                  'Machine ${connect?.terminalId ?? _dojo?.terminalId ?? '—'}',
                  style: theme.textTheme.titleMedium,
                ),
                const SizedBox(height: 4),

                // The reports are Connect's alone. A Dojo reader is cashed up
                // from Dojo's portal, so a Dojo till gets the refund key and
                // an explanation instead of buttons that would 404.
                if (connect != null) ...[
                  Text(
                    'End of day closes the machine\'s own banking day. It has '
                    'to be started from here — the PDQ cannot do it on its own '
                    'when it is integrated with a till.',
                    style: theme.textTheme.bodySmall,
                  ),
                  const SizedBox(height: 18),
                  Wrap(
                    spacing: 10,
                    runSpacing: 10,
                    children: [
                      for (final report in ConnectReport.values)
                        FilledButton.tonalIcon(
                          onPressed: _busy ? null : () => _run(report),
                          icon: Icon(
                            report == ConnectReport.endOfDay
                                ? Icons.lock_clock
                                : Icons.summarize_outlined,
                            size: 18,
                          ),
                          label: Text(report.label),
                        ),
                    ],
                  ),
                ] else
                  Text(
                    'End of day and balance reports for a Dojo reader are run '
                    'from the Dojo portal rather than the till.',
                    style: theme.textTheme.bodySmall,
                  ),
                const SizedBox(height: 14),
                OutlinedButton.icon(
                  onPressed: _busy ? null : _refund,
                  style: OutlinedButton.styleFrom(foregroundColor: Pos.red),
                  icon: const Icon(Icons.undo, size: 18),
                  label: Text(
                    _dojo != null
                        ? 'Refund without a sale (unlinked)'
                        : 'Refund to card',
                  ),
                ),
                if (_dojo != null) ...[
                  const SizedBox(height: 6),
                  Text(
                    'To refund a sale, tap it in Card payments below (or use '
                    'Refund off its receipt): it is linked to the sale and '
                    'can be full or part.',
                    style: theme.textTheme.bodySmall,
                  ),
                ],

                if (_busy || _status != null) ...[
                  const SizedBox(height: 20),
                  Card(
                    margin: EdgeInsets.zero,
                    child: ListTile(
                      leading: _busy
                          ? const SizedBox(
                              width: 20,
                              height: 20,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Icon(Icons.info_outline),
                      title: Text(_status ?? 'Working…'),
                    ),
                  ),
                ],

                // The reader's own text, printed as it came off the machine.
                // A card report has to carry the acquirer's wording verbatim.
                if (_report?.lines.isNotEmpty ?? false) ...[
                  const SizedBox(height: 20),
                  Text(_report!.report.label, style: theme.textTheme.titleSmall),
                  const SizedBox(height: 8),
                  Container(
                    width: double.infinity,
                    padding: const EdgeInsets.all(14),
                    decoration: BoxDecoration(
                      color: theme.colorScheme.surfaceContainerHighest,
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: SelectableText(
                      _report!.lines.join('\n'),
                      style: const TextStyle(
                        fontFamily: 'monospace',
                        fontSize: 12.5,
                        height: 1.4,
                      ),
                    ),
                  ),
                ],

                if (_dojo != null) ...[
                  const SizedBox(height: 26),
                  const CardPaymentsList(),
                ],
              ],
            ),
    );
  }
}

/// The till's card log: every Dojo sale, refund and check on this till,
/// approved or not, newest first. Tap a sale to check it with Dojo or refund
/// it, full or part.
class CardPaymentsList extends ConsumerStatefulWidget {
  const CardPaymentsList({super.key});

  @override
  ConsumerState<CardPaymentsList> createState() => _CardPaymentsListState();
}

class _CardPaymentsListState extends ConsumerState<CardPaymentsList> {
  List<CardLogEntry> _entries = const [];
  StreamSubscription<void>? _sub;

  /// Live Dojo status per intent, filled in when the clerk asks.
  final Map<String, String> _live = {};

  @override
  void initState() {
    super.initState();
    _load();
    _sub = CardLog.instance.changes.listen((_) => _load());
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    final list = await CardLog.instance.recent();
    if (mounted) setState(() => _entries = list);
  }

  Future<void> _check(CardLogEntry e) async {
    final dojo = tillDojo(ref);
    final id = e.intentId;
    if (dojo == null || id == null) return;
    setState(() => _live[id] = 'Checking…');
    try {
      final st = await dojo.paymentStatus(id);
      if (mounted) setState(() => _live[id] = st.summary);
    } catch (err) {
      if (mounted) {
        setState(() => _live[id] =
            err is DojoException ? err.clerkMessage : 'Could not reach Dojo');
      }
    }
  }

  Future<void> _open(CardLogEntry e) async {
    final id = e.intentId;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (sheet) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
          child: SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  '${_kindLabel(e.kind)} ${_money(e.amountMinor)} · ${_outcomeLabel(e.outcome)}',
                  style: Theme.of(sheet).textTheme.titleMedium,
                ),
                const SizedBox(height: 6),
                Text(e.message ?? '', style: const TextStyle(fontSize: 13)),
                const SizedBox(height: 10),
                _kv('When', DateFormat('d MMM y HH:mm:ss').format(e.at)),
                if (e.status != null) _kv('Dojo status', e.status!),
                if (id != null) _kv('Payment intent', id),
                if (e.sessionId != null) _kv('Terminal session', e.sessionId!),
                if (e.terminalId != null) _kv('Card machine', e.terminalId!),
                if (e.softwareHouseId != null) _kv('Software house', e.softwareHouseId!),
                if (e.resellerId != null) _kv('Reseller', e.resellerId!),
                if (e.authCode != null) _kv('Auth code', e.authCode!),
                if (e.cardLast4 != null) _kv('Card', '${e.cardType ?? ''} ••${e.cardLast4}'),
                if (e.staff != null) _kv('Staff', e.staff!),
                if (e.refundedMinor > 0) _kv('Refunded here', _money(e.refundedMinor)),
                if (e.receiptLines.isNotEmpty) ...[
                  const SizedBox(height: 10),
                  Container(
                    width: double.infinity,
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: Theme.of(sheet).colorScheme.surfaceContainerHighest,
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: SelectableText(
                      e.receiptLines.join('\n'),
                      style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
                    ),
                  ),
                ],
                const SizedBox(height: 16),
                Wrap(
                  spacing: 10,
                  runSpacing: 10,
                  children: [
                    if (id != null)
                      OutlinedButton.icon(
                        onPressed: () {
                          Navigator.pop(sheet);
                          _check(e);
                        },
                        icon: const Icon(Icons.manage_search, size: 18),
                        label: const Text('Check status with Dojo'),
                      ),
                    if (e.refundable)
                      FilledButton.icon(
                        onPressed: () async {
                          Navigator.pop(sheet);
                          await refundDojoPayment(
                            context,
                            ref,
                            intentId: id!,
                            orderId: e.orderId,
                          );
                        },
                        style: FilledButton.styleFrom(backgroundColor: Pos.red),
                        icon: const Icon(Icons.undo, size: 18),
                        label: const Text('Refund (full or part)'),
                      ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _kv(String k, String v) => Padding(
    padding: const EdgeInsets.only(bottom: 3),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(width: 130, child: Text(k, style: const TextStyle(fontSize: 12.5, color: Colors.grey))),
        Expanded(child: SelectableText(v, style: const TextStyle(fontSize: 12.5))),
      ],
    ),
  );

  static String _kindLabel(String kind) => switch (kind) {
    'sale' => 'Sale',
    'refund' => 'Refund to card',
    'matched_refund' => 'Refund on machine',
    'unlinked_refund' => 'Unlinked refund',
    'check' => 'Status check',
    _ => kind,
  };

  static String _outcomeLabel(String o) => switch (o) {
    'approved' => 'Approved',
    'declined' => 'Declined',
    'cancelled' => 'Cancelled',
    'busy' => 'Machine busy',
    'expired' => 'Not confirmed (expired)',
    'unknown' => 'Not confirmed',
    'signature_rejected' => 'Signature rejected',
    'recorded_manually' => 'Recorded as paid by hand',
    'not_paid' => 'Not paid',
    'failed' => 'Failed',
    _ => o,
  };

  static Color _outcomeColour(String o) => switch (o) {
    'approved' || 'recorded_manually' => Pos.green,
    'busy' || 'expired' || 'unknown' || 'cancelled' => Colors.orange.shade800,
    _ => Pos.red,
  };

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Text('Card payments on this till', style: theme.textTheme.titleMedium),
            const Spacer(),
            IconButton(
              tooltip: 'Refresh',
              onPressed: _load,
              icon: const Icon(Icons.refresh),
            ),
          ],
        ),
        Text(
          'Every card sale, refund and check, approved or not. Tap one for its '
          'details, to check it with Dojo, or to refund it.',
          style: theme.textTheme.bodySmall,
        ),
        const SizedBox(height: 8),
        if (_entries.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 16),
            child: Text('No card payments yet.', style: theme.textTheme.bodySmall),
          ),
        for (final e in _entries.take(100))
          Card(
            margin: const EdgeInsets.only(bottom: 6),
            child: ListTile(
              dense: true,
              onTap: () => _open(e),
              leading: Icon(
                e.kind == 'sale' ? Icons.credit_card : e.kind == 'check' ? Icons.manage_search : Icons.undo,
                color: _outcomeColour(e.outcome),
              ),
              title: Text(
                '${_kindLabel(e.kind)} ${_money(e.amountMinor)}'
                '${e.refundedMinor > 0 ? ' (${_money(e.refundedMinor)} refunded)' : ''}',
              ),
              subtitle: Text(
                [
                  DateFormat('d MMM HH:mm').format(e.at),
                  if (e.intentId != null && _live[e.intentId] != null)
                    'Dojo: ${_live[e.intentId]}'
                  else if (e.status != null)
                    e.status!,
                ].join(' · '),
                style: const TextStyle(fontSize: 12),
              ),
              trailing: Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  color: _outcomeColour(e.outcome).withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(20),
                ),
                child: Text(
                  _outcomeLabel(e.outcome),
                  style: TextStyle(fontSize: 12, color: _outcomeColour(e.outcome), fontWeight: FontWeight.w600),
                ),
              ),
            ),
          ),
      ],
    );
  }
}
