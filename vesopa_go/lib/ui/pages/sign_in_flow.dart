/// Signing this device in to a venue, after Continue with Vesopa: the site,
/// when the login runs several, and a seat, when every Go licence is in use.
///
/// "All 10 Vesopa Go licences are in use: …" used to be a red paragraph and a
/// trip to the back office. Now the same person, there and then, picks the
/// device to sign out and this one takes its seat (owner, 2026-10-30). The
/// server gives a ten-minute pass with the refusal, for that and nothing else.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/api.dart';
import '../../data/session.dart';
import '../theme.dart';

/// Sign in with [idToken]. Throws [TapApiError] for anything the person has
/// to read; returns quietly when they backed out of a question.
Future<void> commissionDevice(BuildContext context, WidgetRef ref, String idToken) async {
  final session = ref.read(tapProvider.notifier);
  final api = ref.read(apiProvider);
  try {
    final answer = await api.commission(idToken, device: session.terminalName, deviceId: session.deviceId);
    final choice = await session.commissioned(answer);
    if (choice == null || !context.mounted) return;
    // A login that runs several venues: which one is this device for?
    final site = await showDialog<Map<String, dynamic>>(
      context: context,
      builder: (c) => SimpleDialog(title: const Text('Which venue is this device for?'), children: [
        for (final s in choice.sites)
          SimpleDialogOption(onPressed: () => Navigator.pop(c, s), child: Text('${s['name'] ?? s['office_name'] ?? s['id']}')),
      ]),
    );
    if (site == null) return;
    final picked = await api.commissionSite(choice.pickToken, site['id'] as Object, device: session.terminalName, deviceId: session.deviceId);
    await session.commissioned(picked);
  } on TapApiError catch (e) {
    final pass = e.body['release_token'];
    final seats = e.body['seats'];
    if (e.status != 409 || pass is! String || seats is! List || seats.isEmpty || !context.mounted) rethrow;
    final seat = await showModalBottomSheet<Map<String, dynamic>>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => SeatsFullSheet(
        limit: (e.body['licences'] as num?)?.toInt() ?? seats.length,
        seats: [for (final s in seats) if (s is Map) Map<String, dynamic>.from(s)],
      ),
    );
    if (seat == null) return;
    final answer = await api.releaseSeatAndCommission(
      pass,
      '${seat['id']}',
      device: session.terminalName,
      deviceId: session.deviceId,
    );
    await session.commissioned(answer);
  }
}

/// Every licence in use: the devices holding them, least recently used first,
/// to sign one out.
class SeatsFullSheet extends StatelessWidget {
  const SeatsFullSheet({super.key, required this.limit, required this.seats});
  final int limit;
  final List<Map<String, dynamic>> seats;

  static DateTime? _at(Object? v) => v == null ? null : DateTime.tryParse('$v')?.toLocal();

  /// "Used 3 days ago", "Used today", or when it signed in.
  static String lastUsed(Map<String, dynamic> s, [DateTime? now]) {
    final at = _at(s['last_seen_at']) ?? _at(s['signed_in_at']);
    if (at == null) return 'Not used yet';
    final days = (now ?? DateTime.now()).difference(at).inDays;
    String two(int n) => n.toString().padLeft(2, '0');
    if (days <= 0) return 'Used today, ${two(at.hour)}:${two(at.minute)}';
    if (days == 1) return 'Used yesterday';
    if (days < 30) return 'Used $days days ago';
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return 'Last used ${at.day} ${months[at.month - 1]} ${at.year}';
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    // The one nobody has touched for longest first: it is the one to go.
    final sorted = [...seats]..sort((a, b) {
        final x = _at(a['last_seen_at']) ?? _at(a['signed_in_at']) ?? DateTime(2000);
        final y = _at(b['last_seen_at']) ?? _at(b['signed_in_at']) ?? DateTime(2000);
        return x.compareTo(y);
      });
    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.85),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 16),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text('All $limit Vesopa Go licences are in use', style: t.titleLarge?.copyWith(fontWeight: FontWeight.w800)),
            const SizedBox(height: 6),
            Text(
              'Sign one of these devices out and this one takes its licence. '
              'A device that is not used for 30 days gives its licence back by itself.',
              style: t.bodyMedium?.copyWith(color: context.goMuted),
            ),
            const SizedBox(height: 12),
            Flexible(
              child: ListView.separated(
                shrinkWrap: true,
                itemCount: sorted.length,
                separatorBuilder: (_, _) => const Divider(height: 1),
                itemBuilder: (_, i) {
                  final s = sorted[i];
                  final name = '${s['name'] ?? 'A Go device'}';
                  return ListTile(
                    contentPadding: const EdgeInsets.symmetric(horizontal: 4),
                    leading: Icon(name.startsWith('iPhone') || name.startsWith('iPad') ? Icons.phone_iphone_rounded : Icons.phone_android_rounded),
                    title: Text(name),
                    subtitle: Text(lastUsed(s)),
                    trailing: OutlinedButton(
                      onPressed: () async {
                        final sure = await showDialog<bool>(
                          context: context,
                          builder: (c) => AlertDialog(
                            title: Text('Sign out $name?'),
                            content: const Text('It stops working until somebody signs it in again. Bills it holds stay in the back office.'),
                            actions: [
                              TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
                              FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Sign it out')),
                            ],
                          ),
                        );
                        if (sure == true && context.mounted) Navigator.pop(context, s);
                      },
                      child: const Text('Sign out'),
                    ),
                  );
                },
              ),
            ),
            const SizedBox(height: 8),
            TextButton(onPressed: () => Navigator.pop(context), child: const Text('Not now')),
          ]),
        ),
      ),
    );
  }
}
