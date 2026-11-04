/// Dojo's accreditation, run from Vesopa Go itself (owner, 2026-11-03: "add
/// all the options and cases to get accredited from Dojo again").
///
/// The till passed Dojo's pack (vesopa_epos test_live/
/// dojo_accreditation_live_test.dart, 47 scenarios). This is the same list
/// for Go: each case says what Dojo checks and how Go meets it, and the ones
/// a person must do on the machine or the phone have a Run button that takes
/// a real payment or refund through the same screens a clerk uses. Each run's
/// verdict, Dojo's reference and the time are kept on the device, and the
/// whole sheet can be shared as a report to send to Dojo.
library;

import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:share_plus/share_plus.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vesopa_go/data/api.dart';
import 'package:vesopa_go/data/session.dart';
import 'package:vesopa_go/payments/payment_service.dart';
import 'package:vesopa_go/ui/adaptive.dart';
import 'package:vesopa_go/ui/theme.dart';

import '../../ui/pages/reasons.dart' show reasonsFor;
import 'card_pay_screen.dart';
import 'receipt_view.dart' show hhmm;
import 'sales_page.dart' show MachineRefundPage;

/// How a case is carried out from the checklist.
enum CaseRun { sale, saleTap, refundToCard, refundMatched, refundUnlinked, tapSetUp, tapGuide, manual }

@immutable
class DojoCase {
  const DojoCase(this.id, this.group, this.title, this.how, {this.run = CaseRun.manual, this.amountMinor = 1000, this.expect = PayResult.paid, this.hint});
  final String id;
  final String group;
  final String title;

  /// What Go does that meets it, as the report says.
  final String how;
  final CaseRun run;
  final int amountMinor;

  /// The verdict that passes the case.
  final PayResult expect;

  /// What the tester does on the machine or the phone while it runs.
  final String? hint;
}

