/// Settings for a device running as a kitchen screen or a customer display:
/// behind a manager's PIN, because the screen is out where anybody can touch
/// it. What it runs as (unless the back office fixed it), and whatever the
/// mode adds of its own.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/session.dart';
import '../data/till_permissions.dart';
import '../ui/adaptive.dart';
import '../ui/app_version.dart';
import '../ui/theme.dart';
import '../ui/tv.dart';
import 'device_mode.dart';

/// A manager's PIN, as the till asks for one; true when it is right.
///
/// On a TV (or a box driven by a remote) there is no touch and no on-screen
/// keyboard worth using: the PIN comes from the remote itself (owner,
/// 2026-11-19), see [RemotePinDialog].
Future<bool> askManagerPin(BuildContext context, WidgetRef ref, {required String why}) async {
  if (GoDevice.isTv || GoDevice.remote.value) {
    final typed = await showDialog<String>(context: context, builder: (_) => RemotePinDialog(title: why));
    if (typed == null) return false;
    final manager = ref.read(tapProvider.notifier).managerByPin(typed, TillPermission.isManager);
    if (manager == null && context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("That is not a manager's PIN.")));
    }
    return manager != null;
  }
  final pin = TextEditingController();
  final ok = await showAdaptiveDialog<bool>(
    context: context,
    builder: (c) => AlertDialog.adaptive(
      title: Text(why),
      content: Padding(
        padding: const EdgeInsets.only(top: 12),
        child: Material(
          type: MaterialType.transparency,
          child: TextField(
            controller: pin,
            autofocus: true,
            obscureText: true,
            keyboardType: TextInputType.number,
            inputFormatters: [FilteringTextInputFormatter.digitsOnly],
            decoration: const InputDecoration(labelText: "A manager's PIN"),
            onSubmitted: (_) => Navigator.pop(c, true),
          ),
        ),
      ),
      actions: [
        adaptiveAction(c, label: 'Cancel', onPressed: () => Navigator.pop(c, false)),
        adaptiveAction(c, label: 'Continue', primary: true, onPressed: () => Navigator.pop(c, true)),
      ],
    ),
  );
  if (ok != true) return false;
  final manager = ref.read(tapProvider.notifier).managerByPin(pin.text.trim(), TillPermission.isManager);
  if (manager == null && context.mounted) {
    HapticFeedback.vibrate();
    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("That is not a manager's PIN.")));
  }
  return manager != null;
}

/// The settings sheet, after the PIN.
///
/// [unlocked]: opened from Vesopa Go on a phone, which asked for a manager's
/// PIN itself (lib/remote/remote_page.dart).
Future<void> showModeSettings(BuildContext context, WidgetRef ref, {List<Widget> extra = const [], bool unlocked = false}) async {
  if (!unlocked && !await askManagerPin(context, ref, why: 'Settings')) return;
  if (!context.mounted) return;
  await showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (c) => Consumer(builder: (c, ref, _) {
      final m = ref.watch(deviceModeProvider);
      final t = Theme.of(c).textTheme;
      final venue = ref.watch(tapProvider.select((s) => s.venue?.name)) ?? '';
      return SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 24),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('Settings', style: t.titleLarge?.copyWith(fontWeight: FontWeight.w700)),
          if (venue.isNotEmpty) Text(venue, style: t.bodySmall),
          const SizedBox(height: 12),
          ...extra,
          Card(
            child: ListTile(
              leading: Icon(m.mode?.icon ?? Icons.devices_rounded),
              title: Text('Runs as ${m.mode?.label ?? '…'}'),
              subtitle: Text(m.fixed ? 'Set for this device in the back office (Devices).' : 'Change what this device is used for.'),
              trailing: m.fixed ? const Icon(Icons.lock_rounded) : const Icon(Icons.chevron_right_rounded),
              onTap: m.fixed
                  ? null
                  : () {
                      Navigator.pop(c);
                      ref.read(deviceModeProvider.notifier).forget();
                    },
            ),
          ),
          for (final other in DeviceMode.available)
            if (other != m.mode)
              Card(
                child: ListTile(
                  leading: Icon(other.icon),
                  title: Text('Switch to ${other.label}'),
                  subtitle: Text(other.detail),
                  onTap: () async {
                    Navigator.pop(c);
                    final why = await ref.read(deviceModeProvider.notifier).switchTo(other);
                    if (why != null && context.mounted) {
                      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(why)));
                    }
                  },
                ),
              ),
          Card(
            child: ListTile(
              leading: const Icon(Icons.refresh_rounded),
              title: const Text('Check the back office again'),
              subtitle: const Text('For a change made on the Devices page just now.'),
              onTap: () {
                Navigator.pop(c);
                ref.read(deviceModeProvider.notifier).load(again: true);
              },
            ),
          ),
          const AppVersionLine(),
        ]),
      );
    }),
  );
}


/// A PIN typed with a TV remote, never an on-screen keyboard.
///
/// The remote's number buttons type it. A remote without them: Up and Down
/// choose a digit, Right (or OK) adds it, Left deletes. OK unlocks once there
/// are four digits or more; Back cancels. Answers with the PIN, or null.
class RemotePinDialog extends StatefulWidget {
  const RemotePinDialog({super.key, required this.title});
  final String title;

