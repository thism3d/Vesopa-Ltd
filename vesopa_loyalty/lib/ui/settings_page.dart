import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:url_launcher/url_launcher.dart';

import '../data/api.dart';
import '../data/brand.dart';
import '../data/preferences.dart';
import '../data/session.dart';
import '../data/venue_style.dart';
import '../platform/push.dart';
import '../platform/wallet.dart';
import 'account_page.dart';
import 'venue_intro.dart';
import 'licenses_page.dart';
import 'widgets.dart';

/// The app's own settings: how it looks, what it does with the screen and
/// notifications, the small print, and who is behind it.
///
/// THE ACCOUNT TAB IS THE MEMBER; THIS IS THE APP. Name, photo, membership,
/// signing in and their data stay on the Account tab, where somebody looks
/// for "me". Everything here is about this copy of the app on this device,
/// and none of it is the venue's to switch off.
///
/// Opened from the gear at the top of the app (ui/home.dart) and from the
/// foot of the Account tab.
class SettingsPage extends ConsumerStatefulWidget {
  const SettingsPage({super.key});

  static Future<void> open(BuildContext context) =>
      Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const SettingsPage()));

  @override
  ConsumerState<SettingsPage> createState() => _SettingsPageState();
}

/// The club's own words under its name, from its venue.json (a venue build).
const _tagline = String.fromEnvironment('VENUE_TAGLINE');

/// Where a venue's own privacy policy is, for a venue whose back office has
/// no "privacy" link yet. Its store listings already name these.
const _venuePrivacy = {'pontardawe-rfc': 'https://pontardawerfc.com/privacy'};

/// A venue's own pages for this app, on its own website, in place of
/// Vesopa's (the owner, 2026-10-25: "All the privacy URLs should be in the
/// pontardawerfc official website"). The store listings name the same ones.
const _venueAppPages = {
  'pontardawe-rfc': (
    privacy: 'https://pontardawerfc.com/app/privacy',
    choices: 'https://pontardawerfc.com/app/privacy-choices',
    terms: 'https://pontardawerfc.com/app/terms',
  ),
};

/// Vesopa's own pages, which every venue's app shares.
const vesopaPrivacy = 'https://loyalty.vesopa.com/privacy';
const vesopaTerms = 'https://auth.vesopa.com/terms';
const vesopaSupport = 'https://loyalty.vesopa.com/support';
const vesopaWebsite = 'https://vesopasoftware.com';

class _SettingsPageState extends ConsumerState<SettingsPage> {
  Choices? _choices;
  PackageInfo? _package;
  var _busy = false;
  var _wallet = false;
  // Whether the phone lets this app notify; the "Notification settings" row
  // shows only when it does not (owner, 2026-10-25).
  var _osAllowed = true;

  @override
  void initState() {
    super.initState();
    Choices.of(ref.read(configProvider).slug).then((c) {
      if (mounted) setState(() => _choices = c);
    });
    PackageInfo.fromPlatform().then((p) {
      if (mounted) setState(() => _package = p);
    }, onError: (Object _) {});
    AppleWallet.available().then((ok) {
      if (mounted) setState(() => _wallet = ok);
    });
    _checkAllowed();
  }

  Future<void> _checkAllowed() async {
    final ok = await pushAllowed();
    if (mounted) setState(() => _osAllowed = ok);
  }

  Future<void> _signOut() async {
    final sure = await showDialog<bool>(
      context: context,
      builder: (d) => AlertDialog.adaptive(
        title: const Text('Sign out?'),
        content: const Text('You can sign back in at any time. Your membership and points stay with the club.'),
        actions: [
          DialogAction(onPressed: () => Navigator.pop(d, false), child: const Text('Cancel')),
          DialogAction(primary: true, onPressed: () => Navigator.pop(d, true), child: const Text('Sign out')),
        ],
      ),
    );
    if (sure != true || !mounted) return;
    setState(() => _busy = true);
    final nav = Navigator.of(context);
    await signOutHere(ref);
    // Back to the sign-in page underneath.
    nav.popUntil((r) => r.isFirst);
  }

