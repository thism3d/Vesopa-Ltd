import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:qr_flutter/qr_flutter.dart';

import '../data/brand.dart';
import '../data/session.dart';
import 'widgets.dart';

/// The card: a QR code the till scans, and what is on it.
///
/// The QR is the card number — exactly what a plastic loyalty card or the
/// Wallet pass carries — so every till that reads a card reads this.
///
/// IT TURNS OVER, like the card it stands in for. The front is the thing
/// somebody holds up at a counter and nothing else; the back is everything they
/// would otherwise have had to go looking for — what their points are worth,
/// how far to the next tier, the number in a form they can read out on the
/// telephone. Putting that on the front would crowd the one job the front has.
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
        child: LayoutBuilder(
          builder: (context, box) {
            /*
             * WIDE SCREENS PUT THE CARD BESIDE THE FACTS, not under them.
             *
             * On a laptop the old single column left the card marooned in the
             * middle of a very wide page with everything below the fold. The
             * break is at 900: below it a phone or a narrow window, above it
             * there is genuinely room for two columns.
             */
            final wide = box.maxWidth >= 900;
            final card = _FlipCard(brand: brand, me: m);
            final facts = _Facts(brand: brand, me: m);
            if (!wide) {
              return ListView(
                padding: const EdgeInsets.all(20),
                children: [
                  Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 440), child: card)),
                  const SizedBox(height: 18),
                  Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 440), child: facts)),
                ],
              );
            }
            return SingleChildScrollView(
              padding: const EdgeInsets.all(28),
              child: Center(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 980),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Expanded(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 440), child: card)),
                      const SizedBox(width: 28),
                      Expanded(child: facts),
                    ],
                  ),
                ),
              ),
            );
          },
        ),
      ),
    );
  }
}

/// The card, and the turn.
///
/// A real half-turn rather than a cross-fade: the point of the gesture is that
/// somebody believes there is a back, and a fade does not say "there is more
/// here" — it says "that changed". The trick is to swap the face exactly at
/// the halfway point, where the card is edge-on and neither is visible, and to
/// flip the back's matrix so its text is not mirrored.
class _FlipCard extends StatefulWidget {
  const _FlipCard({required this.brand, required this.me});

  final Brand brand;
  final Map<String, dynamic> me;

  @override
  State<_FlipCard> createState() => _FlipCardState();
}

class _FlipCardState extends State<_FlipCard> with SingleTickerProviderStateMixin {
  late final AnimationController _turn = AnimationController(
    vsync: this,
    // Long enough to read as a card turning, short enough not to be in the way
    // of somebody at a till with a queue behind them.
    duration: const Duration(milliseconds: 520),
  );

  bool get _showingBack => _turn.value > 0.5;

  @override
  void dispose() {
    _turn.dispose();
    super.dispose();
  }

  void _flip() {
    if (_turn.isAnimating) return;
    HapticFeedback.selectionClick();
    _showingBack ? _turn.reverse() : _turn.forward();
  }

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      label: _showingBack ? 'Card details. Tap to show the code.' : 'Your code. Tap to turn the card over.',
      child: GestureDetector(
        onTap: _flip,
        child: AnimatedBuilder(
          animation: _turn,
          builder: (context, _) {
            // Eased so the card slows as it lands rather than stopping dead.
            final t = Curves.easeInOutCubic.transform(_turn.value);
            final angle = t * math.pi;
            final back = t > 0.5;
            return Transform(
              alignment: Alignment.center,
              transform: Matrix4.identity()
                // A little perspective, or the turn reads as a horizontal
                // squash rather than something with a thickness.
                ..setEntry(3, 2, 0.0012)
                ..rotateY(angle),
              child: back
                  // The back is drawn into an already-rotated space, so it is
                  // flipped again to come out the right way round.
                  ? Transform(
                      alignment: Alignment.center,
                      transform: Matrix4.identity()..rotateY(math.pi),
                      child: _Back(brand: widget.brand, me: widget.me),
                    )
                  : _Front(brand: widget.brand, me: widget.me),
            );
          },
        ),
      ),
    );
  }
}

/// Shared skin, so the two faces are unmistakably the same card.
class _Face extends StatelessWidget {
  const _Face({required this.brand, required this.child});

  final Brand brand;
  final Widget child;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.fromLTRB(22, 22, 22, 18),
    constraints: const BoxConstraints(minHeight: 430),
    decoration: BoxDecoration(
      borderRadius: BorderRadius.circular(22),
      gradient: LinearGradient(
        begin: Alignment.topLeft,
        end: Alignment.bottomRight,
        colors: [brand.primary, Color.lerp(brand.primary, Colors.black, 0.28)!],
      ),
      boxShadow: [BoxShadow(color: brand.primary.withValues(alpha: 0.35), blurRadius: 24, offset: const Offset(0, 10))],
    ),
    child: child,
  );
}

class _Front extends StatelessWidget {
  const _Front({required this.brand, required this.me});

  final Brand brand;
  final Map<String, dynamic> me;

