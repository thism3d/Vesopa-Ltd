import 'package:flutter/material.dart';

import '../payments/connect_pac.dart';
import '../payments/dojo_desktop.dart';
import '../payments/payment_provider.dart';

/// The steps a card sale walks through, in the order a customer experiences
/// them. This is the clerk's view of the reader, not Dojo's state machine —
/// several Dojo statuses collapse into one step here because they look
/// identical from the counter.
enum CardStep {
  starting('Starting', 'Setting up the payment'),
  present('Present card', 'Ask the customer to tap, insert or swipe'),
  pin('Enter PIN', 'The customer is entering their PIN'),
  processing('Processing', 'Authorising with the bank'),
  signature('Signature', 'Check the signature matches the card'),
  removeCard('Remove card', 'Ask the customer to take their card'),
  done('Complete', 'Payment approved');

  const CardStep(this.label, this.detail);
  final String label;
  final String detail;

  /// The steps shown in the timeline. Signature and remove-card are omitted:
  /// they only happen on some sales, and a timeline that changes length
  /// mid-payment is disorienting.
  static const timeline = [starting, present, pin, processing, done];

  /// Where this step sits on the timeline, for progress purposes. The
  /// conditional steps map onto the surrounding ones.
  int get timelineIndex => switch (this) {
        starting => 0,
        present => 1,
        pin => 2,
        signature => 3,
        processing => 3,
        removeCard => 4,
        done => 4,
      };
}

/// Translates provider progress into a [CardStep].
///
/// The reader's own notification wins when there is one: it reflects what the
/// customer is actually looking at, which the till's own stage cannot know.
CardStep cardStepFor({DojoStage? stage, DojoSession? session}) {
  if (session != null) {
    if (session.captured) return CardStep.done;
    if (session.needsSignature) return CardStep.signature;
    switch (session.lastNotification) {
      case 'PresentCard':
        return CardStep.present;
      case 'EnterPin':
        return CardStep.pin;
      case 'RemoveCard':
        return CardStep.removeCard;
      case 'PleaseWait':
        return CardStep.processing;
    }
    if (session.authorized) return CardStep.processing;
  }
  return switch (stage) {
    DojoStage.creating => CardStep.starting,
    DojoStage.sendingToTerminal => CardStep.starting,
    DojoStage.awaitingCard => CardStep.present,
    DojoStage.checking => CardStep.processing,
    null => CardStep.starting,
  };
}

/// The same translation for Paymentsense Connect, which reports progress as
/// notification values rather than a session status. Kept beside [cardStepFor]
/// so the two acquirers cannot drift into showing the clerk different screens
/// for the same moment in a sale.
CardStep cardStepForConnect(ConnectProgress progress) =>
    switch (progress.notification) {
      'PRESENT_CARD' ||
      'INSERT_CARD' ||
      'RE_PRESENT_CARD' ||
      'PRESENT_ONLY_ONE_CARD' ||
      'BAD_SWIPE' => CardStep.present,
      'PIN_ENTRY' => CardStep.pin,
      'SIGNATURE_VERIFICATION' => CardStep.signature,
      'REMOVE_CARD' => CardStep.removeCard,
      'APPROVED' || 'TRANSACTION_FINISHED' => CardStep.done,
      'PLEASE_WAIT' ||
      'RETRYING' ||
      'SIGNATURE_VERIFICATION_IN_PROGRESS' ||
      'CANCELLING' ||
      'ATTEMPTING_CANCEL' => CardStep.processing,
      _ => CardStep.starting,
    };

/// Live state of a card payment, driven by the provider callbacks.
class CardPaymentState {
  const CardPaymentState({
    required this.step,
    this.readerPrompt,
    this.terminalLabel,
    this.error,
  });

  final CardStep step;

  /// The reader's own words, when it has given any.
  final String? readerPrompt;
  final String? terminalLabel;
  final String? error;

  CardPaymentState copyWith({
    CardStep? step,
    String? readerPrompt,
    String? terminalLabel,
    String? error,
  }) =>
      CardPaymentState(
        step: step ?? this.step,
        readerPrompt: readerPrompt ?? this.readerPrompt,
        terminalLabel: terminalLabel ?? this.terminalLabel,
        error: error ?? this.error,
      );
}

