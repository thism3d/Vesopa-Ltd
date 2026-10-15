import 'package:flutter/material.dart';

import '../data/basket_feed.dart';
import 'theme.dart';

/// What the card machine is doing, over the whole screen, while the till takes
/// a card.
///
/// Dojo's accreditation asked that the customer can see where the payment is
/// up to and how it ended, and that the answer stays up long enough to read.
/// The till decides how long: this draws whatever the file says and goes away
/// when the till clears it.
class CardOverlay extends StatelessWidget {
  const CardOverlay({super.key, required this.card});

  final CardStatus card;

  @override
  Widget build(BuildContext context) {
    final (icon, colour) = _look(card);
    return ColoredBox(
      color: Brand.panel.withValues(alpha: 0.96),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 720),
          child: Padding(
            padding: const EdgeInsets.all(32),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (card.heading != null) ...[
                  Text(
                    card.heading!.toUpperCase(),
                    style: const TextStyle(
                      color: Brand.inkSoft,
                      fontSize: 22,
                      fontWeight: FontWeight.w600,
                      letterSpacing: 2,
                    ),
                  ),
                  const SizedBox(height: 8),
                ],
                if (card.amountMinor > 0)
                  Text(
                    money(card.amountMinor),
                    style: const TextStyle(
                      color: Brand.ink,
                      fontSize: 56,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                const SizedBox(height: 28),
                AnimatedSwitcher(
                  duration: const Duration(milliseconds: 250),
                  child: card.isResult
                      ? Icon(icon, key: ValueKey(icon), size: 120, color: colour)
                      : SizedBox(
                          key: const ValueKey('progress'),
                          width: 120,
                          height: 120,
                          child: Stack(
                            alignment: Alignment.center,
                            children: [
                              const SizedBox.expand(
                                child: CircularProgressIndicator(
                                  strokeWidth: 6,
                                  color: Brand.lime,
                                ),
                              ),
                              Icon(icon, size: 56, color: colour),
                            ],
                          ),
                        ),
                ),
                const SizedBox(height: 28),
                Text(
                  _title(card),
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    color: card.isResult ? colour : Brand.ink,
                    fontSize: 44,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                if (_detail(card) != null) ...[
                  const SizedBox(height: 14),
                  Text(
                    _detail(card)!,
                    textAlign: TextAlign.center,
                    style: const TextStyle(color: Brand.inkSoft, fontSize: 26),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }

  static (IconData, Color) _look(CardStatus c) {
    if (!c.isResult) {
      final t = c.title.toLowerCase();
      if (t.contains('sign')) return (Icons.draw_outlined, Brand.ink);
      return (Icons.contactless_outlined, Brand.ink);
    }
    if (c.approved) return (Icons.check_circle_rounded, Brand.lime);
    if (c.uncertain) return (Icons.hourglass_top_rounded, Colors.amber);
    return switch (c.outcome) {
      'cancelled' => (Icons.cancel_outlined, Brand.inkSoft),
      'busy' => (Icons.hourglass_empty_rounded, Colors.amber),
      // A card that did not go through is not an alarm. No red warning in
      // front of the queue (Nicki, Pontardawe RFC, 2026-10-15): a quiet card
      // icon in the soft ink, and the till says the rest to the clerk.
      _ => (Icons.credit_card_outlined, Brand.inkSoft),
    };
  }

  /// A payment that did not go through, in words that do not embarrass the
  /// customer, whatever an older till sends.
  static bool _notThrough(CardStatus c) =>
      c.isResult && const {'declined', 'failed', 'signatureRejected'}.contains(c.outcome);

  static String _title(CardStatus c) {
    if (!_notThrough(c)) return c.title;
    return (c.heading ?? '').toLowerCase().contains('refund') ? 'Refund not completed' : 'Payment not completed';
  }

  static String? _detail(CardStatus c) {
    if (!_notThrough(c)) return c.detail;
    return (c.heading ?? '').toLowerCase().contains('refund')
        ? 'Nothing went back to your card. Please ask a member of staff.'
        : 'Please try again, or pay another way. No money has been taken.';
  }
}
