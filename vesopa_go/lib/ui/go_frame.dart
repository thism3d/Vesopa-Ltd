/// What sits around every signed-on screen, as on the till:
///
///   * the status chips in the top bar: card payments (Tap to Pay or the
///     venue's Dojo machine), the receipt printer, and the back office link;
///   * the licence: a venue without Vesopa Go on its licence sees why;
///   * offline: the owner's rule is no orders while the back office cannot be
///     reached (2026-10-27), so the screen is held behind a banner until it is;
///   * idle: after the venue's timeout the till's own idle screen and
///     wallpaper, and a PIN to come back when the venue asks for one.
library;

import 'dart:async';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config/constants.dart' show apiBase;
import '../counter/data/lite_state.dart';
import '../counter/ui/brand.dart';
import '../data/session.dart';
import 'fit_text.dart';
import 'sounds.dart';
import 'theme.dart';

/// The app's navigator, so the frame (which sits above it, in
/// MaterialApp.builder, and so covers every pushed page too) can tell whether a
/// page or sheet is open over the main screens.
final goNavigator = GlobalKey<NavigatorState>();

/// The top bar's chips.
class StatusChips extends ConsumerWidget {
  const StatusChips({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = ref.watch(tapProvider);
    final via = cardVia(ref.watch(liteSettingsProvider), s.config, tablet: MediaQuery.sizeOf(context).shortestSide >= 600);
    final wide = MediaQuery.sizeOf(context).width >= 700;
    final live = s.config.environment == 'live';
    final chips = [
      _Chip(
        icon: via == 'tap' ? Icons.contactless_rounded : Icons.point_of_sale_rounded,
        label: via == 'tap' ? 'Tap to Pay' : 'Dojo machine',
        ok: s.online,
        note: live ? null : 'sandbox',
        tooltip: via == 'tap' ? 'Cards are taken on this device' : 'Cards go to the venue\'s Dojo card machine',
      ),
      _Chip(
        icon: Icons.print_rounded,
        label: s.config.go.printAirprintFallback ? 'Receipts · AirPrint' : 'Receipts',
        ok: true,
        tooltip: 'Receipts print on the venue\'s receipt printer, or AirPrint when none is set',
      ),
      _Chip(
        icon: s.online ? Icons.cloud_done_rounded : Icons.cloud_off_rounded,
        label: s.online ? (s.pendingSync > 0 ? 'Sending ${s.pendingSync}' : 'Synced') : 'Offline',
        ok: s.online,
        tooltip: 'The link to the back office',
      ),
    ];
    // A phone's bar has room for one light: the link to the back office.
    if (!wide) {
      return Tooltip(
        message: s.online ? 'Synced with the back office' : 'Offline',
        child: Icon(s.online ? Icons.cloud_done_rounded : Icons.cloud_off_rounded, color: s.online ? Tp.green : Tp.amber),
      );
    }
    return Row(mainAxisSize: MainAxisSize.min, children: [for (final c in chips) Padding(padding: const EdgeInsets.only(right: 6), child: c)]);
  }
}

class _Chip extends StatelessWidget {
  const _Chip({required this.icon, required this.label, required this.ok, required this.tooltip, this.note});
  final IconData icon;
  final String label;
  final bool ok;
  final String tooltip;
  final String? note;

  @override
  Widget build(BuildContext context) => Tooltip(
        message: tooltip,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 300),
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
          decoration: BoxDecoration(
            color: Tp.inkCard,
            borderRadius: BorderRadius.circular(999),
            border: Border.all(color: ok ? Tp.inkLine : Tp.amber),
          ),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            _Dot(colour: ok ? Tp.green : Tp.amber),
            const SizedBox(width: 6),
            Icon(icon, size: 15),
            const SizedBox(width: 5),
            Text(label, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
            if (note != null) Text(' · $note', style: const TextStyle(fontSize: 12, color: Tp.amber)),
          ]),
        ),
      );
}

/// A status light that breathes while it is green.
class _Dot extends StatefulWidget {
  const _Dot({required this.colour});
  final Color colour;
  @override
  State<_Dot> createState() => _DotState();
}

class _DotState extends State<_Dot> with SingleTickerProviderStateMixin {
  late final _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 1600), value: 1);

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (ambientMotion(context) && !_c.isAnimating) _c.repeat(reverse: true);
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => FadeTransition(
        opacity: Tween(begin: 0.45, end: 1.0).animate(_c),
        child: Container(width: 8, height: 8, decoration: BoxDecoration(color: widget.colour, shape: BoxShape.circle)),
      );
}

