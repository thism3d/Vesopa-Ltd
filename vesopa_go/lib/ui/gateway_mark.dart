/// Which payment company took the card, with that company's own logo (owner,
/// 2026-11-07: "show the used gateway ... maybe the original icon"). On the
/// paid screen and in Settings. Each logo stays on white, its own colours
/// untouched, so it reads the same in Night and Day.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_svg/flutter_svg.dart';

import '../data/session.dart';
import '../payments/payment_service.dart';
import '../payments/stripe_tap.dart';
import '../payments/teya_machine.dart';
import '../counter/ui/brand.dart' show GoMark;
import 'theme.dart';

enum CardGateway {
  // Vesopa's own payments (Stripe underneath): branded Vesopa, never Stripe
  // (owner, 2026-11-18: "Don't brand Stripe directly, brand Vesopa Tap to Pay").
  stripe('Vesopa Pay', ''),
  dojo('Dojo', 'assets/marks/gateway_dojo.png'),
  teya('Teya', 'assets/marks/gateway_teya.svg');

  const CardGateway(this.label, this.asset);
  final String label;
  final String asset;
}

/// The gateway this device's cards go through; none in the demo.
CardGateway? gatewayOf(PaymentService pay) => switch (pay) {
  StripeTapToPay() => CardGateway.stripe,
  TeyaCardMachine() => CardGateway.teya,
  DojoCardMachine() => CardGateway.dojo,
  _ => null,
};

final cardGatewayProvider = Provider<CardGateway?>((ref) => gatewayOf(ref.watch(paymentsProvider)));

/// Stripe's own view of this venue: test or live, and whether its account can
/// take cards. Null on any other gateway, or when the server cannot be asked.
final stripeStatusProvider = FutureProvider.autoDispose<({bool live, bool ready})?>((ref) async {
  if (ref.watch(cardGatewayProvider) != CardGateway.stripe) return null;
  try {
    final c = await ref.read(apiProvider).stripeConfig();
    return (live: c['environment'] == 'live', ready: c['ready'] == true);
  } on Object {
    return null;
  }
});

/// "Paid with [logo]" or "Card payments by [logo]". Nothing when no gateway
/// took the card.
class GatewayBadge extends ConsumerWidget {
  const GatewayBadge({super.key, this.label = 'Paid with'});

  final String label;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final gateway = ref.watch(cardGatewayProvider);
    if (gateway == null) return const SizedBox.shrink();
    const height = 22.0;
    final logo = gateway.asset.isEmpty
        ? Row(mainAxisSize: MainAxisSize.min, children: [
            const GoMark(size: height),
            const SizedBox(width: 6),
            Text(gateway.label, style: const TextStyle(color: Color(0xFF111111), fontWeight: FontWeight.w800, fontSize: 15, height: 1)),
          ])
        : gateway.asset.endsWith('.svg')
            ? SvgPicture.asset(gateway.asset, height: height, fit: BoxFit.contain, semanticsLabel: gateway.label)
            : Image.asset(gateway.asset, height: height, fit: BoxFit.contain, semanticLabel: gateway.label);
    return Row(
      mainAxisSize: MainAxisSize.min,
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        if (label.isNotEmpty) ...[
          Text(label, style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: context.goMuted)),
          const SizedBox(width: 10),
        ],
        Container(
          key: ValueKey('gateway-${gateway.name}'),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
          decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(8)),
          child: logo,
        ),
      ],
    );
  }
}