  void _say(String text) {
    ScaffoldMessenger.maybeOf(context)
      ?..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(text), behavior: SnackBarBehavior.floating));
  }

  Future<void> _open(String url) async {
    try {
      final ok = await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
      if (!ok) _say(url);
    } catch (_) {
      _say(url);
    }
  }

  Future<void> _setNotifications(Brand brand, bool on) async {
    final choices = _choices;
    if (choices == null) return;
    setState(() => _busy = true);
    final said = await switchNotifications(ref.read(apiProvider), brand, choices, on);
    if (!mounted) return;
    setState(() => _busy = false);
    _checkAllowed();
    if (said != null) _say(said);
  }

  /// "1.1.0 (7)", as the stores show it, once the platform has said.
  String get _version {
    final p = _package;
    if (p == null || p.version.isEmpty) return '';
    return p.buildNumber.isEmpty || p.buildNumber == p.version ? p.version : '${p.version} (${p.buildNumber})';
  }

  @override
  Widget build(BuildContext context) {
    final brand = ref.watch(brandProvider).requireValue;
    final theme = Theme.of(context);
    final account = ref.watch(accountProvider).value;
    final mode = ref.watch(appearanceProvider);
    final glow = ref.watch(cardGlowProvider);
    final choices = _choices;
    final canPush = pushAvailable(brand);
    final ios = !kIsWeb && defaultTargetPlatform == TargetPlatform.iOS;
    final phone = !kIsWeb && (ios || defaultTargetPlatform == TargetPlatform.android);
    final privacy = brand.links['privacy'] ?? _venuePrivacy[brand.slug];
    final appPages = _venueAppPages[brand.slug];
    final venueName = brand.venue.isNotEmpty ? brand.venue : brand.name;
    final passkeys = (account?['passkeys'] as List?)?.length ?? 0;
    final devices = (account?['devices'] as List?)?.length ?? 0;

    return Scaffold(
      appBar: AppBar(
        flexibleSpace: VenueStyle.enabled ? const ClubGradient(intensity: 0.6) : null,
        backgroundColor: VenueStyle.enabled ? Colors.transparent : null,
        foregroundColor: VenueStyle.enabled ? Colors.white : null,
        titleTextStyle: VenueStyle.enabled ? theme.appBarTheme.titleTextStyle?.copyWith(color: Colors.white) : null,
        title: const Text('Settings'),
      ),
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 640),
            child: ListView(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 32),
              children: [
                // ---- How it looks -------------------------------------------
                // Only where there is a dark look to choose: a venue's own app
                // or page has the club's shades in both (data/venue_style.dart).
                // Every other venue's app is drawn in the one set of colours
                // its back office chose, and a dark mode guessed from those
                // would be a look nobody at the venue had seen.
                if (VenueStyle.enabled) ...[
                  SettingsCard(
                    title: 'Appearance',
                    children: [
                      const Padding(
                        padding: EdgeInsets.only(top: 4, bottom: 10),
                        child: Text('Match your phone, or keep the app light or dark.'),
                      ),
                      SizedBox(
                        width: double.infinity,
                        child: SegmentedButton<ThemeMode>(
                          segments: const [
                            ButtonSegment(value: ThemeMode.system, icon: Icon(Icons.brightness_auto_outlined), label: Text('Automatic')),
                            ButtonSegment(value: ThemeMode.light, icon: Icon(Icons.light_mode_outlined), label: Text('Light')),
                            ButtonSegment(value: ThemeMode.dark, icon: Icon(Icons.dark_mode_outlined), label: Text('Dark')),
                          ],
                          selected: {mode},
                          showSelectedIcon: false,
                          onSelectionChanged: (s) => ref.read(appearanceProvider.notifier).set(s.first),
                        ),
                      ),
                      const SizedBox(height: 6),
                    ],
                  ),
                  const SizedBox(height: 10),
                ],

                // ---- The card and notifications -----------------------------
                SettingsCard(
                  title: 'Your card and alerts',
                  children: [
                    // A browser cannot change the screen at all, so the switch
                    // would do nothing there.
                    if (!kIsWeb)
                      SwitchListTile.adaptive(
                        contentPadding: EdgeInsets.zero,
                        secondary: const Icon(Icons.brightness_high_outlined),
                        title: const Text('Brighten the screen for my card'),
                        subtitle: const Text('Turns the screen right up while your code is showing, so the till can scan it.'),
                        value: glow,
                        onChanged: (v) => ref.read(cardGlowProvider.notifier).set(v),
                      ),
                    SwitchListTile.adaptive(
                      contentPadding: EdgeInsets.zero,
                      secondary: const Icon(Icons.notifications_active_outlined),
                      title: const Text('Notifications'),
                      subtitle: Text(
                        !canPush
                            ? 'Not available on this device. Our news is always under the bell.'
                            : (choices?.notifications ?? false)
                                ? 'On. Offers and news as they happen.'
                                : 'Off. Turn on for offers and news as they happen.',
                      ),
                      value: choices?.notifications ?? false,
                      onChanged: (choices == null || _busy || !canPush) ? null : (v) => _setNotifications(brand, v),
                    ),
                    // A phone that was asked once and said no will not ask
                    // again; only its own settings can change that. Shown only
                    // while notifications are blocked there.
                    if (phone && !_osAllowed)
                      ListTile(
                        contentPadding: EdgeInsets.zero,
                        leading: const Icon(Icons.settings_outlined),
                        title: const Text('Notification settings'),
                        subtitle: const Text('Notifications are blocked for this app. Allow them here.'),
                        trailing: const Icon(Icons.open_in_new, size: 18),
                        onTap: () async {
                          await pushOpenSettings();
                          // Back from the phone's settings: look again.
                          Future.delayed(const Duration(seconds: 2), _checkAllowed);
                        },
                      ),
                  ],
                ),
                const SizedBox(height: 10),

                // ---- What it is connected to --------------------------------
                SettingsCard(
                  title: 'Connections',
                  children: [
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      leading: const Icon(Icons.fingerprint),
                      title: const Text('Passkeys'),
                      subtitle: Text(
                        passkeys == 0
                            ? 'None yet. Add one under Signing in, on the Account tab.'
                            : '$passkeys on your account. Manage them under Signing in, on the Account tab.',
                      ),
                    ),
                    if (devices > 0)
                      ListTile(
                        contentPadding: EdgeInsets.zero,
                        leading: const Icon(Icons.devices_other),
                        title: const Text('Signed in'),
                        subtitle: Text('On $devices device${devices == 1 ? '' : 's'}. See them on the Account tab.'),
                      ),
                    if (_wallet)
                      const ListTile(
                        contentPadding: EdgeInsets.zero,
                        leading: Icon(Icons.wallet_outlined),
                        title: Text('Apple Wallet'),
                        subtitle: Text('Add your card from the Card tab, and it is there even without the app.'),
                      ),
                    if (GoogleWallet.available && brand.googleWallet)
                      const ListTile(
                        contentPadding: EdgeInsets.zero,
                        leading: Icon(Icons.wallet_outlined),
                        title: Text('Google Wallet'),
                        subtitle: Text('Add your card from the Card tab, and it is there even without the app.'),
                      ),
                    if (ios)
                      const ListTile(
                        contentPadding: EdgeInsets.zero,
                        leading: Icon(Icons.watch_outlined),
                        title: Text('Apple Watch'),
                        subtitle: Text('Your card is on your watch once its app is installed, kept up to date by this one.'),
                      ),
                  ],
                ),
                const SizedBox(height: 10),

                // ---- The small print -----------------------------------------
                SettingsCard(
                  title: 'Privacy and terms',
                  children: [
                    if (privacy != null)
                      _LinkRow(
                        icon: Icons.privacy_tip_outlined,
                        title: '$venueName privacy policy',
                        subtitle: 'How the club looks after your details.',
                        onTap: () => _open(privacy),
                      ),
                    _LinkRow(
                      icon: Icons.shield_outlined,
                      title: privacy == null ? 'Privacy policy' : 'App privacy policy',
                      subtitle: 'What this app keeps, why, and for how long.',
                      onTap: () => _open(appPages?.privacy ?? vesopaPrivacy),
                    ),
                    if (appPages != null)
                      _LinkRow(
                        icon: Icons.tune,
                        title: 'Your privacy choices',
                        subtitle: 'What is optional, and how to switch it off.',
                        onTap: () => _open(appPages.choices),
                      ),
                    _LinkRow(
                      icon: Icons.gavel_outlined,
                      title: appPages == null ? 'Terms of use' : 'Terms and licences',
                      subtitle: 'The agreement for using this app.',
                      onTap: () => _open(appPages?.terms ?? vesopaTerms),
                    ),
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      leading: const Icon(Icons.code),
                      title: const Text('Open-source software'),
                      subtitle: const Text('The free software this app is built with, and its licences.'),
                      trailing: const Icon(Icons.chevron_right),
                      onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(
                        builder: (_) => LicensesPage(appName: brand.name, version: _version),
                      )),
                    ),
                  ],
                ),
                const SizedBox(height: 10),

                _AboutVenue(brand: brand, onOpen: _open),
                GetTheApp(brand: brand),
                const SizedBox(height: 10),

                // ---- Who makes it -------------------------------------------
                SettingsCard(
                  title: 'About Vesopa',
                  children: [
                    Padding(
                      padding: const EdgeInsets.only(top: 4, bottom: 6),
                      child: Text(
                        '$venueName\'s app is made by Vesopa Software Ltd, a Welsh company that also makes '
                        'the tills, bookings and loyalty behind it.',
                      ),
                    ),
                    if (_version.isNotEmpty)
                      ListTile(
                        contentPadding: EdgeInsets.zero,
                        leading: const Icon(Icons.info_outline),
                        title: const Text('Version'),
                        subtitle: Text(_version),
                      ),
                    _LinkRow(
                      icon: Icons.help_outline,
                      title: 'Help and support',
                      subtitle: 'Answers, and how to reach us.',
                      onTap: () => _open(vesopaSupport),
                    ),
                    _LinkRow(
                      icon: Icons.language,
                      title: 'vesopasoftware.com',
                      onTap: () => _open(vesopaWebsite),
                    ),
                  ],
                ),

                // ---- Leaving ------------------------------------------------
                // Here as well as on Account, which needs the server to load:
                // Settings always opens, so signing out always works.
                if (ref.watch(sessionProvider).value != null) ...[
                  const SizedBox(height: 10),
                  SettingsCard(
                    title: 'This device',
                    children: [
                      ListTile(
                        contentPadding: EdgeInsets.zero,
                        leading: const Icon(Icons.logout),
                        title: const Text('Sign out'),
                        subtitle: const Text('Your membership and points stay with the club.'),
                        onTap: _busy ? null : _signOut,
                      ),
                    ],
                  ),
                ],
                const SizedBox(height: 22),
                const PoweredBy(),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// A row that opens a page outside the app.
