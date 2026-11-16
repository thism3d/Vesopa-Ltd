/// Card terminal: this device takes card payments for the venue's tills.
///
/// The owner, 2026-11-16: "I want another different system in Go to use as
/// only Terminal, can be connected from other till, like in iPad another
/// Android can be that terminal." In this mode Go sells nothing. It sits ready,
/// a till in the venue (a Windows till, or another Go device) sends it an
/// amount, and it takes the card with its own Tap to Pay and tells the till
/// how it went. The wire is vesopa_server src/go_terminal.js.
///
/// The payment itself is the same one a tap on this device has always been:
/// the venue's gateway, this device's reader, the same record in the back
/// office. The till that asked records the tender.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:wakelock_plus/wakelock_plus.dart';

import '../counter/ui/brand.dart';
import '../counter/ui/card_pay_screen.dart';
import '../data/api.dart';
import '../data/session.dart';
import '../payments/payment_service.dart';
import '../ui/theme.dart';
import 'mode_settings.dart';

/// One payment a till has sent.
@immutable
class TerminalAsk {
  const TerminalAsk({required this.id, required this.amountMinor, this.reference, this.from, this.clerk, this.cancel = false, this.status = 'waiting'});
  final String id;
  final int amountMinor;
  final String? reference;
  final String? from;
  final String? clerk;
  final bool cancel;
  final String status;

  static TerminalAsk? fromJson(Object? j) {
    if (j is! Map) return null;
    final id = '${j['id'] ?? ''}';
    final amount = (j['amount_minor'] as num?)?.toInt() ?? 0;
    if (id.isEmpty || amount <= 0) return null;
    return TerminalAsk(
      id: id,
      amountMinor: amount,
      reference: j['reference'] as String?,
      from: j['from'] as String?,
      clerk: j['clerk'] as String?,
      cancel: j['cancel'] == true,
      status: '${j['status'] ?? 'waiting'}',
    );
  }
}

/// What the terminal tells the till about a finished payment.
({String status, bool uncertain}) terminalVerdict(PaymentOutcome o) => switch (o.result) {
      PayResult.paid => (status: 'paid', uncertain: false),
      PayResult.declined => (status: 'declined', uncertain: false),
      PayResult.cancelled => (status: 'cancelled', uncertain: false),
      // Nobody knows whether the card was charged: the till must say so.
      PayResult.uncertain => (status: 'failed', uncertain: true),
      PayResult.unavailable => (status: 'failed', uncertain: false),
    };

class TerminalModePage extends ConsumerStatefulWidget {
  const TerminalModePage({super.key});

  @override
  ConsumerState<TerminalModePage> createState() => _TerminalModePageState();
}

class _TerminalModePageState extends ConsumerState<TerminalModePage> {
  Timer? _beat;
  bool _calling = false;
  bool _online = true;
  String? _why;

  TerminalAsk? _ask;
  PayStep? _step;
  PaymentOutcome? _result;
  PayControl? _control;
  bool _cancelling = false;

  @override
  void initState() {
    super.initState();
    WakelockPlus.enable().catchError((Object _) {});
    unawaited(_ready());
    _beat = Timer.periodic(const Duration(seconds: 2), (_) => unawaited(_hello()));
    unawaited(_hello());
  }

  @override
  void dispose() {
    _beat?.cancel();
    WakelockPlus.disable().catchError((Object _) {});
    super.dispose();
  }

  /// Whether this device can take a card at all, said once and on return.
  Future<void> _ready() async {
    String? why;
    try {
      why = await ref.read(paymentsProvider).whyUnavailable();
    } catch (_) {
      why = null;
    }
    if (mounted) setState(() => _why = why);
  }

