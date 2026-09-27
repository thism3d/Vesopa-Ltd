import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:qr_flutter/qr_flutter.dart';

import '../brand.dart';
import '../data/api.dart';
import '../data/session.dart';
import 'widgets.dart';

/// The membership card: who, whether the barriers open today, and the cars.
class MembershipPage extends ConsumerWidget {
  const MembershipPage({super.key, required this.onAddCar});

  final VoidCallback onAddCar;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final account = ref.watch(accountProvider);
    return RefreshIndicator(
      onRefresh: () async {
        ref.read(activityLogProvider).event('refresh_membership');
        ref.invalidate(accountProvider);
        await ref.read(accountProvider.future).catchError((_) => const Account(member: _empty, vehicles: []));
      },
      child: account.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => ListView(children: [ErrorNotice(e.toString(), onRetry: () => ref.invalidate(accountProvider))]),
        data: (a) => ListView(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
          children: [
            const Align(alignment: Alignment.centerLeft, child: MetricLogo(height: 32)),
            const SizedBox(height: 16),
            _Card(member: a.member),
            const SizedBox(height: 16),
            StandingBanner(standing: a.member.standing, validTo: friendlyDay(a.member.validTo)),
            const SizedBox(height: 24),
            Row(
              children: [
                Text('Your cars', style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700, color: MetricBrand.navy)),
                const Spacer(),
                Text('${a.vehicles.length} of ${a.member.maxVehicles}', style: const TextStyle(color: Color(0xFF5D6679))),
              ],
            ),
            const SizedBox(height: 8),
            if (a.vehicles.isEmpty)
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(20),
                  child: Column(
                    children: [
                      const Icon(Icons.directions_car, size: 40, color: MetricBrand.navy),
                      const SizedBox(height: 8),
                      const Text('Add your car registration so the barrier knows you.', textAlign: TextAlign.center),
                      const SizedBox(height: 12),
                      FilledButton.icon(
                        key: const Key('add-first-car'),
                        onPressed: () {
                          ref.read(activityLogProvider).tap('add_first_car');
                          onAddCar();
                        },
                        icon: const Icon(Icons.add),
                        label: const Text('Add a car'),
                      ),
                    ],
                  ),
                ),
              )
            else
              for (final v in a.vehicles)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: Card(
                    child: ListTile(
                      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                      title: Align(alignment: Alignment.centerLeft, child: NumberPlate(v.display)),
                      subtitle: Padding(
                        padding: const EdgeInsets.only(top: 8),
                        child: Text(
                          [
                            if (v.nickname.isNotEmpty) v.nickname,
                            if (v.description.isNotEmpty) v.description,
                            if (v.lastSeen != null)
                              '${v.lastSeen!.direction == 'exit' ? 'Left' : 'Arrived at'} ${v.lastSeen!.site} ${friendlyDate(v.lastSeen!.at).toLowerCase()}',
                          ].join(' · '),
                        ),
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

const _empty = Member(id: 0, memberNo: '', name: '', email: '', phone: '', company: '', status: 'pending', standing: 'pending');

class _Card extends StatelessWidget {
  const _Card({required this.member});

  final Member member;

  @override
  Widget build(BuildContext context) {
    final ok = member.opensBarriers;
    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(20),
        gradient: const LinearGradient(
          colors: [MetricBrand.navy, MetricBrand.navyDark],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
        boxShadow: const [BoxShadow(color: Color(0x33002788), blurRadius: 18, offset: Offset(0, 8))],
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('METRIC MEMBER', style: TextStyle(color: MetricBrand.green, fontWeight: FontWeight.w800, letterSpacing: 1.6, fontSize: 12)),
                const SizedBox(height: 10),
                Text(
                  member.name.isEmpty ? member.email : member.name,
                  style: const TextStyle(color: Colors.white, fontSize: 22, fontWeight: FontWeight.w700),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
                const SizedBox(height: 4),
                Text(member.memberNo, style: const TextStyle(color: Colors.white70, fontSize: 15, letterSpacing: 1.2)),
                const SizedBox(height: 16),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                  decoration: BoxDecoration(
                    color: ok ? MetricBrand.green : Colors.white24,
                    borderRadius: BorderRadius.circular(99),
                  ),
                  child: Text(
                    ok ? 'Barriers open' : member.status == 'pending' ? 'Awaiting approval' : 'Not active',
                    style: TextStyle(color: ok ? MetricBrand.navy : Colors.white, fontWeight: FontWeight.w700, fontSize: 12),
                  ),
                ),
                if (member.planName.isNotEmpty || member.validTo != null) ...[
                  const SizedBox(height: 10),
                  Text(
                    [
                      if (member.planName.isNotEmpty) member.planName,
                      if (member.validTo != null) 'until ${friendlyDay(member.validTo)}',
                    ].join(' · '),
                    style: const TextStyle(color: Colors.white70, fontSize: 13),
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(width: 12),
          // The member number as a code, for a site's staff to scan at a
          // pay station or reception if a camera ever cannot read a plate.
          Container(
            padding: const EdgeInsets.all(6),
            decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(10)),
            child: QrImageView(data: member.memberNo.isEmpty ? '-' : member.memberNo, size: 84, padding: EdgeInsets.zero),
          ),
        ],
      ),
    );
  }
}
