import 'package:flutter/material.dart';

import '../brand.dart';

/// A registration drawn the way it looks on the back of a UK car: black on
/// yellow, in a condensed bold face, so members recognise their own car at a
/// glance.
class NumberPlate extends StatelessWidget {
  const NumberPlate(this.text, {super.key, this.size = 20, this.front = false});

  final String text;
  final double size;

  /// White, as on the front of the car.
  final bool front;

  @override
  Widget build(BuildContext context) => Container(
    padding: EdgeInsets.symmetric(horizontal: size * 0.5, vertical: size * 0.18),
    decoration: BoxDecoration(
      color: front ? Colors.white : const Color(0xFFFFD300),
      borderRadius: BorderRadius.circular(size * 0.2),
      border: Border.all(color: const Color(0xFF222222), width: 1.2),
    ),
    child: Text(
      text,
      style: TextStyle(
        fontSize: size,
        fontWeight: FontWeight.w800,
        letterSpacing: size * 0.08,
        color: const Color(0xFF111111),
        fontFamily: 'Arial Narrow',
        fontFamilyFallback: const ['Roboto Condensed', 'Arial', 'sans-serif'],
      ),
    ),
  );
}

/// The Metric logo, for the top of a page.
class MetricLogo extends StatelessWidget {
  const MetricLogo({super.key, this.height = 36, this.white = false});

  final double height;
  final bool white;

  @override
  Widget build(BuildContext context) => Image.asset(
    white ? MetricBrand.logoWhite : MetricBrand.logo,
    height: height,
    semanticLabel: 'metric',
    fit: BoxFit.contain,
  );
}

/// A coloured line that says where a membership stands.
class StandingBanner extends StatelessWidget {
  const StandingBanner({super.key, required this.standing, this.validTo});

  final String standing;
  final String? validTo;

  @override
  Widget build(BuildContext context) {
    final (IconData icon, Color bg, Color fg, String text) = switch (standing) {
      'ok' => (Icons.check_circle, MetricBrand.green50, MetricBrand.green700, 'Active: the barriers open for your registered cars.'),
      'pending' => (Icons.hourglass_top, MetricBrand.amber50, MetricBrand.amber, 'Waiting for Metric to approve your membership. Add your cars now and they will work as soon as it is approved.'),
      'suspended' => (Icons.block, MetricBrand.red50, MetricBrand.red, 'Your membership is on hold. Call Metric on ${MetricBrand.phone}.'),
      'expired' => (Icons.event_busy, MetricBrand.red50, MetricBrand.red, 'Your membership ended${validTo != null ? ' on $validTo' : ''}. Call Metric to renew.'),
      'not_started' => (Icons.schedule, MetricBrand.amber50, MetricBrand.amber, 'Your membership has not started yet.'),
      _ => (Icons.info_outline, MetricBrand.navy50, MetricBrand.slate, 'Your membership is not active.'),
    };
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(14)),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, color: fg),
          const SizedBox(width: 12),
          Expanded(child: Text(text, style: TextStyle(color: fg, fontWeight: FontWeight.w500))),
        ],
      ),
    );
  }
}

/// Short, friendly error text with a retry.
class ErrorNotice extends StatelessWidget {
  const ErrorNotice(this.message, {super.key, this.onRetry});

  final String message;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(32),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.cloud_off, size: 40, color: MetricBrand.slate),
          const SizedBox(height: 12),
          Text(message, textAlign: TextAlign.center),
          if (onRetry != null) ...[
            const SizedBox(height: 16),
            OutlinedButton(onPressed: onRetry, child: const Text('Try again')),
          ],
        ],
      ),
    ),
  );
}

String friendlyDate(DateTime d) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  final now = DateTime.now();
  final hm = '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
  if (d.year == now.year && d.month == now.month && d.day == now.day) return 'Today $hm';
  final y = now.subtract(const Duration(days: 1));
  if (d.year == y.year && d.month == y.month && d.day == y.day) return 'Yesterday $hm';
  return '${d.day} ${months[d.month - 1]}${d.year == now.year ? '' : ' ${d.year}'} $hm';
}

