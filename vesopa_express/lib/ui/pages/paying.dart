/// Paying, and the number.
///
/// The payment screen is dark and says one thing at a time, because the
/// customer is looking at two screens -- this one and the card machine's --
/// and this one's job is to send them to the other. It never offers Cancel
/// once a card is on the machine: the server will not walk away from a
/// payment in progress, and a button that could not work would be a lie.
library;

import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/basket.dart';
import '../../data/models.dart';
import '../../data/order_flow.dart';
import '../../data/receipts.dart';
import '../../data/session.dart';
import '../theme.dart';
import '../widgets/common.dart';
import '../widgets/marks.dart';

class PayingPage extends ConsumerWidget {
  const PayingPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final flow = ref.watch(orderFlowProvider);
    final config = ref.watch(kioskSessionProvider.select((s) => s.config));
    final reach = flow.reach;
    final s = flow.s;
    final order = flow.order;
    final n = ref.read(orderFlowProvider.notifier);
    final stage = order?.stage ?? PayStage.starting;
    // Under 760 tall (a kiosk on its side, a small tablet) everything comes
    // down a size; at 960 x 540 the full-size screen ran 170 px off the bottom.
    final short = MediaQuery.sizeOf(context).height < 760;

    final (title, sub) = switch (stage) {
      PayStage.starting => (s('starting'), s('present_card_sub')),
      PayStage.presentCard => (s('present_card'), s('present_card_sub')),
      PayStage.processing => (s('processing'), s('processing_sub')),
      PayStage.declined => (s('declined'), s('declined_sub')),
      PayStage.uncertain => (s('uncertain'), s('uncertain_sub')),
      PayStage.unavailable => (s('unavailable'), s('unavailable_sub')),
      _ => (s('processing'), s('processing_sub')),
    };

    final Widget art = switch (stage) {
      PayStage.declined => const _Badge(icon: Icons.credit_card_off_rounded, color: Xp.danger),
      PayStage.uncertain => const _Badge(icon: Icons.help_outline_rounded, color: Xp.amber),
      PayStage.unavailable => const _Badge(icon: Icons.portable_wifi_off_rounded, color: Xp.amber),
      PayStage.processing => const _Spinner(),
      _ => const _TapHere(),
    };

    final actions = <Widget>[
      if (stage.needsAnswer) ...[
        SizedBox(
          width: double.infinity,
          child: FilledButton(
            onPressed: flow.busy ? null : n.retryPayment,
            child: Text(s('try_again')),
          ),
        ),
        const SizedBox(height: 14),
        SizedBox(
          width: double.infinity,
          child: _GhostButton(label: s('cancel_order'), onTap: flow.busy ? null : n.cancelPayment),
        ),
      ] else if (stage == PayStage.presentCard || stage == PayStage.starting)
        _GhostButton(label: s('cancel'), onTap: flow.busy ? null : n.cancelPayment),
    ];

    final content = Padding(
      padding: EdgeInsets.symmetric(horizontal: 44, vertical: short ? 14 : 28),
      child: Column(
        children: [
          Row(children: [
            Expanded(
              child: Text(config?.venueName ?? '',
                  style: const TextStyle(color: Color(0xFFB9C1A8), fontSize: 20, fontWeight: FontWeight.w700)),
            ),
            if (config?.sandbox == true) Pill(s('sandbox'), color: Xp.amber),
          ]),
          const Spacer(),
          Text(money(order?.totalMinor ?? flow.basket.totalMinor),
              style: TextStyle(
                  fontFamily: Xp.numerals, fontSize: short ? 44 : 64, fontWeight: FontWeight.w800, color: Colors.white)),
          SizedBox(height: short ? 10 : 34),
          SizedBox(height: short ? 120 : 220, child: Center(child: FittedBox(child: art))),
          SizedBox(height: short ? 10 : 30),
          Text(title,
              textAlign: TextAlign.center,
              style: TextStyle(color: Colors.white, fontSize: short ? 28 : 40, fontWeight: FontWeight.w800, height: 1.1)),
          const SizedBox(height: 12),
          Text(sub,
              textAlign: TextAlign.center,
              style: TextStyle(color: const Color(0xFFCBD3BC), fontSize: short ? 18 : 22, fontWeight: FontWeight.w500)),
          if (flow.error != null) ...[
            const SizedBox(height: 16),
            Text(flow.error!,
                textAlign: TextAlign.center,
                style: const TextStyle(color: Color(0xFFFFB4A6), fontSize: 18, fontWeight: FontWeight.w700)),
          ],
          const Spacer(),
          ConstrainedBox(constraints: const BoxConstraints(maxWidth: 560), child: Column(children: actions)),
          const SizedBox(height: 18),
          if (!short && (stage == PayStage.presentCard || stage == PayStage.starting))
            const Icon(Icons.keyboard_double_arrow_down_rounded, color: Xp.lime, size: 56),
        ],
      ),
    );

