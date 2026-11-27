/// The day on this device at a glance, and the End of day.
///
/// The headline is what the customers paid (net). Under it, the four
/// numbers a manager asks first, how it was paid, and what sold, by
/// category and by item, as ranked bars in one colour with the value printed
/// beside each: a share is read off a bar's length more surely than off a
/// wedge, and a bar list stays readable on a five-inch screen.
///
/// The back office's reports cover every terminal and any period; this is
/// the device's own day, there with or without a signal.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:vesopa_go/data/api.dart';
import 'package:vesopa_go/data/models.dart';
import 'package:vesopa_go/data/session.dart';
import 'package:vesopa_go/ui/theme.dart';

import '../data/day_report.dart';
import '../data/journal.dart';
import 'receipt_print.dart';
import 'receipt_view.dart';

class ReportsPage extends ConsumerWidget {
  const ReportsPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = Theme.of(context).textTheme;
    final s = ref.watch(tapProvider);
    final go = s.config.go;
    // The venue decides whether clerks see the day's takings (back office).
    // The till's X report key decides who reads the day (and the venue's option).
    final manager = s.clerk?.can(TillPermission.xReport) ?? false;
    if (!go.reportsClerks && !manager && !s.demo) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            const Icon(Icons.lock_rounded, size: 48),
            const SizedBox(height: 12),
            Text('Reports are for managers', style: t.titleLarge),
            const SizedBox(height: 6),
            const Text('A manager can open them here with their PIN, or the venue can let every clerk see them in the back office.', textAlign: TextAlign.center),
            const SizedBox(height: 16),
            FilledButton.icon(
              onPressed: () async {
                final m = await askManager(context, ref, why: 'Open the reports', permission: TillPermission.xReport);
                if (m != null && context.mounted) {
                  Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => Scaffold(appBar: AppBar(title: const Text('Reports')), body: _ReportTabs(manager: m))));
                }
              },
              icon: const Icon(Icons.key_rounded),
              label: const Text('Manager\'s PIN'),
            ),
          ]),
        ),
      );
    }
    return const _ReportTabs();
  }
}

class _ReportBody extends ConsumerWidget {
  const _ReportBody({this.manager});

  /// Who opened the reports with their PIN, when a clerk could not.
  final String? manager;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final j = ref.watch(journalProvider);
    final r = DayReport.of(j.sales);
    final t = Theme.of(context).textTheme;
    final since = j.dayStarted ?? r.from;
    final go = ref.watch(tapProvider.select((s) => s.config.go));

