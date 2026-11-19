/// The accent this device wears: Vesopa lime unless someone picks another,
/// once, on the "Pick your colour" page the first time Go opens (before the
/// PIN), or any time in Settings, Appearance. Kept with the device's other
/// settings, so it comes back after a reinstall (terminal_sync.dart).
///
/// On the web demo the share page can choose it first: it writes the same
/// keys into the browser's storage (flutter.go_accent, flutter.go_accent_asked),
/// so the app opens in the colour picked on the page and does not ask again.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'theme.dart';
import 'tv.dart';

class Accent extends Notifier<GoPalette> {
  static const _key = 'go_accent';

  @override
  GoPalette build() {
    SharedPreferences.getInstance().then((p) {
      final saved = GoPalette.byId(p.getString(_key));
      if (saved != state) _apply(saved);
    }).catchError((Object _) {});
    return GoPalette.lime;
  }

  Future<void> set(GoPalette palette) async {
    _apply(palette);
    try {
      await (await SharedPreferences.getInstance()).setString(_key, palette.id);
    } catch (_) {}
  }

  void _apply(GoPalette palette) {
    Tp.palette = palette;
    state = palette;
    // Most screens read Tp.lime directly rather than through the theme, so
    // after the frame that swaps the theme, rebuild every widget once.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final root = WidgetsBinding.instance.rootElement;
      if (root == null) return;
      void mark(Element e) {
        e.markNeedsBuild();
        e.visitChildren(mark);
      }
      mark(root);
    });
  }
}

final accentProvider = NotifierProvider<Accent, GoPalette>(Accent.new);

/// Whether this device has been asked for its colour yet: null while storage
/// loads, then true once a colour was picked or the page skipped (or a colour
/// was already saved, as on a device that chose one in Settings before the
/// page existed).
class AccentAsked extends Notifier<bool?> {
  static const _key = 'go_accent_asked';

  @override
  bool? build() {
    SharedPreferences.getInstance().then((p) {
      state = (p.getBool(_key) ?? false) || p.containsKey(Accent._key);
    }).catchError((Object _) {
      state = true;
    });
    return null;
  }

  Future<void> done() async {
    state = true;
    try {
      await (await SharedPreferences.getInstance()).setBool(_key, true);
    } catch (_) {}
  }
}

final accentAskedProvider = NotifierProvider<AccentAsked, bool?>(AccentAsked.new);

/// The colours as round swatches, the chosen one ringed and ticked, each
/// with a soft glow of its own colour (neon on black).
class AccentSwatches extends ConsumerWidget {
  const AccentSwatches({super.key, this.size = Tp.target, this.labels = false, this.spacing = 12, this.alignment = WrapAlignment.start});
  final WrapAlignment alignment;
  final double size;
  final bool labels;
  final double spacing;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final current = ref.watch(accentProvider);
    final muted = context.goMuted;
    return Wrap(spacing: spacing, runSpacing: spacing, alignment: alignment, children: [
      for (final p in GoPalette.all)
        _Swatch(
          key: ValueKey('accent-${p.id}'),
          palette: p,
          selected: p == current,
          size: size,
          labels: labels,
          muted: muted,
          // With a remote the chosen colour has the focus first, so OK and the
          // arrows start from it (owner, 2026-11-19: colours not working with
          // the remote).
          autofocus: p == current && GoDevice.remote.value,
          onPick: () {
            HapticFeedback.selectionClick();
            ref.read(accentProvider.notifier).set(p);
          },
        ),
    ]);
  }
}