String friendlyDay(String? isoDay) {
  if (isoDay == null || isoDay.isEmpty) return '';
  final d = DateTime.tryParse(isoDay);
  if (d == null) return isoDay;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return '${d.day} ${months[d.month - 1]} ${d.year}';
}

/// The top of each tab: an icon tile, an overline, the title and one line of
/// help, all centred on the page background. Navy blocks are kept for the
/// membership card and the entry screen, so they stay special.
class PageHero extends StatelessWidget {
  const PageHero({super.key, required this.icon, required this.title, this.overline, this.subtitle, this.trailing});

  final IconData icon;
  final String title;
  final String? overline;
  final String? subtitle;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(8, 12, 8, 4),
    child: Column(
      children: [
        Container(
          width: 56,
          height: 56,
          decoration: BoxDecoration(
            gradient: const LinearGradient(colors: [MetricBrand.navy, MetricBrand.navy600], begin: Alignment.topLeft, end: Alignment.bottomRight),
            borderRadius: BorderRadius.circular(18),
            boxShadow: MetricBrand.shadowMd,
          ),
          child: Icon(icon, color: MetricBrand.green, size: 28),
        ),
        const SizedBox(height: 14),
        if (overline != null) ...[
          Text(
            overline!.toUpperCase(),
            textAlign: TextAlign.center,
            style: const TextStyle(color: MetricBrand.green700, fontSize: 11, fontWeight: FontWeight.w800, letterSpacing: 1.6),
          ),
          const SizedBox(height: 6),
        ],
        Text(title, textAlign: TextAlign.center, style: Theme.of(context).textTheme.headlineSmall),
        if (subtitle != null) ...[
          const SizedBox(height: 6),
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 360),
            child: Text(subtitle!, textAlign: TextAlign.center, style: Theme.of(context).textTheme.bodyMedium),
          ),
        ],
        if (trailing != null) ...[const SizedBox(height: 14), trailing!],
      ],
    ),
  );
}

/// A friendly empty screen: a ringed icon, a title, a line and an action,
/// all centred.
class EmptyState extends StatelessWidget {
  const EmptyState({super.key, required this.icon, required this.title, required this.message, this.action});

  final IconData icon;
  final String title;
  final String message;
  final Widget? action;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.fromLTRB(24, 28, 24, 24),
    decoration: BoxDecoration(
      color: Colors.white,
      borderRadius: BorderRadius.circular(20),
      border: Border.all(color: MetricBrand.line),
    ),
    child: Column(
      children: [
        Container(
          width: 84,
          height: 84,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: MetricBrand.green.withValues(alpha: 0.12),
            border: Border.all(color: MetricBrand.green.withValues(alpha: 0.35), width: 6),
          ),
          child: Icon(icon, size: 36, color: MetricBrand.navy),
        ),
        const SizedBox(height: 16),
        Text(title, textAlign: TextAlign.center, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800, color: MetricBrand.ink)),
        const SizedBox(height: 6),
        Text(message, textAlign: TextAlign.center, style: const TextStyle(color: MetricBrand.slate, height: 1.4)),
        if (action != null) ...[const SizedBox(height: 18), action!],
      ],
    ),
  );
}

/// A rounded, tinted square for the icon at the start of a list row.
class IconTile extends StatelessWidget {
  const IconTile(this.icon, {super.key, this.colour = MetricBrand.navy});

  final IconData icon;
  final Color colour;

  @override
  Widget build(BuildContext context) => Container(
    width: 40,
    height: 40,
    decoration: BoxDecoration(color: colour.withValues(alpha: 0.09), borderRadius: BorderRadius.circular(12)),
    child: Icon(icon, color: colour, size: 22),
  );
}

/// A section heading inside a tab.
class SectionTitle extends StatelessWidget {
  const SectionTitle(this.text, {super.key, this.trailing});

  final String text;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(4, 0, 4, 10),
    child: Row(
      children: [
        Container(width: 4, height: 18, decoration: BoxDecoration(color: MetricBrand.green, borderRadius: BorderRadius.circular(2))),
        const SizedBox(width: 10),
        Expanded(child: Text(text, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w800, color: MetricBrand.ink))),
        ?trailing,
      ],
    ),
  );
}
