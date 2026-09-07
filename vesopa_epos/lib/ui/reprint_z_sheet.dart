/// Another copy of a Z report that has already been run.
///
/// A Z is the document a venue hands their accountant, and it is printed once,
/// on thermal paper, next to a cash drawer, at the end of a long day. "The
/// printer had no paper", "it printed and somebody binned it" and "we need last
/// Tuesday's again" are all ordinary Monday mornings, and until now the only
/// answer was to look it up in the back office on a different machine.
///
/// The figures are **rebuilt from the sales**, not from a stored copy — the
/// orders are still in the till's own database keyed by session, so a reprint
/// comes out identical to the paper and there is no second set of totals to
/// drift from the first. See `SessionRepository.reprintZ`.
///
/// The consequence worth knowing, and worth saying on screen: this is a
/// reprint, not an archive. A till whose local database has been wiped and
/// re-synced has no orders to rebuild from, and the list comes up empty rather
/// than wrong.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../data/local/database.dart';
import '../data/till_permissions.dart';
import '../main.dart';
import 'permission_gate.dart';
import 'reports_page.dart' show printTillReport;
import 'widgets/basket_panel.dart' show money;
import 'widgets/pos_message.dart';

/// How many days back the list reaches. The venue asked for "the last few
/// days"; a week covers a Monday morning asking for the previous Tuesday, which
/// is the case this was built for.
const _daysBack = 7;

Future<void> showReprintZSheet(BuildContext context, WidgetRef ref) =>
    showDialog<void>(
      context: context,
      builder: (_) => const ReprintZSheet(),
    );

class ReprintZSheet extends ConsumerStatefulWidget {
  const ReprintZSheet({super.key});

  @override
  ConsumerState<ReprintZSheet> createState() => _ReprintZSheetState();
}

class _ReprintZSheetState extends ConsumerState<ReprintZSheet> {
  late Future<List<TillSession>> _sessions;

  /// The Z currently being printed, so its row can say so and the list cannot
  /// be double-tapped into printing the same report twice.
  String? _printing;

  @override
  void initState() {
    super.initState();
    _sessions = ref.read(sessionRepositoryProvider).recentZs(days: _daysBack);
  }

  Future<void> _reprint(TillSession session) async {
    // The same key that runs a Z in the first place. A reprint is not a weaker
    // act than the original: it is the same document, and anybody who may not
    // read the takings may not read them twice either.
    if (!await allowed(context, ref, TillPermission.zReport)) return;
    if (!mounted) return;

    setState(() => _printing = session.id);
    try {
      final report = await ref.read(sessionRepositoryProvider).reprintZ(
            session,
            staffName: ref.read(servedByProvider),
          );
      await printTillReport(ref, report);
      if (!mounted) return;
      PosMessenger.success(context, 'Z #${session.zNumber} printed again.');
    } catch (e) {
      if (!mounted) return;
      PosMessenger.error(context, 'Could not print: $e');
    } finally {
      if (mounted) setState(() => _printing = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final screen = MediaQuery.sizeOf(context);

    return Dialog(
      insetPadding: const EdgeInsets.all(20),
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxWidth: screen.width * 0.92 < 620 ? screen.width * 0.92 : 620,
          maxHeight: screen.height * 0.86,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 18, 12, 6),
              child: Row(
                children: [
                  const Icon(Icons.print),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      'Reprint a Z report',
                      style: Theme.of(context).textTheme.titleLarge,
                    ),
                  ),
                  IconButton(
                    onPressed: () => Navigator.pop(context),
                    icon: const Icon(Icons.close),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 12),
              child: Text(
                'The last $_daysBack days, from this terminal.',
                style: TextStyle(color: scheme.onSurfaceVariant),
              ),
            ),
            Flexible(
              child: FutureBuilder<List<TillSession>>(
                future: _sessions,
                builder: (context, snap) {
                  if (snap.connectionState != ConnectionState.done) {
                    return const Padding(
                      padding: EdgeInsets.all(40),
                      child: Center(child: CircularProgressIndicator()),
                    );
                  }
                  final sessions = snap.data ?? const <TillSession>[];
                  if (sessions.isEmpty) {
                    return Padding(
                      padding: const EdgeInsets.fromLTRB(20, 10, 20, 34),
                      child: Text(
                        'No Z reports on this terminal in the last '
                        '$_daysBack days.',
                        style: TextStyle(color: scheme.onSurfaceVariant),
                      ),
                    );
                  }
                  return ListView.separated(
                    shrinkWrap: true,
                    padding: const EdgeInsets.symmetric(horizontal: 12),
                    itemCount: sessions.length,
                    separatorBuilder: (_, _) =>
                        Divider(height: 1, color: scheme.outlineVariant),
                    itemBuilder: (context, i) =>
                        _Row(
                      session: sessions[i],
                      busy: _printing == sessions[i].id,
                      anyBusy: _printing != null,
                      onPrint: () => _reprint(sessions[i]),
                    ),
                  );
                },
              ),
            ),
            const SizedBox(height: 10),
          ],
        ),
      ),
    );
  }
}

/// One past Z, named the way somebody asking for it would name it.
///
/// The Z number first because that is what an accountant quotes, and the date
/// beside it because that is what everybody in the building says instead.
class _Row extends ConsumerWidget {
  const _Row({
    required this.session,
    required this.busy,
    required this.anyBusy,
    required this.onPrint,
  });

  final TillSession session;
  final bool busy;
  final bool anyBusy;
  final VoidCallback onPrint;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final scheme = Theme.of(context).colorScheme;
    final closed = session.closedAt;

    return ListTile(
      leading: CircleAvatar(
        backgroundColor: scheme.primaryContainer,
        child: Text(
          '${session.zNumber}',
          style: TextStyle(
            fontWeight: FontWeight.w700,
            color: scheme.onPrimaryContainer,
          ),
        ),
      ),
      title: Text(
        closed == null
            ? 'Z #${session.zNumber}'
            : DateFormat('EEEE d MMMM').format(closed),
        style: const TextStyle(fontWeight: FontWeight.w600),
      ),
      subtitle: Text(
        [
          'Z #${session.zNumber}',
          if (closed != null) 'closed ${DateFormat('HH:mm').format(closed)}',
          'opened ${DateFormat('d MMM HH:mm').format(session.openedAt)}',
          if (session.openingFloatMinor > 0)
            'float ${money(session.openingFloatMinor)}',
        ].join('  ·  '),
        style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant),
      ),
      trailing: busy
          ? const SizedBox(
              width: 22,
              height: 22,
              child: CircularProgressIndicator(strokeWidth: 2.5),
            )
          : FilledButton.tonalIcon(
              // Disabled while another one is printing, so a second tap cannot
              // queue a report on top of the one on the roll.
              onPressed: anyBusy ? null : onPrint,
              icon: const Icon(Icons.print, size: 18),
              label: const Text('Print'),
            ),
    );
  }
}
