import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../data/brand.dart';
import '../data/session.dart';
import '../platform/location.dart';
import '../platform/push.dart';
import 'widgets.dart';

/// The venue -- where, when, how to reach it -- and the customer's own
/// choices: notifications, nearby offers, signing out.
class VenuePage extends ConsumerStatefulWidget {
  const VenuePage({super.key});

  @override
  ConsumerState<VenuePage> createState() => _VenuePageState();
}

class _VenuePageState extends ConsumerState<VenuePage> {
  Choices? _choices;
  var _busy = false;

  @override
  void initState() {
    super.initState();
    Choices.of(ref.read(configProvider).slug).then((c) {
      if (mounted) setState(() => _choices = c);
    });
  }

  void _say(String text) {
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(text)));
  }

  Future<void> _setNotifications(Brand brand, bool on) async {
    final choices = _choices;
    if (choices == null) return;
    setState(() => _busy = true);
    final api = ref.read(apiProvider);
    try {
      if (on) {
        final channel = await pushSubscribe(brand);
        if (channel == null) {
          _say('Notifications were not allowed. You can still read all our news in the News tab.');
          return;
        }
        if (channel.kind == 'wns') {
          await api.addWindowsChannel(channel.channelUri!);
        } else {
          await api.addWebPush(channel.subscription!);
        }
        await choices.setNotifications(true);
        _say('Notifications are on.');
      } else {
        final endpoint = await pushUnsubscribe();
        if (endpoint != null) await api.removePush(endpoint);
        await choices.setNotifications(false);
      }
    } catch (e) {
      _say('$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _setNearby(bool on) async {
    final choices = _choices;
    if (choices == null) return;
    setState(() => _busy = true);
    final api = ref.read(apiProvider);
    try {
      if (on) {
        final p = await currentPosition();
        if (p == null) {
          _say('Location was not allowed, so nearby offers stay off.');
          return;
        }
        await api.reportLocation(latitude: p.latitude, longitude: p.longitude, accuracy: p.accuracy);
        await choices.setNearby(true);
      } else {
        await api.forgetLocation();
        await choices.setNearby(false);
      }
    } catch (e) {
      _say('$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _signOut({required bool remove}) async {
    if (remove) {
      final sure = await showDialog<bool>(
        context: context,
        builder: (d) => AlertDialog(
          title: const Text('Remove the app from your membership?'),
          content: const Text(
            'Every device you signed in on is signed out, notifications stop and your saved location is deleted. '
            'Your membership and points stay with the venue.',
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('Cancel')),
            FilledButton(onPressed: () => Navigator.pop(d, true), child: const Text('Remove')),
          ],
        ),
      );
      if (sure != true) return;
    }
    setState(() => _busy = true);
    final api = ref.read(apiProvider);
    try {
      final endpoint = await pushUnsubscribe();
      if (endpoint != null) await api.removePush(endpoint).catchError((_) {});
      if (remove) {
        await api.removeApp();
      } else {
        await api.signOut();
      }
    } catch (_) {
      // Signed out here regardless: the token is forgotten below.
    }
    await _choices?.setNotifications(false);
    await _choices?.setNearby(false);
    await ref.read(sessionProvider.notifier).clear();
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
    final choices = _choices;
    final canPush = pushAvailable(brand);
    return ListView(
      padding: const EdgeInsets.only(bottom: 24),
      children: [
        if (brand.hero != null)
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
        const Divider(height: 32),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 20),
          child: Text('Your settings', style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700)),
        ),
        SwitchListTile(
          secondary: const Icon(Icons.notifications_active_outlined),
          title: const Text('Notifications'),
          subtitle: Text(canPush ? 'Offers and news as they happen.' : 'Not available on this device. Our news is always in the News tab.'),
          value: choices?.notifications ?? false,
          onChanged: (choices == null || _busy || !canPush) ? null : (v) => _setNotifications(brand, v),
        ),
        if (brand.location != null)
          SwitchListTile(
            secondary: const Icon(Icons.near_me_outlined),
            title: const Text("Offers when I'm nearby"),
            subtitle: const Text('Uses your location only while the app is open, and forgets it after a day.'),
            value: choices?.nearby ?? false,
            onChanged: (choices == null || _busy) ? null : _setNearby,
          ),
        ListTile(
          leading: const Icon(Icons.logout),
          title: const Text('Sign out'),
          onTap: _busy ? null : () => _signOut(remove: false),
        ),
        ListTile(
          leading: Icon(Icons.delete_outline, color: theme.colorScheme.error),
          title: Text('Remove the app from my membership', style: TextStyle(color: theme.colorScheme.error)),
          onTap: _busy ? null : () => _signOut(remove: true),
        ),
        const SizedBox(height: 16),
        const PoweredBy(),
      ],
    );
  }
}
