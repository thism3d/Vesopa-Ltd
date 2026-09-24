/// Swapping the till between its six price levels.
///
/// "…or a setting on the till in functions to swap price levels." This is that
/// setting: six choices, the venue's own names on them where it has given any,
/// and a line saying what it will and will not affect.
///
/// WHY IT SAYS WHAT IT WILL NOT AFFECT
///
/// The question anybody switching a price level actually has is "what happens
/// to the four tables I have open". The answer is nothing — prices are
/// snapshotted onto a line when it is rung up — and it is worth saying on the
/// screen rather than leaving somebody to find out by switching at six o'clock
/// on a Friday and watching the floor.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/price_level_controller.dart';
import '../data/price_levels.dart';
import '../data/till_permissions.dart';
import 'permission_gate.dart';
import 'widgets/pos_message.dart';

/// Offer the six levels and switch to whichever is chosen.
Future<void> showPriceLevelSheet(BuildContext context, WidgetRef ref) async {
  // Changing what everything costs is the same kind of act as overriding one
  // price, so it asks for the same key — and offers the same manager override
  // when the clerk has not got it.
  if (!await allowed(context, ref, TillPermission.setPrice)) return;
  if (!context.mounted) return;

  await showModalBottomSheet<void>(
    context: context,
    builder: (_) => const _PriceLevelSheet(),
  );
}

class _PriceLevelSheet extends ConsumerWidget {
  const _PriceLevelSheet();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final current = ref.watch(currentPriceLevelProvider);
    final names = ref.watch(priceLevelNamesProvider);
    final scheme = Theme.of(context).colorScheme;

    return SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 18, 20, 4),
            child: Row(
              children: [
                const Icon(Icons.sell_outlined),
                const SizedBox(width: 10),
                const Expanded(
                  child: Text(
                    'Price level',
                    style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700),
                  ),
                ),
                IconButton(
                  icon: const Icon(Icons.close),
                  onPressed: () => Navigator.of(context).pop(),
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 12),
            child: Text(
              'What this terminal charges from the next item on. Bills already '
              'open keep the prices they were rung up at.',
              style: TextStyle(color: scheme.onSurfaceVariant),
            ),
          ),
          for (final level in priceLevels)
            ListTile(
              leading: Icon(
                level == current
                    ? Icons.radio_button_checked
                    : Icons.radio_button_unchecked,
                color: level == current ? scheme.primary : null,
              ),
              title: Text(
                names.nameFor(level),
                style: TextStyle(
                  fontWeight: level == current
                      ? FontWeight.w700
                      : FontWeight.w400,
                ),
              ),
              // A venue that has named a level is shown both, because the till
              // key will say the name and the product form says the number.
              subtitle: names.nameFor(level) == 'Price $level'
                  ? null
                  : Text('Price $level'),
              onTap: () async {
                await ref.read(priceLevelProvider.notifier).set(level);
                if (!context.mounted) return;
                Navigator.of(context).pop();
                PosMessenger.success(
                  context,
                  'Now charging ${names.nameFor(level)}.',
                );
              },
            ),
          const SizedBox(height: 12),
        ],
      ),
    );
  }
}