/// The cases, in Dojo's own numbering where the till's pack used it.
const dojoCases = <DojoCase>[
  DojoCase('CFG-01', 'Set-up', 'The venue\'s own Dojo account', 'The key is sealed on the server per venue; Go never holds it. Settings shows Live or Sandbox, the software house and reseller ids.'),
  DojoCase('CFG-03', 'Set-up', 'Card machines listed and chosen', 'Card machine page lists the account\'s machines (GET /api/tap/terminals); one is chosen per device or for the venue.'),
  DojoCase('TS-01', 'Card machine sales', 'A sale on the card machine', 'The amount goes to the chosen machine; each prompt (present card, PIN, processing) is shown as a step; only Captured is paid.',
      run: CaseRun.sale, hint: 'Tap, insert or swipe a test card and enter the PIN.'),
  DojoCase('TS-07', 'Card machine sales', 'A declined card is never money taken', 'A decline shows "Payment declined", nothing is put on the bill, and Try again, the other way to pay and QR Pay are offered.',
      run: CaseRun.sale, expect: PayResult.declined, hint: 'Use a card or amount the simulator declines.'),
  DojoCase('TS-11', 'Card machine sales', 'Cancelled on the card machine', 'A cancel pressed on the machine ends the sale as cancelled; nothing is taken.',
      run: CaseRun.sale, expect: PayResult.cancelled, hint: 'Press cancel on the card machine.'),
  DojoCase('TS-12', 'Card machine sales', 'Cancelled from Go before the card', 'Cancel payment on the card screen cancels the machine\'s session; the sale is cancelled only when Dojo agrees.',
      run: CaseRun.sale, expect: PayResult.cancelled, hint: 'Press Cancel payment on this device before presenting a card.'),
  DojoCase('ERR-422', 'Card machine sales', 'Cancel refused once the card is in', 'When the machine refuses the cancel, Go says the card is in and follows the payment to its real verdict, never marking it cancelled.',
      run: CaseRun.sale, hint: 'Present the card, then press Cancel payment while the PIN is asked.'),
  DojoCase('TS-05', 'Signature', 'Signature accepted completes the sale', 'The machine\'s "check the signature" comes to Go as an alert; Accept completes the sale.',
      run: CaseRun.sale, hint: 'Use a signature test card, then press Accept.'),
  DojoCase('TS-08', 'Signature', 'Signature declined is never money taken', 'Decline on the alert declines the sale: "The signature was declined, so nothing was taken."',
      run: CaseRun.sale, expect: PayResult.declined, hint: 'Use a signature test card, then press Decline.'),
  DojoCase('TS-14', 'Card machine sales', 'An expired session is unconfirmed, not failed', 'An expired session shows "Payment not confirmed" with Check payment status, which asks Dojo\'s intent before anything is retried.',
      run: CaseRun.sale, expect: PayResult.uncertain, hint: 'Leave the machine without a card until it times out.'),
  DojoCase('DUP-01', 'Card machine sales', 'The same payment is never taken twice', 'Each payment has its own id; the server returns the existing payment for a repeated request instead of starting another.'),
  DojoCase('RF-02', 'Refunds', 'Refund back to the card', 'Sales › receipt › Refund › Back to the card: no card needed, full or part, never more than is left; a manager approves.',
      run: CaseRun.refundToCard, hint: 'Refunds the last sale taken on this checklist.'),
  DojoCase('RF-04', 'Refunds', 'Refund on the machine, linked to the sale', 'On the card machine, the whole of what is left of a machine sale goes as Dojo\'s MatchedRefund; the customer presents the card.',
      run: CaseRun.refundMatched, hint: 'Present the same card on the machine.'),
  DojoCase('RF-03', 'Refunds', 'Refund on the machine, any amount', 'Refund without a receipt, or a part refund on the machine, goes as Dojo\'s UnlinkedRefund after a manager approves.',
      run: CaseRun.refundUnlinked, amountMinor: 450, hint: 'Present any test card on the machine.'),
  DojoCase('RF-06a', 'Refunds', 'A declined refund is said as declined', 'A refund the machine declines shows "The refund was declined. Nothing went back." and nothing is booked.',
      run: CaseRun.refundUnlinked, amountMinor: 450, expect: PayResult.declined, hint: 'Decline it on the machine or use a declining card.'),
  DojoCase('LOG-01', 'Records', 'Every attempt in the venue\'s card log', 'Approved, declined, cancelled, signature answers and refunds are each written to the back office\'s Card payments log with Dojo\'s status.'),
  DojoCase('RCPT-01', 'Records', 'Receipts', 'Receipts print to the venue\'s printer or are emailed from the sale; card payments carry the payment reference.'),
  DojoCase('TTP-01', 'Tap to Pay on iPhone', 'The merchant accepts Apple\'s terms first', 'Settings › Set up Tap to Pay links the venue\'s account (Apple\'s terms sheet) before the first customer.', run: CaseRun.tapSetUp),
  DojoCase('TTP-02', 'Tap to Pay on iPhone', 'Apple\'s merchant education', 'Apple\'s own "How to use Tap to Pay on iPhone" screens open from Settings.', run: CaseRun.tapGuide),
  DojoCase('TTP-03', 'Tap to Pay on iPhone', 'The reader is prepared early', 'Tap to Pay is prepared as the app opens, so the first customer is not kept waiting.'),
  DojoCase('TTP-04', 'Tap to Pay on iPhone', 'A Tap to Pay sale', 'The amount is shown, Turn to customer faces the screen to the customer, Apple\'s sheet reads the card; only Captured is paid.',
      run: CaseRun.saleTap, hint: 'Hold a test card at the top of the iPhone.'),
  DojoCase('TTP-05', 'Tap to Pay on iPhone', 'A Tap to Pay refund', 'Refunded back to the card through Dojo; no tap needed.', run: CaseRun.refundToCard),
];

/// One run of a case.
@immutable
class CaseResult {
  const CaseResult({required this.passed, required this.at, this.outcome, this.reference, this.note});
  final bool passed;
  final DateTime at;
  final String? outcome;
  final String? reference;
  final String? note;

  Map<String, Object?> toJson() => {'p': passed, 'at': at.toIso8601String(), 'o': outcome, 'r': reference, 'n': note};
  static CaseResult? fromJson(Object? j) {
    if (j is! Map) return null;
    return CaseResult(
      passed: j['p'] == true,
      at: DateTime.tryParse('${j['at']}') ?? DateTime.now(),
      outcome: j['o'] as String?,
      reference: j['r'] as String?,
      note: j['n'] as String?,
    );
  }
}

class DojoChecklistPage extends ConsumerStatefulWidget {
  const DojoChecklistPage({super.key});
  @override
  ConsumerState<DojoChecklistPage> createState() => _DojoChecklistPageState();
}

class _DojoChecklistPageState extends ConsumerState<DojoChecklistPage> {
  static const _key = 'go_dojo_checklist';
  final Map<String, CaseResult> _results = {};

