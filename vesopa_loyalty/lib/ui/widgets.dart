import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/api.dart';
import '../data/brand.dart';
import '../data/session.dart';

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
