/// A product's photo on its key, as design A draws it: a strip across the top
/// of the button, kept on the device after the first sight (cached), with the
/// category's colour behind it while it loads. Nothing at all when the venue
/// turns photos off (back office) or the product has none.
library;

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config/constants.dart' show apiBase;
import '../data/models.dart';
import '../data/session.dart';

String photoUrl(String url) => url.startsWith('http') ? url : '$apiBase${url.startsWith('/') ? '' : '/'}$url';

class ProductPhoto extends ConsumerWidget {
  const ProductPhoto({super.key, required this.product, required this.tint, this.height = 56, this.radius = 0});
  final Product product;
  final Color tint;
  final double height;
  final double radius;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final on = ref.watch(tapProvider.select((s) => s.config.go.productImages));
    if (!on || product.imageUrl.isEmpty) return const SizedBox.shrink();
    return ClipRRect(
      borderRadius: BorderRadius.circular(radius),
      child: SizedBox(
        height: height,
        child: CachedNetworkImage(
          imageUrl: photoUrl(product.imageUrl),
          fit: BoxFit.cover,
          fadeInDuration: const Duration(milliseconds: 250),
          memCacheHeight: (height * 3).round(),
          placeholder: (_, _) => ColoredBox(color: tint.withValues(alpha: 0.3)),
          errorWidget: (_, _, _) => ColoredBox(color: tint.withValues(alpha: 0.3)),
        ),
      ),
    );
  }
}

/// Fetches every product photo into the device's cache after the menu loads,
/// so the first tap on a category shows its photos at once.
Future<void> warmPhotos(BuildContext context, List<Product> products) async {
  for (final p in products) {
    if (p.imageUrl.isEmpty || !context.mounted) continue;
    try {
      await precacheImage(CachedNetworkImageProvider(photoUrl(p.imageUrl)), context);
    } catch (_) {}
  }
}
