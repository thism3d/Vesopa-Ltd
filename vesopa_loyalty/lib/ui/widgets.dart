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
    say(done);
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