    return LayoutBuilder(builder: (context, box) {
      final two = box.maxWidth >= 760;
      final left = <Widget>[
        Card(
          child: Padding(
            padding: const EdgeInsets.all(18),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(since == null ? 'Today' : 'Since ${ddmmyy(since)} ${hhmm(since)}', style: t.bodySmall),
              const SizedBox(height: 4),
              Text('Net sales', style: t.titleSmall),
              Money(r.netMinor, style: t.displaySmall?.copyWith(fontWeight: FontWeight.w900)),
              const SizedBox(height: 14),
              _StatGrid([
                _Stat('Sales', '${r.sales}'),
                _Stat('Average', money(r.averageMinor)),
                _Stat('Discounts', money(r.discountMinor)),
                _Stat('Refunds', r.refundCount == 0 ? money(0) : '${money(r.refundsMinor)} (${r.refundCount})'),
              ]),
            ]),
          ),
        ),
        const SizedBox(height: 12),
        _Section(title: 'Payments', children: [
          _Line('Cash', r.cashMinor),
          _Line('Card', r.cardMinor),
          if (r.tapMinor > 0 && r.machineMinor > 0) ...[
            _Line('   on this device', r.tapMinor),
            _Line('   on the card machine', r.machineMinor),
          ],
          if (r.tipsMinor > 0) _Line('Tips (on top)', r.tipsMinor),
          if (r.refundCashMinor > 0) _Line('Cash refunded', -r.refundCashMinor),
          if (r.refundCardMinor > 0) _Line('Card refunded', -r.refundCardMinor),
          const Divider(),
          _Line('Cash in the drawer', r.cashInDrawerMinor, bold: true),
        ]),
        const SizedBox(height: 12),
        if (go.reportsStaff)
          _Section(title: 'Staff', subtitle: 'Sales, tips, refunds', children: [
            for (final c in r.byClerk) ...[
              _Line('${c.label} (${c.count})', c.minor),
              if ((r.tipsByClerk[c.label] ?? 0) > 0) _Line('   tips', r.tipsByClerk[c.label]!),
              if ((r.refundsByClerk[c.label] ?? 0) > 0) _Line('   refunded', -r.refundsByClerk[c.label]!),
            ],
            if (r.byClerk.isEmpty) Text('No sales yet', style: t.bodySmall),
          ]),
      ];
      final right = <Widget>[
        if (go.reportsHourly) ...[
          _Section(title: 'Sales by the hour', subtitle: 'Net', children: [_Hours(r.byHour)]),
          const SizedBox(height: 12),
        ],
        _Section(title: 'By category', subtitle: 'Before discounts', children: [_Bars(r.byCategory, total: r.grossMinor)]),
        if (go.reportsProducts) ...[
          const SizedBox(height: 12),
          _Section(title: 'Product mix', subtitle: 'Top 15 by value', children: [_Bars(r.byProduct.take(15).toList(), total: r.grossMinor, counts: true)]),
        ],
      ];
      final end = <Widget>[
        const SizedBox(height: 16),
        Row(children: [
          Expanded(
            child: OutlinedButton.icon(
              onPressed: j.sales.isEmpty ? null : () => printReport(context, ref, r, title: 'X report', since: since),
              icon: const Icon(Icons.print_rounded),
              label: const Text('Print X report'),
            ),
          ),
          if (go.reportsZ) ...[
            const SizedBox(width: 12),
            Expanded(
              flex: 2,
              child: FilledButton.icon(
                key: const ValueKey('end-of-day'),
                onPressed: j.sales.isEmpty ? null : () => _endOfDay(context, ref, r),
                icon: const Icon(Icons.lock_clock_rounded),
                label: const Text('End of day (Z)'),
              ),
            ),
          ],
        ]),
        if (j.zs.isNotEmpty) ...[
          const SizedBox(height: 20),
          Text('Past End of days', style: t.titleMedium),
          for (final z in j.zs.take(14))
            ListTile(
              contentPadding: EdgeInsets.zero,
              title: Text('Z ${z.number} · ${ddmmyy(z.to)}'),
              subtitle: Text('${z.sales} sales · cash ${money(z.cashMinor)} · card ${money(z.cardMinor)} · by ${z.by}'),
              trailing: Money(z.netMinor),
            ),
        ],
      ];

      return ListView(padding: const EdgeInsets.all(16), children: [
        if (two)
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Expanded(child: Column(children: left)),
            const SizedBox(width: 12),
            Expanded(child: Column(children: right)),
          ])
        else ...[...left, const SizedBox(height: 12), ...right],
        ...end,
      ]);
    });
  }

  Future<void> _endOfDay(BuildContext context, WidgetRef ref, DayReport r) async {
    final manager = await askManager(context, ref, why: 'End of day', permission: TillPermission.zReport);
    if (manager == null || !context.mounted) return;
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('End the day?'),
        content: Text('${r.sales} sales, ${money(r.netMinor)}. Count ${money(r.cashInDrawerMinor)} in the drawer.\n\n'
            'Today\'s sales leave this device and a new day starts. The back office keeps every sale.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Not yet')),
          FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('End the day')),
        ],
      ),
    );
    if (ok != true) return;
    final j = ref.read(journalProvider);
    final zTitle = 'Z report ${j.nextZ}';
    final zSince = j.dayStarted ?? r.from;
    ref.read(journalProvider.notifier).endOfDay(
          summary: ZSummary(
            number: j.nextZ,
            from: j.dayStarted ?? r.from ?? DateTime.now(),
            to: DateTime.now(),
            sales: r.sales,
            netMinor: r.netMinor,
            cashMinor: r.cashMinor,
            cardMinor: r.cardMinor,
            refundsMinor: r.refundsMinor,
            by: manager,
          ),
        );
    if (context.mounted) {
      // The Z prints as the till's does, from the figures the day closed on.
      printReport(context, ref, r, title: zTitle, since: zSince, by: manager);
      final pending = ref.read(tapProvider).pendingSync;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(pending > 0 ? 'Day ended. $pending sales still to reach the back office: keep the device online.' : 'Day ended.'),
      ));
    }
  }
}