class _LinkRow extends StatelessWidget {
  const _LinkRow({required this.icon, required this.title, this.subtitle, required this.onTap});

  final IconData icon;
  final String title;
  final String? subtitle;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => ListTile(
    contentPadding: EdgeInsets.zero,
    leading: Icon(icon),
    title: Text(title),
    subtitle: subtitle == null ? null : Text(subtitle!),
    trailing: const Icon(Icons.open_in_new, size: 18),
    onTap: onTap,
  );
}

/// The club's crest: bundled in its own build, the back office's logo
/// everywhere else.
class _Crest extends StatelessWidget {
  const _Crest({required this.brand, required this.size});

  final Brand brand;
  final double size;

  @override
  Widget build(BuildContext context) => VenueIntro.enabled
      ? Image.asset(
          VenueIntro.crestAsset,
          height: size,
          fit: BoxFit.contain,
          errorBuilder: (_, _, _) => VenueLogo(brand: brand, size: size),
        )
      : VenueLogo(brand: brand, size: size);
}

/// The venue, in brief: who they are, where, when, and how to reach them.
/// The Venue tab has the full page; this is the "about" a settings screen is
/// expected to have, from the same branding.
class _AboutVenue extends StatelessWidget {
  const _AboutVenue({required this.brand, required this.onOpen});

