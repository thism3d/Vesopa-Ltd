/// The sale on this Go device, as a customer display reads it: the till's
/// basket format (vesopa_epos customer_display.dart; read by data/
/// basket_feed.dart), sent through [GoDisplayHub] whenever it changes.
library;

import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../config/constants.dart';
import '../../counter/data/lite_state.dart';
import '../../data/api.dart';
import '../../data/models.dart';
import '../../data/session.dart';
import 'display_hub.dart';

/// What a card payment is doing, for the display (set by the pay screens):
/// `{phase, title, detail, outcome, amount_minor, qr, heading}`, or null.
final displayCardProvider = NotifierProvider<DisplayCard, Map<String, Object?>?>(DisplayCard.new);

class DisplayCard extends Notifier<Map<String, Object?>?> {
  Timer? _clear;
  @override
  Map<String, Object?>? build() => null;

  void show(Map<String, Object?>? card, {Duration? clearAfter}) {
    _clear?.cancel();
    state = card;
    if (clearAfter != null) _clear = Timer(clearAfter, () => state = null);
  }
}

/// [bill] in the till's basket format.
Map<String, Object?> basketOf(Bill? bill, {String state = 'sale', Map<String, Object?>? card, String? terminal, int changeMinor = 0}) {
  final lines = <Map<String, Object?>>[];
  for (final l in bill?.lines ?? const <BillLine>[]) {
    lines.add({
      'name': l.product.name,
      'quantity': l.quantity,
      'total_minor': l.product.priceMinor * l.quantity,
      if (l.product.allergens.isNotEmpty) 'allergens': [for (final a in l.product.allergens) a.replaceAll('_', ' ')],
    });
    for (final c in l.choices) {
      lines.add({'name': c.name, 'quantity': l.quantity, 'total_minor': c.priceMinor * l.quantity, 'modifier': true});
    }
  }
  final member = bill?.member;
  return {
    'format': 1,
    'state': bill == null || lines.isEmpty ? (state == 'paid' ? 'paid' : 'idle') : state,
    'updated_at': DateTime.now().toIso8601String(),
    'lines': lines,
    'subtotal_minor': bill?.subtotalMinor ?? 0,
    'discount_minor': bill?.discountMinor ?? 0,
    'tax_minor': 0,
    'total_minor': bill?.totalMinor ?? 0,
    'paid_minor': bill?.paidMinor ?? 0,
    'change_minor': changeMinor,
    'terminal': ?terminal,
    if (member != null) 'customer_name': member.name,
    if (member != null) 'customer_points': member.pointsBalance.floor(),
    'card': ?card,
  };
}

/// Around the EPOS shell: keeps the hub connected and the bill flowing.
class GoDisplayFeed extends ConsumerStatefulWidget {
  const GoDisplayFeed({super.key, required this.child});
  final Widget child;
  @override
  ConsumerState<GoDisplayFeed> createState() => _GoDisplayFeedState();
}

class _GoDisplayFeedState extends ConsumerState<GoDisplayFeed> {
  bool _queued = false;
  String? _paidId;
  Timer? _thanks;
  StreamSubscription<String>? _scans;

  @override
  void initState() {
    super.initState();
    _configure();
  }

  @override
  void dispose() {
    _thanks?.cancel();
    _scans?.cancel();
    // The hub stays connected while the PIN pad is up between clerks, so a
    // display does not drop to its pairing screen every time the till locks.
    super.dispose();
  }

  /// A customer's card from the display: on the bill in front of the clerk.
  Future<void> _memberFromDisplay(String code) async {
    final id = ref.read(currentSaleProvider);
    if (id == null) return;
    try {
      final member = await ref.read(apiProvider).member(code);
      if (mounted) ref.read(tapProvider.notifier).setMember(id, member);
    } on TapApiError {
      // Not a member's card: the clerk sees no member and can ask.
    }
  }

  void _configure() {
    _scans ??= GoDisplayHub.instance.memberScans.listen(_memberFromDisplay);
    final session = ref.read(tapProvider.notifier);
    if (ref.read(tapProvider).demo || session.deviceId.isEmpty) return;
    GoDisplayHub.instance.configure(
      apiBase: apiBase,
      token: ref.read(apiProvider).token,
      device: 'go-${session.deviceId}',
      name: session.terminalName,
    );
    GoDisplayHub.instance.sendControl({
      'format': 1,
      'show_prices': true,
      'thank_you': 'Thank you',
      'thank_you_seconds': 12,
      'idle_seconds': 30,
      'bill_share': 55,
    });
  }

  void _push() {
    if (_queued) return;
    _queued = true;
    scheduleMicrotask(() {
      _queued = false;
      if (!mounted || _thanks?.isActive == true) return;
      final s = ref.read(tapProvider);
      final id = ref.read(currentSaleProvider);
      final bill = id == null ? null : s.bills[id];
      GoDisplayHub.instance.sendBasket(basketOf(bill, card: ref.read(displayCardProvider), terminal: ref.read(tapProvider.notifier).terminalName));
    });
  }

  @override
  Widget build(BuildContext context) {
    ref.listen(tapProvider.select((s) => s.bills), (_, _) => _push());
    ref.listen(currentSaleProvider, (_, _) => _push());
    ref.listen(displayCardProvider, (_, _) => _push());
    // A paid bill: the thank-you, for a few seconds, then the next sale.
    ref.listen(tapProvider.select((s) => s.lastClosed), (_, closed) {
      if (closed == null || closed.id == _paidId) return;
      _paidId = closed.id;
      final paid = closed.paidMinor;
      GoDisplayHub.instance.sendBasket(basketOf(closed, state: 'paid', changeMinor: paid > closed.totalMinor ? paid - closed.totalMinor : 0));
      _thanks?.cancel();
      _thanks = Timer(const Duration(seconds: 8), _push);
    });
    return widget.child;
  }
}
