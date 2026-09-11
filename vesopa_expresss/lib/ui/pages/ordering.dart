/// Choosing: the attract screen, eat in or take away, the menu, a dish, the
/// basket, a name, and how to pay.
///
/// ONE LAYOUT RULE, APPLIED EVERYWHERE
///
/// Portrait is the kiosk's own shape and the one designed first: a category
/// rail down the left, dishes in a grid, and the basket as a bar along the
/// bottom, where a thumb already is. Landscape -- a kiosk on its side, a tablet
/// on a counter -- keeps the rail and the grid and moves the basket to a panel
/// on the right, because a bottom bar across 1920 pixels is a long way to
/// reach for a total. Nothing is decided by device, only by the shape of the
/// window at this moment, so turning a screen round mid-order just works.
library;

import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/basket.dart';
import '../../data/models.dart';
import '../../data/order_flow.dart';
import '../../data/session.dart';
import '../../l10n/strings.dart';
import '../theme.dart';
import '../widgets/common.dart';
import '../widgets/marks.dart';

bool _portrait(BuildContext context) {
  final size = MediaQuery.sizeOf(context);
  return size.height >= size.width;
}

// ---------------------------------------------------------------------------
// The frame every ordering screen sits in
// ---------------------------------------------------------------------------

/// The header, the body, an optional footer -- and reach mode, which lowers
/// all of it into the bottom of the screen for somebody who cannot reach the
/// top of a tall kiosk.
class FlowScaffold extends ConsumerWidget {
  const FlowScaffold({super.key, required this.body, this.footer, this.topBar = true});

  final Widget body;
  final Widget? footer;
  final bool topBar;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final reach = ref.watch(orderFlowProvider.select((f) => f.reach));
    final config = ref.watch(kioskSessionProvider.select((s) => s.config));
    final connected = ref.watch(kioskSessionProvider.select((s) => s.connected));
    final s = ref.watch(orderFlowProvider.select((f) => f.s));
    final skin = XpSkin.of(context);

    final content = Column(
      children: [
        if (topBar) const TopBar(),
        if (config?.demo == true) _Banner(s('demo_banner'), color: Xp.amber),
        if (!connected) _Banner(s('offline_body'), color: Xp.danger),
        Expanded(child: body),
        ?footer,
      ],
    );

    return ColoredBox(
      color: skin.ground,
      child: SafeArea(
        child: reach
            ? Column(
                children: [
                  Expanded(flex: 34, child: _ReachSpace(venue: config?.venueName ?? '')),
                  Expanded(flex: 66, child: content),
                ],
              )
            : content,
      ),
    );
  }
}

class _Banner extends StatelessWidget {
  const _Banner(this.text, {required this.color});
  final String text;
  final Color color;

  @override
  Widget build(BuildContext context) => Container(
    width: double.infinity,
    color: color,
    padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 8),
    child: Text(text,
        textAlign: TextAlign.center,
        style: TextStyle(fontWeight: FontWeight.w800, fontSize: 15, color: Xp.onColor(color))),
  );
}

/// The top of the screen in reach mode: nothing to press, just a calm space
/// that says where the kiosk has gone.
class _ReachSpace extends StatelessWidget {
  const _ReachSpace({required this.venue});
  final String venue;

  @override
  Widget build(BuildContext context) {
    final skin = XpSkin.of(context);
    return Container(
      color: skin.contrast ? Xp.night : Xp.limeSoft,
      alignment: Alignment.center,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          ExpressMark(size: 72, onDark: skin.contrast),
          const SizedBox(height: 12),
          if (venue.isNotEmpty)
            Text(venue, style: Theme.of(context).textTheme.headlineSmall),
          const SizedBox(height: 8),
          Icon(Icons.keyboard_double_arrow_down_rounded, size: 40, color: skin.inkSoft),
        ],
      ),
    );
  }
}

/// Venue, eat in / take away, language, accessibility, start again.
class TopBar extends ConsumerWidget {
  const TopBar({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final flow = ref.watch(orderFlowProvider);
    final config = ref.watch(kioskSessionProvider.select((s) => s.config));
    final s = flow.s;
    final skin = XpSkin.of(context);
    final narrow = MediaQuery.sizeOf(context).width < 760;

    return Container(
      padding: const EdgeInsets.fromLTRB(20, 12, 12, 12),
      decoration: BoxDecoration(
        color: skin.card,
        border: Border(bottom: BorderSide(color: skin.line)),
      ),
      child: Row(
        children: [
          ClipRRect(
            borderRadius: BorderRadius.circular(14),
            child: SizedBox(
              width: 52,
              height: 52,
              child: config?.logoUrl != null
                  ? NetImage(config!.logoUrl, fit: BoxFit.contain, icon: Icons.storefront)
                  : ColoredBox(color: skin.chip, child: const Center(child: ExpressMark(size: 34))),
            ),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  config?.venueName.isNotEmpty == true ? config!.venueName : 'Vesopa Express',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.titleLarge,
                ),
                if (flow.orderType != null)
                  Text(
                    flow.orderType == 'eat_in' ? s('eat_in') : s('take_away'),
                    style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: skin.muted),
                  ),
              ],
            ),
          ),
          _BarButton(
            icon: Icons.translate_rounded,
            label: flow.lang == Lang.en ? Lang.cy.label : Lang.en.label,
            compact: narrow,
            onTap: () => ref.read(orderFlowProvider.notifier)
                .setLang(flow.lang == Lang.en ? Lang.cy : Lang.en),
          ),
          _BarButton(
            icon: Icons.accessibility_new_rounded,
            label: s('accessibility'),
            compact: true,
            onTap: () => _accessibility(context, ref),
          ),
          if (flow.step != FlowStep.attract)
            _BarButton(
              icon: Icons.restart_alt_rounded,
              label: s('start_again'),
              compact: narrow,
              onTap: () async {
                if (flow.basket.isEmpty) {
                  ref.read(orderFlowProvider.notifier).reset();
                  return;
                }
                final yes = await askYesNo(
                  context,
                  title: s('start_again_q'),
                  body: s('start_again_body'),
                  yes: s('start_again'),
                  no: s('keep_ordering'),
                );
                if (yes) ref.read(orderFlowProvider.notifier).reset();
              },
            ),
        ],
      ),
    );
  }

  void _accessibility(BuildContext context, WidgetRef ref) {
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (context) => Consumer(builder: (context, ref, _) {
        final flow = ref.watch(orderFlowProvider);
        final n = ref.read(orderFlowProvider.notifier);
        final s = flow.s;
        return SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(24, 0, 24, 24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(s('accessibility'), style: Theme.of(context).textTheme.headlineSmall),
                const SizedBox(height: 8),
                SwitchListTile(
                  value: flow.reach,
                  onChanged: (_) => n.toggleReach(),
                  secondary: const Icon(Icons.accessible_rounded, size: 32),
                  title: Text(s('reach'), style: Theme.of(context).textTheme.titleMedium),
                ),
                SwitchListTile(
                  value: flow.contrast,
                  onChanged: (_) => n.toggleContrast(),
                  secondary: const Icon(Icons.contrast_rounded, size: 32),
                  title: Text(s('contrast'), style: Theme.of(context).textTheme.titleMedium),
                ),
                const SizedBox(height: 8),
                Row(children: [
                  for (final lang in Lang.values) ...[
                    Expanded(
                      child: flow.lang == lang
                          ? FilledButton(onPressed: () {}, child: Text(lang.label))
                          : OutlinedButton(onPressed: () => n.setLang(lang), child: Text(lang.label)),
                    ),
                    if (lang != Lang.values.last) const SizedBox(width: 12),
                  ],
                ]),
              ],
            ),
          ),
        );
      }),
    );
  }
}

