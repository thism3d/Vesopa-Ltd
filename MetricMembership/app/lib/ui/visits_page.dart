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
            const PageHero(
              icon: Icons.timeline_rounded,
              overline: 'Barrier activity',
              title: 'Visits',
              subtitle: 'Every time a barrier reads one of your cars, in and out.',
            ),
            const SizedBox(height: 18),
            if (list.isEmpty)
              const EmptyState(
                icon: Icons.route_rounded,
                title: 'No visits yet',
                message: 'Drive up to a Metric barrier and your first visit appears here.',
              ),
            for (final v in list)
              Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: Card(
                  child: Padding(
                    padding: const EdgeInsets.all(14),
                    child: Row(
                      children: [
                        IconTile(
                          v.direction == 'exit' ? Icons.logout_rounded : Icons.login_rounded,
                          colour: v.opened ? MetricBrand.green700 : MetricBrand.red,
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(v.site, style: Theme.of(context).textTheme.titleMedium, maxLines: 1, overflow: TextOverflow.ellipsis),
                              const SizedBox(height: 2),
                              Text(
                                '${v.direction == 'exit' ? 'Left' : v.direction == 'entry' ? 'Arrived' : 'Read'} ${friendlyDate(v.at).toLowerCase()} · ${v.gate}',
                                style: Theme.of(context).textTheme.bodySmall?.copyWith(color: MetricBrand.slate),
                              ),
                              if (!v.opened) ...[
                                const SizedBox(height: 4),
                                Text(_why[v.reason] ?? 'Not opened', style: const TextStyle(color: MetricBrand.red, fontSize: 12.5, fontWeight: FontWeight.w700)),
                              ],
                            ],
                          ),
                        ),
                        const SizedBox(width: 10),
                        Column(
                          crossAxisAlignment: CrossAxisAlignment.end,
                          children: [
                            NumberPlate(v.display.isEmpty ? v.plate : v.display, size: 12),
                            const SizedBox(height: 6),
                            _Pill(opened: v.opened),
                          ],
                        ),
                      ],
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _Pill extends StatelessWidget {
  const _Pill({required this.opened});

  final bool opened;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
    decoration: BoxDecoration(color: opened ? MetricBrand.green50 : MetricBrand.red50, borderRadius: BorderRadius.circular(99)),
    child: Text(
      opened ? 'Opened' : 'Refused',
      style: TextStyle(color: opened ? MetricBrand.green700 : MetricBrand.red, fontSize: 11.5, fontWeight: FontWeight.w800),
    ),
  );
}
