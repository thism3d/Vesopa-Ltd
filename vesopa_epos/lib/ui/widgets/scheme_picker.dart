/// "Which loyalty scheme are they joining?" -- asked whenever the till adds a
/// customer.
///
/// "When creating a new customer on the till, it should ask which Loyalty
/// Scheme the customer wants to be part of." A row of large tiles rather than a
/// dropdown, because the clerk is reading them out to somebody across a counter
/// and each one says what it gives: "VIP · 10% off Drinks", "Member · 1 pt per
/// £1". The venue's default is already picked, so the common case is no tap at
/// all.
///
/// Draws nothing for a venue with no schemes, which adds customers exactly as
/// it did before schemes existed.
library;

import 'package:flutter/material.dart';

import '../../data/loyalty_schemes.dart';

/// The schemes a clerk may hand out: live, and offered at the till. A scheme
/// for the committee is one the venue sets in the back office.
List<LoyaltyScheme> tillSchemes(List<LoyaltyScheme> all) =>
    all.where((s) => s.offerAtTill).toList();

/// The scheme already picked for somebody new: the one a swiped card's prefix
/// names, else the venue's default, else none.
int? initialSchemeId(List<LoyaltyScheme> offered, {String? cardNumber}) {
  final card = (cardNumber ?? '').trim();
  if (card.isNotEmpty) {
    final byCard = offered
        .where((s) => s.cardPrefix.isNotEmpty && card.startsWith(s.cardPrefix))
        .toList()
      ..sort((a, b) => b.cardPrefix.length.compareTo(a.cardPrefix.length));
    if (byCard.isNotEmpty) return byCard.first.id;
  }
  return offered.where((s) => s.isDefault).firstOrNull?.id;
}

class SchemePicker extends StatelessWidget {
  const SchemePicker({
    super.key,
    required this.schemes,
    required this.selected,
    required this.onChanged,
  });

  /// Already filtered to the ones the till offers; see [tillSchemes].
  final List<LoyaltyScheme> schemes;
  final int? selected;
  final ValueChanged<int?> onChanged;

  @override
  Widget build(BuildContext context) {
    if (schemes.isEmpty) return const SizedBox.shrink();
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          'Loyalty scheme',
          style: theme.textTheme.labelLarge?.copyWith(
            fontWeight: FontWeight.w700,
          ),
        ),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final s in schemes)
              _Tile(
                key: ValueKey('scheme-${s.id}'),
                colour: s.color,
                name: s.name,
                detail: s.rewardLabel,
                on: selected == s.id,
                onTap: () => onChanged(s.id),
              ),
            _Tile(
              key: const ValueKey('scheme-none'),
              colour: theme.colorScheme.outline,
              name: 'No scheme',
              detail: 'Just a customer',
              on: selected == null,
              onTap: () => onChanged(null),
            ),
          ],
        ),
      ],
    );
  }
}

class _Tile extends StatelessWidget {
  const _Tile({
    super.key,
    required this.colour,
    required this.name,
    required this.detail,
    required this.on,
    required this.onTap,
  });

  final Color colour;
  final String name;
  final String detail;
  final bool on;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Semantics(
      selected: on,
      button: true,
      label: '$name, $detail',
      child: Material(
        color: on ? colour.withValues(alpha: 0.16) : scheme.surfaceContainerHigh,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(12),
          side: BorderSide(
            color: on ? colour : scheme.outlineVariant,
            width: on ? 2 : 1,
          ),
        ),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: ConstrainedBox(
            // A finger, not a cursor: 56 high at the least.
            constraints: const BoxConstraints(minWidth: 150, minHeight: 56),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(12, 8, 14, 8),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Container(
                    width: 14,
                    height: 14,
                    decoration: BoxDecoration(
                      color: colour,
                      shape: BoxShape.circle,
                    ),
                  ),
                  const SizedBox(width: 10),
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        name,
                        style: const TextStyle(
                          fontSize: 15,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      Text(
                        detail,
                        style: TextStyle(
                          fontSize: 12,
                          color: scheme.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                  if (on) ...[
                    const SizedBox(width: 8),
                    Icon(Icons.check_circle, size: 18, color: colour),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
