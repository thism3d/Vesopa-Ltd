/// Orders arriving, as notifications that slide in from the side.
///
/// WHY NOT A BADGE
///
/// A badge is a number that waits to be noticed. That is the right shape for
/// "the printer is offline" — a state, true until somebody deals with it — and
/// the wrong shape for an order from a table, which is a *thing that just
/// happened* with somebody sitting down waiting for it. A clerk facing a
/// counter does not scan the top bar between customers, and the badge sat there
/// counting while the food went uncooked.
///
/// So an order announces itself the way the operating system announces
/// anything: it comes in from the edge of the screen, it says what it is, it
/// carries the two buttons that answer it, and it goes away again.
///
/// THEY STACK
///
/// Because a Friday brings three at once. Newest at the top, oldest sliding
/// down, and past [_maxVisible] the rest are a single line saying how many are
/// behind — which opens the full list rather than trying to show it.
///
/// THEY DO NOT TIME OUT
///
/// Deliberately, and this is where they part company with a Windows toast. A
/// notification about an email can afford to disappear; one about food somebody
/// has ordered and is waiting for cannot. It stays until it is accepted,
/// refused, or explicitly put aside — and putting it aside leaves it in the
/// list under Functions rather than throwing it away.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/dinein_orders.dart';
import '../data/order_alerts.dart';
import '../main.dart';
import 'dinein_actions.dart';
import 'dinein_sheet.dart' show showDineInOrders;
import 'theme.dart';
import 'widgets/basket_panel.dart' show money;

/// Wrap the whole till in this, once.
///
/// A Stack rather than an Overlay entry: the toasts belong to the shell, live
/// exactly as long as it does, and never need to outlive a route. An
/// OverlayEntry would need creating, updating and disposing by hand for
/// something that is simply "draw this above the page".
class DineInToastLayer extends ConsumerWidget {
  const DineInToastLayer({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final where = ref.watch(orderAlertsProvider);
    if (!where.showsToasts) return child;

    return Stack(
      children: [
        child,
        const Positioned(
          top: 0,
          right: 0,
          bottom: 0,
          width: 400,
          child: _ToastStack(),
        ),
      ],
    );
  }
}

class _ToastStack extends ConsumerStatefulWidget {
  const _ToastStack();

  @override
  ConsumerState<_ToastStack> createState() => _ToastStackState();
}

class _ToastStackState extends ConsumerState<_ToastStack> {
  /// The orders somebody has put aside on this terminal.
  ///
  /// Terminal-local and not remembered across a restart, on purpose: putting a
  /// notification aside means "I have seen it, stop showing me" and not "this
  /// order is dealt with". The order is still waiting, still in the list, and
  /// still on the till next door.
  final _setAside = <int>{};

  /// How many stay on screen before the rest become a single line.
  static const _maxVisible = 3;

  /// Orders being acted on, so a second press cannot start a second accept.
  final _busy = <int>{};

  @override
  Widget build(BuildContext context) {
    final orders = ref.watch(dineInOrdersProvider).value ?? const <DineInOrder>[];
    final waiting = [
      for (final order in orders)
        if (order.isWaiting && !_setAside.contains(order.id)) order,
    ]..sort((a, b) => b.placedAt.compareTo(a.placedAt));

    if (waiting.isEmpty) return const SizedBox.shrink();

    final shown = waiting.take(_maxVisible).toList();
    final hidden = waiting.length - shown.length;

    return SafeArea(
      child: Padding(
        // Clear of the top bar. Starting at the very top put the first
        // notification over Sign Off and the page selector — the two controls a
        // clerk needs *while* deciding what to do about the order it is
        // covering. 84 clears a two-row programmed bar; on a section with the
        // plain 46px bar the notifications simply hang a little lower, which
        // nobody minds.
        padding: const EdgeInsets.fromLTRB(12, 84, 12, 12),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            for (final order in shown)
              _Toast(
                key: ValueKey(order.id),
                order: order,
                busy: _busy.contains(order.id),
                onAccept: () => unawaited(_accept(order)),
                onRefuse: () => unawaited(_refuse(order)),
                onSetAside: () => setState(() => _setAside.add(order.id)),
              ),
            if (hidden > 0) _MoreLine(count: hidden),
          ],
        ),
      ),
    );
  }

  Future<void> _accept(DineInOrder order) async {
    if (_busy.contains(order.id)) return;
    setState(() => _busy.add(order.id));
    try {
      await acceptAndSay(context, ref, order);
    } finally {
      if (mounted) setState(() => _busy.remove(order.id));
    }
  }

  Future<void> _refuse(DineInOrder order) async {
    if (_busy.contains(order.id)) return;
    setState(() => _busy.add(order.id));
    try {
      await refuseWithReason(context, ref, order);
    } finally {
      if (mounted) setState(() => _busy.remove(order.id));
    }
  }
}

/// One notification.
class _Toast extends StatefulWidget {
  const _Toast({
    super.key,
    required this.order,
    required this.busy,
    required this.onAccept,
    required this.onRefuse,
    required this.onSetAside,
  });

  final DineInOrder order;
  final bool busy;
  final VoidCallback onAccept;
  final VoidCallback onRefuse;
  final VoidCallback onSetAside;

  @override
  State<_Toast> createState() => _ToastState();
}

