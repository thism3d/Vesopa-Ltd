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
      'ok' => (Icons.check_circle, const Color(0xFFE5F6DC), const Color(0xFF2E7D32), 'Active: the barriers open for your registered cars.'),
      'pending' => (Icons.hourglass_top, const Color(0xFFFFF4D6), const Color(0xFF7A5200), 'Waiting for Metric to approve your membership. Add your cars now and they will work as soon as it is approved.'),
      'suspended' => (Icons.block, const Color(0xFFFDE7E6), const Color(0xFFB3261E), 'Your membership is on hold. Call Metric on ${MetricBrand.phone}.'),
      'expired' => (Icons.event_busy, const Color(0xFFFDE7E6), const Color(0xFFB3261E), 'Your membership ended${validTo != null ? ' on $validTo' : ''}. Call Metric to renew.'),
      'not_started' => (Icons.schedule, const Color(0xFFFFF4D6), const Color(0xFF7A5200), 'Your membership has not started yet.'),
      _ => (Icons.info_outline, const Color(0xFFEEF1F7), const Color(0xFF5D6679), 'Your membership is not active.'),
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
          const Icon(Icons.cloud_off, size: 40, color: Color(0xFF5D6679)),
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