  Future<void> _hello() async {
    if (_calling || !mounted) return;
    _calling = true;
    try {
      final session = ref.read(tapProvider.notifier);
      final r = await ref.read(apiProvider).terminalHello(
            deviceId: session.deviceId,
            name: session.terminalName,
            gateway: ref.read(tapProvider).config.tapProvider,
            ready: _why == null,
            why: _why,
          );
      if (!mounted) return;
      if (!_online) setState(() => _online = true);
      final ask = TerminalAsk.fromJson(r['request']);
      if (ask == null) return;
      if (_ask == null && ask.status == 'waiting') {
        unawaited(_take(ask));
      } else if (_ask?.id == ask.id && ask.cancel && !_cancelling) {
        // The till asked to stop. Only the reader can say whether it did.
        _control?.cancel();
        setState(() => _cancelling = true);
      }
    } on TapApiError {
      if (mounted && _online) setState(() => _online = false);
    } finally {
      _calling = false;
    }
  }

  Future<void> _tell(TerminalAsk ask, String status, {PayStep? step, PaymentOutcome? outcome, bool uncertain = false}) async {
    final session = ref.read(tapProvider.notifier);
    // The verdict matters more than anything else this page sends: tried
    // until it lands, for as long as the page is open.
    for (var attempt = 0; attempt < (outcome == null ? 1 : 30); attempt++) {
      try {
        await ref.read(apiProvider).terminalUpdate(
              ask.id,
              deviceId: session.deviceId,
              status: status,
              step: step?.name,
              paymentId: outcome?.paymentId,
              message: outcome?.message,
              uncertain: uncertain,
              gateway: ref.read(tapProvider).config.tapProvider,
            );
        return;
      } on TapApiError catch (e) {
        if (e.status == 404 || e.status == 403) return;
        await Future<void>.delayed(const Duration(seconds: 2));
        if (!mounted) return;
      }
    }
  }

  Future<void> _take(TerminalAsk ask) async {
    final control = PayControl();
    setState(() {
      _ask = ask;
      _step = PayStep.preparing;
      _result = null;
      _control = control;
      _cancelling = false;
    });
    unawaited(HapticFeedback.mediumImpact());
    await _tell(ask, 'started', step: PayStep.preparing);
    PaymentOutcome outcome;
    try {
      outcome = await ref.read(paymentsProvider).take(
            amountMinor: ask.amountMinor,
            billRef: ask.reference,
            clerk: ask.clerk ?? ask.from,
            onStep: (step) {
              if (!mounted) return;
              setState(() => _step = step);
              unawaited(_tell(ask, 'started', step: step));
            },
            control: control,
          );
    } catch (e) {
      outcome = PaymentOutcome(PayResult.uncertain, message: 'The payment stopped unexpectedly ($e). Check it before taking it again.');
    }
    final verdict = terminalVerdict(outcome);
    if (mounted) {
      setState(() {
        _result = outcome;
        _step = outcome.paid ? PayStep.done : _step;
        _control = null;
        _cancelling = false;
      });
    }
    await _tell(ask, verdict.status, outcome: outcome, uncertain: verdict.uncertain);
    // The customer reads the result, then the screen is ready for the next.
    await Future<void>.delayed(Duration(seconds: outcome.paid ? 4 : 8));
    if (mounted && _ask?.id == ask.id) _clear();
  }

  void _clear() => setState(() {
        _ask = null;
        _step = null;
        _result = null;
      });