/// Full-screen card payment view.
///
/// Deliberately not a small spinner dialog. During a card sale the till is
/// unusable for anything else and the clerk's whole job is relaying what the
/// reader wants, so the screen shows one instruction at a time, in the largest
/// type on the till, with the amount always visible.
class CardPaymentView extends StatelessWidget {
  const CardPaymentView({
    super.key,
    required this.state,
    required this.amountLabel,
    this.onCancel,
    this.onSignatureAccepted,
    this.onSignatureRejected,
  });

  final CardPaymentState state;
  final String amountLabel;

  /// Null when the payment cannot be abandoned from the till.
  final VoidCallback? onCancel;

  /// Signature verification. Both null unless the reader has asked.
  final VoidCallback? onSignatureAccepted;
  final VoidCallback? onSignatureRejected;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final step = state.step;
    final isSignature = step == CardStep.signature;
    final failed = state.error != null;

    return Dialog.fullscreen(
      backgroundColor: scheme.surface,
      child: SafeArea(
        child: Column(
          children: [
            _AmountHeader(amountLabel: amountLabel, terminal: state.terminalLabel),
            Expanded(
              child: Center(
                child: SingleChildScrollView(
                  padding: const EdgeInsets.symmetric(
                      horizontal: 32, vertical: 16),
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 560),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        _StageArt(step: step, failed: failed),
                        const SizedBox(height: 28),

                        // The instruction. Swapped with a fade+slide so a
                        // change of prompt is noticed from across the counter.
                        AnimatedSwitcher(
                          duration: const Duration(milliseconds: 260),
                          transitionBuilder: (child, animation) => FadeTransition(
                            opacity: animation,
                            child: SlideTransition(
                              position: Tween(
                                begin: const Offset(0, 0.12),
                                end: Offset.zero,
                              ).animate(animation),
                              child: child,
                            ),
                          ),
                          child: Column(
                            key: ValueKey('${step.name}|${state.readerPrompt}|$failed'),
                            children: [
                              Text(
                                failed ? 'Payment failed' : step.label,
                                textAlign: TextAlign.center,
                                style: theme.textTheme.headlineMedium?.copyWith(
                                  fontWeight: FontWeight.w700,
                                  color: failed ? scheme.error : null,
                                ),
                              ),
                              const SizedBox(height: 10),
                              Text(
                                state.error ??
                                    state.readerPrompt ??
                                    step.detail,
                                textAlign: TextAlign.center,
                                style: theme.textTheme.titleMedium?.copyWith(
                                  color: scheme.onSurfaceVariant,
                                ),
                              ),
                            ],
                          ),
                        ),

                        const SizedBox(height: 32),
                        if (!failed) _StepTimeline(step: step),
                      ],
                    ),
                  ),
                ),
              ),
            ),