  @override
  State<RemotePinDialog> createState() => _RemotePinDialogState();
}

class _RemotePinDialogState extends State<RemotePinDialog> {
  final _focus = FocusNode();
  String _pin = '';
  int _digit = 0;

  static final _digits = {
    LogicalKeyboardKey.digit0: 0, LogicalKeyboardKey.digit1: 1, LogicalKeyboardKey.digit2: 2,
    LogicalKeyboardKey.digit3: 3, LogicalKeyboardKey.digit4: 4, LogicalKeyboardKey.digit5: 5,
    LogicalKeyboardKey.digit6: 6, LogicalKeyboardKey.digit7: 7, LogicalKeyboardKey.digit8: 8,
    LogicalKeyboardKey.digit9: 9,
    LogicalKeyboardKey.numpad0: 0, LogicalKeyboardKey.numpad1: 1, LogicalKeyboardKey.numpad2: 2,
    LogicalKeyboardKey.numpad3: 3, LogicalKeyboardKey.numpad4: 4, LogicalKeyboardKey.numpad5: 5,
    LogicalKeyboardKey.numpad6: 6, LogicalKeyboardKey.numpad7: 7, LogicalKeyboardKey.numpad8: 8,
    LogicalKeyboardKey.numpad9: 9,
  };

  @override
  void dispose() {
    _focus.dispose();
    super.dispose();
  }

  void _add(int d) {
    if (_pin.length >= 8) return;
    setState(() => _pin += '$d');
  }

  KeyEventResult _key(FocusNode _, KeyEvent e) {
    if (e is! KeyDownEvent && e is! KeyRepeatEvent) return KeyEventResult.ignored;
    final k = e.logicalKey;
    final typed = _digits[k];
    if (typed != null) {
      _add(typed);
      return KeyEventResult.handled;
    }
    if (k == LogicalKeyboardKey.arrowUp) {
      setState(() => _digit = (_digit + 1) % 10);
    } else if (k == LogicalKeyboardKey.arrowDown) {
      setState(() => _digit = (_digit + 9) % 10);
    } else if (k == LogicalKeyboardKey.arrowRight) {
      _add(_digit);
    } else if (k == LogicalKeyboardKey.arrowLeft || k == LogicalKeyboardKey.backspace || k == LogicalKeyboardKey.delete) {
      if (_pin.isNotEmpty) setState(() => _pin = _pin.substring(0, _pin.length - 1));
    } else if (k == LogicalKeyboardKey.select || k == LogicalKeyboardKey.enter || k == LogicalKeyboardKey.numpadEnter ||
        k == LogicalKeyboardKey.gameButtonA) {
      if (_pin.length >= 4) {
        Navigator.pop(context, _pin);
      } else {
        _add(_digit);
      }
    } else if (k == LogicalKeyboardKey.escape || k == LogicalKeyboardKey.goBack || k == LogicalKeyboardKey.browserBack) {
      Navigator.pop(context);
    } else {
      return KeyEventResult.ignored;
    }
    return KeyEventResult.handled;
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final accent = Theme.of(context).colorScheme.primary;
    return Focus(
      focusNode: _focus,
      autofocus: true,
      onKeyEvent: _key,
      child: AlertDialog(
        title: Text(widget.title),
        content: SizedBox(
          width: 520,
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text("A manager's PIN", style: t.titleMedium),
            const SizedBox(height: 16),
            Row(mainAxisAlignment: MainAxisAlignment.center, children: [
              for (var i = 0; i < _pin.length; i++)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 6),
                  child: Container(width: 18, height: 18, decoration: BoxDecoration(color: context.goText, shape: BoxShape.circle)),
                ),
              const SizedBox(width: 14),
              // The digit Up and Down choose, for a remote with no numbers.
              Container(
                key: const ValueKey('remote-pin-digit'),
                width: 64,
                padding: const EdgeInsets.symmetric(vertical: 4),
                decoration: BoxDecoration(border: Border.all(color: accent, width: 3), borderRadius: BorderRadius.circular(14)),
                child: Column(mainAxisSize: MainAxisSize.min, children: [
                  Icon(Icons.keyboard_arrow_up_rounded, color: accent),
                  Text('$_digit', style: t.headlineMedium?.copyWith(fontWeight: FontWeight.w900, fontFeatures: Tp.tabular)),
                  Icon(Icons.keyboard_arrow_down_rounded, color: accent),
                ]),
              ),
            ]),
            const SizedBox(height: 18),
            Text(
              'Type it with the number buttons on the remote. No number buttons? Up and Down choose a digit, '
              'Right adds it, Left deletes. OK unlocks. Back cancels.',
              style: t.bodyMedium?.copyWith(color: context.goMuted, height: 1.35),
            ),
            const SizedBox(height: 6),
            Text('Or unlock it from Vesopa Go on a phone or tablet: Screens and TVs, then this screen.',
                style: t.bodySmall?.copyWith(color: context.goMuted)),
          ]),
        ),
      ),
    );
  }
}
