/// "A customer display wants to connect."
///
/// WHY THIS TAKES THE WHOLE SCREEN
///
/// Pairing happens once, on the day a screen is mounted, and it happens while
/// somebody is standing at the counter with a bracket in one hand wondering why
/// the display is showing a code. That person is not going to find Settings ›
/// Customer display on their own, and a badge in a corner is not going to make
/// them.
///
/// So it interrupts. It is the one thing on this screen for as long as it is up,
/// it says exactly what is being asked, and it offers two answers. It is also
/// the only interruption of its kind in the till, which is what keeps it from
/// being noise: it appears at most once per screen, ever.
///
/// AND WHY IT LEAVES ON ITS OWN
///
/// Three things dismiss it, and only one of them is a button:
///
///   * **Connect** — the grant is written, the screen lights up, and this shows
///     what happened for a moment before going.
///   * **Not now** — the screen is remembered as declined and stops
///     interrupting. It is still listed on the customer display page, because
///     "stop asking me" and "never connect this" are different instructions.
///   * **The display stopping** — somebody switches the screen off, or unplugs
///     it, or walks away. The request goes stale within forty-five seconds and
///     this vanishes by itself, rather than leaving a dialog about a screen that
///     is no longer there for somebody to dismiss tomorrow morning.
///
/// The third one is the reason this is a widget in the tree rather than a
/// `showDialog`. A dialog can only be closed by the thing that opened it; this
/// has to be able to close because the *world* changed.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config/constants.dart';
import '../data/device_registry.dart';
import '../data/display_pairing.dart';
import '../data/session_controller.dart';
import '../data/terminal_identity.dart';
import '../main.dart';
import 'theme.dart';

/// Watches for a screen asking to be connected, and puts it in front of
/// whatever the till is doing.
class PairRequestOverlay extends ConsumerStatefulWidget {
  const PairRequestOverlay({required this.child, super.key});

  final Widget child;

  @override
  ConsumerState<PairRequestOverlay> createState() => _PairRequestOverlayState();
}

/// What the overlay is showing.
enum _Phase { asking, connecting, connected, failed }

class _PairRequestOverlayState extends ConsumerState<PairRequestOverlay> {
  Timer? _poll;

  DisplayPairRequest? _request;
  _Phase _phase = _Phase.asking;
  String _message = '';

  /// Cleared when the success card has been up long enough to read.
  Timer? _dismiss;

  @override
  void initState() {
    super.initState();
    // Three seconds, matching how often the display rewrites its request. Any
    // faster and this is reading a file nothing has changed; any slower and
    // somebody who has just switched a screen on stands there wondering.
    _poll = Timer.periodic(const Duration(seconds: 3), (_) => unawaited(_look()));
    unawaited(_look());
  }

  @override
  void dispose() {
    _poll?.cancel();
    _dismiss?.cancel();
    super.dispose();
  }

  Future<void> _look() async {
    // Nothing is offered on a till with no venue. A display is registered
    // against an office and there is not one yet — and interrupting somebody
    // who is part-way through signing the till in, to tell them about a screen
    // they cannot yet connect, would be the worst possible moment for it.
    final session = ref.read(sessionControllerProvider).value;
    if (session == null || !session.signedIn) return;

    // Mid-flight. The result of what is happening now decides what shows next,
    // and a poll landing in the middle of it would replace the success card
    // with the request that produced it.
    if (_phase != _Phase.asking) return;

    final pending = await ref.read(displayPairingProvider).pending();
    if (!mounted) return;

    final next = pending.isEmpty ? null : pending.first;
    if (next?.deviceId == _request?.deviceId) return;
    setState(() => _request = next);
  }

  Future<void> _connect(DisplayPairRequest request) async {
    final session = ref.read(sessionControllerProvider).value;
    setState(() => _phase = _Phase.connecting);

    final failure = await ref
        .read(displayPairingProvider)
        .connect(
          request,
          office: session?.office ?? '',
          terminalName: ref.read(terminalNameProvider),
          venueName: session?.venueName ?? '',
        );
    if (!mounted) return;

    if (failure != null) {
      setState(() {
        _phase = _Phase.failed;
        _message = _explain(failure);
      });
      return;
    }

    setState(() {
      _phase = _Phase.connected;
      _message = request.name;
    });

    // The back office is told second and never waited on. A venue whose
    // broadband is down still gets a working customer display; what it does not
    // get, until the next start, is a row on a screen somebody looks at once a
    // month.
    unawaited(_register(session));

    // Long enough to read, short enough that nobody has to dismiss it. The
    // screen itself is already showing the same news to the customer's side of
    // the counter.
    _dismiss = Timer(const Duration(seconds: 4), () {
      if (mounted) setState(() => _reset());
    });
  }

