import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config/constants.dart';
import '../data/providers.dart';
import 'theme.dart';
import 'widgets/brand_mark.dart';

/// The speech-bubble key in the header: what this screen is, and who to ring.
///
/// It exists for a phone call. When a kitchen rings support the first four
/// questions are always the same — which venue, which board, is it connected,
/// what version — and without a panel like this the answers involve somebody
/// walking to an office. Every one of them is on this one screen, and the
/// **Copy** key puts the lot on the clipboard for an email.
///
/// The support number is here rather than only on a card taped to the wall,
/// because the card falls off.
Future<void> showKitchenInfo(BuildContext context) => showDialog<void>(
  context: context,
  builder: (_) => const Dialog(child: _InfoSheet()),
);

class _InfoSheet extends ConsumerWidget {
  const _InfoSheet();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(kitchenSessionProvider).value;
    final board = ref.watch(ticketBoardProvider);
    if (session == null) return const SizedBox.shrink();

    final facts = <String, String>{
      'Venue': session.officeName ?? session.office ?? '—',
      'Office key': session.office ?? '—',
      'Signed in as': session.userName ?? '—',
      'This board': session.screen.name,
      'Stations': session.screen.stations.isEmpty
          ? 'Every station'
          : session.screen.stations.map(session.labelFor).join(', '),
      'Back office': board.online ? 'Connected' : 'Not reachable',
      'Server': Uri.parse(Api.resolvedBase).host,
      'Environment': Api.environmentName,
      'Orders on the board': '${board.tickets.length}',
      if (board.queuedActions > 0)
        'Changes waiting to send': '${board.queuedActions}',
    };

    return ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 560, maxHeight: 720),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          AppBar(
            title: const Text('About this screen'),
            automaticallyImplyLeading: false,
            actions: [
              IconButton(
                icon: const Icon(Icons.close),
                onPressed: () => Navigator.of(context).pop(),
              ),
            ],
          ),
          Flexible(
            child: ListView(
              padding: const EdgeInsets.fromLTRB(18, 14, 18, 18),
              children: [
                Row(
                  children: [
                    const BrandMark(size: 40),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            VesopaBrand.appName,
                            style: Theme.of(context).textTheme.titleMedium
                                ?.copyWith(fontWeight: FontWeight.w700),
                          ),
                          const Text(
                            VesopaBrand.slogan,
                            style: TextStyle(
                              color: Kds.inkMuted,
                              fontSize: 12.5,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
                const Divider(height: 26),

                for (final entry in facts.entries)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 3),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        SizedBox(
                          width: 190,
                          child: Text(
                            entry.key,
                            style: const TextStyle(color: Kds.inkMuted),
                          ),
                        ),
                        Expanded(
                          child: SelectableText(
                            entry.value,
                            style: const TextStyle(
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),

                const Divider(height: 26),
                const Text(
                  'Support',
                  style: TextStyle(fontWeight: FontWeight.w700, fontSize: 15),
                ),
                const SizedBox(height: 4),
                const SelectableText(
                  '${VesopaBrand.phone}\n${VesopaBrand.email}\n'
                  '${VesopaBrand.website}',
                ),

                const SizedBox(height: 16),
                Row(
                  children: [
                    OutlinedButton.icon(
                      onPressed: () {
                        Clipboard.setData(
                          ClipboardData(
                            text: facts.entries
                                .map((e) => '${e.key}: ${e.value}')
                                .join('\n'),
                          ),
                        );
                        ScaffoldMessenger.of(context)
                          ..clearSnackBars()
                          ..showSnackBar(
                            const SnackBar(
                              content: Text(
                                'Copied — paste it into an email to support.',
                              ),
                            ),
                          );
                      },
                      icon: const Icon(Icons.copy_all_outlined),
                      label: const Text('Copy these details'),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
