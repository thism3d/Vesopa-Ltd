/// The screens a kiosk shows before it is selling: starting, being set up,
/// choosing its passcode, and closed.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../config/constants.dart';
import '../../data/order_flow.dart';
import '../../data/session.dart';
import '../../platform/kiosk_window.dart';
import '../theme.dart';
import '../widgets/common.dart';
import '../widgets/marks.dart';

class SplashPage extends StatelessWidget {
  const SplashPage({super.key});

  @override
  Widget build(BuildContext context) => const ColoredBox(
    color: Xp.night,
    child: Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          ExpressMark(size: 120, onDark: true),
          SizedBox(height: 28),
          SizedBox(width: 36, height: 36, child: CircularProgressIndicator(color: Xp.lime, strokeWidth: 3)),
        ],
      ),
    ),
  );
}

/// Setting a kiosk up: Continue with Vesopa, and nothing else.
///
/// The owner's rule for the whole platform -- one way in, with the Vesopa mark
/// on it, worded exactly "Continue with Vesopa" -- and no self-registration:
/// the person pressing it must already be a manager of a venue in the back
/// office. Done once per machine; the kiosk keeps its own token after that and
/// nobody stays signed in as the manager.
class SetupPage extends ConsumerStatefulWidget {
  const SetupPage({super.key});

  @override
  ConsumerState<SetupPage> createState() => _SetupPageState();
}

class _SetupPageState extends ConsumerState<SetupPage> {
  bool _busy = false;
  String? _error;
  Uri? _opened;

