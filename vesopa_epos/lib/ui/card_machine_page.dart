import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../main.dart';
import '../payments/connect_pac.dart';
import '../payments/payment_provider.dart';
import 'theme.dart';

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

  /// Refund on a Dojo reader.
  ///
  /// This is an *unlinked* refund: it carries no reference to an original sale,
  /// which is why the confirmation above spells the amount out and why it lives
  /// behind the manager's functions rather than on the sale screen. A matched
  /// refund — tied to the sale's `paymentIntentId`, and therefore capped at what
  /// was actually taken — is the safer form and belongs on the sale itself.
  ///
  /// The session is polled exactly as a sale is, once a second, so the clerk
  /// sees the same prompts; the signature step is answered the same way too,
  /// because a refund can ask for one just as a sale can.
  Future<void> _refundOnDojo(int amount) async {
    final dojo = _dojo;
    if (dojo == null) return;

    try {
      final sessionId = await dojo.startRefundSession(amountMinor: amount);
      final deadline = DateTime.now().add(const Duration(minutes: 3));
      var answeredSignature = false;

      while (DateTime.now().isBefore(deadline)) {
        final session = await dojo.fetchSession(sessionId);
        if (!mounted) return;
        setState(() => _status = session.prompt);

        if (session.needsSignature && !answeredSignature) {
          answeredSignature = true;
          final accepted = await _askSignature();
          if (!mounted) return;
          await dojo.answerSignature(sessionId, accepted: accepted);
          continue;
        }

        if (session.captured) {
          setState(() {
            _busy = false;
            _status = 'Refunded ${_money(amount)}.';
          });
          return;
        }
        if (session.failed) {
          setState(() {
            _busy = false;
            _status = 'The refund was ${session.status.toLowerCase()}.';
          });
          return;
        }
        await Future<void>.delayed(const Duration(seconds: 1));
      }

      // Ran out of time without a verdict. This is the one outcome that must
      // not be guessed at: the money may or may not have gone back.
      if (!mounted) return;
      setState(() {
        _busy = false;
        _status = 'The result could not be confirmed. Check the card machine '
            'screen before refunding again.';
      });
    } on DojoException catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _status = e.clerkMessage;
      });
    }
  }

  /// The signature prompt. Returns false — reject — if the dialog is dismissed,
  /// because an unanswered signature must never be taken as approval.
  Future<bool> _askSignature() async {
    final accepted = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (context) => AlertDialog(
        icon: const Icon(Icons.draw_outlined, size: 30),
        title: const Text('Check the signature'),
        content: const Text(
          'Compare the signature on the receipt with the one on the card.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            style: TextButton.styleFrom(foregroundColor: Pos.red),
            child: const Text('Reject'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Accept'),
          ),
        ],
      ),
    );
    return accepted ?? false;
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
                  label: const Text('Refund to card'),
                ),

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
              ],
            ),
    );
  }
}
