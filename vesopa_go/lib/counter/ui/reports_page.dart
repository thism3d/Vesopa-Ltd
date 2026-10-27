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

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
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
                  Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => Scaffold(appBar: AppBar(title: const Text('Reports')), body: _ReportBody(manager: m))));
                }
              },
              icon: const Icon(Icons.key_rounded),
              label: const Text('Manager\'s PIN'),
            ),
          ]),
        ),
      );
    }
    return const _ReportBody();
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
              Wrap(spacing: 10, runSpacing: 10, children: [
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

class _Stat extends StatelessWidget {
  const _Stat(this.label, this.value);
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Container(
      constraints: const BoxConstraints(minWidth: 120),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(border: Border.all(color: Theme.of(context).colorScheme.outlineVariant), borderRadius: BorderRadius.circular(14)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(label, style: t.bodySmall),
        Text(value, style: t.titleMedium?.copyWith(fontWeight: FontWeight.w800, fontFeatures: Tp.tabular)),
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