/// The stat boxes, sharing the whole width of the card.
///
/// A Wrap left each box at its own width, so the row stopped short and an
/// empty strip sat beside the last box (the owner, 2026-11-16). Here every row
/// is filled edge to edge: as many boxes as fit at a readable width, and a
/// short last row stretches rather than leaving a hole.
class _StatGrid extends StatelessWidget {
  const _StatGrid(this.stats);
  final List<Widget> stats;

  static const _gap = 10.0;
  static const _least = 132.0;

  @override
  Widget build(BuildContext context) {
    if (stats.isEmpty) return const SizedBox.shrink();
    return LayoutBuilder(builder: (context, box) {
      final fit = ((box.maxWidth + _gap) / (_least + _gap)).floor().clamp(1, stats.length);
      // Even rows where the count allows: four boxes on a phone are two and
      // two, never three and one.
      final rows = (stats.length / fit).ceil();
      final perRow = (stats.length / rows).ceil();
      return Column(children: [
        for (var start = 0; start < stats.length; start += perRow) ...[
          if (start > 0) const SizedBox(height: _gap),
          IntrinsicHeight(
            child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              for (var i = start; i < start + perRow && i < stats.length; i++) ...[
                if (i > start) const SizedBox(width: _gap),
                Expanded(child: stats[i]),
              ],
            ]),
          ),
        ],
      ]);
    });
  }
}

class _Stat extends StatelessWidget {
  const _Stat(this.label, this.value, {this.rolling = false});
  final String label;
  final String value;

  /// The digits roll when the value changes (the live venue report).
  final bool rolling;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(border: Border.all(color: Theme.of(context).colorScheme.outlineVariant), borderRadius: BorderRadius.circular(14)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(label, style: t.bodySmall),
        // Scaled down rather than clipped when a long figure meets a narrow box.
        FittedBox(
          fit: BoxFit.scaleDown,
          alignment: Alignment.centerLeft,
          child: rolling
              ? RollingText(value, style: t.titleMedium?.copyWith(fontWeight: FontWeight.w800, fontFeatures: Tp.tabular))
              : Text(value, style: t.titleMedium?.copyWith(fontWeight: FontWeight.w800, fontFeatures: Tp.tabular)),
        ),
      ]),
    );
  }
}

class _Section extends StatelessWidget {
  const _Section({required this.title, this.subtitle, required this.children});
  final String title;
  final String? subtitle;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Row(crossAxisAlignment: CrossAxisAlignment.baseline, textBaseline: TextBaseline.alphabetic, children: [
            Flexible(child: Text(title, overflow: TextOverflow.ellipsis, style: t.titleMedium?.copyWith(fontWeight: FontWeight.w800))),
            if (subtitle != null) ...[const SizedBox(width: 8), Flexible(child: Text(subtitle!, overflow: TextOverflow.ellipsis, style: t.bodySmall))],
          ]),
          const SizedBox(height: 8),
          ...children,
        ]),
      ),
    );
  }
}

class _Line extends StatelessWidget {
  const _Line(this.label, this.minor, {this.bold = false});
  final String label;
  final int minor;
  final bool bold;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final style = bold ? t.titleMedium?.copyWith(fontWeight: FontWeight.w800) : t.bodyMedium;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(children: [Expanded(child: Text(label, style: style)), Money(minor, style: style)]),
    );
  }
}