/// The first time Go opens, before the PIN: welcome, and pick a colour. A tap
/// recolours the page at once; Continue keeps it, Skip keeps Vesopa lime.
/// Always dark, as the PIN pad after it.
class AccentWelcomePage extends ConsumerWidget {
  const AccentWelcomePage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final current = ref.watch(accentProvider);
    final t = Theme.of(context).textTheme;
    return Scaffold(
      body: Stack(children: [
        // The chosen colour's glow behind the page.
        Positioned(
          right: -160,
          top: -120,
          child: IgnorePointer(
            child: AnimatedContainer(
              duration: const Duration(milliseconds: 300),
              width: 420,
              height: 420,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                gradient: RadialGradient(colors: [current.colour.withValues(alpha: 0.22), current.colour.withValues(alpha: 0)]),
              ),
            ),
          ),
        ),
        SafeArea(
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 460),
              child: ListView(
                padding: const EdgeInsets.fromLTRB(24, 32, 24, 24),
                children: [
                  Align(
                    alignment: Alignment.centerLeft,
                    child: DecoratedBox(
                      decoration: BoxDecoration(
                        borderRadius: BorderRadius.circular(20),
                        boxShadow: [BoxShadow(color: current.colour.withValues(alpha: 0.5), blurRadius: 30, spreadRadius: -6)],
                      ),
                      child: const TapMark(size: 64),
                    ),
                  ),
                  const SizedBox(height: 24),
                  Text('Welcome to Vesopa Go.\nPick your colour.',
                      style: t.headlineMedium?.copyWith(fontWeight: FontWeight.w800, height: 1.15, letterSpacing: -0.5)),
                  const SizedBox(height: 8),
                  Text('It lights up the button to press next. You can change it later in Settings.',
                      style: t.bodyLarge?.copyWith(color: context.goMuted)),
                  const SizedBox(height: 28),
                  const AccentSwatches(size: 68, labels: true, spacing: 14, alignment: WrapAlignment.center),
                  const SizedBox(height: 32),
                  FilledButton(
                    key: const ValueKey('accent-continue'),
                    onPressed: () => ref.read(accentAskedProvider.notifier).done(),
                    child: Text('Continue with ${current.name}'),
                  ),
                  const SizedBox(height: 8),
                  TextButton(
                    key: const ValueKey('accent-skip'),
                    onPressed: () {
                      ref.read(accentProvider.notifier).set(GoPalette.lime);
                      ref.read(accentAskedProvider.notifier).done();
                    },
                    style: TextButton.styleFrom(foregroundColor: context.goMuted, minimumSize: const Size(64, 48)),
                    child: const Text('Skip: keep Vesopa Lime'),
                  ),
                ],
              ),
            ),
          ),
        ),
      ]),
    );
  }
}


/// One colour: a tap, a click or the remote's OK picks it. With the remote,
/// the one in focus grows and gets a thick white ring, so it is always clear
/// which colour OK will choose.
class _Swatch extends StatefulWidget {
  const _Swatch({
    super.key,
    required this.palette,
    required this.selected,
    required this.size,
    required this.labels,
    required this.muted,
    required this.autofocus,
    required this.onPick,
  });
  final GoPalette palette;
  final bool selected;
  final double size;
  final bool labels;
  final Color muted;
  final bool autofocus;
  final VoidCallback onPick;

  @override
  State<_Swatch> createState() => _SwatchState();
}

class _SwatchState extends State<_Swatch> {
  bool _focused = false;

  @override
  Widget build(BuildContext context) {
    final p = widget.palette;
    final size = widget.size;
    final ring = _focused ? Colors.white : (widget.selected ? context.goText : Colors.transparent);
    return Semantics(
      button: true,
      selected: widget.selected,
      label: p.name,
      excludeSemantics: true,
      child: FocusableActionDetector(
        autofocus: widget.autofocus,
        onShowFocusHighlight: (v) => setState(() => _focused = v),
        actions: {ActivateIntent: CallbackAction<ActivateIntent>(onInvoke: (_) => widget.onPick())},
        shortcuts: const {
          SingleActivator(LogicalKeyboardKey.select): ActivateIntent(),
          SingleActivator(LogicalKeyboardKey.enter): ActivateIntent(),
          SingleActivator(LogicalKeyboardKey.numpadEnter): ActivateIntent(),
          SingleActivator(LogicalKeyboardKey.gameButtonA): ActivateIntent(),
        },
        mouseCursor: SystemMouseCursors.click,
        child: GestureDetector(
          onTap: widget.onPick,
          child: AnimatedScale(
            scale: _focused ? 1.15 : 1,
            duration: const Duration(milliseconds: 140),
            child: SizedBox(
              width: size + 8,
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                AnimatedContainer(
                  duration: const Duration(milliseconds: 180),
                  width: size,
                  height: size,
                  padding: const EdgeInsets.all(4),
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    border: Border.all(color: ring, width: _focused ? 4 : 2.5),
                  ),
                  child: DecoratedBox(
                    decoration: BoxDecoration(
                      color: p.colour,
                      shape: BoxShape.circle,
                      boxShadow: context.goDark ? [BoxShadow(color: p.colour.withValues(alpha: 0.45), blurRadius: 16, spreadRadius: -2)] : null,
                    ),
                    child: widget.selected ? Icon(Icons.check_rounded, color: p.on, size: size * 0.46) : null,
                  ),
                ),
                if (widget.labels) ...[
                  const SizedBox(height: 6),
                  Text(
                    p.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      fontSize: 12,
                      color: widget.selected || _focused ? context.goText : widget.muted,
                      fontWeight: widget.selected || _focused ? FontWeight.w700 : FontWeight.w500,
                    ),
                  ),
                ],
              ]),
            ),
          ),
        ),
      ),
    );
  }
}