  @override
  Widget build(BuildContext context) {
    final on = Brand.onColour(brand.primary);
    final theme = Theme.of(context);
    final number = (me['card_number'] as String?) ?? (me['member_no'] != null ? 'Member ${me['member_no']}' : '');
    final points = (me['points'] as num?)?.toInt() ?? 0;
    return _Face(
      brand: brand,
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
            style: theme.textTheme.titleMedium?.copyWith(
              color: on,
              letterSpacing: 3,
              fontFeatures: const [FontFeature.tabularFigures()],
            ),
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
          const SizedBox(height: 12),
          _Hint(on: on, icon: Icons.flip_camera_android, text: 'Tap the card to turn it over'),
        ],
      ),
    );
  }
}

/// The back: what the points are worth, how far to the next thing, and the
/// number written so somebody can read it down a telephone.
class _Back extends StatelessWidget {
  const _Back({required this.brand, required this.me});

  final Brand brand;
  final Map<String, dynamic> me;

  /// The card number in fours. A long run of digits read aloud goes wrong at
  /// about the sixth one; in groups it does not.
  static String _grouped(String value) {
    final digits = value.replaceAll(RegExp(r'\s'), '');
    final out = StringBuffer();
    for (var i = 0; i < digits.length; i += 1) {
      if (i > 0 && i % 4 == 0) out.write(' ');
      out.write(digits[i]);
    }
    return out.toString();
  }

  @override
  Widget build(BuildContext context) {
    final on = Brand.onColour(brand.primary);
    final theme = Theme.of(context);
    final points = (me['points'] as num?)?.toInt() ?? 0;
    final worth = (me['points_value_minor'] as num?)?.toInt() ?? 0;
    final minRedeem = brand.minRedeem;
    final number = (me['card_number'] as String?) ?? '';
    final short = minRedeem > points ? minRedeem - points : 0;

    return _Face(
      brand: brand,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Your card', style: theme.textTheme.titleLarge?.copyWith(color: on, fontWeight: FontWeight.w800)),
          const SizedBox(height: 18),
          if (number.isNotEmpty) ...[
            Text('Card number', style: theme.textTheme.bodySmall?.copyWith(color: on.withValues(alpha: 0.75))),
            SelectableText(
              _grouped(number),
              style: theme.textTheme.titleMedium?.copyWith(
                color: on,
                letterSpacing: 2,
                fontFeatures: const [FontFeature.tabularFigures()],
              ),
            ),
            const SizedBox(height: 14),
          ],
          _BackRow(on: on, label: 'Points', value: '$points'),
          _BackRow(on: on, label: 'Worth', value: money(worth)),
          if (minRedeem > 0)
            _BackRow(
              on: on,
              label: 'Spend from',
              value: '$minRedeem points',
            ),
          if (short > 0) ...[
            const SizedBox(height: 14),
            /*
             * The one genuinely useful sentence on this side. "You have 340
             * points" means nothing to most people; "60 more and you can spend
             * them" is the thing that brings somebody back on a Tuesday.
             */
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: on.withValues(alpha: 0.14),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Text(
                '$short more point${short == 1 ? '' : 's'} and you can start spending them.',
                style: theme.textTheme.bodyMedium?.copyWith(color: on),
              ),
            ),
          ] else if (minRedeem > 0) ...[
            const SizedBox(height: 14),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: on.withValues(alpha: 0.14),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Text(
                'You have enough to spend. Just say so at the till.',
                style: theme.textTheme.bodyMedium?.copyWith(color: on),
              ),
            ),
          ],
          const Spacer(),
          if (me['member_since'] != null)
            Text(
              'Member since ${when(me['member_since'], time: false)}',
              style: theme.textTheme.bodySmall?.copyWith(color: on.withValues(alpha: 0.75)),
            ),
          const SizedBox(height: 10),
          _Hint(on: on, icon: Icons.flip_camera_android, text: 'Tap to go back to your code'),
        ],
      ),
    );
  }
}

class _BackRow extends StatelessWidget {
  const _BackRow({required this.on, required this.label, required this.value});

  final Color on;
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label, style: theme.textTheme.bodyMedium?.copyWith(color: on.withValues(alpha: 0.8))),
          Text(value, style: theme.textTheme.titleMedium?.copyWith(color: on, fontWeight: FontWeight.w700)),
        ],
      ),
    );
  }
}

class _Hint extends StatelessWidget {
  const _Hint({required this.on, required this.icon, required this.text});

  final Color on;
  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) => Row(
    mainAxisAlignment: MainAxisAlignment.center,
    children: [
      Icon(icon, size: 15, color: on.withValues(alpha: 0.7)),
      const SizedBox(width: 6),
      Text(
        text,
        style: Theme.of(context).textTheme.bodySmall?.copyWith(color: on.withValues(alpha: 0.7)),
      ),
    ],
  );
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
            ListTile(
              dense: true,
              leading: Icon(icon, color: brand.primary),
              title: Text(label),
              trailing: Text(value, style: const TextStyle(fontWeight: FontWeight.w700)),
            ),
        ],
      ),
    );
  }
}