/// Ranked bars, one hue: the label and value in text colour, the bar beside.
class _Bars extends StatelessWidget {
  const _Bars(this.slices, {required this.total, this.counts = false});
  final List<Slice> slices;
  final int total;
  final bool counts;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final track = Theme.of(context).colorScheme.outlineVariant.withValues(alpha: 0.5);
    if (slices.isEmpty) return Text('No sales yet', style: t.bodySmall);
    final top = slices.first.minor <= 0 ? 1 : slices.first.minor;
    return Column(children: [
      for (final s in slices)
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 5),
          child: Semantics(
            label: '${s.label}: ${money(s.minor)}${total > 0 ? ', ${(s.minor * 100 / total).round()} percent' : ''}',
            excludeSemantics: true,
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Row(children: [
                Expanded(child: Text(counts ? '${s.count}× ${s.label}' : s.label, overflow: TextOverflow.ellipsis, style: t.bodyMedium)),
                if (total > 0) Text('${(s.minor * 100 / total).round()}%  ', style: t.bodySmall?.copyWith(fontFeatures: Tp.tabular)),
                Money(s.minor, style: t.bodyMedium?.copyWith(fontWeight: FontWeight.w700)),
              ]),
              const SizedBox(height: 4),
              LayoutBuilder(
                builder: (_, box) => Stack(children: [
                  Container(height: 8, decoration: BoxDecoration(color: track, borderRadius: BorderRadius.circular(4))),
                  Container(
                    height: 8,
                    width: (box.maxWidth * s.minor / top).clamp(4.0, box.maxWidth),
                    decoration: BoxDecoration(color: Tp.lime, borderRadius: BorderRadius.circular(4)),
                  ),
                ]),
              ),
            ]),
          ),
        ),
    ]);
  }
}

/// Net sales by the hour, as columns from the first hour traded to the last.
class _Hours extends StatelessWidget {
  const _Hours(this.byHour);
  final Map<int, int> byHour;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    if (byHour.isEmpty) return Text('No sales yet', style: t.bodySmall);
    final first = byHour.keys.reduce((a, b) => a < b ? a : b);
    final last = byHour.keys.reduce((a, b) => a > b ? a : b);
    final top = byHour.values.reduce((a, b) => a > b ? a : b);
    final busiest = byHour.entries.firstWhere((e) => e.value == top).key;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      SizedBox(
        height: 140,
        child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
          for (var h = first; h <= last; h++)
            Expanded(
              child: Tooltip(
                message: '${h.toString().padLeft(2, '0')}:00  ${money(byHour[h] ?? 0)}',
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 2),
                  child: TweenAnimationBuilder<double>(
                    tween: Tween(begin: 0, end: top == 0 ? 0 : (byHour[h] ?? 0) / top),
                    duration: const Duration(milliseconds: 600),
                    curve: Curves.easeOutCubic,
                    builder: (_, v, _) => FractionallySizedBox(
                      heightFactor: v.clamp(0.02, 1.0),
                      alignment: Alignment.bottomCenter,
                      child: Container(decoration: BoxDecoration(color: h == busiest ? Tp.lime : Tp.lime.withValues(alpha: 0.45), borderRadius: BorderRadius.circular(4))),
                    ),
                  ),
                ),
              ),
            ),
        ]),
      ),
      const SizedBox(height: 6),
      Row(children: [
        Text('${first.toString().padLeft(2, '0')}:00', style: t.bodySmall),
        Expanded(
          child: Text('Busiest ${busiest.toString().padLeft(2, '0')}:00 · ${money(top)}',
              textAlign: TextAlign.center, overflow: TextOverflow.ellipsis, style: t.bodySmall?.copyWith(fontWeight: FontWeight.w700)),
        ),
        if (last != first) Text('${last.toString().padLeft(2, '0')}:00', style: t.bodySmall),
      ]),
    ]);
  }
}

/// This device's day, or the whole venue's today (every till and Go device),
/// live from the back office.
class _ReportTabs extends ConsumerStatefulWidget {
  const _ReportTabs({this.manager});
  final String? manager;
  @override
  ConsumerState<_ReportTabs> createState() => _ReportTabsState();
}

class _ReportTabsState extends ConsumerState<_ReportTabs> {
  /// The whole venue first, except in the demo, which has no back office.
  /// 0: today across the venue, 1: every back-office report, 2: this device.
  late int _tab = ref.read(tapProvider).demo ? 2 : 0;