class _ToastState extends State<_Toast> with SingleTickerProviderStateMixin {
  late final AnimationController _in = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 260),
  )..forward();

  @override
  void dispose() {
    _in.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final order = widget.order;
    final waited = DateTime.now().difference(order.placedAt);
    final late = waited.inMinutes >= 5;

    final slide = CurvedAnimation(parent: _in, curve: Curves.easeOutCubic);

    return SlideTransition(
      position: Tween<Offset>(
        begin: const Offset(1.05, 0),
        end: Offset.zero,
      ).animate(slide),
      child: FadeTransition(
        opacity: slide,
        child: Padding(
          padding: const EdgeInsets.only(bottom: 10),
          child: Material(
            elevation: 10,
            borderRadius: BorderRadius.circular(12),
            clipBehavior: Clip.antiAlias,
            color: theme.colorScheme.surfaceContainerHighest,
            child: Container(
              decoration: BoxDecoration(
                border: Border.all(color: theme.posLine),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  // The strip that says what kind of thing this is, the way an
                  // operating system's notification names the application it
                  // came from.
                  Container(
                    padding: const EdgeInsets.fromLTRB(12, 8, 6, 8),
                    color: late ? Pos.red : Pos.brandDeep,
                    child: Row(
                      children: [
                        const Icon(
                          Icons.qr_code_2,
                          size: 16,
                          color: Colors.white,
                        ),
                        const SizedBox(width: 8),
                        const Expanded(
                          child: Text(
                            'Order from a table',
                            style: TextStyle(
                              color: Colors.white,
                              fontSize: 12,
                              fontWeight: FontWeight.w700,
                              letterSpacing: 0.4,
                            ),
                          ),
                        ),
                        Text(
                          _waited(waited),
                          style: const TextStyle(
                            color: Colors.white,
                            fontSize: 11.5,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        // Put aside, not dismissed. The order stays in the list
                        // — this only stops it sitting over the sale screen.
                        IconButton(
                          tooltip: 'Put aside',
                          visualDensity: VisualDensity.compact,
                          onPressed: widget.onSetAside,
                          icon: const Icon(
                            Icons.close,
                            size: 16,
                            color: Colors.white,
                          ),
                        ),
                      ],
                    ),
                  ),

                  Padding(
                    padding: const EdgeInsets.fromLTRB(12, 10, 12, 12),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Row(
                          children: [
                            Expanded(
                              child: Text(
                                order.tableLabel.isEmpty
                                    ? 'A table'
                                    : order.tableLabel,
                                style: const TextStyle(
                                  fontSize: 16,
                                  fontWeight: FontWeight.w700,
                                ),
                              ),
                            ),
                            Text(
                              money(order.totalMinor),
                              style: const TextStyle(
                                fontSize: 16,
                                fontWeight: FontWeight.w800,
                              ),
                            ),
                          ],
                        ),
                        if (order.customerName != null)
                          Text(
                            order.customerName!,
                            style: const TextStyle(fontSize: 12.5),
                          ),
                        const SizedBox(height: 8),

                        // Three lines, then a count. A toast is a summons, not
                        // the bill — the whole order is one tap away and the
                        // point of this is to be readable at a glance.
                        for (final line in order.lines.take(3))
                          Padding(
                            padding: const EdgeInsets.symmetric(vertical: 1),
                            child: Text(
                              '${line.qty} × ${line.name}',
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(fontSize: 13.5),
                            ),
                          ),
                        if (order.lines.length > 3)
                          Text(
                            'and ${order.lines.length - 3} more',
                            style: TextStyle(
                              fontSize: 12.5,
                              color: theme.colorScheme.onSurfaceVariant,
                            ),
                          ),
                        if (order.note != null) ...[
                          const SizedBox(height: 6),
                          Row(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              const Icon(Icons.sticky_note_2_outlined, size: 14),
                              const SizedBox(width: 6),
                              Expanded(
                                child: Text(
                                  order.note!,
                                  maxLines: 2,
                                  overflow: TextOverflow.ellipsis,
                                  style: const TextStyle(
                                    fontSize: 12.5,
                                    fontStyle: FontStyle.italic,
                                  ),
                                ),
                              ),
                            ],
                          ),
                        ],

                        const SizedBox(height: 12),
                        if (widget.busy)
                          const Center(
                            child: Padding(
                              padding: EdgeInsets.symmetric(vertical: 6),
                              child: SizedBox(
                                width: 22,
                                height: 22,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                ),
                              ),
                            ),
                          )
                        else
                          Row(
                            children: [
                              Expanded(
                                child: OutlinedButton(
                                  onPressed: widget.onRefuse,
                                  style: OutlinedButton.styleFrom(
                                    foregroundColor: Pos.red,
                                    padding: const EdgeInsets.symmetric(
                                      vertical: 12,
                                    ),
                                  ),
                                  child: const Text('Cannot take it'),
                                ),
                              ),
                              const SizedBox(width: 8),
                              Expanded(
                                child: FilledButton.icon(
                                  onPressed: widget.onAccept,
                                  icon: const Icon(Icons.check, size: 18),
                                  label: const Text('Accept'),
                                  style: FilledButton.styleFrom(
                                    padding: const EdgeInsets.symmetric(
                                      vertical: 12,
                                    ),
                                  ),
                                ),
                              ),
                            ],
                          ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  static String _waited(Duration age) {
    if (age.inMinutes < 1) return 'just now';
    if (age.inMinutes < 60) return '${age.inMinutes} min';
    return '${age.inHours} h';
  }
}

/// What is behind the ones on screen.
class _MoreLine extends StatelessWidget {
  const _MoreLine({required this.count});

  final int count;

  @override
  Widget build(BuildContext context) => Material(
    elevation: 6,
    borderRadius: BorderRadius.circular(10),
    color: Theme.of(context).colorScheme.surfaceContainerHighest,
    child: InkWell(
      borderRadius: BorderRadius.circular(10),
      onTap: () => unawaited(showDineInOrders(context)),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.expand_more, size: 18),
            const SizedBox(width: 8),
            Text(
              count == 1 ? '1 more waiting' : '$count more waiting',
              style: const TextStyle(fontWeight: FontWeight.w600),
            ),
          ],
        ),
      ),
    ),
  );
}
