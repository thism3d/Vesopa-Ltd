import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../brand.dart';
import '../data/session.dart';
import 'widgets.dart';

/// Every time a camera read one of the member's cars, and what happened.
class VisitsPage extends ConsumerWidget {
  const VisitsPage({super.key});

  static const _why = {
    'member': 'Barrier opened',
    'member_fuzzy': 'Barrier opened',
    'pending': 'Not opened: waiting for approval',
    'suspended': 'Not opened: membership on hold',
    'expired': 'Not opened: membership ended',
    'not_started': 'Not opened: membership not started',
    'not_this_site': 'Not opened: not included at this site',
    'closed': 'Not opened',
  };

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final visits = ref.watch(visitsProvider);
    return RefreshIndicator(
      onRefresh: () async {
        ref.read(activityLogProvider).event('refresh_visits');
        ref.invalidate(visitsProvider);
        await ref.read(visitsProvider.future).catchError((_) => <Never>[]);
      },
      child: visits.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => ListView(children: [ErrorNotice(e.toString(), onRetry: () => ref.invalidate(visitsProvider))]),
        data: (list) => ListView(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
          children: [
            Text('Visits', style: Theme.of(context).textTheme.headlineSmall?.copyWith(color: MetricBrand.navy, fontWeight: FontWeight.w700)),
            const SizedBox(height: 12),
            if (list.isEmpty)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 40),
                child: Text('No visits yet. Each time a barrier reads one of your cars it shows here.', textAlign: TextAlign.center),
              ),
            for (final v in list)
              Card(
                margin: const EdgeInsets.only(bottom: 8),
                child: ListTile(
                  leading: CircleAvatar(
                    backgroundColor: v.opened ? const Color(0xFFE5F6DC) : const Color(0xFFFDE7E6),
                    child: Icon(
                      v.direction == 'exit' ? Icons.logout : Icons.login,
                      color: v.opened ? const Color(0xFF2E7D32) : const Color(0xFFB3261E),
                    ),
                  ),
                  title: Text('${v.direction == 'exit' ? 'Out of' : v.direction == 'entry' ? 'Into' : 'At'} ${v.site}'),
                  subtitle: Text('${friendlyDate(v.at)} · ${v.gate}\n${_why[v.reason] ?? (v.opened ? 'Barrier opened' : 'Not opened')}'),
                  isThreeLine: true,
                  trailing: NumberPlate(v.display.isEmpty ? v.plate : v.display, size: 13),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