  @override
  Widget build(BuildContext context) {
    final demo = ref.watch(tapProvider.select((s) => s.demo));
    return Column(children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
        child: SegmentedButton<int>(
          showSelectedIcon: false,
          segments: [
            const ButtonSegment(value: 0, icon: Icon(Icons.storefront_rounded), label: Text('Today')),
            if (!demo) const ButtonSegment(value: 1, icon: Icon(Icons.analytics_rounded), label: Text('All reports')),
            const ButtonSegment(value: 2, icon: Icon(Icons.phone_iphone_rounded), label: Text('This device')),
          ],
          selected: {_tab},
          onSelectionChanged: (v) => setState(() => _tab = v.first),
        ),
      ),
      Expanded(
        child: switch (_tab) {
          0 => const _VenueBody(),
          1 => const _AllReports(),
          _ => _ReportBody(manager: widget.manager),
        },
      ),
    ]);
  }
}

/// Today across the venue, from /api/tap/today, asked again every 15
/// seconds while it is open; numbers roll to their new value.
class _VenueBody extends ConsumerStatefulWidget {
  const _VenueBody();
  @override
  ConsumerState<_VenueBody> createState() => _VenueBodyState();
}

class _VenueBodyState extends ConsumerState<_VenueBody> {
  Map<String, dynamic>? _r;
  String? _error;
  Timer? _timer;
  DateTime? _at;

  @override
  void initState() {
    super.initState();
    _load();
    _timer = Timer.periodic(const Duration(seconds: 15), (_) => _load());
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final r = await ref.read(apiProvider).today();
      if (mounted) {
        setState(() {
          _r = r;
          _error = null;
          _at = DateTime.now();
        });
      }
    } on TapApiError catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final r = _r;
    final go = ref.watch(tapProvider.select((s) => s.config.go));
    if (r == null) {
      return Center(child: _error == null ? const CircularProgressIndicator() : Padding(padding: const EdgeInsets.all(24), child: Text(_error!, textAlign: TextAlign.center)));
    }
    int n(Object? v) => v is num ? v.toInt() : (num.tryParse('${v ?? ''}') ?? 0).toInt();
    List<Map<String, dynamic>> list(String k) => [for (final x in (r[k] as List? ?? const [])) Map<String, dynamic>.from(x as Map)];
    final net = n(r['net_minor']);
    final gross = list('departments').fold<int>(0, (s, d) => s + n(d['total_minor']));
    String method(String m) => switch (m.toLowerCase()) {
          'cash' => 'Cash',
          'card' || 'dojo' || 'machine' || 'tap' => 'Card',
          'teya' => 'Card (Teya)',
          'voucher' => 'Voucher',
          'gift_card' || 'gift' => 'Gift card',
          'points' => 'Points',
          _ => m.isEmpty ? 'Other' : '${m[0].toUpperCase()}${m.substring(1).replaceAll('_', ' ')}',
        };
    return LayoutBuilder(builder: (context, box) {
      final two = box.maxWidth >= 900;
      final left = <Widget>[
        Card(
          child: Padding(
            padding: const EdgeInsets.all(18),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Expanded(child: Text('Today, every till and device', style: t.bodySmall)),
                if (_at != null) ...[
                  const _LiveDot(),
                  const SizedBox(width: 6),
                  Text('Live · ${hhmm(_at!)}', style: t.bodySmall),
                ],
              ]),
              const SizedBox(height: 4),
              Text('Net sales', style: t.titleSmall),
              RollingText(money(net), style: t.displaySmall?.copyWith(fontWeight: FontWeight.w900, fontFeatures: Tp.tabular)),
              const SizedBox(height: 14),
              _StatGrid([
                _Stat('Sales', '${n(r['sales'])}', rolling: true),
                _Stat('Average', money(n(r['average_minor'])), rolling: true),
                _Stat('Discounts', money(n(r['discount_minor'])), rolling: true),
                if (n(r['tips_minor']) > 0) _Stat('Tips', money(n(r['tips_minor'])), rolling: true),
                if (n(r['covers']) > 0) _Stat('Covers', '${n(r['covers'])}', rolling: true),
              ]),
            ]),
          ),
        ),
        const SizedBox(height: 12),
        _Section(title: 'Payments', children: [
          for (final p in list('payments')) _Line('${method('${p['method']}')} (${n(p['count'])})', n(p['total_minor'])),
          if (list('payments').isEmpty) Text('No sales yet', style: t.bodySmall),
        ]),
        if (go.reportsStaff) ...[
          const SizedBox(height: 12),
          _Section(title: 'Staff', subtitle: 'Sales today', children: [
            for (final c in list('staff')) _Line('${c['name']} (${n(c['count'])})', n(c['total_minor'])),
            if (list('staff').isEmpty) Text('No sales yet', style: t.bodySmall),
          ]),
        ],
      ];
      final right = <Widget>[
        if (go.reportsHourly) ...[
          _Section(title: 'Sales by the hour', subtitle: 'Net', children: [
            _Hours({for (final h in list('hours')) n(h['hour']): n(h['total_minor'])}),
          ]),
          const SizedBox(height: 12),
        ],
        _Section(title: 'By department', subtitle: 'Before discounts', children: [
          _Bars([for (final d in list('departments')) Slice('${d['name']}', n(d['total_minor']))], total: gross),
        ]),
        if (go.reportsProducts) ...[
          const SizedBox(height: 12),
          _Section(title: 'Product mix', subtitle: 'Top 15 by value', children: [
            _Bars([for (final p in list('products')) Slice('${p['name']}', n(p['total_minor']), count: n(p['quantity']))], total: gross, counts: true),
          ]),
        ],
      ];
      return RefreshIndicator(
        onRefresh: _load,
        child: ListView(padding: const EdgeInsets.all(16), children: [
          if (two)
            Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Expanded(child: Column(children: left)),
              const SizedBox(width: 12),
              Expanded(child: Column(children: right)),
            ])
          else ...[...left, const SizedBox(height: 12), ...right],
        ]),
      );
    });
  }
}

