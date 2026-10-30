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

import 'dart:ui' show ImageFilter;

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:screen_brightness/screen_brightness.dart';

import '../config/constants.dart' show apiBase;
import '../counter/data/lite_state.dart';
import '../counter/ui/brand.dart';
import '../counter/ui/receipt_print.dart' show receiptPrinter;
import '../data/lan/lan_service.dart';
import '../data/session.dart';
import '../payments/teya_machine.dart';
import 'device_prefs.dart';
import 'fit_text.dart';
import 'pages/card_machine_page.dart' show deviceMachine;
import 'sounds.dart';
import 'theme.dart';

/// The app's navigator, so the frame (which sits above it, in
/// MaterialApp.builder, and so covers every pushed page too) can tell whether a
/// page or sheet is open over the main screens.
final goNavigator = GlobalKey<NavigatorState>();

/// The top bar's lights, as small icons (owner, 2026-10-28: "use icons,
/// interactive, once clicked show dialogs"): card payments, the receipt
/// printer, and the link to the back office and the tills. Each has a dot for
/// its state; a tap shows what it is connected to.
class StatusChips extends ConsumerWidget {
  const StatusChips({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = ref.watch(tapProvider);
    final via = cardVia(ref.watch(liteSettingsProvider), s.config, tablet: MediaQuery.sizeOf(context).shortestSide >= 600);
    final teya = s.config.teya.enabled;
    final sandbox = (teya ? s.config.teya.environment : s.config.environment) != 'live';
    final cardName = teya ? 'Teya card machine' : (via == 'tap' ? 'Tap to Pay on this device' : 'Dojo card machine');
    final lan = LanService.instance;
    // A phone's bar has room for one light: the link to the back office.
    final phone = MediaQuery.sizeOf(context).width < 600;
    return Row(mainAxisSize: MainAxisSize.min, children: [
      if (!phone) ...[
      _StatusIcon(
        icon: via == 'tap' ? Icons.contactless_rounded : Icons.point_of_sale_rounded,
        ok: s.online,
        warn: sandbox,
        tooltip: cardName,
        onTap: () async {
          final machine = teya ? await deviceTeyaMachine() ?? s.config.teya.machineId : await deviceMachine();
          final nfc = via == 'tap' ? await nfcProblem() : null;
          if (!context.mounted) return;
          _info(context, 'Card payments', Icons.credit_card_rounded, [
            ('Takes cards', cardName),
            ('Provider', teya ? 'Teya' : 'Dojo'),
            ('Mode', sandbox ? 'Sandbox (test cards)' : 'Live'),
            if (via == 'machine') ('Machine', machine ?? 'The venue\'s default'),
            if (!teya && s.config.softwareHouseId.isNotEmpty) ('Software house ID', s.config.softwareHouseId),
            if (nfc != null) ('NFC', nfc),
          ]);
        },
      ),
      _StatusIcon(
        icon: Icons.print_rounded,
        ok: true,
        tooltip: 'Receipts',
        onTap: () async {
          final printer = await receiptPrinter();
          if (!context.mounted) return;
          _info(context, 'Receipts', Icons.print_rounded, [
            ('Receipt printer', printer.isEmpty ? 'None set' : printer),
            ('Without one', s.config.go.printAirprintFallback ? 'AirPrint or Android printing' : 'No printing'),
            ('Kitchen tickets', s.config.go.printKitchen ? 'To the kitchen printers and screens' : 'Off'),
          ]);
        },
      ),
      ],
      _StatusIcon(
        icon: s.online ? Icons.cloud_done_rounded : Icons.cloud_off_rounded,
        ok: s.online,
        badge: s.pendingSync > 0 ? '${s.pendingSync}' : null,
        tooltip: s.online ? 'Synced' : 'Offline',
        onTap: () => _info(context, 'Connection', Icons.cloud_done_rounded, [
          ('Back office', s.online ? 'Connected' : 'Offline'),
          ('Waiting to send', s.pendingSync == 0 ? 'Nothing' : '${s.pendingSync}'),
          ('Venue network', lan.linked ? (lan.isHub ? 'Linked, leading the tills' : 'Linked to the tills') : 'Not linked'),
          ('This device', ref.read(tapProvider.notifier).terminalName),
        ]),
      ),
    ]);
  }
}

void _info(BuildContext context, String title, IconData icon, List<(String, String)> facts) => showDialog<void>(
      context: context,
      builder: (c) => AlertDialog(
        icon: Icon(icon),
        title: Text(title),
        content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          for (final (k, v) in facts)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 5),
              child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                SizedBox(width: 130, child: Text(k, style: Theme.of(c).textTheme.bodySmall)),
                Expanded(child: Text(v, style: const TextStyle(fontWeight: FontWeight.w600))),
              ]),
            ),
        ]),
        actions: [TextButton(onPressed: () => Navigator.pop(c), child: const Text('Done'))],
      ),
    );

class _StatusIcon extends StatelessWidget {
  const _StatusIcon({required this.icon, required this.ok, required this.tooltip, required this.onTap, this.warn = false, this.badge});
  final IconData icon;
  final bool ok;
  final bool warn;
  final String tooltip;
  final VoidCallback onTap;
  final String? badge;

