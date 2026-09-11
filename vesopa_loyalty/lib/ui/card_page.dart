import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:qr_flutter/qr_flutter.dart';

import '../data/brand.dart';
import '../data/session.dart';
import 'widgets.dart';

/// The card: a QR code the till scans, and the points on it.
///
/// The QR is the card number -- exactly what a plastic loyalty card or the
/// Wallet pass carries -- so every till that reads a card reads this.
class CardPage extends ConsumerWidget {
  const CardPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final brand = ref.watch(brandProvider).requireValue;
    final me = ref.watch(meProvider);
    return me.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (e, _) => LoadFailed(error: e, onRetry: () => ref.invalidate(meProvider)),
      data: (m) => RefreshIndicator(
        onRefresh: () => ref.refresh(meProvider.future),
        child: ListView(
          padding: const EdgeInsets.all(20),
          children: [
            Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 440),
                child: _Card(brand: brand, me: m),
              ),
            ),
            const SizedBox(height: 18),
            Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 440),
                child: _Facts(brand: brand, me: m),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Card extends StatelessWidget {
  const _Card({required this.brand, required this.me});

  final Brand brand;
  final Map<String, dynamic> me;

  @override
  Widget build(BuildContext context) {
    final on = Brand.onColour(brand.primary);
    final theme = Theme.of(context);
    final number = (me['card_number'] as String?) ?? (me['member_no'] != null ? 'Member ${me['member_no']}' : '');
    final points = (me['points'] as num?)?.toInt() ?? 0;
    return Container(
      padding: const EdgeInsets.fromLTRB(22, 22, 22, 18),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(22),
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [brand.primary, Color.lerp(brand.primary, Colors.black, 0.28)!],
        ),
        boxShadow: [BoxShadow(color: brand.primary.withValues(alpha: 0.35), blurRadius: 24, offset: const Offset(0, 10))],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  (me['name'] as String?) ?? '',
                  style: theme.textTheme.titleLarge?.copyWith(color: on, fontWeight: FontWeight.w800),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              if (me['tier'] != null)
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                  decoration: BoxDecoration(color: brand.accent, borderRadius: BorderRadius.circular(99)),
                  child: Text(
                    '${me['tier']}',
                    style: TextStyle(color: Brand.onColour(brand.accent), fontWeight: FontWeight.w700, fontSize: 12),
                  ),
                ),
            ],
          ),
          const SizedBox(height: 18),
          Center(
            child: Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(16)),
              child: Semantics(
                label: 'Your membership QR code',
                child: QrImageView(
                  data: '${me['qr']}',
                  size: 210,
                  backgroundColor: Colors.white,
                  errorCorrectionLevel: QrErrorCorrectLevel.M,
                ),
              ),
            ),
          ),
          const SizedBox(height: 10),
          Text(
            number,
            textAlign: TextAlign.center,
            style: theme.textTheme.titleMedium?.copyWith(color: on, letterSpacing: 3, fontFeatures: const [FontFeature.tabularFigures()]),
          ),
          Text(
            'Show this at the till',
            textAlign: TextAlign.center,
            style: theme.textTheme.bodySmall?.copyWith(color: on.withValues(alpha: 0.8)),
          ),
          const SizedBox(height: 16),
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.baseline,
            textBaseline: TextBaseline.alphabetic,
            children: [
              Text('$points', style: theme.textTheme.displaySmall?.copyWith(color: on, fontWeight: FontWeight.w900)),
              const SizedBox(width: 8),
              Text(points == 1 ? 'point' : 'points', style: theme.textTheme.titleMedium?.copyWith(color: on)),
            ],
          ),
          if (points > 0)
            Text(
              'worth ${money((me['points_value_minor'] as num?)?.toInt() ?? 0)}',
              textAlign: TextAlign.center,
              style: theme.textTheme.bodyMedium?.copyWith(color: on.withValues(alpha: 0.9)),
            ),
        ],
      ),
    );
  }
}

class _Facts extends StatelessWidget {
  const _Facts({required this.brand, required this.me});

  final Brand brand;
  final Map<String, dynamic> me;

  @override
  Widget build(BuildContext context) {
    final rows = <(IconData, String, String)>[
      (Icons.event_repeat, 'Visits', '${me['visits'] ?? 0}'),
      if (me['last_visit'] != null) (Icons.history, 'Last visit', when(me['last_visit'], time: false)),
      if (me['member_since'] != null) (Icons.card_membership, 'Member since', when(me['member_since'], time: false)),
      if (me['membership_expiry'] != null) (Icons.event_available, 'Membership until', when(me['membership_expiry'], time: false)),
      if (brand.minRedeem > 0) (Icons.redeem, 'Spend points from', '${brand.minRedeem} points'),
    ];
    return Card(
      elevation: 0,
      color: Theme.of(context).colorScheme.surfaceContainerHighest.withValues(alpha: 0.5),
      child: Column(
        children: [
          for (final (icon, label, value) in rows)
            ListTile(dense: true, leading: Icon(icon, color: brand.primary), title: Text(label), trailing: Text(value, style: const TextStyle(fontWeight: FontWeight.w700))),
        ],
      ),
    );
  }
}