/// A small green light that says the figures are live.
class _LiveDot extends StatelessWidget {
  const _LiveDot();
  @override
  Widget build(BuildContext context) => Container(width: 8, height: 8, decoration: const BoxDecoration(color: Tp.green, shape: BoxShape.circle));
}

/// Text whose characters roll to their new value when it changes, like an
/// odometer: each digit that changed slides up out and the new one in.
class RollingText extends StatelessWidget {
  const RollingText(this.text, {super.key, this.style});
  final String text;
  final TextStyle? style;

  @override
  Widget build(BuildContext context) => Row(mainAxisSize: MainAxisSize.min, children: [
        for (var i = 0; i < text.length; i++)
          AnimatedSwitcher(
            duration: const Duration(milliseconds: 420),
            switchInCurve: Curves.easeOutCubic,
            switchOutCurve: Curves.easeInCubic,
            transitionBuilder: (child, anim) {
              final incoming = child.key == ValueKey('$i${text[i]}');
              return ClipRect(
                child: SlideTransition(
                  position: Tween(begin: Offset(0, incoming ? 1 : -1), end: Offset.zero).animate(anim),
                  child: FadeTransition(opacity: anim, child: child),
                ),
              );
            },
            child: Text(text[i], key: ValueKey('$i${text[i]}'), style: style),
          ),
      ]);
}


/// Every report the back office runs, on Go (owner, 2026-11-26: managers,
/// and Vesopa, read every report here "without touching the back office"):
/// the report, the period and the terminal, then its tables. The back office
/// runs it (/api/tap/reports/run) and checks the PIN of whoever asks.
class _AllReports extends ConsumerStatefulWidget {
  const _AllReports();
  @override
  ConsumerState<_AllReports> createState() => _AllReportsState();
}

class _AllReportsState extends ConsumerState<_AllReports> {
  Map<String, dynamic>? _catalogue;
  Map<String, dynamic>? _result;
  String? _error;
  bool _busy = false;
  String? _report;
  String _period = 'today';
  String? _terminal;
  DateTimeRange? _custom;

  /// Whoever runs it: the clerk signed on, or a manager who typed their PIN.
  Clerk? _reader;

  @override
  void initState() {
    super.initState();
    _reader = ref.read(tapProvider).clerk;
    _loadCatalogue();
  }

