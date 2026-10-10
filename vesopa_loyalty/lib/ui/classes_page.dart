import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/api.dart';
import '../data/membership.dart';
import '../data/session.dart';
import 'widgets.dart';

/// The next fortnight of classes, a day at a time, and the member's place on
/// each: book, cancel, or join the waiting list when it is full.
///
/// The server decides who may book -- an active member whose plan includes
/// classes, with credits left this month -- and says why not in words, which
/// are shown as they come. Nothing here second-guesses it.
class ClassesPage extends ConsumerWidget {
  const ClassesPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final classes = ref.watch(classesProvider);
    return classes.when(
      loading: () => const Center(child: CircularProgressIndicator.adaptive()),
      error: (e, _) => LoadFailed(error: e, onRetry: () => ref.invalidate(classesProvider)),
      data: (list) {
        final now = DateTime.now();
        final days = classesByDay(list, now);
        final theme = Theme.of(context);
        return RefreshIndicator.adaptive(
          onRefresh: () => ref.refresh(classesProvider.future),
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 640),
              child: ListView(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 32),
                children: [
                  if (days.isEmpty)
                    const Padding(
                      padding: EdgeInsets.symmetric(vertical: 60),
                      child: Text('No classes in the next two weeks.', textAlign: TextAlign.center),
                    ),
                  for (final (day, sessions) in days) ...[
                    Padding(
                      padding: const EdgeInsets.fromLTRB(4, 12, 4, 6),
                      child: Text(
                        classDayTitle(day, now),
                        style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800),
                      ),
                    ),
                    for (final c in sessions) _ClassTile(session: c, now: now),
                  ],
                  const SizedBox(height: 22),
                  const PoweredBy(),
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}

class _ClassTile extends ConsumerStatefulWidget {
  const _ClassTile({required this.session, required this.now});

  final Map<String, dynamic> session;
  final DateTime now;

  @override
  ConsumerState<_ClassTile> createState() => _ClassTileState();
}

class _ClassTileState extends ConsumerState<_ClassTile> {
  var _busy = false;

  Future<void> _act(Future<void> Function(LoyaltyApi api) job, String done, {String Function()? doneText}) async {
    setState(() => _busy = true);
    await runWithFeedback(context, ref, () async {
      await job(ref.read(apiProvider));
      ref.invalidate(classesProvider);
      await ref.read(classesProvider.future);
    }, done: done, doneText: doneText);
    if (mounted) setState(() => _busy = false);
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.session;
    final theme = Theme.of(context);
    final id = (c['id'] as num).toInt();
    final start = classStart(c);
    final end = classEnd(c);
    final cancelled = c['cancelled'] == true;
    final started = start != null && !start.isAfter(widget.now);
    final mine = c['my_status'] as String?;
    final spaces = (c['spaces'] as num?)?.toInt() ?? 0;
    final waiting = (c['waiting'] as num?)?.toInt() ?? 0;
    final colour = hexColour(c['colour'] as String?) ?? theme.colorScheme.primary;

    final details = [
      '${clock(start)}${end != null ? '-${clock(end)}' : ''}',
      if ((c['instructor'] as String?)?.isNotEmpty == true) '${c['instructor']}',
      if ((c['room'] as String?)?.isNotEmpty == true) '${c['room']}',
    ].join(' · ');

    final String status;
    if (cancelled) {
      status = 'Cancelled by the venue${(c['note'] as String?)?.isNotEmpty == true ? ': ${c['note']}' : ''}';
    } else if (mine == 'booked' || mine == 'attended') {
      status = mine == 'attended' ? 'You were here' : 'You are booked';
    } else if (mine == 'waitlist') {
      status = 'You are on the waiting list';
    } else if (spaces > 0) {
      status = '$spaces place${spaces == 1 ? '' : 's'} left';
    } else {
      status = 'Full${waiting > 0 ? ', $waiting waiting' : ''}';
    }

    Widget? action;
    if (_busy) {
      action = const SizedBox(width: 24, height: 24, child: CircularProgressIndicator.adaptive(strokeWidth: 2.5));
    } else if (!cancelled && !started) {
      if (mine == 'booked' || mine == 'waitlist') {
        action = OutlinedButton(
          onPressed: () => _act(
            (api) => api.cancelClass(id),
            mine == 'waitlist' ? 'You have left the waiting list.' : 'Booking cancelled.',
          ),
          child: Text(mine == 'waitlist' ? 'Leave' : 'Cancel'),
        );
      } else if (mine == null || mine == 'cancelled') {
        action = FilledButton(
          onPressed: () {
            String? result;
            _act(
              (api) async => result = await api.bookClass(id),
              'Booked. See you there.',
              doneText: () => result == 'waitlist'
                  ? 'The class is full, so you are on the waiting list.'
                  : 'Booked. See you there.',
            );
          },
          child: Text(spaces > 0 ? 'Book' : 'Waitlist'),
        );
      }
    }

    final booked = mine == 'booked' || mine == 'waitlist' || mine == 'attended';
    return Card(
      elevation: 0,
      color: booked
          ? theme.colorScheme.primaryContainer.withValues(alpha: 0.55)
          : theme.colorScheme.surfaceContainerHighest.withValues(alpha: 0.45),
      child: ListTile(
        leading: Container(width: 6, height: 40, decoration: BoxDecoration(color: colour, borderRadius: BorderRadius.circular(3))),
        title: Text(
          '${c['name'] ?? 'Class'}',
          style: TextStyle(
            fontWeight: FontWeight.w700,
            decoration: cancelled ? TextDecoration.lineThrough : null,
          ),
        ),
        subtitle: Text('$details\n$status'),
        isThreeLine: true,
        trailing: action,
      ),
    );
  }
}