/// The licence, offline and idle rules around a signed-on screen.
class GoFrame extends ConsumerStatefulWidget {
  const GoFrame({super.key, required this.child});
  final Widget child;
  @override
  ConsumerState<GoFrame> createState() => _GoFrameState();
}

class _GoFrameState extends ConsumerState<GoFrame> {
  Timer? _idle;
  bool _idleShown = false;

  @override
  void initState() {
    super.initState();
    _touch();
  }

  @override
  void dispose() {
    _idle?.cancel();
    super.dispose();
  }

  void _touch() {
    _idle?.cancel();
    final go = ref.read(tapProvider).config.go;
    if (!go.idleEnabled || go.idleSeconds <= 0) return;
    _idle = Timer(Duration(seconds: go.idleSeconds), _goIdle);
  }

  void _goIdle() {
    if (!mounted) return;
    // Never over a sale being paid or a sheet that is open: only from the
    // main screens, as the till only idles from the sale screen.
    if (goNavigator.currentState?.canPop() ?? false) {
      _touch();
      return;
    }
    setState(() => _idleShown = true);
  }

  void _wake() {
    final go = ref.read(tapProvider).config.go;
    setState(() => _idleShown = false);
    if (go.idleRequirePin) {
      ref.read(tapProvider.notifier).lock();
    } else {
      _touch();
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = ref.watch(tapProvider);
    // The kitchen has finished a table's food: the ready sound, and a banner.
    ref.listen(tapProvider.select((s) => s.alerts), (before, now) {
      if (now.length > (before?.length ?? 0)) GoSounds.play(ref.read(tapProvider).config.go, GoSound.kitchenReady);
    });
    if (!s.config.licensed && !s.demo) return const Material(child: _NotLicensed());
    return Listener(
      behavior: HitTestBehavior.translucent,
      onPointerDown: (_) => _touch(),
      child: Stack(children: [
        // The owner's rule: no orders while the back office cannot be reached.
        AbsorbPointer(absorbing: !s.online && !s.demo, child: widget.child),
        if (!s.online && !s.demo) const Positioned.fill(child: Material(type: MaterialType.transparency, child: _Offline())),
        Positioned(
          left: 16,
          right: 16,
          top: 0,
          child: SafeArea(
            child: AnimatedSwitcher(
              duration: const Duration(milliseconds: 300),
              transitionBuilder: (child, a) => SlideTransition(position: Tween(begin: const Offset(0, -1.2), end: Offset.zero).animate(a), child: child),
              child: s.alerts.isEmpty
                  ? const SizedBox.shrink()
                  : Material(
                      key: ValueKey(s.alerts.first),
                      color: Tp.lime,
                      elevation: 8,
                      borderRadius: BorderRadius.circular(14),
                      child: ListTile(
                        leading: const Icon(Icons.room_service_rounded, color: Tp.onLime),
                        title: Text(s.alerts.first, style: const TextStyle(color: Tp.onLime, fontWeight: FontWeight.w800)),
                        subtitle: s.alerts.length > 1 ? Text('and ${s.alerts.length - 1} more', style: const TextStyle(color: Tp.onLime)) : null,
                        trailing: TextButton(onPressed: () => ref.read(tapProvider.notifier).clearAlerts(), child: const Text('OK', style: TextStyle(color: Tp.onLime, fontWeight: FontWeight.w800))),
                      ),
                    ),
            ),
          ),
        ),
        Positioned.fill(
          child: IgnorePointer(
            ignoring: !_idleShown,
            child: AnimatedOpacity(
              opacity: _idleShown ? 1 : 0,
              duration: const Duration(milliseconds: 500),
              child: _idleShown ? IdleScreen(onWake: _wake) : const SizedBox.shrink(),
            ),
          ),
        ),
      ]),
    );
  }
}

class _Offline extends ConsumerWidget {
  const _Offline();
  @override
  Widget build(BuildContext context, WidgetRef ref) => ColoredBox(
        color: Colors.black.withValues(alpha: 0.55),
        child: Center(
          child: Card(
            child: Padding(
              padding: const EdgeInsets.all(28),
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                const Icon(Icons.wifi_off_rounded, size: 48, color: Tp.amber),
                const SizedBox(height: 12),
                Text('Waiting for the back office', style: Theme.of(context).textTheme.titleLarge),
                const SizedBox(height: 6),
                const Text('Orders are held until this device is back online, so nothing clashes with the till.', textAlign: TextAlign.center),
                const SizedBox(height: 18),
                FilledButton.icon(
                  onPressed: () => ref.read(tapProvider.notifier).refresh(),
                  icon: const Icon(Icons.refresh_rounded),
                  label: const Text('Try again'),
                ),
              ]),
            ),
          ),
        ),
      );
}