    return ColoredBox(
      color: Xp.night,
      child: SafeArea(
        child: reach
            ? Column(children: [const Spacer(flex: 30), Expanded(flex: 70, child: content)])
            : content,
      ),
    );
  }
}

class _GhostButton extends StatelessWidget {
  const _GhostButton({required this.label, required this.onTap});
  final String label;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) => OutlinedButton(
    style: OutlinedButton.styleFrom(
      foregroundColor: Colors.white,
      side: BorderSide(color: Colors.white.withValues(alpha: .45), width: 2),
    ),
    onPressed: onTap,
    child: Text(label),
  );
}

/// The card-machine prompt: a contactless mark with rings flowing out of it,
/// down towards the machine.
class _TapHere extends StatefulWidget {
  const _TapHere();

  @override
  State<_TapHere> createState() => _TapHereState();
}

class _TapHereState extends State<_TapHere> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(seconds: 2))
    ..repeat();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: _c,
    builder: (context, _) => CustomPaint(
      size: const Size(220, 220),
      painter: _Rings(_c.value),
      child: const SizedBox(
        width: 220,
        height: 220,
        child: Center(child: Icon(Icons.contactless_rounded, size: 110, color: Xp.lime)),
      ),
    ),
  );
}

class _Rings extends CustomPainter {
  _Rings(this.t);
  final double t;

  @override
  void paint(Canvas canvas, Size size) {
    final centre = size.center(Offset.zero);
    for (var i = 0; i < 3; i++) {
      final p = (t + i / 3) % 1;
      canvas.drawCircle(
        centre,
        50 + p * (size.width / 2 - 50),
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 4
          ..color = Xp.lime.withValues(alpha: (1 - p) * .55),
      );
    }
  }

  @override
  bool shouldRepaint(covariant _Rings old) => old.t != t;
}

class _Spinner extends StatelessWidget {
  const _Spinner();

  @override
  Widget build(BuildContext context) => const SizedBox(
    width: 140,
    height: 140,
    child: CircularProgressIndicator(strokeWidth: 10, color: Xp.lime, backgroundColor: Xp.nightLine),
  );
}

class _Badge extends StatelessWidget {
  const _Badge({required this.icon, required this.color});
  final IconData icon;
  final Color color;

  @override
  Widget build(BuildContext context) => Container(
    width: 180,
    height: 180,
    decoration: BoxDecoration(color: color.withValues(alpha: .16), shape: BoxShape.circle),
    child: Icon(icon, size: 96, color: color),
  );
}

// ---------------------------------------------------------------------------
// The number
// ---------------------------------------------------------------------------

/// Thank you, and the number -- big enough to photograph, and on screen long
/// enough to. Then back to the start by itself: the next person is waiting.
class DonePage extends ConsumerStatefulWidget {
  const DonePage({super.key});

  @override
  ConsumerState<DonePage> createState() => _DonePageState();
}

/// Where the ticket has got to on this screen.
enum _Ticket { none, printing, printed, failed }

class _DonePageState extends ConsumerState<DonePage> with SingleTickerProviderStateMixin {
  static const _stay = Duration(seconds: 15);

  late final AnimationController _left = AnimationController(vsync: this, duration: _stay)..forward();
  Timer? _timer;
  _Ticket _ticket = _Ticket.none;