  Future<void> _register(Session? session) async {
    if (session == null || !session.signedIn) return;
    final registry = ref.read(deviceRegistryProvider);
    if (!registry.canRegister) return;

    await registry.register(
      describeDevices(
        terminalDeviceId: await terminalDeviceId(),
        terminalName: ref.read(terminalNameProvider),
        appVersion: VesopaBrand.appVersion,
        signedInAs: session.email,
        displays: await ref.read(displayPairingProvider).paired(),
      ),
    );
  }

  Future<void> _decline(DisplayPairRequest request) async {
    await ref.read(displayPairingProvider).decline(request.deviceId);
    if (mounted) setState(() => _reset());
  }

  void _reset() {
    _request = null;
    _phase = _Phase.asking;
    _message = '';
  }

  static String _explain(PairFailure failure) => switch (failure) {
    PairFailure.notSignedIn =>
      'Sign this till in first. A customer display belongs to a venue, and '
          'until the till is signed in there is no venue to attach it to.',
    PairFailure.noSharedFolder =>
      'This machine has no shared folder for the two applications to meet in, '
          'so a display cannot be connected on it.',
    PairFailure.noBasketFolder =>
      'The till could not open its own data folder, so there is no file to '
          'point the screen at. Nothing else about the till is affected.',
    PairFailure.couldNotWrite =>
      'The till could not write the connection file. Check that this account '
          'can write to the Vesopa folder in ProgramData.',
  };

  @override
  Widget build(BuildContext context) {
    final request = _request;

    return Stack(
      children: [
        widget.child,
        if (request != null)
          Positioned.fill(
            child: _PairSheet(
              request: request,
              phase: _phase,
              message: _message,
              onConnect: () => unawaited(_connect(request)),
              onDecline: () => unawaited(_decline(request)),
              onDone: () => setState(_reset),
            ),
          ),
      ],
    );
  }
}

/// The card itself, over a scrim that swallows every touch behind it.
class _PairSheet extends StatelessWidget {
  const _PairSheet({
    required this.request,
    required this.phase,
    required this.message,
    required this.onConnect,
    required this.onDecline,
    required this.onDone,
  });

  final DisplayPairRequest request;
  final _Phase phase;
  final String message;
  final VoidCallback onConnect;
  final VoidCallback onDecline;
  final VoidCallback onDone;

