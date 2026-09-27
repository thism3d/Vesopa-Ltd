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
            _Greeting(name: a.member.name),
            const SizedBox(height: 18),
            _Card(member: a.member),
            if (a.member.standing != 'ok') ...[
              const SizedBox(height: 16),
              StandingBanner(standing: a.member.standing, validTo: friendlyDay(a.member.validTo)),
            ],
            const SizedBox(height: 28),
            SectionTitle(
              'Your cars',
              trailing: Text('${a.vehicles.length} of ${a.member.maxVehicles}', style: const TextStyle(color: MetricBrand.slate, fontWeight: FontWeight.w600)),
            ),
            if (a.vehicles.isEmpty)
              EmptyState(
                icon: Icons.directions_car_rounded,
                title: 'Add your first car',
                message: 'Register your number plate so the barrier knows you.',
                action: FilledButton.icon(
                        key: const Key('add-first-car'),
                        onPressed: () {
                          ref.read(activityLogProvider).tap('add_first_car');
                          onAddCar();
                        },
                        icon: const Icon(Icons.add),
                        label: const Text('Add a car'),
                      ),
              )
            else
              for (final v in a.vehicles)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: Card(
                    child: ListTile(
                      leading: const IconTile(Icons.directions_car_filled_rounded),
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

/// "Good evening, Sam" over the Metric logo, centred.
class _Greeting extends StatelessWidget {
  const _Greeting({required this.name});

  final String name;

  @override
  Widget build(BuildContext context) {
    final h = DateTime.now().hour;
    final part = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    final first = name.trim().split(' ').first;
    return Column(
      children: [
        const SizedBox(height: 4),
        const MetricLogo(height: 30),
        const SizedBox(height: 14),
        Text(
          first.isEmpty ? part : '$part, $first',
          textAlign: TextAlign.center,
          style: const TextStyle(fontSize: 24, fontWeight: FontWeight.w800, color: MetricBrand.ink, letterSpacing: -0.3),
        ),
        const SizedBox(height: 4),
        const Text('Your membership card', textAlign: TextAlign.center, style: TextStyle(color: MetricBrand.slate)),
      ],
    );
  }
}

/// The membership card: navy, with a light that sweeps across it now and
/// then, the Metric mark, the member, and a code staff can scan.
class _Card extends StatefulWidget {
  const _Card({required this.member});

  final Member member;

  @override
  State<_Card> createState() => _CardState();
}

class _CardState extends State<_Card> with SingleTickerProviderStateMixin {
  late final AnimationController _sheen = AnimationController(vsync: this, duration: const Duration(milliseconds: 5200));

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (MediaQuery.of(context).disableAnimations) {
      _sheen.stop();
    } else if (!_sheen.isAnimating) {
      _sheen.repeat();
    }
  }

  @override
  void dispose() {
    _sheen.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final member = widget.member;
    final ok = member.opensBarriers;
    return AspectRatio(
      aspectRatio: 1.62,
      child: Container(
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(24),
          boxShadow: const [BoxShadow(color: Color(0x55002788), blurRadius: 28, offset: Offset(0, 14))],
        ),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(24),
          child: Stack(
            fit: StackFit.expand,
            children: [
              const DecoratedBox(
                decoration: BoxDecoration(
                  gradient: LinearGradient(
                    colors: [MetricBrand.navy900, MetricBrand.navy, MetricBrand.navy600],
                    begin: Alignment.topLeft,
                    end: Alignment.bottomRight,
                  ),
                ),
              ),
              CustomPaint(painter: _CardPattern()),
              AnimatedBuilder(
                animation: _sheen,
                builder: (context, _) {
                  final x = -1.6 + 3.2 * Curves.easeInOut.transform((_sheen.value * 1.6).clamp(0.0, 1.0));
                  return DecoratedBox(
                    decoration: BoxDecoration(
                      gradient: LinearGradient(
                        begin: Alignment(x - 0.4, -1),
                        end: Alignment(x + 0.4, 1),
                        colors: [Colors.white.withValues(alpha: 0), Colors.white.withValues(alpha: 0.14), Colors.white.withValues(alpha: 0)],
                      ),
                    ),
                  );
                },
              ),
              Padding(
                padding: const EdgeInsets.all(20),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        const MetricLogo(height: 24, white: true),
                        const Spacer(),
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                          decoration: BoxDecoration(
                            color: ok ? MetricBrand.green : Colors.white.withValues(alpha: 0.16),
                            borderRadius: BorderRadius.circular(99),
                          ),
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Icon(ok ? Icons.check_circle_rounded : Icons.hourglass_top_rounded, size: 14, color: ok ? MetricBrand.navy : Colors.white),
                              const SizedBox(width: 5),
                              Text(
                                ok ? 'Barriers open' : member.status == 'pending' ? 'Awaiting approval' : 'Not active',
                                style: TextStyle(color: ok ? MetricBrand.navy : Colors.white, fontWeight: FontWeight.w800, fontSize: 12),
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                    const Spacer(),
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.end,
                      children: [
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              const Text('MEMBER', style: TextStyle(color: MetricBrand.green, fontWeight: FontWeight.w800, letterSpacing: 2.2, fontSize: 11)),
                              const SizedBox(height: 6),
                              Text(
                                member.name.isEmpty ? member.email : member.name,
                                style: const TextStyle(color: Colors.white, fontSize: 21, fontWeight: FontWeight.w800),
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                              ),
                              const SizedBox(height: 4),
                              Text(member.memberNo, style: const TextStyle(color: Colors.white70, fontSize: 15, letterSpacing: 2, fontWeight: FontWeight.w600)),
                              if (member.planName.isNotEmpty || member.validTo != null) ...[
                                const SizedBox(height: 4),
                                Text(
                                  [
                                    if (member.planName.isNotEmpty) member.planName,
                                    if (member.validTo != null) 'until ${friendlyDay(member.validTo)}',
                                  ].join(' · '),
                                  style: const TextStyle(color: Colors.white60, fontSize: 12.5),
                                ),
                              ],
                            ],
                          ),
                        ),
                        const SizedBox(width: 12),
                        // The member number as a code, for a site's staff to scan
                        // at a pay station or reception if a camera ever cannot
                        // read a plate.
                        Container(
                          padding: const EdgeInsets.all(6),
                          decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(12)),
                          child: QrImageView(
                            data: member.memberNo.isEmpty ? '-' : member.memberNo,
                            size: 72,
                            padding: EdgeInsets.zero,
                            eyeStyle: const QrEyeStyle(eyeShape: QrEyeShape.square, color: MetricBrand.navy),
                            dataModuleStyle: const QrDataModuleStyle(dataModuleShape: QrDataModuleShape.square, color: MetricBrand.navy),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _CardPattern extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final ring = Paint()
      ..style = PaintingStyle.stroke
      ..color = Colors.white.withValues(alpha: 0.06)
      ..strokeWidth = 1.2;
    for (var i = 1; i <= 6; i++) {
      canvas.drawCircle(Offset(size.width * 1.02, size.height * -0.05), size.height * 0.22 * i, ring);
    }
    canvas.drawCircle(
      Offset(size.width * 0.1, size.height * 1.1),
      size.height * 0.55,
      Paint()..color = MetricBrand.green.withValues(alpha: 0.10),
    );
  }

  @override
  bool shouldRepaint(_CardPattern old) => false;
}