            // Signature is a decision, not a wait, so it gets the affirmative
            // and destructive actions rather than a cancel button.
            if (isSignature &&
                onSignatureAccepted != null &&
                onSignatureRejected != null)
              _SignatureActions(
                onAccepted: onSignatureAccepted!,
                onRejected: onSignatureRejected!,
              )
            else if (onCancel != null && !failed)
              Padding(
                padding: const EdgeInsets.fromLTRB(24, 0, 24, 24),
                child: SizedBox(
                  width: double.infinity,
                  height: 52,
                  child: OutlinedButton.icon(
                    onPressed: onCancel,
                    icon: const Icon(Icons.close),
                    label: const Text('Cancel payment'),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _AmountHeader extends StatelessWidget {
  const _AmountHeader({required this.amountLabel, this.terminal});

  final String amountLabel;
  final String? terminal;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(vertical: 20, horizontal: 24),
      color: scheme.primaryContainer,
      child: Column(
        children: [
          Text(
            'Card payment',
            style: theme.textTheme.labelLarge?.copyWith(
              color: scheme.onPrimaryContainer.withValues(alpha: 0.8),
              letterSpacing: 1.1,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            amountLabel,
            style: theme.textTheme.displaySmall?.copyWith(
              fontWeight: FontWeight.w800,
              color: scheme.onPrimaryContainer,
            ),
          ),
          if (terminal != null && terminal!.isNotEmpty) ...[
            const SizedBox(height: 6),
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Icon(Icons.point_of_sale,
                    size: 15,
                    color: scheme.onPrimaryContainer.withValues(alpha: 0.75)),
                const SizedBox(width: 6),
                Text(
                  terminal!,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: scheme.onPrimaryContainer.withValues(alpha: 0.75),
                  ),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

/// The animated card graphic. Each stage gets motion that mirrors what the
/// customer should physically do, so the screen is readable at a glance even
/// before the words are.
class _StageArt extends StatefulWidget {
  const _StageArt({required this.step, required this.failed});

  final CardStep step;
  final bool failed;

  @override
  State<_StageArt> createState() => _StageArtState();
}

class _StageArtState extends State<_StageArt>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1400),
  )..repeat(reverse: true);

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final step = widget.step;

    final (IconData icon, Color colour) = switch (true) {
      _ when widget.failed => (Icons.error_outline, scheme.error),
      _ when step == CardStep.done => (Icons.check_circle, Colors.green),
      _ when step == CardStep.signature => (Icons.draw_outlined, scheme.primary),
      _ when step == CardStep.pin => (Icons.dialpad, scheme.primary),
      _ when step == CardStep.removeCard =>
        (Icons.pan_tool_alt_outlined, scheme.primary),
      _ when step == CardStep.processing =>
        (Icons.sync, scheme.primary),
      _ when step == CardStep.present => (Icons.contactless, scheme.primary),
      _ => (Icons.credit_card, scheme.primary),
    };

    // Settled states hold still; waiting states pulse. A static screen during
    // a wait reads as a frozen till.
    final animate = !widget.failed &&
        step != CardStep.done &&
        step != CardStep.signature;

    return AnimatedBuilder(
      animation: _controller,
      builder: (context, child) {
        final t = _controller.value;
        final scale = animate ? 1 + (t * 0.06) : 1.0;
        final haloScale = animate ? 1 + (t * 0.28) : 1.0;
        return SizedBox(
          height: 168,
          child: Stack(
            alignment: Alignment.center,
            children: [
              // Halo, strongest while waiting on the customer.
              Transform.scale(
                scale: haloScale,
                child: Container(
                  width: 132,
                  height: 132,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: colour.withValues(
                      alpha: animate ? 0.10 * (1 - t) + 0.05 : 0.08,
                    ),
                  ),
                ),
              ),
              Transform.scale(
                scale: scale,
                child: Container(
                  width: 104,
                  height: 104,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: colour.withValues(alpha: 0.14),
                  ),
                  child: step == CardStep.processing && !widget.failed
                      // Processing is the one stage with no customer action,
                      // so it gets a determinate-looking spinner instead.
                      ? Padding(
                          padding: const EdgeInsets.all(26),
                          child: CircularProgressIndicator(
                            strokeWidth: 3.5,
                            color: colour,
                          ),
                        )
                      : Icon(icon, size: 52, color: colour),
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}

/// Dots-and-rail progress across the sale. Gives the clerk a sense of how far
/// along a payment is, which a bare spinner never does.
class _StepTimeline extends StatelessWidget {
  const _StepTimeline({required this.step});

  final CardStep step;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final current = step.timelineIndex;

    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        for (var i = 0; i < CardStep.timeline.length; i++) ...[
          if (i > 0)
            Container(
              width: 26,
              height: 2,
              margin: const EdgeInsets.symmetric(horizontal: 3),
              color: i <= current
                  ? scheme.primary
                  : scheme.outlineVariant,
            ),
          AnimatedContainer(
            duration: const Duration(milliseconds: 300),
            width: i == current ? 14 : 10,
            height: i == current ? 14 : 10,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: i <= current ? scheme.primary : scheme.outlineVariant,
              border: i == current
                  ? Border.all(color: scheme.primary.withValues(alpha: 0.3), width: 4)
                  : null,
            ),
          ),
        ],
      ],
    );
  }
}

class _SignatureActions extends StatelessWidget {
  const _SignatureActions({required this.onAccepted, required this.onRejected});

  final VoidCallback onAccepted;
  final VoidCallback onRejected;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.fromLTRB(24, 0, 24, 24),
      child: Row(
        children: [
          Expanded(
            child: SizedBox(
              height: 60,
              child: OutlinedButton.icon(
                onPressed: onRejected,
                style: OutlinedButton.styleFrom(foregroundColor: scheme.error),
                icon: const Icon(Icons.close),
                label: const Text('Reject'),
              ),
            ),
          ),
          const SizedBox(width: 14),
          Expanded(
            flex: 2,
            child: SizedBox(
              height: 60,
              child: FilledButton.icon(
                onPressed: onAccepted,
                icon: const Icon(Icons.check),
                label: const Text('Signature OK'),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
