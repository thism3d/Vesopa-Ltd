import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../data/session.dart';
import '../data/venue_style.dart';
import 'widgets.dart';

/// The venue: where, when and how to reach it. The member's own choices
/// (notifications) live in Settings (owner, 2026-10-25), and location is not
/// used at all.
class VenuePage extends ConsumerStatefulWidget {
  const VenuePage({super.key});

  @override
  ConsumerState<VenuePage> createState() => _VenuePageState();
}

class _VenuePageState extends ConsumerState<VenuePage> {

  void _say(String text) {
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(text)));
  }

  Future<void> _open(String url) async {
    try {
      await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
    } catch (_) {
      _say(url);
    }
  }

  static const _linkMeta = <String, (IconData, String)>{
    'website': (Icons.language, 'Website'),
    'booking': (Icons.event, 'Book'),
    'menu': (Icons.restaurant_menu, 'Menu'),
    'phone': (Icons.call, 'Call'),
    'email': (Icons.mail_outline, 'Email'),
    'facebook': (Icons.facebook, 'Facebook'),
    'instagram': (Icons.photo_camera_outlined, 'Instagram'),
    'x': (Icons.alternate_email, 'X'),
    'tiktok': (Icons.music_note_outlined, 'TikTok'),
  };

  String _href(String key, String value) => switch (key) {
    'phone' => 'tel:${value.replaceAll(' ', '')}',
    'email' => 'mailto:$value',
    _ => value.startsWith('http') ? value : 'https://$value',
  };

  @override
  Widget build(BuildContext context) {
    final brand = ref.watch(brandProvider).requireValue;
    final theme = Theme.of(context);
    return ListView(
      padding: const EdgeInsets.only(bottom: 24),
      children: [
        // A venue's own build opens on its own header (the crest at its
        // ground, posts and a ball in flight; tool/make_venue_art.py), there
        // before the network is. Everywhere else, the back office's picture.
        if (VenueStyle.art)
          AspectRatio(
            aspectRatio: 16 / 7,
            child: Image.asset(
              'assets/venue/header.webp',
              fit: BoxFit.cover,
              semanticLabel: brand.name,
              errorBuilder: (_, _, _) => brand.hero == null
                  ? const SizedBox()
                  : Image.network(brand.hero!, fit: BoxFit.cover, errorBuilder: (_, _, _) => const SizedBox()),
            ),
          )
        else if (brand.hero != null)
          AspectRatio(
            aspectRatio: 16 / 7,
            child: Image.network(brand.hero!, fit: BoxFit.cover, errorBuilder: (_, _, _) => const SizedBox()),
          ),
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 20, 20, 8),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(brand.venue.isNotEmpty ? brand.venue : brand.name, style: theme.textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
              const SizedBox(height: 6),
              Text(brand.welcome, style: theme.textTheme.bodyLarge),
            ],
          ),
        ),
        if (brand.address != null)
          ListTile(
            leading: const Icon(Icons.place_outlined),
            title: Text(brand.address!),
            trailing: brand.location == null ? null : const Icon(Icons.directions),
            onTap: brand.location == null
                ? null
                : () => _open('https://www.google.com/maps/dir/?api=1&destination=${brand.location!.latitude},${brand.location!.longitude}'),
          ),
        if (brand.hours != null) ListTile(leading: const Icon(Icons.schedule), title: Text(brand.hours!)),
        for (final e in brand.links.entries)
          if (_linkMeta.containsKey(e.key))
            ListTile(
              leading: Icon(_linkMeta[e.key]!.$1),
              title: Text(_linkMeta[e.key]!.$2),
              subtitle: Text(e.value, overflow: TextOverflow.ellipsis),
              onTap: () => _open(_href(e.key, e.value)),
            ),
        const SizedBox(height: 16),
        const PoweredBy(),
      ],
    );
  }
}