  Future<void> _loadCatalogue() async {
    try {
      final c = await ref.read(apiProvider).reportCatalogue();
      if (!mounted) return;
      final reports = (c['reports'] as List? ?? const []);
      setState(() {
        _catalogue = c;
        _report ??= reports.isEmpty ? null : '${(reports.first as Map)['key']}';
        _error = null;
      });
    } on TapApiError catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  String _day(DateTime d) => '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

  Future<void> _run({bool askPin = false}) async {
    final report = _report;
    if (report == null || _busy) return;
    var reader = _reader;
    if (askPin || reader == null) {
      reader = await _askReaderPin();
      if (reader == null) return;
      _reader = reader;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final r = await ref.read(apiProvider).runReport(
            report: report,
            period: _period,
            from: _period == 'custom' && _custom != null ? _day(_custom!.start) : null,
            to: _period == 'custom' && _custom != null ? _day(_custom!.end) : null,
            terminal: _terminal,
            clerkId: reader.id,
            pin: reader.pin,
          );
      if (mounted) setState(() => _result = r);
    } on TapApiError catch (e) {
      if (!mounted) return;
      setState(() => _error = e.message);
      // Not allowed for this clerk: a manager's PIN, then the same report.
      if (e.status == 403 && !askPin) {
        setState(() => _busy = false);
        return _run(askPin: true);
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// A manager's PIN, typed here, matched to the venue's staff.
  Future<Clerk?> _askReaderPin() async {
    final staff = ref.read(tapProvider).staff;
    final ctl = TextEditingController();
    final pin = await showDialog<String>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('Manager\'s PIN'),
        content: TextField(
          controller: ctl,
          autofocus: true,
          obscureText: true,
          keyboardType: TextInputType.number,
          decoration: const InputDecoration(hintText: 'PIN'),
          onSubmitted: (v) => Navigator.pop(c, v),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(c, ctl.text), child: const Text('Run')),
        ],
      ),
    );
    if (pin == null || pin.isEmpty) return null;
    final found = staff.where((c) => c.pin == pin).firstOrNull;
    if (found == null && mounted) setState(() => _error = 'That PIN is not one of this venue\'s staff.');
    return found;
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final c = _catalogue;
    if (c == null) {
      return Center(
        child: _error == null
            ? const CircularProgressIndicator()
            : Padding(
                padding: const EdgeInsets.all(24),
                child: Column(mainAxisSize: MainAxisSize.min, children: [
                  Text(_error!, textAlign: TextAlign.center),
                  const SizedBox(height: 12),
                  OutlinedButton(onPressed: _loadCatalogue, child: const Text('Try again')),
                ]),
              ),
      );
    }
    List<Map<String, dynamic>> list(String k) => [for (final x in (c[k] as List? ?? const [])) Map<String, dynamic>.from(x as Map)];
    final groups = {for (final g in list('groups')) '${g['key']}': '${g['label']}'};
    final reports = list('reports');
    final ranges = list('ranges');
    final terminals = list('terminals');
    final r = _result;
    return ListView(padding: const EdgeInsets.all(16), children: [
      Card(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            DropdownButtonFormField<String>(
              isExpanded: true,
              initialValue: _report,
              decoration: const InputDecoration(labelText: 'Report'),
              items: [
                for (final rep in reports)
                  DropdownMenuItem(
                    value: '${rep['key']}',
                    child: Text('${groups['${rep['group']}'] ?? ''}${groups['${rep['group']}'] == null ? '' : ' · '}${rep['label']}', overflow: TextOverflow.ellipsis),
                  ),
              ],
              onChanged: (v) => setState(() => _report = v),
            ),
            const SizedBox(height: 12),
            Wrap(spacing: 8, runSpacing: 8, children: [
              for (final g in ranges)
                ChoiceChip(
                  label: Text('${g['label']}'),
                  selected: _period == '${g['key']}',
                  onSelected: (_) async {
                    final key = '${g['key']}';
                    if (key == 'custom') {
                      final now = DateTime.now();
                      final picked = await showDateRangePicker(
                        context: context,
                        firstDate: DateTime(now.year - 5),
                        lastDate: now,
                        initialDateRange: _custom ?? DateTimeRange(start: now.subtract(const Duration(days: 7)), end: now),
                      );
                      if (picked == null) return;
                      _custom = picked;
                    }
                    setState(() => _period = key);
                  },
                ),
            ]),
            if (_period == 'custom' && _custom != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text('${ddmmyy(_custom!.start)} to ${ddmmyy(_custom!.end)}', style: t.bodySmall),
              ),
            if (terminals.isNotEmpty) ...[
              const SizedBox(height: 12),
              DropdownButtonFormField<String?>(
                isExpanded: true,
                initialValue: _terminal,
                decoration: const InputDecoration(labelText: 'Terminal'),
                items: [
                  const DropdownMenuItem<String?>(value: null, child: Text('All terminals')),
                  for (final term in terminals) DropdownMenuItem<String?>(value: '${term['value'] ?? term['key'] ?? term['label']}', child: Text('${term['label']}')),
                ],
                onChanged: (v) => setState(() => _terminal = v),
              ),
            ],
            const SizedBox(height: 16),
            FilledButton.icon(
              onPressed: _busy || _report == null ? null : () => _run(),
              icon: _busy ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)) : const Icon(Icons.play_arrow_rounded),
              label: Text(_busy ? 'Running…' : 'Run report'),
            ),
            if (_error != null) Padding(padding: const EdgeInsets.only(top: 10), child: Text(_error!, style: t.bodyMedium?.copyWith(color: Tp.danger))),
          ]),
        ),
      ),
      if (r != null) ...[
        const SizedBox(height: 12),
        Text('${r['title'] ?? 'Report'}', style: t.titleLarge?.copyWith(fontWeight: FontWeight.w800)),
        Text('${r['terminalLabel'] ?? 'All terminals'}', style: t.bodySmall?.copyWith(color: context.goMuted)),
        for (final sec in (r['sections'] as List? ?? const [])) _ReportTable(section: Map<String, dynamic>.from(sec as Map)),
      ],
    ]);
  }
}