  @override
  Widget build(BuildContext context) {
    // A short fade, so the card arrives rather than appearing. Anything longer
    // and a manager has pressed through it before it has finished.
    return TweenAnimationBuilder<double>(
      tween: Tween(begin: 0, end: 1),
      duration: const Duration(milliseconds: 180),
      builder: (_, t, child) => Opacity(opacity: t, child: child),
      child: Material(
      // Not transparent, and not dismissible by tapping past it. A half-pressed
      // answer to "shall I connect this screen" is not an answer, and a scrim
      // that closes on a stray touch is how a manager ends up with a display
      // that never asked again.
        color: Colors.black.withValues(alpha: 0.72),
        child: Center(
          // Scrollable, because this card is tall and a till in portrait — or
          // one whose window has been dragged small — must not clip the buttons
          // off the bottom of the one dialog that has no other way out.
          child: SingleChildScrollView(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 560),
              child: Card(
                margin: const EdgeInsets.all(24),
                elevation: 12,
                child: Padding(
                  padding: const EdgeInsets.all(32),
                  child: switch (phase) {
                    _Phase.asking => _Asking(
                      request: request,
                      onConnect: onConnect,
                      onDecline: onDecline,
                    ),
                    _Phase.connecting => const _Busy(),
                    _Phase.connected => _Connected(name: message),
                    _Phase.failed => _Failed(message: message, onDone: onDone),
                  },
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _Asking extends StatelessWidget {
  const _Asking({
    required this.request,
    required this.onConnect,
    required this.onDecline,
  });

  final DisplayPairRequest request;
  final VoidCallback onConnect;
  final VoidCallback onDecline;

  @override
  Widget build(BuildContext context) => Column(
    mainAxisSize: MainAxisSize.min,
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      const Icon(Icons.tv_outlined, size: 44, color: Pos.brandDeep),
      const SizedBox(height: 16),
      const Text(
        'A customer display wants to connect',
        textAlign: TextAlign.center,
        style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700),
      ),
      const SizedBox(height: 8),
      Text(
        request.name,
        textAlign: TextAlign.center,
        style: const TextStyle(fontSize: 15, color: Pos.graphite),
      ),
      const SizedBox(height: 24),

      // The code, and the one instruction that matters. This is the only thing
      // on the card the manager has to *check* rather than read — everything
      // else is the till telling them what it found.
      Container(
        padding: const EdgeInsets.symmetric(vertical: 18),
        decoration: BoxDecoration(
          color: Pos.brandSoft,
          borderRadius: BorderRadius.circular(12),
        ),
        child: Column(
          children: [
            const Text(
              'CHECK THIS MATCHES THE SCREEN',
              style: TextStyle(
                fontSize: 11,
                letterSpacing: 1.8,
                fontWeight: FontWeight.w700,
                color: Pos.brandDeep,
              ),
            ),
            const SizedBox(height: 6),
            Text(
              request.code,
              style: const TextStyle(
                fontSize: 52,
                height: 1.05,
                letterSpacing: 10,
                fontWeight: FontWeight.w700,
                color: Pos.onBrand,
              ),
            ),
          ],
        ),
      ),
      const SizedBox(height: 20),
      const Text(
        'The display is showing four digits. If they are the same, connect it — '
        'the screen will start showing bills straight away.',
        textAlign: TextAlign.center,
        style: TextStyle(fontSize: 13.5, height: 1.45, color: Pos.graphite),
      ),
      const SizedBox(height: 26),
      Row(
        children: [
          Expanded(
            child: OutlinedButton(
              onPressed: onDecline,
              style: OutlinedButton.styleFrom(
                padding: const EdgeInsets.symmetric(vertical: 16),
              ),
              child: const Text('Not now'),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            flex: 2,
            child: FilledButton(
              onPressed: onConnect,
              style: FilledButton.styleFrom(
                padding: const EdgeInsets.symmetric(vertical: 16),
              ),
              child: const Text('Connect this screen'),
            ),
          ),
        ],
      ),
      const SizedBox(height: 10),
      const Text(
        'Not now stops it interrupting. You can still connect it from '
        'Settings › Customer display.',
        textAlign: TextAlign.center,
        style: TextStyle(fontSize: 11.5, color: Pos.graphite),
      ),
    ],
  );
}

class _Busy extends StatelessWidget {
  const _Busy();

  @override
  Widget build(BuildContext context) => const Column(
    mainAxisSize: MainAxisSize.min,
    children: [
      SizedBox(height: 8),
      CircularProgressIndicator(),
      SizedBox(height: 20),
      Text('Connecting…', style: TextStyle(fontSize: 17)),
      SizedBox(height: 8),
    ],
  );
}

class _Connected extends StatelessWidget {
  const _Connected({required this.name});

  final String name;

  @override
  Widget build(BuildContext context) => Column(
    mainAxisSize: MainAxisSize.min,
    children: [
      const Icon(Icons.check_circle, size: 52, color: Pos.green),
      const SizedBox(height: 16),
      const Text(
        'Connected',
        style: TextStyle(fontSize: 24, fontWeight: FontWeight.w700),
      ),
      const SizedBox(height: 10),
      Text(
        '$name is showing this till.',
        textAlign: TextAlign.center,
        style: const TextStyle(fontSize: 15),
      ),
      const SizedBox(height: 12),
      const Text(
        'It stays connected through updates and reinstalls — this till tells it '
        'where to look every time it starts.',
        textAlign: TextAlign.center,
        style: TextStyle(fontSize: 12.5, height: 1.4, color: Pos.graphite),
      ),
    ],
  );
}

class _Failed extends StatelessWidget {
  const _Failed({required this.message, required this.onDone});

  final String message;
  final VoidCallback onDone;

  @override
  Widget build(BuildContext context) => Column(
    mainAxisSize: MainAxisSize.min,
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      const Icon(Icons.error_outline, size: 44, color: Pos.red),
      const SizedBox(height: 16),
      const Text(
        'That screen could not be connected',
        textAlign: TextAlign.center,
        style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700),
      ),
      const SizedBox(height: 12),
      Text(
        message,
        textAlign: TextAlign.center,
        style: const TextStyle(fontSize: 13.5, height: 1.45),
      ),
      const SizedBox(height: 24),
      FilledButton(
        onPressed: onDone,
        style: FilledButton.styleFrom(
          padding: const EdgeInsets.symmetric(vertical: 14),
        ),
        child: const Text('OK'),
      ),
    ],
  );
}