  /// The last paid sale this checklist took, for the refund cases.
  String? _lastPayment;
  int _lastAmount = 0;

  @override
  void initState() {
    super.initState();
    SharedPreferences.getInstance().then((p) {
      try {
        final raw = jsonDecode(p.getString(_key) ?? '{}') as Map;
        for (final e in raw.entries) {
          if (e.key == '_last') {
            _lastPayment = (e.value as Map)['id'] as String?;
            _lastAmount = ((e.value as Map)['a'] as num?)?.toInt() ?? 0;
            continue;
          }
          final r = CaseResult.fromJson(e.value);
          if (r != null) _results['${e.key}'] = r;
        }
      } catch (_) {}
      if (mounted) setState(() {});
    }).catchError((Object _) {});
  }

  Future<void> _save() async {
    try {
      final p = await SharedPreferences.getInstance();
      await p.setString(_key, jsonEncode({
        for (final e in _results.entries) e.key: e.value.toJson(),
        if (_lastPayment != null) '_last': {'id': _lastPayment, 'a': _lastAmount},
      }));
    } catch (_) {}
  }

  void _record(DojoCase c, CaseResult r) {
    setState(() => _results[c.id] = r);
    _save();
  }

  Future<void> _run(DojoCase c) async {
    final s = ref.read(tapProvider);
    final pay = ref.read(paymentsProvider);
    switch (c.run) {
      case CaseRun.sale || CaseRun.saleTap:
        final outcome = await Navigator.of(context).push<PaymentOutcome>(MaterialPageRoute(
          fullscreenDialog: true,
          builder: (_) => _CaseSalePage(dojoCase: c, via: c.run == CaseRun.sale ? 'machine' : 'tap'),
        ));
        if (outcome == null || !mounted) return;
        if (outcome.paid && outcome.paymentId != null) {
          _lastPayment = outcome.paymentId;
          _lastAmount = c.amountMinor;
        }
        _record(c, CaseResult(passed: outcome.result == c.expect, at: DateTime.now(), outcome: outcome.result.name, reference: outcome.paymentId, note: outcome.message));
      case CaseRun.refundToCard:
        final id = _lastPayment;
        if (id == null) return _say('Run a sale first (TS-01 or TTP-04): the refund goes back on it.');
        try {
          if (!s.demo) await ref.read(apiProvider).refund(id, amountMinor: (_lastAmount / 2).round().clamp(1, _lastAmount), approvedBy: s.clerk?.name ?? 'Checklist', reason: 'Dojo checklist ${c.id}');
          _record(c, CaseResult(passed: true, at: DateTime.now(), outcome: 'refunded', reference: id, note: 'Half of the sale, back to the card'));
        } on TapApiError catch (e) {
          _record(c, CaseResult(passed: false, at: DateTime.now(), outcome: 'error', reference: id, note: e.message));
        }
      case CaseRun.refundMatched || CaseRun.refundUnlinked:
        final linked = c.run == CaseRun.refundMatched;
        if (linked && _lastPayment == null) return _say('Run a card machine sale first (TS-01): the refund is linked to it.');
        final reasons = await reasonsFor(ref, 'refund');
        if (!mounted) return;
        final outcome = await Navigator.of(context).push<PaymentOutcome>(MaterialPageRoute(
          fullscreenDialog: true,
          builder: (_) => MachineRefundPage(
            amountMinor: linked ? _lastAmount : c.amountMinor,
            reason: 'Dojo checklist ${c.id}: ${reasons.isEmpty ? 'Refund' : reasons.first}',
            approvedBy: s.clerk?.name ?? 'Checklist',
            paymentId: linked ? _lastPayment : null,
          ),
        ));
        if (!mounted) return;
        final r = outcome ?? const PaymentOutcome(PayResult.cancelled);
        _record(c, CaseResult(passed: r.result == c.expect, at: DateTime.now(), outcome: r.result.name, reference: r.paymentId, note: r.message));
      case CaseRun.tapSetUp:
        if (pay is! DojoTapToPay) return _say('Tap to Pay on iPhone is not this device\'s card reader.');
        final why = await pay.setUp();
        _record(c, CaseResult(passed: why == null, at: DateTime.now(), outcome: why == null ? 'linked' : 'error', note: why));
      case CaseRun.tapGuide:
        if (pay is! DojoTapToPay) return _say('Tap to Pay on iPhone is not this device\'s card reader.');
        final why = await pay.showGuide();
        _record(c, CaseResult(passed: why == null, at: DateTime.now(), outcome: why == null ? 'shown' : 'error', note: why));
      case CaseRun.manual:
        final ok = await showAdaptiveDialog<bool>(
          context: context,
          builder: (d) => AlertDialog.adaptive(
            title: Text('${c.id} ${c.title}'),
            content: Text(c.how),
            actions: [
              adaptiveAction(d, label: 'Not met', destructive: true, onPressed: () => Navigator.pop(d, false)),
              adaptiveAction(d, label: 'Checked', primary: true, onPressed: () => Navigator.pop(d, true)),
            ],
          ),
        );
        if (ok != null) _record(c, CaseResult(passed: ok, at: DateTime.now(), outcome: ok ? 'checked' : 'not met'));
    }
  }

