import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/api.dart';
import '../data/brand.dart';
import '../data/session.dart';
import '../platform/passkey.dart';

/// The venue's logo, or its initial on its colour.
class VenueLogo extends StatelessWidget {
  const VenueLogo({super.key, required this.brand, this.size = 40});

  final Brand brand;
  final double size;

  @override
  Widget build(BuildContext context) {
    final fallback = Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(color: brand.primary, borderRadius: BorderRadius.circular(size * 0.22)),
      child: Text(
        brand.name.isEmpty ? '?' : brand.name.characters.first.toUpperCase(),
        style: TextStyle(color: Brand.onColour(brand.primary), fontSize: size * 0.45, fontWeight: FontWeight.w800),
      ),
    );
    final url = brand.logo ?? brand.icon;
    if (url == null) return Center(child: fallback);
    return Center(
      child: ClipRRect(
        borderRadius: BorderRadius.circular(size * 0.22),
        child: Image.network(url, width: size, height: size, fit: BoxFit.contain, errorBuilder: (_, _, _) => fallback),
      ),
    );
  }
}

/// A titled group of settings rows.
class SettingsCard extends StatelessWidget {
  const SettingsCard({super.key, required this.title, required this.children});

  final String title;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      elevation: 0,
      color: theme.colorScheme.surfaceContainerHighest.withValues(alpha: 0.45),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800)),
            const SizedBox(height: 4),
            ...children,
          ],
        ),
      ),
    );
  }
}

/// Run something that talks to the server, and say what happened.
///
/// ONE PLACE FOR THIS because every action on the account page has the same
/// three endings — it worked, the server said no, or the network is down —
/// and writing that out eleven times is eleven chances for one of them to
/// quietly do nothing. A button that appears to do nothing is the single
/// most common way a settings page gets reported as broken.
///
/// Answers whether it succeeded, so a dialog can decide to close itself.
Future<bool> runWithFeedback(
  BuildContext context,
  WidgetRef ref,
  Future<void> Function() job, {
  required String done,
  String Function()? doneText,
}) async {
  final messenger = ScaffoldMessenger.maybeOf(context);
  void say(String text, {bool bad = false}) {
    // Captured before the await: the context may be gone by the time this
    // runs, and a message nobody sees is the failure this function exists
    // to prevent.
    messenger?.showSnackBar(SnackBar(
      content: Text(text),
      behavior: SnackBarBehavior.floating,
      backgroundColor: bad ? Theme.of(context).colorScheme.error : null,
    ));
  }

  try {
    await job();
    // [doneText] when what to say depends on the answer, read after the job.
    say(doneText?.call() ?? done);
    return true;
  } on PasskeyCancelled {
    // Somebody changed their mind. Not a failure, and nothing to report.
    return false;
  } on ApiError catch (e) {
    say(e.message, bad: true);
    return false;
  } catch (_) {
    say('That did not work. Please try again.', bad: true);
    return false;
  }
}

class PoweredBy extends StatelessWidget {
  const PoweredBy({super.key});

  @override
  Widget build(BuildContext context) => Text(
    'Powered by Vesopa',
    textAlign: TextAlign.center,
    style: Theme.of(context).textTheme.bodySmall?.copyWith(color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.55)),
  );
}

/// A failed load, said plainly, with a way to try again. A signed-out answer
/// signs the app out.
class LoadFailed extends ConsumerWidget {
  const LoadFailed({super.key, required this.error, required this.onRetry});

  final Object error;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (error is ApiError && (error as ApiError).signedOut) {
      WidgetsBinding.instance.addPostFrameCallback((_) => ref.read(sessionProvider.notifier).clear());
    }
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(error is ApiError ? (error as ApiError).message : 'Something went wrong.', textAlign: TextAlign.center),
            const SizedBox(height: 12),
            OutlinedButton(onPressed: onRetry, child: const Text('Try again')),
          ],
        ),
      ),
    );
  }
}

/// A '#rrggbb' colour from the back office, or null when it will not read.
Color? hexColour(String? value) {
  final hex = (value ?? '').replaceFirst('#', '');
  if (hex.length != 6) return null;
  final v = int.tryParse(hex, radix: 16);
  return v == null ? null : Color(0xff000000 | v);
}

/// Something arriving: it fades in and rises a little, once, after [delay].
///
/// For the first look at a page -- the card, then what is under it -- so the
/// page assembles rather than blinking in whole. Plays once per element; a
/// rebuild (a refresh, a new balance) never replays it. Off where the device
/// asks for less motion.
class Entrance extends StatefulWidget {
  const Entrance({super.key, required this.child, this.delay = Duration.zero, this.rise = 18});

  final Widget child;
  final Duration delay;
  final double rise;

  @override
  State<Entrance> createState() => _EntranceState();
}

class _EntranceState extends State<Entrance> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 520));
  late final Animation<double> _t = CurvedAnimation(parent: _c, curve: Curves.easeOutCubic);

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_c.status != AnimationStatus.dismissed || _c.isAnimating) return;
    if (MediaQuery.maybeOf(context)?.disableAnimations ?? false) {
      _c.value = 1;
    } else {
      Future.delayed(widget.delay, () {
        if (mounted) _c.forward();
      });
    }
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: _t,
    child: widget.child,
    builder: (context, child) => Opacity(
      opacity: _t.value,
      child: Transform.translate(offset: Offset(0, widget.rise * (1 - _t.value)), child: child),
    ),
  );
}

/// An [IndexedStack] whose newly chosen page fades through rather than
/// snapping in. Every page stays alive underneath, exactly as before, so a
/// half-scrolled list or a half-typed field is still there on the way back.
class FadeIndexedStack extends StatefulWidget {
  const FadeIndexedStack({super.key, required this.index, required this.children});

  final int index;
  final List<Widget> children;

  @override
  State<FadeIndexedStack> createState() => _FadeIndexedStackState();
}

class _FadeIndexedStackState extends State<FadeIndexedStack> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 260), value: 1);

  @override
  void didUpdateWidget(FadeIndexedStack old) {
    super.didUpdateWidget(old);
    if (old.index != widget.index && !(MediaQuery.maybeOf(context)?.disableAnimations ?? false)) {
      _c.forward(from: 0);
    }
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: _c,
    builder: (context, child) {
      final t = Curves.easeOutCubic.transform(_c.value);
      return Opacity(
        opacity: t,
        child: Transform.translate(offset: Offset(0, 10 * (1 - t)), child: child),
      );
    },
    child: IndexedStack(index: widget.index, children: widget.children),
  );
}
