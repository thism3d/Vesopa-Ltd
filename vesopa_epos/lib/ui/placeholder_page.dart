import 'package:flutter/material.dart';

import 'theme.dart';

/// A section that exists in the navigation but is driven from the back office
/// rather than the till. Rather than a blank "not built" screen, it says what
/// the section is for and where it is configured — a clerk who taps it should
/// learn something, not hit a dead end.
class PlaceholderPage extends StatelessWidget {
  const PlaceholderPage({
    super.key,
    required this.title,
    required this.icon,
    required this.description,
    this.points = const [],
    this.managedInBackOffice = true,
    this.action,
  });

  final String title;
  final IconData icon;
  final String description;
  final List<String> points;
  final bool managedInBackOffice;

  /// An optional call-to-action button: (label, onTap).
  final (String, VoidCallback)? action;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 460),
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(28),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: 60,
                height: 60,
                decoration: BoxDecoration(
                  color: Pos.brandSoft,
                  borderRadius: BorderRadius.circular(16),
                ),
                child: Icon(icon, size: 30, color: Pos.brandDeep),
              ),
              const SizedBox(height: 20),
              Text(
                title,
                style: const TextStyle(
                  fontSize: 24,
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 8),
              Text(
                description,
                // From the theme: hardcoding black made this invisible in dark
                // mode.
                style: TextStyle(
                  fontSize: 15,
                  height: 1.5,
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
              ),
              if (points.isNotEmpty) ...[
                const SizedBox(height: 20),
                for (final point in points)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 10),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Icon(Icons.check_circle,
                            size: 18, color: Pos.brandDeep),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Text(
                            point,
                            style: const TextStyle(fontSize: 14, height: 1.4),
                          ),
                        ),
                      ],
                    ),
                  ),
              ],
              if (managedInBackOffice) ...[
                const SizedBox(height: 12),
                Container(
                  padding: const EdgeInsets.all(14),
                  decoration: BoxDecoration(
                    color: Pos.brandSoft,
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: const Row(
                    children: [
                      Icon(Icons.settings_ethernet, size: 18, color: Pos.brandDeep),
                      SizedBox(width: 10),
                      Expanded(
                        child: Text(
                          'Configured in the Vesopa Back Office. Changes appear '
                          'here immediately — no restart needed.',
                          style: TextStyle(fontSize: 13, height: 1.4),
                        ),
                      ),
                    ],
                  ),
                ),
              ],
              if (action case (final label, final onTap)) ...[
                const SizedBox(height: 18),
                FilledButton.icon(
                  onPressed: onTap,
                  icon: const Icon(Icons.arrow_forward, size: 18),
                  label: Text(label),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