  void _say(String words) => ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(words)));

  String _report() {
    final s = ref.read(tapProvider);
    final b = StringBuffer()
      ..writeln('Vesopa Go: Dojo integration checklist')
      ..writeln('Venue: ${s.venue?.name ?? ''}')
      ..writeln('Environment: ${s.config.environment == 'live' ? 'Live' : 'Sandbox'} · Software house ${s.config.softwareHouseId} · Reseller ${s.config.resellerId}')
      ..writeln('Device: ${ref.read(tapProvider.notifier).terminalName} (${defaultTargetPlatform.name})')
      ..writeln('Report made: ${DateTime.now().toIso8601String()}')
      ..writeln();
    String? group;
    for (final c in dojoCases) {
      if (c.group != group) {
        group = c.group;
        b
          ..writeln()
          ..writeln('== $group');
      }
      final r = _results[c.id];
      final verdict = r == null ? 'NOT RUN' : (r.passed ? 'PASS' : 'FAIL');
      b.writeln('$verdict  ${c.id}  ${c.title}');
      b.writeln('      ${c.how}');
      if (r != null) {
        b.writeln('      ${r.at.toIso8601String()} · ${r.outcome ?? ''}${r.reference == null ? '' : ' · ref ${r.reference}'}${r.note == null ? '' : ' · ${r.note}'}');
      }
    }
    final passed = _results.values.where((r) => r.passed).length;
    b
      ..writeln()
      ..writeln('$passed of ${dojoCases.length} passed.');
    return b.toString();
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final s = ref.watch(tapProvider);
    final passed = dojoCases.where((c) => _results[c.id]?.passed == true).length;
    final groups = <String, List<DojoCase>>{};
    for (final c in dojoCases) {
      groups.putIfAbsent(c.group, () => []).add(c);
    }
    return Scaffold(
      appBar: AppBar(
        title: const Text('Dojo checklist'),
        actions: [
          IconButton(
            tooltip: 'Share the report',
            icon: Icon(defaultTargetPlatform == TargetPlatform.iOS ? Icons.ios_share_rounded : Icons.share_rounded),
            onPressed: () => SharePlus.instance.share(ShareParams(text: _report(), subject: 'Vesopa Go Dojo checklist')),
          ),
        ],
      ),
      body: ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 32), children: [
        Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Row(children: [
              SizedBox(
                width: 54,
                height: 54,
                child: Stack(alignment: Alignment.center, children: [
                  CircularProgressIndicator(value: passed / dojoCases.length, strokeWidth: 6, color: Tp.lime, backgroundColor: Colors.black12),
                  Text('$passed', style: t.titleMedium?.copyWith(fontWeight: FontWeight.w800)),
                ]),
              ),
              const SizedBox(width: 16),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text('$passed of ${dojoCases.length} passed', style: t.titleMedium),
                  Text(
                    s.config.environment == 'live'
                        ? 'Live account: every run here takes or refunds real money.'
                        : 'Sandbox: nothing here moves real money.',
                    style: t.bodySmall?.copyWith(color: s.config.environment == 'live' ? Tp.danger : null),
                  ),
                ]),
              ),
            ]),
          ),
        ),
        for (final g in groups.entries) ...[
          Padding(padding: const EdgeInsets.fromLTRB(4, 18, 4, 6), child: Text(g.key.toUpperCase(), style: t.labelMedium?.copyWith(letterSpacing: 1.1))),
          Card(
            margin: EdgeInsets.zero,
            clipBehavior: Clip.antiAlias,
            child: Column(children: [
              for (final c in g.value) ...[
                if (c != g.value.first) const Divider(height: 1, indent: 16),
                _CaseTile(dojoCase: c, result: _results[c.id], onRun: () => _run(c)),
              ],
            ]),
          ),
        ],
      ]),
    );
  }
}

