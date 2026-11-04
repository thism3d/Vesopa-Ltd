/// After sign-in, on a device the back office leaves to choose: EPOS, Vesopa
/// Kitchen or Customer display (owner, 2026-11-03).
///
/// Laid out the way Apple's setup screens are: a large title that says what
/// is being decided, one sentence under it, and the choices as big, plainly
/// labelled cards (three across where there is room, a list on a phone),
/// each a single tap with a light haptic. Nothing is hidden behind a menu,
/// and the words say it can be changed later, so the choice is not a worry.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/session.dart';
import '../ui/theme.dart';
import 'device_mode.dart';

class ModeChooserPage extends ConsumerWidget {
  const ModeChooserPage({super.key});

  static const _tints = {
    DeviceMode.epos: Tp.lime,
    DeviceMode.kitchen: Color(0xFFFF9F0A), // Apple's system orange
    DeviceMode.display: Color(0xFF0A84FF), // Apple's system blue
  };

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = Theme.of(context).textTheme;
    final venue = ref.watch(tapProvider.select((s) => s.venue?.name)) ?? 'your venue';
    final size = MediaQuery.sizeOf(context);
    final wide = size.width >= 760;
    final kind = size.shortestSide >= 600 ? 'iPad' : 'phone';
    final cards = [
      for (final (i, m) in DeviceMode.values.indexed)
        _ModeCard(
          key: ValueKey('mode-${m.name}'),
          mode: m,
          tint: _tints[m]!,
          tall: wide,
          delay: Duration(milliseconds: 80 * i),
          onTap: () {
            HapticFeedback.selectionClick();
            ref.read(deviceModeProvider.notifier).choose(m);
          },
        ),
    ];
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 1040),
            child: ListView(
              padding: EdgeInsets.symmetric(horizontal: wide ? 40 : 20, vertical: wide ? 48 : 24),
              children: [
                Text('How will this $kind be used?', style: t.headlineLarge?.copyWith(fontWeight: FontWeight.w800, letterSpacing: -0.5)),
                const SizedBox(height: 8),
                Text(
                  'Signed in to $venue. Choose one; a manager can change it later in Settings, '
                  'or set it for this device in the back office.',
                  style: t.bodyLarge?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant),
                ),
                SizedBox(height: wide ? 36 : 24),
                if (wide)
                  IntrinsicHeight(
                    child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                      for (final (i, c) in cards.indexed) ...[if (i > 0) const SizedBox(width: 16), Expanded(child: c)],
                    ]),
                  )
                else
                  for (final (i, c) in cards.indexed) ...[if (i > 0) const SizedBox(height: 12), c],
                const SizedBox(height: 28),
                Text(
                  'Not sure? Choose EPOS: it is what most devices are.',
                  textAlign: wide ? TextAlign.center : TextAlign.start,
                  style: t.bodySmall?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _ModeCard extends StatefulWidget {
  const _ModeCard({super.key, required this.mode, required this.tint, required this.onTap, this.tall = false, this.delay = Duration.zero});
  final DeviceMode mode;
  final Color tint;
  final VoidCallback onTap;
  final bool tall;
  final Duration delay;

  @override
  State<_ModeCard> createState() => _ModeCardState();
}

class _ModeCardState extends State<_ModeCard> with SingleTickerProviderStateMixin {
  bool _down = false;
  late final AnimationController _in = AnimationController(vsync: this, duration: const Duration(milliseconds: 520));

  @override
  void initState() {
    super.initState();
    Future<void>.delayed(widget.delay, () {
      if (mounted) _in.forward();
    });
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // Reduce Motion: the cards are simply there.
    if (MediaQuery.of(context).disableAnimations) _in.value = 1;
  }

  @override
  void dispose() {
    _in.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final scheme = Theme.of(context).colorScheme;
    final m = widget.mode;
    final reduce = MediaQuery.of(context).disableAnimations;
    final icon = Container(
      width: 60,
      height: 60,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(16),
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [widget.tint, Color.lerp(widget.tint, Colors.black, 0.25)!],
        ),
      ),
      child: Icon(m.icon, color: widget.tint == Tp.lime ? Colors.black : Colors.white, size: 32),
    );
    final words = Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
      Text(m.label, style: t.titleLarge?.copyWith(fontWeight: FontWeight.w700)),
      const SizedBox(height: 4),
      Text(m.detail, style: t.bodyMedium?.copyWith(color: scheme.onSurfaceVariant)),
    ]);
    final a = CurvedAnimation(parent: _in, curve: const Cubic(0.2, 0, 0, 1));
    return FadeTransition(
      opacity: a,
      child: SlideTransition(
        position: Tween(begin: const Offset(0, 0.08), end: Offset.zero).animate(a),
        child: AnimatedScale(
          scale: _down && !reduce ? 0.97 : 1,
          duration: const Duration(milliseconds: 140),
          child: Semantics(
            button: true,
            label: '${m.label}. ${m.detail}',
            excludeSemantics: true,
            child: Material(
              color: scheme.surfaceContainerHighest.withValues(alpha: 0.6),
              borderRadius: BorderRadius.circular(22),
              clipBehavior: Clip.antiAlias,
              child: InkWell(
                onTap: widget.onTap,
                onHighlightChanged: (v) => setState(() => _down = v),
                child: Padding(
                  padding: const EdgeInsets.all(20),
                  child: widget.tall
                      ? Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          icon,
                          const SizedBox(height: 18),
                          words,
                          const Spacer(),
                          const SizedBox(height: 18),
                          Align(alignment: Alignment.bottomRight, child: Icon(Icons.arrow_forward_rounded, color: scheme.onSurfaceVariant)),
                        ])
                      : Row(children: [
                          icon,
                          const SizedBox(width: 16),
                          Expanded(child: words),
                          const SizedBox(width: 8),
                          Icon(Icons.chevron_right_rounded, color: scheme.onSurfaceVariant),
                        ]),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
