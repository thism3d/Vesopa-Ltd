/// The venue's own reasons, as the till asks for them (vesopa_epos
/// lib/ui/void_dialog.dart): set in the back office per action (Error
/// reasons), fetched from /till/error-reasons, with the till's own lists
/// when the venue has none or the network is down.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/session.dart';

/// The till's built-in lists, by the back office's `applies_to` key.
const _fallback = <String, List<String>>{
  'void': ['Customer changed their mind', 'Rung up in error', 'Wrong item rung up', 'Kitchen error', 'Other'],
  'cancel': ['Customer left', 'Ordered by mistake', 'Table walked', 'Training / test', 'Other'],
  'refund': ['Item returned', 'Not as described', 'Wrong item served', 'Other'],
  'no_sale': ['Change for a customer', 'Opened in error', 'Other'],
};

final _cache = <String, List<String>>{};

/// The venue's reasons for [action] (void, cancel, refund, no_sale).
Future<List<String>> reasonsFor(WidgetRef ref, String action) async {
  final cached = _cache[action];
  if (cached != null) return cached;
  try {
    final list = await ref.read(apiProvider).reasons(action);
    if (list.isNotEmpty) return _cache[action] = list;
  } catch (_) {}
  return _fallback[action] ?? const ['Other'];
}

/// Asks why, with the venue's reasons; null when the clerk backs out.
Future<String?> askReason(BuildContext context, WidgetRef ref, String action, {required String title, String? subtitle, String confirm = 'Done'}) async {
  final reasons = await reasonsFor(ref, action);
  if (!context.mounted) return null;
  return showDialog<String>(
    context: context,
    builder: (c) => AlertDialog(
      title: Text(title),
      content: SizedBox(
        width: 420,
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          if (subtitle != null) ...[Text(subtitle, style: Theme.of(c).textTheme.bodySmall), const SizedBox(height: 8)],
          Flexible(
            child: ListView(shrinkWrap: true, children: [
              for (final r in reasons)
                ListTile(
                  title: Text(r),
                  trailing: const Icon(Icons.chevron_right_rounded),
                  onTap: () => Navigator.pop(c, r),
                ),
            ]),
          ),
        ]),
      ),
      actions: [TextButton(onPressed: () => Navigator.pop(c), child: const Text('Keep it'))],
    ),
  );
}