  Future<void> _continue() async {
    setState(() {
      _busy = true;
      _error = null;
      _opened = null;
    });
    // The kiosk gets out of the way so the sign-in browser can be seen, and
    // comes back afterwards whatever happens -- including when the sign-in
    // fails, or this page is gone by the time it does.
    //
    // It comes back BEFORE the phase changes, not after: a frame built while
    // the kiosk is off the screen is never presented, so relocking afterwards
    // left a manager who had just signed in still looking at "Set up this
    // kiosk". Hence `beforeApply`, and hence the guard -- it must run exactly
    // once, whichever of the two paths gets there first.
    await KioskWindow.release();
    var relocked = false;
    Future<void> relock() async {
      if (relocked) return;
      relocked = true;
      await KioskWindow.relock();
    }

    try {
      await ref.read(kioskSessionProvider.notifier).commission(
        onUrl: (url) {
          if (mounted) setState(() => _opened = url);
        },
        beforeApply: relock,
      );
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    } finally {
      await relock();
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final message = ref.watch(kioskSessionProvider.select((s) => s.message));
    final text = Theme.of(context).textTheme;
    return ColoredBox(
      color: Xp.paper,
      child: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(32),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 560),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const ExpressMark(size: 132, tile: true),
                const SizedBox(height: 20),
                Text('Vesopa Express', style: text.headlineLarge),
                const SizedBox(height: 8),
                Text(
                  'Set up this kiosk',
                  style: text.titleLarge?.copyWith(color: Xp.inkSoft),
                ),
                const SizedBox(height: 18),
                Text(
                  'A manager of this venue signs in once with their Vesopa account. '
                  'The kiosk keeps its own login from then on, so nobody stays '
                  'signed in as you. Vesopa Express has to be switched on for the '
                  'venue in the back office first.',
                  textAlign: TextAlign.center,
                  style: text.bodyLarge?.copyWith(color: Xp.inkSoft),
                ),
                if (message != null) ...[
                  const SizedBox(height: 18),
                  _Notice(message, tone: Xp.amber),
                ],
                if (_error != null) ...[
                  const SizedBox(height: 18),
                  _Notice(_error!, tone: Xp.danger),
                ],
                const SizedBox(height: 26),
                // Lime on black, the Vesopa mark, and exactly these words: the
                // same button the back office, the till and the kitchen draw.
                SizedBox(
                  width: double.infinity,
                  child: FilledButton.icon(
                    style: FilledButton.styleFrom(
                      backgroundColor: Xp.lime,
                      foregroundColor: Colors.black,
                    ),
                    onPressed: _busy ? null : _continue,
                    icon: _busy
                        ? const SizedBox(
                            width: 24,
                            height: 24,
                            child: CircularProgressIndicator(strokeWidth: 2.6, color: Colors.black),
                          )
                        : const VesopaMark(size: 26),
                    label: const Text('Continue with Vesopa'),
                  ),
                ),
                if (_opened != null) ...[
                  const SizedBox(height: 12),
                  SelectableText(
                    'Finish in the browser, or open this on your phone:\n${_opened!.origin}',
                    textAlign: TextAlign.center,
                    style: text.bodySmall?.copyWith(color: Xp.muted),
                  ),
                ],
                const SizedBox(height: 26),
                Text(
                  ExpressConfig.isLive
                      ? 'Connecting to ${Uri.parse(ExpressConfig.resolvedBase).host}'
                      : 'Server: ${ExpressConfig.resolvedBase}',
                  style: text.bodySmall?.copyWith(color: Xp.muted),
                ),
                const SizedBox(height: 8),
                // Nothing is locked to a venue yet, so there is no passcode to
                // ask for: whoever is installing it may leave.
                TextButton(onPressed: KioskWindow.exitApp, child: const Text('Exit Vesopa Express')),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _Notice extends StatelessWidget {
  const _Notice(this.text, {required this.tone});
  final String text;
  final Color tone;

  @override
  Widget build(BuildContext context) => Container(
    width: double.infinity,
    padding: const EdgeInsets.all(14),
    decoration: BoxDecoration(
      color: tone.withValues(alpha: .12),
      borderRadius: BorderRadius.circular(14),
      border: Border.all(color: tone.withValues(alpha: .4)),
    ),
    child: Text(text, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600, color: Xp.ink)),
  );
}

/// Entering a passcode: dots and a number pad. Used to choose one and to
/// check one.
class PasscodeEntry extends StatefulWidget {
  const PasscodeEntry({
    super.key,
    required this.title,
    required this.subtitle,
    required this.onDone,
    this.error,
    this.busy = false,
    this.okLabel = 'OK',
  });

  final String title;
  final String subtitle;
  final Future<void> Function(String code) onDone;
  final String? error;
  final bool busy;
  final String okLabel;

  @override
  State<PasscodeEntry> createState() => _PasscodeEntryState();
}

class _PasscodeEntryState extends State<PasscodeEntry> {
  String _code = '';

  @override
  void didUpdateWidget(covariant PasscodeEntry old) {
    super.didUpdateWidget(old);
    if (widget.error != null && widget.error != old.error) _code = '';
  }

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final skin = XpSkin.of(context);
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(widget.title, style: text.headlineMedium, textAlign: TextAlign.center),
        const SizedBox(height: 8),
        Text(widget.subtitle, style: text.bodyLarge?.copyWith(color: skin.inkSoft), textAlign: TextAlign.center),
        const SizedBox(height: 22),
        SizedBox(
          height: 30,
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              for (var i = 0; i < 8; i++)
                AnimatedContainer(
                  duration: const Duration(milliseconds: 120),
                  margin: const EdgeInsets.symmetric(horizontal: 7),
                  width: i < _code.length ? 22 : 16,
                  height: i < _code.length ? 22 : 16,
                  decoration: BoxDecoration(
                    color: i < _code.length ? Xp.lime : Colors.transparent,
                    shape: BoxShape.circle,
                    border: Border.all(color: i < 4 || i < _code.length ? skin.inkSoft : skin.line, width: 2),
                  ),
                ),
            ],
          ),
        ),
        const SizedBox(height: 10),
        SizedBox(
          height: 28,
          child: widget.error == null
              ? null
              : Text(widget.error!, style: const TextStyle(color: Xp.danger, fontWeight: FontWeight.w700, fontSize: 16)),
        ),
        const SizedBox(height: 8),
        DigitPad(
          okLabel: widget.okLabel,
          onDigit: (d) => setState(() => _code = _code.length < 8 ? _code + d : _code),
          onBack: () => setState(() => _code = _code.isEmpty ? '' : _code.substring(0, _code.length - 1)),
          onOk: _code.length >= 4 && !widget.busy
              ? () async {
                  final code = _code;
                  await widget.onDone(code);
                  if (mounted) setState(() => _code = '');
                }
              : null,
        ),
      ],
    );
  }
}

