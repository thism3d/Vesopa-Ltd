import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../config/constants.dart';
import 'theme.dart';
import 'widgets/pos_message.dart';

/// One way to reach Vesopa.
class _Contact {
  const _Contact({
    required this.icon,
    required this.label,
    required this.value,
    required this.uri,
    this.colour,
  });

  final IconData icon;
  final String label;
  final String value;

  /// A real scheme (tel:, mailto:, https:) so the device opens the dialler,
  /// the mail app, or the installed app rather than a browser tab.
  final String uri;
  final Color? colour;
}

/// About Vesopa: who made the till, and how to reach them.
///
/// Every contact opens the right app rather than showing a string to copy — a
/// venue with a problem mid-service should be one tap from a phone call.
class AboutPage extends StatelessWidget {
  const AboutPage({super.key});

  /// Contact details come from [VesopaBrand] so the phone number printed on a
  /// receipt and the one dialled from this screen can never drift apart.
  static const _contacts = <_Contact>[
    _Contact(
      icon: Icons.phone,
      label: 'Call us',
      value: '+44 1792 316282',
      uri: 'tel:${VesopaBrand.phone}',
      colour: Color(0xFF2E7D32),
    ),
    _Contact(
      icon: Icons.chat,
      label: 'WhatsApp',
      value: '+44 7501 928043',
      // Pre-filled so the conversation starts with context, matching the
      // prompt already used on vesopaepos.com.
      uri: VesopaBrand.whatsAppUrl,
      colour: Color(0xFF25D366),
    ),
    _Contact(
      icon: Icons.mail_outline,
      label: 'Email',
      value: VesopaBrand.email,
      uri: 'mailto:${VesopaBrand.email}'
          '?subject=Vesopa%20EPOS%20enquiry'
          '&body=Hello%20Vesopa%20team%2C%0A%0A',
      colour: Color(0xFF1565C0),
    ),
    _Contact(
      icon: Icons.language,
      label: 'Website',
      value: 'vesopaepos.com',
      uri: VesopaBrand.website,
    ),
    _Contact(
      icon: Icons.public,
      label: 'Website (UK)',
      value: 'vesopaepos.co.uk',
      uri: VesopaBrand.websiteAlt,
    ),
    _Contact(
      icon: Icons.business_center_outlined,
      label: 'LinkedIn',
      value: 'Vesopa on LinkedIn',
      uri: VesopaBrand.linkedIn,
      colour: Color(0xFF0A66C2),
    ),
    _Contact(
      icon: Icons.alternate_email,
      label: 'X',
      value: '@vesopa_uk',
      uri: VesopaBrand.x,
      colour: Color(0xFF14171A),
    ),
  ];

  Future<void> _open(BuildContext context, _Contact contact) async {
    try {
      final ok = await launchUrl(
        Uri.parse(contact.uri),
        mode: LaunchMode.externalApplication,
      );
      if (!ok && context.mounted) {
        PosMessenger.info(context, '${contact.label}: ${contact.value}');
      }
    } catch (_) {
      // A till with no dialler or no browser must not crash on a tap; show the
      // detail instead so the clerk can still act on it.
      if (context.mounted) {
        PosMessenger.info(context, '${contact.label}: ${contact.value}');
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final wide = MediaQuery.sizeOf(context).width >= 720;

    return SingleChildScrollView(
      padding: const EdgeInsets.all(24),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 820),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _Hero(wide: wide),
              const SizedBox(height: 26),

              Text('What Vesopa does',
                  style: theme.textTheme.titleMedium
                      ?.copyWith(fontWeight: FontWeight.w700)),
              const SizedBox(height: 8),
              Text(
                'Vesopa builds vending, software and payment systems for '
                'hospitality and retail. This till is the front of that: it '
                'keeps selling when the network does not, syncs every sale back '
                'to the back office, and takes card payments through Dojo — on '
                'the counter or on a reader.',
                style: theme.textTheme.bodyMedium
                    ?.copyWith(color: scheme.onSurfaceVariant, height: 1.5),
              ),
              const SizedBox(height: 22),

              const _Features(),
              const SizedBox(height: 26),

              Text('Get in touch',
                  style: theme.textTheme.titleMedium
                      ?.copyWith(fontWeight: FontWeight.w700)),
              const SizedBox(height: 12),

              // Two columns where there is room, one where there is not.
              GridView.count(
                crossAxisCount: wide ? 2 : 1,
                shrinkWrap: true,
                physics: const NeverScrollableScrollPhysics(),
                mainAxisSpacing: 10,
                crossAxisSpacing: 10,
                childAspectRatio: wide ? 5.2 : 5.6,
                children: [
                  for (final contact in _contacts)
                    _ContactTile(
                      contact: contact,
                      onTap: () => _open(context, contact),
                    ),
                ],
              ),

              const SizedBox(height: 28),
              Center(
                child: Column(
                  children: [
                    Text(
                      'VESOPA EPOS',
                      style: theme.textTheme.labelLarge?.copyWith(
                        letterSpacing: 2,
                        color: scheme.onSurfaceVariant,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      VesopaBrand.slogan,
                      style: theme.textTheme.bodySmall
                          ?.copyWith(color: scheme.onSurfaceVariant),
                    ),
                    const SizedBox(height: 10),
                    Text(
                      '© ${DateTime.now().year} Vesopa EPOS Limited',
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: scheme.onSurfaceVariant.withValues(alpha: 0.7),
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 20),
            ],
          ),
        ),
      ),
    );
  }
}

class _Hero extends StatelessWidget {
  const _Hero({required this.wide});

