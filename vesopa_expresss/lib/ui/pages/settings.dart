/// Staff only: the passcode, then Settings, and the way out.
///
/// English only, because it is not a customer screen. Reached from the hidden
/// corner on any screen; the passcode is checked on the kiosk itself against
/// the PBKDF2 hash in its config, so it works with no network.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../config/constants.dart';
import '../../data/passcode.dart';
import '../../data/session.dart';
import '../../platform/kiosk_window.dart';
import '../theme.dart';
import '../widgets/common.dart';
import '../widgets/marks.dart';
import 'setup.dart';

/// Five wrong passcodes and the pad rests for a minute. Somebody guessing at
/// a four-digit code on a kiosk in a public room gets nowhere quickly.
class StaffGate extends ConsumerStatefulWidget {
  const StaffGate({super.key});

  @override
  ConsumerState<StaffGate> createState() => _StaffGateState();
}

class _StaffGateState extends ConsumerState<StaffGate> {
  static int _misses = 0;
  static DateTime? _restUntil;

  bool _open = false;
  bool _busy = false;
  String? _error;
  Timer? _leave;

  @override
  void initState() {
    super.initState();
    // Nobody left a pad open on a kiosk facing the room: it closes itself.
    _leave = Timer(const Duration(seconds: 45), () {
      if (mounted && !_open) Navigator.of(context).maybePop();
    });
  }

  @override
  void dispose() {
    _leave?.cancel();
    super.dispose();
  }

  Future<void> _check(String code) async {
    final check = ref.read(kioskSessionProvider).config?.exit;
    if (check == null) return;
    final rest = _restUntil;
    if (rest != null && DateTime.now().isBefore(rest)) {
      setState(() => _error = 'Too many tries. Wait a minute.');
      return;
    }
    setState(() => _busy = true);
    final ok = await passcodeMatchesAsync(code, check);
    if (!mounted) return;
    if (ok) {
      _misses = 0;
      setState(() {
        _open = true;
        _busy = false;
        _error = null;
      });
    } else {
      _misses++;
      if (_misses >= 5) {
        _misses = 0;
        _restUntil = DateTime.now().add(const Duration(minutes: 1));
      }
      setState(() {
        _busy = false;
        _error = 'That is not the passcode.';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final session = ref.watch(kioskSessionProvider);
    final Widget body;
    if (_open || session.phase == Phase.setup) {
      body = const SettingsPage();
    } else if (session.config?.exit == null) {
      // The venue has no passcode (it was removed in the back office). The
      // kiosk may choose one only because there is none: see the server.
      body = ChoosePasscodePage(onChosen: () => setState(() => _open = true));
    } else {
      body = Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(28),
          child: PasscodeEntry(
            title: 'Staff only',
            subtitle: 'Type the kiosk passcode.',
            error: _error,
            busy: _busy,
            onDone: _check,
          ),
        ),
      );
    }
    return Scaffold(
      backgroundColor: Xp.paper,
      appBar: AppBar(
        backgroundColor: Xp.paper,
        surfaceTintColor: Colors.transparent,
        leading: IconButton(
          iconSize: 32,
          icon: const Icon(Icons.close),
          tooltip: 'Back to the kiosk',
          onPressed: () => Navigator.of(context).pop(),
        ),
        title: const Text('Vesopa Express'),
      ),
      body: body,
    );
  }
}

class SettingsPage extends ConsumerWidget {
  const SettingsPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(kioskSessionProvider);
    final c = session.config;
    final size = MediaQuery.sizeOf(context);
    final text = Theme.of(context).textTheme;

    Widget row(String label, String value) => Padding(
      padding: const EdgeInsets.symmetric(vertical: 9),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(width: 220, child: Text(label, style: text.bodyLarge?.copyWith(color: Xp.muted))),
          Expanded(child: Text(value, style: text.bodyLarge?.copyWith(fontWeight: FontWeight.w700))),
        ],
      ),
    );

    return ListView(
      padding: const EdgeInsets.fromLTRB(32, 12, 32, 40),
      children: [
        Row(children: [
          const ExpressMark(size: 64, tile: true),
          const SizedBox(width: 18),
          Expanded(child: Text('Settings', style: text.headlineLarge)),
        ]),
        const SizedBox(height: 24),
        Container(
          padding: const EdgeInsets.all(22),
          decoration: BoxDecoration(color: Xp.card, borderRadius: BorderRadius.circular(Xp.radius)),
          child: Column(children: [
            row('Venue', c?.venueName.isNotEmpty == true ? c!.venueName : '-'),
            row('This kiosk', c?.kioskName ?? '-'),
            row('Taking orders', switch (session.phase) {
              Phase.ready => c?.demo == true ? 'Yes, in demo mode' : 'Yes',
              Phase.off => 'No: switched off in the back office',
              Phase.offline => 'No: cannot reach the server',
              Phase.setup => 'Not set up',
              _ => '-',
            }),
            row('Card machine', c == null
                ? '-'
                : !c.hasCardMachine
                    ? 'None paired: pair one in the back office, Vesopa Express > Kiosks'
                    : c.sandbox ? 'Paired (Dojo sandbox: test payments)' : 'Paired'),
            row('Menu', '${session.menu.items.length} dishes in ${session.menu.sections.length} sections'),
            row('Server', ExpressConfig.resolvedBase),
            row('Connection', session.connected ? 'OK' : 'Lost: retrying'),
            row('Screen', '${size.width.round()} x ${size.height.round()} '
                '(${size.height >= size.width ? 'portrait' : 'landscape'})'),
            row('Version', '${ExpressConfig.version} (${ExpressConfig.build})'),
          ]),
        ),
        const SizedBox(height: 24),
        Wrap(spacing: 14, runSpacing: 14, children: [
          OutlinedButton.icon(
            icon: const Icon(Icons.refresh),
            label: const Text('Reload the menu'),
            onPressed: () => ref.read(kioskSessionProvider.notifier).refresh(),
          ),
          FilledButton.icon(
            icon: const Icon(Icons.logout),
            label: const Text('Exit Vesopa Express'),
            onPressed: () async {
              final yes = await askYesNo(
                context,
                title: 'Exit Vesopa Express?',
                body: 'The kiosk stops taking orders until the app is opened again.',
                yes: 'Exit',
                no: 'Stay',
              );
              if (yes) await KioskWindow.exitApp();
            },
          ),
          OutlinedButton.icon(
            icon: const Icon(Icons.link_off),
            label: const Text('Sign this kiosk out'),
            onPressed: () async {
              final yes = await askYesNo(
                context,
                title: 'Sign this kiosk out?',
                body: 'A manager will have to set it up again with Continue with Vesopa. '
                    'To stop a kiosk for good, remove it in the back office instead.',
                yes: 'Sign out',
                no: 'Cancel',
                danger: true,
              );
              if (yes) {
                await ref.read(kioskSessionProvider.notifier).signOut();
                if (context.mounted) Navigator.of(context).pop();
              }
            },
          ),
        ]),
      ],
    );
  }
}