class _BarButton extends StatelessWidget {
  const _BarButton({required this.icon, required this.label, required this.onTap, this.compact = false});

  final IconData icon;
  final String label;
  final VoidCallback onTap;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final skin = XpSkin.of(context);
    return Padding(
      padding: const EdgeInsets.only(left: 8),
      child: Tooltip(
        message: label,
        child: Material(
          color: skin.chip,
          borderRadius: BorderRadius.circular(14),
          child: InkWell(
            borderRadius: BorderRadius.circular(14),
            onTap: onTap,
            child: Container(
              constraints: const BoxConstraints(minWidth: 60, minHeight: 60),
              padding: EdgeInsets.symmetric(horizontal: compact ? 14 : 16),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(icon, size: 28, color: skin.ink),
                  if (!compact) ...[
                    const SizedBox(width: 8),
                    Text(label, style: TextStyle(fontWeight: FontWeight.w700, fontSize: 16, color: skin.ink)),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Attract
// ---------------------------------------------------------------------------

/// What the kiosk shows between customers: the venue, one picture, and an
/// invitation big enough to read from the door. Anywhere on it starts an
/// order, except the language buttons, which set the language first.
class AttractPage extends ConsumerStatefulWidget {
  const AttractPage({super.key});

  @override
  ConsumerState<AttractPage> createState() => _AttractPageState();
}

class _AttractPageState extends ConsumerState<AttractPage> with SingleTickerProviderStateMixin {
  late final AnimationController _drift = AnimationController(
    vsync: this,
    duration: const Duration(seconds: 18),
  )..repeat(reverse: true);

  @override
  void dispose() {
    _drift.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final session = ref.watch(kioskSessionProvider);
    final flow = ref.watch(orderFlowProvider);
    final c = session.config!;
    final s = flow.s;
    final popular = session.menu.popular;
    final picture = c.welcomeImage ??
        c.bannerUrl ??
        (popular.where((i) => i.imageUrl != null).map((i) => i.imageUrl).firstOrNull) ??
        session.menu.items.where((i) => i.imageUrl != null).map((i) => i.imageUrl).firstOrNull;
    // With no picture to fill the screen, the dishes do it -- the venue's
    // popular ones, or the first on the menu.
    final teaser = (popular.isNotEmpty ? popular : session.menu.items.where((i) => i.available).toList())
        .take(3)
        .toList();
    final portrait = _portrait(context);
    // A kiosk on its side, a small tablet, a window: under 760 tall the
    // teaser goes and the type comes down; under 640 wide the name beside the
    // mark goes. Measured at 540 x 960 and 960 x 540, where both overflowed.
    final size = MediaQuery.sizeOf(context);
    final short = size.height < 760;
    final narrow = size.width < 640;

    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: () => ref.read(orderFlowProvider.notifier).start(),
      child: Stack(
        fit: StackFit.expand,
        children: [
          const ColoredBox(color: Xp.night),
          if (picture != null)
            AnimatedBuilder(
              animation: _drift,
              builder: (context, child) => Transform.scale(scale: 1 + _drift.value * .07, child: child),
              child: Opacity(opacity: .62, child: NetImage(picture)),
            )
          else
            // No picture from the venue: the brand does the work instead -- a
            // slow lime glow and the mark, large and quiet, so the screen reads
            // as designed rather than as a photograph that failed to load.
            AnimatedBuilder(
              animation: _drift,
              builder: (context, _) => Stack(
                fit: StackFit.expand,
                children: [
                  DecoratedBox(
                    decoration: BoxDecoration(
                      gradient: RadialGradient(
                        center: Alignment(.6 - _drift.value * .3, -.55 + _drift.value * .2),
                        radius: 1.1,
                        colors: [c.accent.withValues(alpha: .34), Xp.night.withValues(alpha: 0)],
                      ),
                    ),
                  ),
                  Positioned(
                    right: -MediaQuery.sizeOf(context).shortestSide * .12,
                    top: MediaQuery.sizeOf(context).height * .08,
                    child: Opacity(
                      opacity: .10 + _drift.value * .04,
                      child: ExpressMark(size: MediaQuery.sizeOf(context).shortestSide * .9, onDark: true),
                    ),
                  ),
                ],
              ),
            ),
          const DecoratedBox(
            decoration: BoxDecoration(
              gradient: LinearGradient(
                begin: Alignment.topCenter,
                end: Alignment.bottomCenter,
                colors: [Color(0x660B0D08), Color(0x000B0D08), Color(0xE60B0D08), Color(0xFF0B0D08)],
                stops: [0, .32, .72, 1],
              ),
            ),
          ),
          SafeArea(
            child: Padding(
              padding: EdgeInsets.symmetric(horizontal: portrait ? 48 : 72, vertical: short ? 20 : 36),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(children: [
                    if (c.logoUrl != null)
                      Container(
                        width: 76,
                        height: 76,
                        margin: const EdgeInsets.only(right: 16),
                        clipBehavior: Clip.antiAlias,
                        decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(18)),
                        child: NetImage(c.logoUrl, fit: BoxFit.contain, icon: Icons.storefront),
                      ),
                    Expanded(
                      child: Text(c.venueName,
                          maxLines: 2,
                          style: const TextStyle(color: Colors.white, fontSize: 28, fontWeight: FontWeight.w800)),
                    ),
                    if (c.demo) Pill(s('demo'), color: Xp.amber),
                    if (!c.demo && c.sandbox) Pill(s('sandbox'), color: Xp.amber),
                  ]),
                  if (picture == null && teaser.isNotEmpty && !short) ...[
                    const Spacer(flex: 2),
                    _AttractTeaser(items: teaser, portrait: portrait),
                    const Spacer(flex: 2),
                  ] else
                    const Spacer(flex: 5),
                  Text(
                    c.welcomeTitle ?? s('order_here'),
                    style: TextStyle(
                      color: Colors.white,
                      fontSize: short ? 54 : (portrait ? 84 : 76),
                      fontWeight: FontWeight.w800,
                      height: 1.02,
                      letterSpacing: -1.5,
                    ),
                  ),
                  const SizedBox(height: 16),
                  Text(
                    c.welcomeSubtitle ?? s('skip_queue'),
                    style: TextStyle(color: const Color(0xFFDDE3CF), fontSize: short ? 20 : 26, fontWeight: FontWeight.w500),
                  ),
                  const Spacer(flex: 2),
                  _Breathing(
                    child: Container(
                      width: double.infinity,
                      padding: EdgeInsets.symmetric(vertical: short ? 18 : 30),
                      decoration: BoxDecoration(
                        color: c.accent,
                        borderRadius: BorderRadius.circular(28),
                        boxShadow: [BoxShadow(color: c.accent.withValues(alpha: .45), blurRadius: 40)],
                      ),
                      child: Row(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Icon(Icons.touch_app_rounded, size: 40, color: Xp.onColor(c.accent)),
                          const SizedBox(width: 14),
                          Text(s('touch_to_start'),
                              style: TextStyle(fontSize: 34, fontWeight: FontWeight.w800, color: Xp.onColor(c.accent))),
                        ],
                      ),
                    ),
                  ),
                  SizedBox(height: short ? 14 : 26),
                  Row(children: [
                    for (final lang in Lang.values)
                      Padding(
                        padding: const EdgeInsets.only(right: 12),
                        child: GestureDetector(
                          onTap: () {
                            ref.read(orderFlowProvider.notifier)
                              ..setLang(lang)
                              ..start();
                          },
                          child: Container(
                            padding: const EdgeInsets.symmetric(horizontal: 22, vertical: 14),
                            decoration: BoxDecoration(
                              borderRadius: BorderRadius.circular(999),
                              border: Border.all(color: Colors.white.withValues(alpha: .5), width: 2),
                            ),
                            child: Text(lang.label,
                                style: const TextStyle(color: Colors.white, fontSize: 20, fontWeight: FontWeight.w700)),
                          ),
                        ),
                      ),
                    const Spacer(),
                    const ExpressMark(size: 34, onDark: true),
                    if (!narrow) ...[
                      const SizedBox(width: 10),
                      const Text('Vesopa Express',
                          style: TextStyle(color: Color(0xFFB9C1A8), fontWeight: FontWeight.w700, fontSize: 16)),
                    ],
                  ]),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Up to three dishes, as dark cards, for an attract screen with no picture.
class _AttractTeaser extends StatelessWidget {
  const _AttractTeaser({required this.items, required this.portrait});

  final List<MenuItem> items;
  final bool portrait;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: portrait ? 330 : 280,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final (i, item) in items.indexed) ...[
            if (i > 0) const SizedBox(width: 18),
            Expanded(
              child: Container(
                clipBehavior: Clip.antiAlias,
                decoration: BoxDecoration(
                  color: Xp.nightCard,
                  borderRadius: BorderRadius.circular(26),
                  border: Border.all(color: Xp.nightLine),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Expanded(child: NetImage(item.imageUrl)),
                    Padding(
                      padding: const EdgeInsets.fromLTRB(18, 14, 18, 16),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(item.name,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(color: Colors.white, fontSize: 20, fontWeight: FontWeight.w700)),
                          const SizedBox(height: 4),
                          Text(money(item.priceMinor),
                              style: const TextStyle(color: Xp.lime, fontSize: 20, fontWeight: FontWeight.w800)),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// A gentle pulse, so the one thing to touch looks touchable from the door.
class _Breathing extends StatefulWidget {
  const _Breathing({required this.child});
  final Widget child;

  @override
  State<_Breathing> createState() => _BreathingState();
}

class _BreathingState extends State<_Breathing> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1600),
  )..repeat(reverse: true);

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ScaleTransition(
    scale: Tween(begin: .985, end: 1.015).animate(CurvedAnimation(parent: _c, curve: Curves.easeInOut)),
    child: widget.child,
  );
}

// ---------------------------------------------------------------------------
// Eat in or take away
// ---------------------------------------------------------------------------

class OrderTypePage extends ConsumerWidget {
  const OrderTypePage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = ref.watch(orderFlowProvider.select((f) => f.s));
    final n = ref.read(orderFlowProvider.notifier);
    return FlowScaffold(
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(36),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(s('where_eating'),
                  textAlign: TextAlign.center, style: Theme.of(context).textTheme.displayMedium),
              const SizedBox(height: 44),
              Flex(
                direction: MediaQuery.sizeOf(context).width < 720 ? Axis.vertical : Axis.horizontal,
                mainAxisSize: MainAxisSize.min,
                children: [
                  _BigChoice(icon: Icons.restaurant_rounded, label: s('eat_in'), onTap: () => n.chooseType('eat_in')),
                  const SizedBox(width: 28, height: 18),
                  _BigChoice(
                      icon: Icons.shopping_bag_rounded, label: s('take_away'), onTap: () => n.chooseType('take_away')),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// One of two big answers: eat in or take away, card or counter.
///
/// Square tiles side by side where there is room; on a narrow screen (a phone,
/// a small tablet, a kiosk window) wide cards stacked one above the other, with
/// the picture beside the words. Never a fixed height: the first live run at
/// 540 x 960 had "Pay at the counter" wrap onto three lines inside a tile sized
/// for one, and the words fell out of the bottom of the card.
class _BigChoice extends StatelessWidget {
  const _BigChoice({required this.icon, required this.label, required this.onTap, this.sub});

  final IconData icon;
  final String label;
  final String? sub;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final skin = XpSkin.of(context);
    final width = MediaQuery.sizeOf(context).width;
    final stacked = width < 720;
    final text = Theme.of(context).textTheme;

    Widget badge(double size) => Container(
      width: size,
      height: size,
      decoration: BoxDecoration(color: skin.chip, shape: BoxShape.circle),
      child: Icon(icon, size: size * .52, color: skin.contrast ? Xp.lime : Xp.limeDeep),
    );

    final Widget content;
    final BoxConstraints box;
    if (stacked) {
      box = BoxConstraints(minWidth: math.min(560, width - 64), maxWidth: math.min(560, width - 64), minHeight: 120);
      content = Padding(
        padding: const EdgeInsets.symmetric(horizontal: 22, vertical: 20),
        child: Row(
          children: [
            badge(84),
            const SizedBox(width: 20),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(label, style: text.headlineSmall),
                  if (sub != null) ...[
                    const SizedBox(height: 4),
                    Text(sub!, style: text.bodyMedium?.copyWith(color: skin.muted)),
                  ],
                ],
              ),
            ),
            Icon(Icons.chevron_right_rounded, size: 34, color: skin.muted),
          ],
        ),
      );
    } else {
      final side = math.min(360.0, (width - 140) / 2);
      box = BoxConstraints(minWidth: side, maxWidth: side, minHeight: side * 1.1);
      content = Padding(
        padding: const EdgeInsets.all(22),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            badge(side * .46),
            const SizedBox(height: 22),
            Text(label, textAlign: TextAlign.center, style: text.headlineMedium),
            if (sub != null) ...[
              const SizedBox(height: 8),
              Text(sub!, textAlign: TextAlign.center, style: text.bodyMedium?.copyWith(color: skin.muted)),
            ],
          ],
        ),
      );
    }

    return Material(
      color: skin.card,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(32),
        side: BorderSide(color: skin.line, width: 2),
      ),
      child: InkWell(
        borderRadius: BorderRadius.circular(32),
        onTap: onTap,
        child: ConstrainedBox(
          constraints: box,
          child: stacked ? content : Center(child: content),
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// The menu
// ---------------------------------------------------------------------------

class MenuPage extends ConsumerStatefulWidget {
  const MenuPage({super.key});

  @override
  ConsumerState<MenuPage> createState() => _MenuPageState();
}

class _MenuPageState extends ConsumerState<MenuPage> {
  /// -1 is "Popular", which leads the rail when the venue has marked any.
  int? _selected;

  @override
  Widget build(BuildContext context) {
    final menu = ref.watch(kioskSessionProvider.select((s) => s.menu));
    final s = ref.watch(orderFlowProvider.select((f) => f.s));
    final portrait = _portrait(context);
    final popular = menu.popular;
    final selected = _selected ?? (popular.isNotEmpty ? -1 : 0);
    final sectionIndex = selected.clamp(-1, menu.sections.length - 1);

    final title = sectionIndex < 0 ? s('popular') : menu.sections[sectionIndex].name;
    final blurb = sectionIndex < 0 ? null : menu.sections[sectionIndex].blurb;
    final items = sectionIndex < 0 ? popular : menu.sections[sectionIndex].items;

    final rail = _CategoryRail(
      width: portrait ? 176 : 220,
      entries: [
        if (popular.isNotEmpty) (-1, s('popular'), popular.first.imageUrl, Icons.local_fire_department_rounded),
        for (var i = 0; i < menu.sections.length; i++)
          (i, menu.sections[i].name, menu.sections[i].imageUrl ?? menu.sections[i].items.first.imageUrl,
              Icons.restaurant_menu_rounded),
      ],
      selected: sectionIndex,
      onSelect: (i) => setState(() => _selected = i),
    );

    final grid = _ItemGrid(
      key: ValueKey('grid-$sectionIndex'),
      title: title,
      blurb: blurb,
      items: items,
      portrait: portrait,
    );

    return FlowScaffold(
      body: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          rail,
          Expanded(child: grid),
          if (!portrait) const SizedBox(width: 400, child: _BasketPanel()),
        ],
      ),
      footer: portrait ? const _BagBar() : null,
    );
  }
}

class _CategoryRail extends StatelessWidget {
  const _CategoryRail({
    required this.width,
    required this.entries,
    required this.selected,
    required this.onSelect,
  });

  final double width;
  final List<(int, String, String?, IconData)> entries;
  final int selected;
  final ValueChanged<int> onSelect;

  @override
  Widget build(BuildContext context) {
    final skin = XpSkin.of(context);
    return Container(
      width: width,
      decoration: BoxDecoration(color: skin.card, border: Border(right: BorderSide(color: skin.line))),
      child: ListView.separated(
        padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 12),
        itemCount: entries.length,
        separatorBuilder: (_, _) => const SizedBox(height: 10),
        itemBuilder: (context, i) {
          final (index, name, image, icon) = entries[i];
          final on = index == selected;
          return Material(
            color: on ? Xp.lime : Colors.transparent,
            borderRadius: BorderRadius.circular(18),
            child: InkWell(
              borderRadius: BorderRadius.circular(18),
              onTap: () => onSelect(index),
              child: Padding(
                padding: const EdgeInsets.all(10),
                child: Column(
                  children: [
                    ClipRRect(
                      borderRadius: BorderRadius.circular(14),
                      child: AspectRatio(
                        aspectRatio: 1.25,
                        child: image != null ? NetImage(image, icon: icon) : ColoredBox(
                          color: skin.chip,
                          child: Icon(icon, size: 36, color: skin.contrast ? Xp.lime : Xp.limeDeep),
                        ),
                      ),
                    ),
                    const SizedBox(height: 8),
                    Text(
                      name,
                      textAlign: TextAlign.center,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 16,
                        fontWeight: on ? FontWeight.w800 : FontWeight.w600,
                        color: on ? Xp.ink : skin.ink,
                        height: 1.15,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          );
        },
      ),
    );
  }
}

class _ItemGrid extends ConsumerWidget {
  const _ItemGrid({super.key, required this.title, required this.items, required this.portrait, this.blurb});

  final String title;
  final String? blurb;
  final List<MenuItem> items;
  final bool portrait;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final skin = XpSkin.of(context);
    return CustomScrollView(
      slivers: [
        SliverPadding(
          padding: const EdgeInsets.fromLTRB(24, 22, 24, 8),
          sliver: SliverToBoxAdapter(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: Theme.of(context).textTheme.headlineLarge),
                if (blurb != null) ...[
                  const SizedBox(height: 6),
                  Text(blurb!, style: Theme.of(context).textTheme.bodyLarge?.copyWith(color: skin.muted)),
                ],
              ],
            ),
          ),
        ),
        SliverPadding(
          padding: const EdgeInsets.fromLTRB(24, 12, 24, 28),
          sliver: SliverGrid(
            gridDelegate: SliverGridDelegateWithMaxCrossAxisExtent(
              maxCrossAxisExtent: portrait ? 320 : 290,
              mainAxisSpacing: 18,
              crossAxisSpacing: 18,
              childAspectRatio: .72,
            ),
            delegate: SliverChildBuilderDelegate(
              (context, i) => ItemCard(item: items[i]),
              childCount: items.length,
            ),
          ),
        ),
      ],
    );
  }
}

class ItemCard extends ConsumerWidget {
  const ItemCard({super.key, required this.item});

  final MenuItem item;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = ref.watch(orderFlowProvider.select((f) => f.s));
    final inBasket = ref.watch(orderFlowProvider.select((f) => f.basket.qtyOf(item.id)));
    final skin = XpSkin.of(context);
    return Material(
      color: skin.card,
      clipBehavior: Clip.antiAlias,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(Xp.radius),
        side: BorderSide(color: inBasket > 0 ? Xp.lime : skin.line, width: inBasket > 0 ? 3 : 1),
      ),
      child: InkWell(
        onTap: item.available ? () => openItem(context, ref, item) : null,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            AspectRatio(
              aspectRatio: 4 / 3,
              child: Stack(
                fit: StackFit.expand,
                children: [
                  NetImage(item.imageUrl),
                  if (item.popular)
                    Positioned(left: 10, top: 10, child: Pill(s('popular'), color: Xp.lime, icon: Icons.star_rounded)),
                  if (inBasket > 0)
                    Positioned(
                      right: 10,
                      top: 10,
                      child: Container(
                        width: 42,
                        height: 42,
                        alignment: Alignment.center,
                        decoration: const BoxDecoration(color: Xp.ink, shape: BoxShape.circle),
                        child: Text('$inBasket',
                            style: const TextStyle(color: Xp.lime, fontWeight: FontWeight.w800, fontSize: 18)),
                      ),
                    ),
                  if (!item.available)
                    ColoredBox(
                      color: skin.card.withValues(alpha: .72),
                      child: Center(child: Pill(s('sold_out'), color: Xp.ink, textColor: Colors.white)),
                    ),
                ],
              ),
            ),
            Expanded(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 12, 12, 12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(item.name,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700)),
                    if (item.diet != null) ...[
                      const SizedBox(height: 6),
                      Pill(item.diet!.toUpperCase()),
                    ],
                    const Spacer(),
                    Row(
                      children: [
                        Text(money(item.priceMinor),
                            style: Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800)),
                        const Spacer(),
                        if (item.available)
                          Container(
                            width: 48,
                            height: 48,
                            decoration: const BoxDecoration(color: Xp.lime, shape: BoxShape.circle),
                            child: const Icon(Icons.add_rounded, size: 30, color: Xp.ink),
                          ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Open a dish: its picture, what is in it, its questions, how many.
///
/// Every dish opens, even one with nothing to ask -- it is where the allergens
/// are, and a customer with an allergy should never have to guess that a
/// different button leads to them.
Future<void> openItem(BuildContext context, WidgetRef ref, MenuItem item) async {
  final messenger = ScaffoldMessenger.of(context);
  final s = ref.read(orderFlowProvider).s;
  final added = await showModalBottomSheet<BasketLine>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    backgroundColor: Colors.transparent,
    constraints: BoxConstraints(
      maxWidth: 920,
      maxHeight: MediaQuery.sizeOf(context).height * .92,
    ),
    builder: (_) => ItemSheet(item: item),
  );
  if (added == null) return;
  ref.read(orderFlowProvider.notifier).add(added);
  messenger
    ..hideCurrentSnackBar()
    ..showSnackBar(
      SnackBar(
        behavior: SnackBarBehavior.floating,
        backgroundColor: Xp.ink,
        duration: const Duration(milliseconds: 1600),
        width: 520,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
        content: Row(children: [
          const Icon(Icons.check_circle_rounded, color: Xp.lime, size: 30),
          const SizedBox(width: 12),
          Expanded(
            child: Text('${added.qty} x ${added.item.name}',
                style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700, fontSize: 18)),
          ),
          Text(money(added.totalMinor), style: const TextStyle(color: Xp.lime, fontWeight: FontWeight.w800, fontSize: 18)),
        ]),
        action: SnackBarAction(label: s('review_order'), textColor: Xp.lime,
            onPressed: () => ref.read(orderFlowProvider.notifier).openBasket()),
      ),
    );
}

class ItemSheet extends ConsumerStatefulWidget {
  const ItemSheet({super.key, required this.item});

  final MenuItem item;

  @override
  ConsumerState<ItemSheet> createState() => _ItemSheetState();
}

class _ItemSheetState extends ConsumerState<ItemSheet> {
  final Map<int, Set<int>> _chosen = {};
  int _qty = 1;

  List<AddOnOption> get _options => [
    for (final g in widget.item.addOns)
      for (final o in g.options)
        if (_chosen[g.id]?.contains(o.pluId) ?? false) o,
  ];

  bool get _valid => widget.item.addOns.every((g) => (_chosen[g.id]?.length ?? 0) >= g.min);

  void _toggle(AddOnGroup g, AddOnOption o) {
    final set = _chosen.putIfAbsent(g.id, () => <int>{});
    setState(() {
      if (set.contains(o.pluId)) {
        set.remove(o.pluId);
      } else if (g.single) {
        set
          ..clear()
          ..add(o.pluId);
      } else if (set.length < g.max) {
        set.add(o.pluId);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final s = ref.watch(orderFlowProvider.select((f) => f.s));
    final skin = XpSkin.of(context);
    final text = Theme.of(context).textTheme;
    final item = widget.item;
    final unit = item.priceMinor + _options.fold<int>(0, (sum, o) => sum + o.priceMinor);
    final allergens = {...item.allergens, for (final o in _options) ...o.allergens}.toList();

    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: skin.card,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(32)),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Flexible(
            child: SingleChildScrollView(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Stack(
                    children: [
                      if (item.imageUrl == null)
                        const SizedBox(height: 132, child: NetImage(null))
                      else
                        AspectRatio(aspectRatio: 16 / 8, child: NetImage(item.imageUrl)),
                      Positioned(
                        right: 14,
                        top: 14,
                        child: Material(
                          color: Colors.white,
                          shape: const CircleBorder(),
                          child: IconButton(
                            iconSize: 32,
                            tooltip: s('back'),
                            icon: const Icon(Icons.close_rounded, color: Xp.ink),
                            onPressed: () => Navigator.of(context).pop(),
                          ),
                        ),
                      ),
                    ],
                  ),
                  Padding(
                    padding: const EdgeInsets.fromLTRB(28, 22, 28, 8),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Expanded(child: Text(item.name, style: text.headlineMedium)),
                            const SizedBox(width: 12),
                            Text(money(item.priceMinor), style: text.headlineSmall),
                          ],
                        ),
                        if (item.description != null) ...[
                          const SizedBox(height: 10),
                          Text(item.description!, style: text.bodyLarge?.copyWith(color: skin.inkSoft)),
                        ],
                        const SizedBox(height: 18),
                        _AllergenBlock(codes: allergens, declared: item.allergensDeclared, s: s),
                        for (final g in item.addOns) ...[
                          const SizedBox(height: 22),
                          _GroupHeader(group: g, s: s, count: _chosen[g.id]?.length ?? 0),
                          const SizedBox(height: 10),
                          Wrap(
                            spacing: 12,
                            runSpacing: 12,
                            children: [
                              for (final o in g.options)
                                _OptionTile(
                                  option: o,
                                  selected: _chosen[g.id]?.contains(o.pluId) ?? false,
                                  onTap: () => _toggle(g, o),
                                ),
                            ],
                          ),
                        ],
                        const SizedBox(height: 12),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
          Container(
            padding: const EdgeInsets.fromLTRB(24, 16, 24, 20),
            decoration: BoxDecoration(border: Border(top: BorderSide(color: skin.line))),
            child: Row(
              children: [
                QtyStepper(qty: _qty, min: 1, max: 20, onChanged: (q) => setState(() => _qty = q)),
                const SizedBox(width: 18),
                Expanded(
                  child: FilledButton(
                    onPressed: _valid
                        ? () => Navigator.of(context).pop(BasketLine(item: item, addOns: _options, qty: _qty))
                        : null,
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Flexible(child: Text(s('add_to_order'), overflow: TextOverflow.ellipsis)),
                        const SizedBox(width: 12),
                        Text(money(unit * _qty)),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _AllergenBlock extends StatelessWidget {
  const _AllergenBlock({required this.codes, required this.declared, required this.s});

  final List<String> codes;
  final bool declared;
  final S s;

  @override
  Widget build(BuildContext context) {
    final skin = XpSkin.of(context);
    if (codes.isEmpty) {
      return Row(children: [
        Icon(declared ? Icons.verified_outlined : Icons.info_outline_rounded, color: skin.muted),
        const SizedBox(width: 8),
        Expanded(
          child: Text(declared ? s('no_allergens') : s('allergens_unknown'),
              style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600, color: skin.inkSoft)),
        ),
      ]);
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(s('contains'), style: TextStyle(fontSize: 15, fontWeight: FontWeight.w800, color: skin.inkSoft)),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final c in codes)
              Pill(s.allergen(c), color: const Color(0xFFFFF1CC), textColor: const Color(0xFF6B4A00),
                  icon: Icons.warning_amber_rounded),
          ],
        ),
      ],
    );
  }
}

class _GroupHeader extends StatelessWidget {
  const _GroupHeader({required this.group, required this.s, required this.count});

  final AddOnGroup group;
  final S s;
  final int count;

  @override
  Widget build(BuildContext context) {
    final skin = XpSkin.of(context);
    final rule = group.single ? s('choose_one') : '${s('choose_up_to')} ${group.max}';
    final needed = group.min > 0 && count < group.min;
    return Row(
      children: [
        Expanded(child: Text(group.name, style: Theme.of(context).textTheme.titleLarge)),
        Text(rule, style: TextStyle(color: skin.muted, fontWeight: FontWeight.w600)),
        const SizedBox(width: 10),
        Pill(
          group.min > 0 ? s('required') : s('optional'),
          color: needed ? Xp.amber : skin.chip,
        ),
      ],
    );
  }
}

class _OptionTile extends StatelessWidget {
  const _OptionTile({required this.option, required this.selected, required this.onTap});

  final AddOnOption option;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final skin = XpSkin.of(context);
    return Material(
      color: selected ? Xp.lime : skin.card,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: BorderSide(color: selected ? Xp.lime : skin.line, width: 2),
      ),
      child: InkWell(
        borderRadius: BorderRadius.circular(16),
        onTap: onTap,
        child: Container(
          constraints: const BoxConstraints(minHeight: 64, minWidth: 180),
          padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 12),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(selected ? Icons.check_circle_rounded : Icons.circle_outlined,
                  color: selected ? Xp.ink : skin.muted, size: 26),
              const SizedBox(width: 10),
              Text(option.name,
                  style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700, color: selected ? Xp.ink : skin.ink)),
              if (option.priceMinor > 0) ...[
                const SizedBox(width: 10),
                Text('+${money(option.priceMinor)}',
                    style: TextStyle(fontWeight: FontWeight.w700, color: selected ? Xp.ink : skin.muted)),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// Portrait: the basket, along the bottom, where a thumb already is.
class _BagBar extends ConsumerWidget {
  const _BagBar();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final basket = ref.watch(orderFlowProvider.select((f) => f.basket));
    final s = ref.watch(orderFlowProvider.select((f) => f.s));
    final skin = XpSkin.of(context);
    return Container(
      padding: const EdgeInsets.fromLTRB(24, 16, 24, 18),
      decoration: BoxDecoration(
        color: skin.card,
        boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: .08), blurRadius: 24, offset: const Offset(0, -6))],
      ),
      child: Row(
        children: [
          _BagIcon(count: basket.count),
          const SizedBox(width: 16),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text('${basket.count} ${basket.count == 1 ? s('item') : s('items')}',
                    style: TextStyle(color: skin.muted, fontWeight: FontWeight.w600, fontSize: 16)),
                AnimatedSwitcher(
                  duration: const Duration(milliseconds: 200),
                  child: Text(money(basket.totalMinor),
                      key: ValueKey(basket.totalMinor),
                      style: Theme.of(context).textTheme.headlineMedium?.copyWith(fontWeight: FontWeight.w800)),
                ),
              ],
            ),
          ),
          FilledButton.icon(
            onPressed: basket.isEmpty ? null : () => ref.read(orderFlowProvider.notifier).openBasket(),
            icon: const Icon(Icons.arrow_forward_rounded, size: 28),
            label: Text(s('review_order')),
          ),
        ],
      ),
    );
  }
}

class _BagIcon extends StatelessWidget {
  const _BagIcon({required this.count});
  final int count;

  @override
  Widget build(BuildContext context) {
    final skin = XpSkin.of(context);
    return SizedBox(
      width: 64,
      height: 64,
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          Container(
            width: 64,
            height: 64,
            decoration: BoxDecoration(color: skin.chip, borderRadius: BorderRadius.circular(18)),
            child: Icon(Icons.shopping_bag_outlined, size: 34, color: skin.ink),
          ),
          if (count > 0)
            Positioned(
              right: -6,
              top: -6,
              child: TweenAnimationBuilder<double>(
                key: ValueKey(count),
                tween: Tween(begin: 1.4, end: 1),
                duration: const Duration(milliseconds: 280),
                curve: Curves.easeOutBack,
                builder: (context, v, child) => Transform.scale(scale: v, child: child),
                child: Container(
                  constraints: const BoxConstraints(minWidth: 30),
                  height: 30,
                  padding: const EdgeInsets.symmetric(horizontal: 6),
                  alignment: Alignment.center,
                  decoration: BoxDecoration(color: Xp.lime, borderRadius: BorderRadius.circular(15)),
                  child: Text('$count', style: const TextStyle(fontWeight: FontWeight.w800, color: Xp.ink)),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// Landscape: the basket as a panel, always in view.
class _BasketPanel extends ConsumerWidget {
  const _BasketPanel();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final basket = ref.watch(orderFlowProvider.select((f) => f.basket));
    final s = ref.watch(orderFlowProvider.select((f) => f.s));
    final skin = XpSkin.of(context);
    final n = ref.read(orderFlowProvider.notifier);
    return Container(
      decoration: BoxDecoration(color: skin.card, border: Border(left: BorderSide(color: skin.line))),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(22, 20, 22, 8),
            child: Row(children: [
              _BagIcon(count: basket.count),
              const SizedBox(width: 14),
              Text(s('your_order'), style: Theme.of(context).textTheme.headlineSmall),
            ]),
          ),
          Expanded(
            child: basket.isEmpty
                ? Center(
                    child: Padding(
                      padding: const EdgeInsets.all(28),
                      child: Text(s('basket_empty_sub'),
                          textAlign: TextAlign.center, style: TextStyle(color: skin.muted, fontSize: 17)),
                    ),
                  )
                : ListView.separated(
                    padding: const EdgeInsets.fromLTRB(18, 8, 18, 8),
                    itemCount: basket.lines.length,
                    separatorBuilder: (_, _) => Divider(color: skin.line),
                    itemBuilder: (context, i) {
                      final l = basket.lines[i];
                      return Row(
                        children: [
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(l.item.name,
                                    maxLines: 2,
                                    overflow: TextOverflow.ellipsis,
                                    style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
                                if (l.addOns.isNotEmpty)
                                  Text(l.addOns.map((a) => a.name).join(', '),
                                      maxLines: 2,
                                      overflow: TextOverflow.ellipsis,
                                      style: TextStyle(color: skin.muted, fontSize: 14)),
                                Text(money(l.totalMinor), style: const TextStyle(fontWeight: FontWeight.w800)),
                              ],
                            ),
                          ),
                          QtyStepper(qty: l.qty, size: 44, onChanged: (q) => n.setQty(l.key, q)),
                        ],
                      );
                    },
                  ),
          ),
          Container(
            padding: const EdgeInsets.fromLTRB(22, 14, 22, 20),
            decoration: BoxDecoration(border: Border(top: BorderSide(color: skin.line))),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(children: [
                  Text(s('total'), style: Theme.of(context).textTheme.titleLarge),
                  const Spacer(),
                  Text(money(basket.totalMinor),
                      style: Theme.of(context).textTheme.headlineMedium?.copyWith(fontWeight: FontWeight.w800)),
                ]),
                const SizedBox(height: 12),
                FilledButton(
                  onPressed: basket.isEmpty ? null : n.openBasket,
                  child: Text(s('review_order')),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// The basket
// ---------------------------------------------------------------------------

class BasketPage extends ConsumerWidget {
  const BasketPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final flow = ref.watch(orderFlowProvider);
    final menu = ref.watch(kioskSessionProvider.select((st) => st.menu));
    final n = ref.read(orderFlowProvider.notifier);
    final s = flow.s;
    final skin = XpSkin.of(context);
    final basket = flow.basket;

    final suggestions = flow.upsellSeen
        ? const <MenuItem>[]
        : [
            for (final id in menu.upsell)
              if (menu.itemById(id) case final item? when item.available && !basket.containsItem(id)) item,
          ].take(4).toList();

    return FlowScaffold(
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 980),
          child: ListView(
            padding: const EdgeInsets.fromLTRB(28, 24, 28, 24),
            children: [
              Row(children: [
                Expanded(child: Text(s('your_order'), style: Theme.of(context).textTheme.displayMedium)),
                TextButton.icon(
                  onPressed: n.backToMenu,
                  icon: const Icon(Icons.add_rounded, size: 28),
                  label: Text(s('menu')),
                ),
              ]),
              const SizedBox(height: 18),
              if (basket.isEmpty)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 48),
                  child: Column(children: [
                    Icon(Icons.shopping_bag_outlined, size: 72, color: skin.muted),
                    const SizedBox(height: 14),
                    Text(s('basket_empty'), style: Theme.of(context).textTheme.headlineSmall),
                    const SizedBox(height: 6),
                    Text(s('basket_empty_sub'), style: TextStyle(color: skin.muted, fontSize: 17)),
                  ]),
                ),
              for (final line in basket.lines) _BasketLineTile(line: line, s: s),
              if (suggestions.isNotEmpty) ...[
                const SizedBox(height: 26),
                _Upsell(items: suggestions, s: s),
              ],
            ],
          ),
        ),
      ),
      footer: _PayFooter(flow: flow),
    );
  }
}

class _BasketLineTile extends ConsumerWidget {
  const _BasketLineTile({required this.line, required this.s});

  final BasketLine line;
  final S s;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final skin = XpSkin.of(context);
    final text = Theme.of(context).textTheme;

    final thumb = ClipRRect(
      borderRadius: BorderRadius.circular(16),
      child: SizedBox(width: 96, height: 96, child: NetImage(line.item.imageUrl)),
    );
    final words = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(line.item.name, style: text.titleLarge),
        if (line.addOns.isNotEmpty) ...[
          const SizedBox(height: 4),
          Text(line.addOns.map((a) => a.name).join(', '), style: TextStyle(color: skin.inkSoft, fontSize: 16)),
        ],
        const SizedBox(height: 4),
        Text('${money(line.unitMinor)} ${s('each')}', style: TextStyle(color: skin.muted, fontSize: 15)),
      ],
    );
    final stepper = QtyStepper(
      qty: line.qty,
      onChanged: (q) => ref.read(orderFlowProvider.notifier).setQty(line.key, q),
    );
    final total = Text(
      money(line.totalMinor),
      textAlign: TextAlign.right,
      style: text.titleLarge?.copyWith(fontWeight: FontWeight.w800),
    );

    return Container(
      margin: const EdgeInsets.only(bottom: 14),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: skin.card,
        borderRadius: BorderRadius.circular(Xp.radius),
        border: Border.all(color: skin.line),
      ),
      child: LayoutBuilder(
        builder: (context, box) {
          // Narrow: the dish's name gets a row of its own. Beside the stepper
          // and the total, on the first live run at 540 x 960, it was squeezed
          // into a column of single letters.
          if (box.maxWidth < 600) {
            return Column(
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [thumb, const SizedBox(width: 16), Expanded(child: words)],
                ),
                const SizedBox(height: 12),
                Row(children: [stepper, const Spacer(), total]),
              ],
            );
          }
          return Row(
            children: [
              thumb,
              const SizedBox(width: 16),
              Expanded(child: words),
              stepper,
              const SizedBox(width: 12),
              SizedBox(width: 110, child: total),
            ],
          );
        },
      ),
    );
  }
}

class _Upsell extends ConsumerWidget {
  const _Upsell({required this.items, required this.s});

  final List<MenuItem> items;
  final S s;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final skin = XpSkin.of(context);
    final n = ref.read(orderFlowProvider.notifier);
    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(color: skin.chip, borderRadius: BorderRadius.circular(Xp.radius)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(children: [
            const Icon(Icons.auto_awesome_rounded, color: Xp.limeDeep, size: 30),
            const SizedBox(width: 10),
            Expanded(child: Text(s('may_we_suggest'), style: Theme.of(context).textTheme.headlineSmall)),
            TextButton(onPressed: n.markUpsellSeen, child: Text(s('not_today'))),
          ]),
          const SizedBox(height: 12),
          SizedBox(
            height: 336,
            child: ListView.separated(
              scrollDirection: Axis.horizontal,
              itemCount: items.length,
              separatorBuilder: (_, _) => const SizedBox(width: 14),
              itemBuilder: (context, i) => SizedBox(width: 240, child: ItemCard(item: items[i])),
            ),
          ),
        ],
      ),
    );
  }
}

class _PayFooter extends ConsumerWidget {
  const _PayFooter({required this.flow});
  final FlowState flow;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = flow.s;
    final skin = XpSkin.of(context);
    final n = ref.read(orderFlowProvider.notifier);
    return Container(
      padding: const EdgeInsets.fromLTRB(28, 16, 28, 20),
      decoration: BoxDecoration(
        color: skin.card,
        boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: .08), blurRadius: 24, offset: const Offset(0, -6))],
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (flow.error != null)
            Container(
              width: double.infinity,
              margin: const EdgeInsets.only(bottom: 12),
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(color: Xp.danger.withValues(alpha: .1), borderRadius: BorderRadius.circular(14)),
              child: Text(flow.error!, style: const TextStyle(color: Xp.danger, fontWeight: FontWeight.w700, fontSize: 16)),
            ),
          Row(children: [
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(s('total'), style: Theme.of(context).textTheme.titleLarge),
                Text(s('includes_vat'), style: TextStyle(color: skin.muted, fontSize: 14)),
              ],
            ),
            const Spacer(),
            Text(money(flow.basket.totalMinor),
                style: Theme.of(context).textTheme.displayMedium?.copyWith(fontSize: 44)),
          ]),
          const SizedBox(height: 14),
          Row(children: [
            OutlinedButton(onPressed: n.backToMenu, child: Text(s('back'))),
            const SizedBox(width: 14),
            Expanded(
              child: FilledButton(
                onPressed: flow.basket.isEmpty || flow.busy
                    ? null
                    : () {
                        n.markUpsellSeen();
                        n.checkout();
                      },
                child: flow.busy
                    ? const SizedBox(width: 28, height: 28, child: CircularProgressIndicator(strokeWidth: 3))
                    : Text('${s('pay_now')}  ${money(flow.basket.totalMinor)}'),
              ),
            ),
          ]),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// A name, and how to pay
// ---------------------------------------------------------------------------

class NamePage extends ConsumerWidget {
  const NamePage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final flow = ref.watch(orderFlowProvider);
    final n = ref.read(orderFlowProvider.notifier);
    final s = flow.s;
    final skin = XpSkin.of(context);

    void type(String k) {
      if (flow.name.length >= 20) return;
      final next = flow.name + k;
      // Capital at the start of each word, because it is read out and printed.
      final pretty = next.split(' ').map((w) => w.isEmpty ? w : w[0].toUpperCase() + w.substring(1).toLowerCase()).join(' ');
      n.setName(pretty.trimLeft());
    }

    return FlowScaffold(
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(28),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 900),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(s('name_title'), textAlign: TextAlign.center, style: Theme.of(context).textTheme.displayMedium),
                const SizedBox(height: 26),
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.symmetric(horizontal: 26, vertical: 20),
                  decoration: BoxDecoration(
                    color: skin.card,
                    borderRadius: BorderRadius.circular(Xp.radius),
                    border: Border.all(color: Xp.lime, width: 3),
                  ),
                  child: Text(
                    flow.name.isEmpty ? s('name_hint') : flow.name,
                    style: TextStyle(
                      fontSize: 40,
                      fontWeight: FontWeight.w800,
                      color: flow.name.isEmpty ? skin.muted : skin.ink,
                    ),
                  ),
                ),
                const SizedBox(height: 22),
                LetterBoard(
                  onKey: type,
                  onBack: () => n.setName(flow.name.isEmpty ? '' : flow.name.substring(0, flow.name.length - 1)),
                ),
                if (flow.error != null) ...[
                  const SizedBox(height: 12),
                  Text(flow.error!, style: const TextStyle(color: Xp.danger, fontWeight: FontWeight.w700)),
                ],
                const SizedBox(height: 22),
                Row(children: [
                  OutlinedButton(onPressed: n.openBasket, child: Text(s('back'))),
                  const SizedBox(width: 14),
                  Expanded(
                    child: FilledButton(
                      onPressed: flow.name.trim().isEmpty || flow.busy ? null : n.choosePayment,
                      child: Text(s('continue')),
                    ),
                  ),
                ]),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class PayMethodPage extends ConsumerWidget {
  const PayMethodPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final flow = ref.watch(orderFlowProvider);
    final n = ref.read(orderFlowProvider.notifier);
    final s = flow.s;
    return FlowScaffold(
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(28),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(s('how_pay'), textAlign: TextAlign.center, style: Theme.of(context).textTheme.displayMedium),
              const SizedBox(height: 12),
              Text(money(flow.basket.totalMinor), style: Theme.of(context).textTheme.headlineLarge),
              const SizedBox(height: 36),
              if (flow.busy)
                const Padding(padding: EdgeInsets.all(40), child: CircularProgressIndicator())
              else
                Flex(
                  direction: MediaQuery.sizeOf(context).width < 720 ? Axis.vertical : Axis.horizontal,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    _BigChoice(
                      icon: Icons.contactless_rounded,
                      label: s('pay_card'),
                      sub: s('pay_card_sub'),
                      onTap: () => n.place('card'),
                    ),
                    const SizedBox(width: 28, height: 18),
                    _BigChoice(
                      icon: Icons.point_of_sale_rounded,
                      label: s('pay_counter'),
                      sub: s('pay_counter_sub'),
                      onTap: () => n.place('counter'),
                    ),
                  ],
                ),
              if (flow.error != null) ...[
                const SizedBox(height: 18),
                Text(flow.error!, style: const TextStyle(color: Xp.danger, fontWeight: FontWeight.w700, fontSize: 17)),
              ],
              const SizedBox(height: 28),
              OutlinedButton(onPressed: n.openBasket, child: Text(s('back'))),
            ],
          ),
        ),
      ),
    );
  }
}