/// One table of a report: its columns, rows and total, scrolling sideways on
/// a phone.
class _ReportTable extends StatelessWidget {
  const _ReportTable({required this.section});
  final Map<String, dynamic> section;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final columns = [for (final c in (section['columns'] as List? ?? const [])) Map<String, dynamic>.from(c as Map)];
    final rows = [for (final r in (section['rows'] as List? ?? const [])) [for (final v in ((r as Map)['values'] as List? ?? const [])) '${v ?? ''}']];
    final total = section['total'] is Map ? [for (final v in ((section['total'] as Map)['values'] as List? ?? const [])) '${v ?? ''}'] : null;
    bool numeric(Map<String, dynamic> c) => c['type'] == 'money' || c['type'] == 'number' || c['type'] == 'percent';
    List<DataCell> cells(List<String> vs, {bool bold = false}) => [
          for (var i = 0; i < columns.length; i++)
            DataCell(Text(i < vs.length ? vs[i] : '', style: bold ? const TextStyle(fontWeight: FontWeight.w800) : null)),
        ];
    return Card(
      margin: const EdgeInsets.only(top: 12),
      clipBehavior: Clip.antiAlias,
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        if ('${section['title'] ?? ''}'.isNotEmpty)
          Padding(padding: const EdgeInsets.fromLTRB(16, 14, 16, 4), child: Text('${section['title']}', style: t.titleMedium?.copyWith(fontWeight: FontWeight.w700))),
        if (rows.isEmpty)
          const Padding(padding: EdgeInsets.all(16), child: Text('Nothing in this period.'))
        else
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: DataTable(
              headingRowHeight: 40,
              dataRowMinHeight: 36,
              dataRowMaxHeight: 48,
              columns: [for (final c in columns) DataColumn(label: Text('${c['label'] ?? c['key']}'), numeric: numeric(c))],
              rows: [
                for (final r in rows) DataRow(cells: cells(r)),
                if (total != null) DataRow(cells: cells(total, bold: true)),
              ],
            ),
          ),
      ]),
    );
  }
}