class _CaseTile extends StatelessWidget {
  const _CaseTile({required this.dojoCase, required this.result, required this.onRun});
  final DojoCase dojoCase;
  final CaseResult? result;
  final VoidCallback onRun;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final r = result;
    final (IconData icon, Color colour) = r == null
        ? (Icons.radio_button_unchecked_rounded, Colors.grey)
        : r.passed
            ? (Icons.check_circle_rounded, Tp.lime)
            : (Icons.cancel_rounded, Tp.danger);
    return ListTile(
      leading: Icon(icon, color: colour),
      title: Text('${dojoCase.id} · ${dojoCase.title}'),
      subtitle: Text(
        [dojoCase.how, if (r != null) '${r.passed ? 'Passed' : 'Failed'} ${hhmm(r.at)}${r.note == null ? '' : ': ${r.note}'}'].join('\n'),
        style: t.bodySmall,
      ),
      isThreeLine: true,
      trailing: TextButton(onPressed: onRun, child: Text(dojoCase.run == CaseRun.manual ? 'Check' : 'Run')),
    );
  }
}

/// One checklist sale through the clerk's own card screen.
class _CaseSalePage extends ConsumerStatefulWidget {
  const _CaseSalePage({required this.dojoCase, required this.via});
  final DojoCase dojoCase;
  final String via;
  @override
  ConsumerState<_CaseSalePage> createState() => _CaseSalePageState();
}

class _CaseSalePageState extends ConsumerState<_CaseSalePage> {
  PayStep _step = PayStep.preparing;
  PaymentOutcome? _result;
  bool _cancelling = false;
  late final PayControl _control = PayControl(checkSignature: _signature)
    ..onCancelRefused = () {
      if (!mounted) return;
      setState(() => _cancelling = false);
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('The card is already in, so the card machine finishes the payment (ERR-422).')));
    };

  Future<bool> _signature() async {
    final ok = await showAdaptiveDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (c) => AlertDialog.adaptive(
        title: const Text('Check the signature'),
        content: const Text("Compare the customer's signature on the card machine's slip with the one on the back of their card."),
        actions: [
          adaptiveAction(c, label: 'Decline', destructive: true, onPressed: () => Navigator.pop(c, false)),
          adaptiveAction(c, label: 'Accept', primary: true, onPressed: () => Navigator.pop(c, true)),
        ],
      ),
    );
    return ok ?? false;
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _go());
  }

  Future<void> _go() async {
    final outcome = await ref.read(paymentsProvider).take(
          amountMinor: widget.dojoCase.amountMinor,
          billRef: 'checklist-${widget.dojoCase.id.toLowerCase()}',
          clerk: ref.read(tapProvider).clerk?.name,
          via: widget.via,
          onStep: (s) => mounted ? setState(() => _step = s) : null,
          control: _control,
        );
    if (!mounted) return;
    setState(() => _result = outcome);
    // A paid case closes itself after the tick.
    if (outcome.paid) {
      await Future<void>.delayed(const Duration(milliseconds: 900));
      if (mounted) Navigator.pop(context, outcome);
    }
  }

  @override
  Widget build(BuildContext context) {
    final machine = widget.via == 'machine';
    final mapped = cardStepOf(_step, machine: machine);
    final r = _result;
    return Theme(
      data: Tp.theme(Brightness.dark, font: Theme.of(context).textTheme.bodyMedium?.fontFamily),
      child: CardPayScreen(
        amountMinor: widget.dojoCase.amountMinor,
        heading: '${widget.dojoCase.id} · ${machine ? 'Card machine' : 'Tap to Pay'}',
        step: r?.paid == true ? CardStep.done : mapped.step,
        detail: widget.dojoCase.hint ?? mapped.detail,
        device: machine ? "The venue's card machine" : ref.read(tapProvider.notifier).terminalName,
        machine: machine,
        result: r == null || r.paid ? null : r,
        actions: [
          if (r != null) (icon: Icons.check_rounded, label: 'Record the result', onPressed: () => Navigator.pop(context, r), primary: true),
        ],
        onCancel: r == null && machine && const {PayStep.onMachine, PayStep.pin, PayStep.cancelling}.contains(_step)
            ? () {
                _control.cancel();
                setState(() => _cancelling = true);
              }
            : null,
        cancelling: _cancelling,
      ),
    );
  }
}