class _NotLicensed extends ConsumerWidget {
  const _NotLicensed();
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = Theme.of(context).textTheme;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const GoMark(size: 72),
          const SizedBox(height: 20),
          Text('Vesopa Go is not on this venue\'s licence', style: t.headlineSmall, textAlign: TextAlign.center),
          const SizedBox(height: 8),
          const Text('Ask Vesopa to add Vesopa Go to your licences. It works the moment it is added.', textAlign: TextAlign.center),
          const SizedBox(height: 20),
          OutlinedButton.icon(onPressed: () => ref.read(tapProvider.notifier).refresh(), icon: const Icon(Icons.refresh_rounded), label: const Text('Check again')),
        ]),
      ),
    );
  }
}

/// The till's idle screen: the venue's wallpaper from the back office (Till
/// settings > Idle screen), the time, and the venue's message.
class IdleScreen extends ConsumerStatefulWidget {
  const IdleScreen({super.key, required this.onWake});
  final VoidCallback onWake;
  @override
  ConsumerState<IdleScreen> createState() => _IdleScreenState();
}

class _IdleScreenState extends ConsumerState<IdleScreen> with SingleTickerProviderStateMixin {
  late final Timer _clock = Timer.periodic(const Duration(seconds: 15), (_) => setState(() {}));
  late final _pulse = AnimationController(vsync: this, duration: const Duration(milliseconds: 1800), value: 1);

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (ambientMotion(context) && !_pulse.isAnimating) _pulse.repeat(reverse: true);
  }

  @override
  void dispose() {
    _clock.cancel();
    _pulse.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final s = ref.watch(tapProvider);
    final url = s.config.idleImageUrl;
    final image = url == null ? null : (url.startsWith('http') ? url : '$apiBase${url.startsWith('/') ? '' : '/'}$url');
    final now = TimeOfDay.now();
    final time = '${now.hour.toString().padLeft(2, '0')}:${now.minute.toString().padLeft(2, '0')}';
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: widget.onWake,
      child: Stack(fit: StackFit.expand, children: [
        const ColoredBox(color: Tp.inkDeep),
        if (image != null)
          CachedNetworkImage(imageUrl: image, fit: BoxFit.cover, fadeInDuration: const Duration(milliseconds: 600), errorWidget: (_, _, _) => const SizedBox.shrink()),
        // Keeps the words readable on any picture.
        const DecoratedBox(
          decoration: BoxDecoration(gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Color(0x66000000), Color(0x00000000), Color(0xB3000000)])),
        ),
        SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(32),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                const GoMark(size: 40),
                const SizedBox(width: 12),
                Expanded(child: Text(s.venue?.name ?? appName, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w700, color: Colors.white))),
                Text(time, style: const TextStyle(fontSize: 40, fontWeight: FontWeight.w800, color: Colors.white, fontFeatures: Tp.tabular)),
              ]),
              const Spacer(),
              Center(
                child: FadeTransition(
                  opacity: Tween(begin: 0.55, end: 1.0).animate(_pulse),
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 16),
                    decoration: BoxDecoration(color: Tp.lime, borderRadius: BorderRadius.circular(999)),
                    // A venue's message can be a sentence: it wraps between
                    // words and shrinks until it fits, never running off the
                    // screen or splitting a word (iPad, 2026-10-28).
                    child: ConstrainedBox(
                      constraints: BoxConstraints(
                        maxWidth: MediaQuery.sizeOf(context).width * 0.8 - 56,
                        maxHeight: MediaQuery.sizeOf(context).height * 0.3,
                      ),
                      child: FitText(s.config.idleMessage,
                          textAlign: TextAlign.center,
                          maxLines: 4,
                          minSize: 14,
                          style: const TextStyle(fontSize: 26, height: 1.2, fontWeight: FontWeight.w800, color: Tp.onLime)),
                    ),
                  ),
                ),
              ),
              const SizedBox(height: 24),
            ]),
          ),
        ),
      ]),
    );
  }
}