  @override
  Widget build(BuildContext context) => IconButton(
        tooltip: tooltip,
        onPressed: onTap,
        icon: Stack(clipBehavior: Clip.none, children: [
          Icon(icon, size: 22),
          Positioned(right: -3, top: -3, child: _Dot(colour: !ok ? Tp.amber : (warn ? Tp.amber : Tp.green))),
          if (badge != null)
            Positioned(
              right: -10,
              bottom: -6,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
                decoration: BoxDecoration(color: Tp.amber, borderRadius: BorderRadius.circular(8)),
                child: Text(badge!, style: const TextStyle(fontSize: 10, fontWeight: FontWeight.w800, color: Tp.ink)),
              ),
            ),
        ]),
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
    // A Material under it: text outside one is drawn with Flutter's warning
    // underlines (the two yellow lines under the words, iPad 2026-10-28).
    return Material(
      type: MaterialType.transparency,
      child: GestureDetector(
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
                // The venue's own logo (back office, Branding), as the till's
                // idle screen; the Vesopa mark when there is none.
                if (s.config.logoUrl case final logo?)
                  ConstrainedBox(
                    constraints: const BoxConstraints(maxHeight: 44, maxWidth: 160),
                    child: CachedNetworkImage(
                      imageUrl: logo.startsWith('http') ? logo : '$apiBase${logo.startsWith('/') ? '' : '/'}$logo',
                      fit: BoxFit.contain,
                      errorWidget: (_, _, _) => const GoMark(size: 40),
                    ),
                  )
                else
                  const GoMark(size: 40),
                const SizedBox(width: 12),
                Expanded(child: Text(s.venue?.name ?? appName, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w700, color: Colors.white))),
                Text(time, style: const TextStyle(fontSize: 40, fontWeight: FontWeight.w800, color: Colors.white, fontFeatures: Tp.tabular)),
              ]),
              const Spacer(),
              Center(
                child: FadeTransition(
                  opacity: Tween(begin: 0.7, end: 1.0).animate(_pulse),
                  // Glass, as Apple's own controls over a picture: the
                  // wallpaper blurred through it, a hairline edge, white words.
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(999),
                    child: BackdropFilter(
                    filter: ImageFilter.blur(sigmaX: 24, sigmaY: 24),
                    child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 16),
                    decoration: BoxDecoration(
                      color: Colors.white.withValues(alpha: 0.16),
                      borderRadius: BorderRadius.circular(999),
                      border: Border.all(color: Colors.white.withValues(alpha: 0.35), width: 0.8),
                    ),
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
                          style: const TextStyle(fontSize: 26, height: 1.2, fontWeight: FontWeight.w700, color: Colors.white, letterSpacing: 0.2)),
                    ),
                  ),
                  ),
                  ),
                ),
              ),
              const SizedBox(height: 24),
            ]),
          ),
        ),
        const Positioned(left: 20, bottom: 20, child: SafeArea(child: _Brightness())),
      ]),
      ),
    );
  }
}

/// Brightness, as one quick button in the idle screen's corner (owner,
/// 2026-10-30, after iOS and Android's own): a tap opens a slider beside it,
/// a tap on the button again puts it away. Taps here do not wake the screen.
class _Brightness extends StatefulWidget {
  const _Brightness();
  @override
  State<_Brightness> createState() => _BrightnessState();
}

class _BrightnessState extends State<_Brightness> {
  bool _open = false;
  double _level = 0.6;

  Future<void> _toggle() async {
    if (!_open) {
      try {
        _level = await ScreenBrightness.instance.application;
      } catch (_) {}
    }
    if (mounted) setState(() => _open = !_open);
  }

  Future<void> _set(double v) async {
    setState(() => _level = v);
    try {
      await ScreenBrightness.instance.setApplicationScreenBrightness(v.clamp(0.05, 1.0));
    } catch (_) {}
  }

  @override
  Widget build(BuildContext context) => ClipRRect(
        borderRadius: BorderRadius.circular(999),
        child: BackdropFilter(
          filter: ImageFilter.blur(sigmaX: 18, sigmaY: 18),
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 220),
            curve: Curves.easeOutCubic,
            width: _open ? 300 : 52,
            height: 52,
            decoration: BoxDecoration(
              color: Colors.white.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(999),
              border: Border.all(color: Colors.white.withValues(alpha: 0.25), width: 0.8),
            ),
            child: Row(children: [
              IconButton(color: Colors.white, onPressed: _toggle, icon: Icon(_open ? Icons.close_rounded : Icons.brightness_6_rounded)),
              if (_open)
                Expanded(
                  child: SliderTheme(
                    data: SliderTheme.of(context).copyWith(
                      activeTrackColor: Colors.white,
                      inactiveTrackColor: Colors.white.withValues(alpha: 0.25),
                      thumbColor: Colors.white,
                      overlayColor: Colors.white.withValues(alpha: 0.12),
                    ),
                    child: Slider(value: _level.clamp(0.05, 1.0), min: 0.05, onChanged: _set),
                  ),
                ),
            ]),
          ),
        ),
      );
}