  @override
  Widget build(BuildContext context) {
    final ask = _ask;
    final venue = ref.watch(tapProvider.select((s) => s.venue?.name)) ?? '';
    if (ask != null) {
      final result = _result;
      final at = cardStepOf(_step ?? PayStep.preparing, machine: false);
      return PopScope(
        canPop: false,
        child: Scaffold(
          body: CardPayScreen(
            amountMinor: ask.amountMinor,
            heading: venue.isEmpty ? 'Pay by card' : venue,
            step: result != null && result.paid ? CardStep.done : at.step,
            detail: _cancelling
                ? 'Cancelling'
                : (at.step == CardStep.present ? 'Hold your card or phone flat against the top of this device' : at.detail),
            device: ask.from == null ? null : 'Sent from ${ask.from}',
            result: result != null && !result.paid ? result : null,
            cancelling: _cancelling,
            actions: result != null && !result.paid
                ? [(icon: Icons.check_rounded, label: 'Done', onPressed: _clear, primary: true)]
                : const [],
          ),
        ),
      );
    }
    final t = Theme.of(context).textTheme;
    final ready = _why == null && _online;
    final name = ref.read(tapProvider.notifier).terminalName;
    return Scaffold(
      body: SafeArea(
        child: Stack(children: [
          Center(
            child: Padding(
              padding: const EdgeInsets.all(28),
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                _ReadyMark(live: ready),
                const SizedBox(height: 28),
                Text(
                  ready ? 'Ready for a payment' : (!_online ? 'No connection' : 'Not ready'),
                  textAlign: TextAlign.center,
                  style: t.headlineMedium?.copyWith(fontWeight: FontWeight.w900, letterSpacing: -0.6),
                ),
                const SizedBox(height: 10),
                ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 460),
                  child: Text(
                    ready
                        ? 'Send the amount from a till. On the till, choose $name as the card machine.'
                        : (!_online ? 'Reaching the back office. Check the Wi-Fi or mobile data.' : _why!),
                    textAlign: TextAlign.center,
                    style: t.titleMedium?.copyWith(color: context.goMuted, height: 1.35),
                  ),
                ),
                if (!ready && _online) ...[
                  const SizedBox(height: 18),
                  OutlinedButton.icon(onPressed: _ready, icon: const Icon(Icons.refresh_rounded), label: const Text('Check again')),
                ],
              ]),
            ),
          ),
          Positioned(
            left: 20,
            top: 14,
            child: Row(children: [
              const GoMark(size: 26),
              const SizedBox(width: 10),
              Text(venue, style: t.titleSmall?.copyWith(fontWeight: FontWeight.w700)),
            ]),
          ),
          Positioned(
            right: 8,
            top: 4,
            child: IconButton(
              tooltip: 'Settings',
              onPressed: () => showModeSettings(context, ref),
              icon: const Icon(Icons.settings_rounded),
            ),
          ),
          Positioned(
            left: 0,
            right: 0,
            bottom: 16,
            child: Text('Card terminal · $name', textAlign: TextAlign.center, style: t.bodySmall?.copyWith(color: context.goMuted)),
          ),
        ]),
      ),
    );
  }
}

/// The contactless mark, breathing while the terminal is listening.
class _ReadyMark extends StatefulWidget {
  const _ReadyMark({required this.live});
  final bool live;

  @override
  State<_ReadyMark> createState() => _ReadyMarkState();
}

class _ReadyMarkState extends State<_ReadyMark> with SingleTickerProviderStateMixin {
  late final _breath = AnimationController(vsync: this, duration: const Duration(milliseconds: 2400));

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _sync();
  }

  @override
  void didUpdateWidget(_ReadyMark old) {
    super.didUpdateWidget(old);
    _sync();
  }

  void _sync() {
    final move = widget.live && ambientMotion(context);
    if (move && !_breath.isAnimating) _breath.repeat(reverse: true);
    if (!move && _breath.isAnimating) _breath.stop();
  }

  @override
  void dispose() {
    _breath.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colour = widget.live ? context.goLimeInk : context.goMuted;
    return AnimatedBuilder(
      animation: _breath,
      builder: (_, _) => Container(
        width: 168,
        height: 168,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          color: colour.withValues(alpha: 0.10 + 0.06 * _breath.value),
          border: Border.all(color: colour.withValues(alpha: 0.35 + 0.35 * _breath.value), width: 3),
        ),
        child: Icon(widget.live ? Icons.contactless_rounded : Icons.contactless_outlined, size: 84, color: colour),
      ),
    );
  }
}