  final bool wide;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;

    return Container(
      padding: EdgeInsets.all(wide ? 30 : 22),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(16),
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [
            scheme.primaryContainer,
            scheme.primaryContainer.withValues(alpha: 0.55),
          ],
        ),
      ),
      child: Flex(
        direction: wide ? Axis.horizontal : Axis.vertical,
        crossAxisAlignment:
            wide ? CrossAxisAlignment.center : CrossAxisAlignment.stretch,
        children: [
          // The mark. Falls back to a monogram if the asset is missing, so a
          // stripped build still renders something sensible.
          Container(
            width: wide ? 132 : double.infinity,
            height: wide ? 132 : 96,
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: scheme.surface,
              borderRadius: BorderRadius.circular(14),
            ),
            child: Image.asset(
              // The wordmark is near-black, so it disappears on the dark
              // theme's surface unless the on-dark lockup is used instead.
              theme.isDark
                  ? 'assets/brand/vesopa_logo_on_dark.png'
                  : 'assets/brand/vesopa_logo.png',
              fit: BoxFit.contain,
              errorBuilder: (_, _, _) => Center(
                child: Text(
                  'V',
                  style: theme.textTheme.displayMedium?.copyWith(
                    fontWeight: FontWeight.w900,
                    color: scheme.primary,
                  ),
                ),
              ),
            ),
          ),
          SizedBox(width: wide ? 26 : 0, height: wide ? 0 : 18),
          Expanded(
            flex: wide ? 1 : 0,
            child: Column(
              crossAxisAlignment:
                  wide ? CrossAxisAlignment.start : CrossAxisAlignment.center,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  'VESOPA EPOS',
                  style: theme.textTheme.headlineMedium?.copyWith(
                    fontWeight: FontWeight.w900,
                    letterSpacing: 1.4,
                    color: scheme.onPrimaryContainer,
                  ),
                ),
                const SizedBox(height: 8),
                // The company's own slogan.
                Text(
                  VesopaBrand.slogan,
                  textAlign: wide ? TextAlign.start : TextAlign.center,
                  style: theme.textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w600,
                    color: scheme.onPrimaryContainer.withValues(alpha: 0.92),
                  ),
                ),
                const SizedBox(height: 12),
                Text(
                  'Point of sale that never stops trading — offline-first, '
                  'card-ready, and built for the counter.',
                  textAlign: wide ? TextAlign.start : TextAlign.center,
                  style: theme.textTheme.bodyMedium?.copyWith(
                    color: scheme.onPrimaryContainer.withValues(alpha: 0.85),
                    height: 1.45,
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

class _Features extends StatelessWidget {
  const _Features();

  static const _items = <(IconData, String, String)>[
    (Icons.cloud_off, 'Offline-first',
        'Sales are written here first and synced when the network returns.'),
    (Icons.credit_card, 'Card payments',
        'Dojo on a reader at the counter, or on the device itself.'),
    (Icons.print_outlined, 'Thermal printing',
        'Receipts and kitchen tickets on 80mm or 58mm rolls.'),
    (Icons.table_restaurant_outlined, 'Tables & bills',
        'Park, recall, transfer and split a bill any way the table wants.'),
    (Icons.loyalty_outlined, 'Loyalty & offers',
        'Points, tiers, vouchers, gift cards and multi-buy deals.'),
    (Icons.insights_outlined, 'Live back office',
        'Every sale on the dashboard the moment it is rung up.'),
  ];

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final wide = MediaQuery.sizeOf(context).width >= 720;

    return GridView.count(
      crossAxisCount: wide ? 2 : 1,
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      mainAxisSpacing: 10,
      crossAxisSpacing: 10,
      childAspectRatio: wide ? 4.4 : 5.0,
      children: [
        for (final (icon, title, detail) in _items)
          Container(
            padding: const EdgeInsets.all(13),
            decoration: BoxDecoration(
              border: Border.all(color: scheme.outlineVariant),
              borderRadius: BorderRadius.circular(11),
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(icon, size: 19, color: scheme.primary),
                const SizedBox(width: 11),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(title,
                          style: theme.textTheme.bodyMedium
                              ?.copyWith(fontWeight: FontWeight.w700)),
                      const SizedBox(height: 2),
                      Text(
                        detail,
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: scheme.onSurfaceVariant,
                          height: 1.3,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }
}

class _ContactTile extends StatelessWidget {
  const _ContactTile({required this.contact, required this.onTap});

  final _Contact contact;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final accent = contact.colour ?? scheme.primary;

    return Material(
      color: scheme.surfaceContainerHighest,
      borderRadius: BorderRadius.circular(11),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(11),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          child: Row(
            children: [
              Container(
                width: 38,
                height: 38,
                decoration: BoxDecoration(
                  color: accent.withValues(alpha: 0.14),
                  borderRadius: BorderRadius.circular(9),
                ),
                child: Icon(contact.icon, size: 19, color: accent),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      contact.label,
                      style: theme.textTheme.labelSmall
                          ?.copyWith(color: scheme.onSurfaceVariant),
                    ),
                    Text(
                      contact.value,
                      style: theme.textTheme.bodyMedium
                          ?.copyWith(fontWeight: FontWeight.w600),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ],
                ),
              ),
              Icon(Icons.open_in_new, size: 15, color: scheme.outline),
            ],
          ),
        ),
      ),
    );
  }
}
