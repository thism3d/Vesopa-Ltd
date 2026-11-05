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
import 'device_mode.dart';

/// A manager's PIN, as the till asks for one; true when it is right.
Future<bool> askManagerPin(BuildContext context, WidgetRef ref, {required String why}) async {
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
Future<void> showModeSettings(BuildContext context, WidgetRef ref, {List<Widget> extra = const []}) async {
  if (!await askManagerPin(context, ref, why: 'Settings') || !context.mounted) return;
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
          for (final other in DeviceMode.values)
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
        ]),
      );
    }),
  );
}