  final Brand brand;
  final void Function(String url) onOpen;

  static const _links = <String, (IconData, String)>{
    'website': (Icons.language, 'Website'),
    'phone': (Icons.call_outlined, 'Call'),
    'email': (Icons.mail_outline, 'Email'),
    'facebook': (Icons.facebook, 'Facebook'),
    'instagram': (Icons.photo_camera_outlined, 'Instagram'),
    'x': (Icons.alternate_email, 'X'),
    'tiktok': (Icons.music_note_outlined, 'TikTok'),
  };

  static String _href(String key, String value) => switch (key) {
    'phone' => 'tel:${value.replaceAll(' ', '')}',
    'email' => 'mailto:$value',
    _ => value.startsWith('http') ? value : 'https://$value',
  };

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final name = brand.venue.isNotEmpty ? brand.venue : brand.name;
    final tagline = _tagline.isNotEmpty ? _tagline : null;
    return SettingsCard(
      title: 'About $name',
      children: [
        const SizedBox(height: 8),
        Row(
          children: [
            _Crest(brand: brand, size: 64),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(name, style: theme.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800)),
                  if (tagline != null)
                    Text(tagline, style: theme.textTheme.bodyMedium?.copyWith(color: theme.colorScheme.onSurfaceVariant)),
                ],
              ),
            ),
          ],
        ),
        if (brand.welcome.isNotEmpty) ...[
          const SizedBox(height: 10),
          Text(brand.welcome),
        ],
        const SizedBox(height: 4),
        if (brand.address != null)
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.place_outlined),
            title: Text(brand.address!),
            trailing: brand.location == null ? null : const Icon(Icons.directions),
            onTap: brand.location == null
                ? null
                : () => onOpen('https://www.google.com/maps/dir/?api=1&destination=${brand.location!.latitude},${brand.location!.longitude}'),
          ),
        if (brand.hours != null)
          ListTile(contentPadding: EdgeInsets.zero, leading: const Icon(Icons.schedule), title: Text(brand.hours!)),
        if (brand.links.keys.any(_links.containsKey)) ...[
          const SizedBox(height: 6),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final e in brand.links.entries)
                if (_links.containsKey(e.key))
                  ActionChip(
                    avatar: Icon(_links[e.key]!.$1, size: 18),
                    label: Text(_links[e.key]!.$2),
                    tooltip: e.value,
                    onPressed: () => onOpen(_href(e.key, e.value)),
                  ),
            ],
          ),
          const SizedBox(height: 6),
        ],
      ],
    );
  }
}

/// Notifications on or off for this device, the same way wherever the switch
/// is: ask the platform for a channel, hand it to the server, remember the
/// choice. Answers what to tell the member, or null when there is nothing to.
Future<String?> switchNotifications(LoyaltyApi api, Brand brand, Choices choices, bool on) async {
  try {
    if (on) {
      final channel = await pushSubscribe(brand);
      if (channel == null) {
        return 'Notifications were not allowed. You can still read all our news under the bell.';
      }
      if (channel.isDeviceToken) {
        await api.addDeviceToken(channel.kind, channel.channelUri!);
      } else if (channel.kind == 'wns') {
        await api.addWindowsChannel(channel.channelUri!);
      } else {
        await api.addWebPush(channel.subscription!);
      }
      await choices.setNotifications(true);
      return 'Notifications are on.';
    }
    final endpoint = await pushUnsubscribe();
    if (endpoint != null) await api.removePush(endpoint);
    await choices.setNotifications(false);
    return null;
  } on ApiError catch (e) {
    return e.message;
  } catch (_) {
    return 'That did not work. Please try again.';
  }
}