  @override
  void initState() {
    super.initState();
    _timer = Timer(_stay, () {
      if (mounted) ref.read(orderFlowProvider.notifier).reset();
    });
    // A venue that prints every time prints now, without being asked -- the
    // McDonald's way: the slip is out before the customer has looked for it.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (ref.read(kioskSessionProvider).config?.receipt.always ?? false) unawaited(_print());
    });
  }

  /// Print the ticket, once. A printer that fails costs the customer nothing
  /// but the paper: their number is on the screen and on the board.
  Future<void> _print() async {
    if (_ticket == _Ticket.printing || _ticket == _Ticket.printed) return;
    final printer = await ref.read(ticketPrinterProvider.future);
    final config = ref.read(kioskSessionProvider).config;
    final order = ref.read(orderFlowProvider).order;
    if (printer == null || config == null || order == null || !mounted) return;
    setState(() => _ticket = _Ticket.printing);
    try {
      await printOrderTicket(printer: printer, order: order, config: config);
      if (mounted) setState(() => _ticket = _Ticket.printed);
    } catch (e) {
      debugPrint('The ticket did not print: $e');
      if (mounted) setState(() => _ticket = _Ticket.failed);
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    _left.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final flow = ref.watch(orderFlowProvider);
    final s = flow.s;
    final order = flow.order;
    final skin = XpSkin.of(context);
    final number = order?.number ?? 0;
    final note = switch (order?.stage) {
      PayStage.counter => s('counter_note'),
      PayStage.demo => s('demo_note'),
      _ => s('watch_screen'),
    };
    final size = MediaQuery.sizeOf(context);
    final numberSize = math.min(220.0, math.min(size.width, size.height) * .26);
    // A ticket is offered only by a kiosk that has a printer, at a venue that
    // prints them. Nothing is drawn otherwise: a button that could not print
    // would be a promise the kiosk could not keep.
    final printer = ref.watch(ticketPrinterProvider).value;
    final face = ref.watch(kioskSessionProvider.select((st) => st.config?.receipt));
    final offer = printer != null && face != null && !face.never;

    final Widget? ticket = !offer
        ? null
        : switch (_ticket) {
            _Ticket.none when face.ask => OutlinedButton.icon(
                key: const ValueKey('print-receipt'),
                onPressed: () => unawaited(_print()),
                icon: const Icon(Icons.receipt_long_rounded, size: 28),
                label: Text(s('print_receipt')),
              ),
            _Ticket.none => null,
            _Ticket.printing || _Ticket.printed => Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  _ticket == _Ticket.printing
                      ? const SizedBox(width: 24, height: 24, child: CircularProgressIndicator(strokeWidth: 3))
                      : const Icon(Icons.receipt_long_rounded, color: Xp.limeDeep, size: 28),
                  const SizedBox(width: 12),
                  Text(s('receipt_printing'), style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w700)),
                ],
              ),
            _Ticket.failed => ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 560),
                child: Text(s('receipt_failed'),
                    textAlign: TextAlign.center,
                    style: const TextStyle(color: Xp.danger, fontSize: 17, fontWeight: FontWeight.w700)),
              ),
          };

    final content = Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TweenAnimationBuilder<double>(
              tween: Tween(begin: 0, end: 1),
              duration: const Duration(milliseconds: 600),
              curve: Curves.easeOutBack,
              builder: (context, v, child) => Transform.scale(scale: v, child: child),
              child: Container(
                width: 110,
                height: 110,
                decoration: const BoxDecoration(color: Xp.lime, shape: BoxShape.circle),
                child: const Icon(Icons.check_rounded, size: 72, color: Xp.ink),
              ),
            ),
            const SizedBox(height: 22),
            Text(s('thank_you'), style: Theme.of(context).textTheme.displayLarge),
            const SizedBox(height: 26),
            Text(s('your_number'), style: Theme.of(context).textTheme.headlineSmall?.copyWith(color: skin.inkSoft)),
            const SizedBox(height: 14),
            Container(
              padding: EdgeInsets.symmetric(horizontal: numberSize * .35, vertical: numberSize * .12),
              decoration: BoxDecoration(
                color: Xp.night,
                borderRadius: BorderRadius.circular(36),
                boxShadow: [BoxShadow(color: Xp.lime.withValues(alpha: .35), blurRadius: 50)],
              ),
              child: Text(
                '$number',
                style: TextStyle(
                  fontFamily: Xp.numerals,
                  fontSize: numberSize,
                  fontWeight: FontWeight.w800,
                  color: Xp.lime,
                  height: 1.05,
                ),
              ),
            ),
            const SizedBox(height: 26),
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 640),
              child: Text(note,
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w600)),
            ),
            if (order != null) ...[
              const SizedBox(height: 14),
              Text(
                '${order.orderType == 'eat_in' ? s('eat_in') : s('take_away')}  ·  ${money(order.totalMinor)}'
                '${order.customerName != null ? '  ·  ${order.customerName}' : ''}',
                style: TextStyle(color: skin.muted, fontSize: 18, fontWeight: FontWeight.w600),
              ),
            ],
            if (ticket != null) ...[
              const SizedBox(height: 22),
              ticket,
            ],
            const SizedBox(height: 34),
            SizedBox(
              width: 360,
              child: FilledButton(
                onPressed: () => ref.read(orderFlowProvider.notifier).reset(),
                child: Text(s('continue')),
              ),
            ),
            const SizedBox(height: 16),
            SizedBox(
              width: 360,
              child: AnimatedBuilder(
                animation: _left,
                builder: (context, _) => ClipRRect(
                  borderRadius: BorderRadius.circular(4),
                  child: LinearProgressIndicator(
                    value: 1 - _left.value,
                    minHeight: 6,
                    color: Xp.lime,
                    backgroundColor: skin.line,
                  ),
                ),
              ),
            ),
            const SizedBox(height: 30),
            const Row(mainAxisSize: MainAxisSize.min, children: [
              ExpressMark(size: 28),
              SizedBox(width: 8),
              Text('Vesopa Express', style: TextStyle(fontWeight: FontWeight.w700, color: Xp.muted)),
            ]),
          ],
        ),
      ),
    );

    return ColoredBox(
      color: skin.ground,
      child: SafeArea(
        child: flow.reach
            ? Column(children: [const Spacer(flex: 25), Expanded(flex: 75, child: content)])
            : content,
      ),
    );
  }
}