/// Just set up, in a venue with no exit passcode: the manager chooses one now.
///
/// The one moment somebody with the authority to choose it is certainly
/// standing at the kiosk. After this it is changed in the back office only.
class ChoosePasscodePage extends ConsumerStatefulWidget {
  const ChoosePasscodePage({super.key, this.onChosen});

  /// For the staff gate, which uses this when a venue's passcode was removed.
  final VoidCallback? onChosen;

  @override
  ConsumerState<ChoosePasscodePage> createState() => _ChoosePasscodePageState();
}

class _ChoosePasscodePageState extends ConsumerState<ChoosePasscodePage> {
  String? _first;
  String? _error;
  bool _busy = false;

  Future<void> _entered(String code) async {
    if (_first == null) {
      setState(() {
        _first = code;
        _error = null;
      });
      return;
    }
    if (code != _first) {
      setState(() {
        _first = null;
        _error = 'Those did not match. Start again.';
      });
      return;
    }
    setState(() => _busy = true);
    try {
      await ref.read(kioskSessionProvider.notifier).setFirstPasscode(code);
      widget.onChosen?.call();
    } catch (e) {
      if (mounted) {
        setState(() {
          _first = null;
          _error = '$e';
        });
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final venue = ref.watch(kioskSessionProvider.select((s) => s.message));
    return ColoredBox(
      color: Xp.paper,
      child: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(28),
          child: PasscodeEntry(
            busy: _busy,
            error: _error,
            okLabel: _first == null ? 'Next' : 'Save',
            title: _first == null ? 'Choose the kiosk passcode' : 'Type it again',
            subtitle: _first == null
                ? 'Four to eight digits. Staff hold the bottom-left corner for three '
                    'seconds and type it to reach Settings${venue == null || venue.isEmpty ? '' : ' at $venue'}. '
                    'It can be changed later in the back office.'
                : 'To be sure it is the one you meant.',
            onDone: _entered,
          ),
        ),
      ),
    );
  }
}

enum ClosedKind { off, offline, noMenu }

/// The kiosk is not taking orders, and says so calmly.
///
/// Customer-facing: it tells somebody where to order instead, in their
/// language, and never shows a spinner that looks like it might become a menu.
class ClosedPage extends ConsumerWidget {
  const ClosedPage({super.key, required this.kind});

  final ClosedKind kind;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = ref.watch(orderFlowProvider.select((f) => f.s));
    final venue = ref.watch(kioskSessionProvider.select((st) => st.config?.venueName)) ?? '';
    final (title, body, icon) = switch (kind) {
      ClosedKind.off => (s('off_title'), s('off_body'), Icons.storefront_outlined),
      ClosedKind.offline => (s('offline_title'), s('offline_body'), Icons.wifi_off_rounded),
      ClosedKind.noMenu => (s('no_menu'), s('no_menu_sub'), Icons.menu_book_outlined),
    };
    if (kind == ClosedKind.offline) {
      // Keep knocking. The session retries on its own; this nudges it along
      // if the network came back while nothing was due.
      unawaited(Future.delayed(const Duration(seconds: 15), () {
        if (context.mounted) ref.read(kioskSessionProvider.notifier).refresh();
      }));
    }
    return ColoredBox(
      color: Xp.night,
      child: SafeArea(
        child: Stack(
          children: [
            Center(
              child: Padding(
                padding: const EdgeInsets.all(40),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(icon, size: 88, color: Xp.lime),
                    const SizedBox(height: 26),
                    Text(title,
                        textAlign: TextAlign.center,
                        style: const TextStyle(fontSize: 44, fontWeight: FontWeight.w800, color: Colors.white, height: 1.1)),
                    const SizedBox(height: 14),
                    Text(body,
                        textAlign: TextAlign.center,
                        style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w500, color: Color(0xFFC9D0BA))),
                    if (venue.isNotEmpty) ...[
                      const SizedBox(height: 32),
                      Text(venue, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700, color: Color(0xFF8C9478))),
                    ],
                  ],
                ),
              ),
            ),
            const Positioned(
              right: 28,
              bottom: 24,
              child: Row(children: [
                ExpressMark(size: 30, onDark: true),
                SizedBox(width: 10),
                Text('Vesopa Express', style: TextStyle(color: Color(0xFF8C9478), fontWeight: FontWeight.w700)),
              ]),
            ),
          ],
        ),
      ),
    );
  }
}
