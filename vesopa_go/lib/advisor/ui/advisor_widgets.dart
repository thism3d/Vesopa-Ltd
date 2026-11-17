/// The pieces every Vesopa AI answer is drawn from, in Go's own look: the
/// outlined stat boxes, the section cards and the ranked lime bars of Reports
/// (lib/counter/ui/reports_page.dart), so an answer reads like the rest of Go.
///
/// The server sends an answer as cards (vesopa_server/src/go_advisor_answers.js):
///
///   kpis     a row of stat boxes, each with its change against the period before
///   bars     ranked bars, or hour columns, optionally against a comparison
///   drivers  what made a difference, signed, adding up to the total
///   table    rows behind the figure, scrolled sideways on a phone
///   alerts   what needs attention
///
/// And under every answer, [AnswerMeta]: the period, what it is compared with,
/// the branch, what each figure means, how fresh the data is, and "View data".
library;

import 'package:flutter/material.dart';

import '../../ui/theme.dart';

// ---- numbers ------------------------------------------------------------------

/// Money with thousands separators: an owner reads £12,480.00 at a glance.
String aiMoney(num minor, {bool whole = false}) {
  final neg = minor < 0;
  final v = minor.abs().round();
  final pounds = (whole ? (v / 100).round() : v ~/ 100).toString().replaceAllMapped(RegExp(r'\B(?=(\d{3})+(?!\d))'), (_) => ',');
  return '${neg ? '-' : ''}£$pounds${whole ? '' : '.${(v % 100).toString().padLeft(2, '0')}'}';
}

String _num(num v) => v == v.roundToDouble() ? v.round().toString() : v.toStringAsFixed(1);

/// A value as the server labels its kind: money (pence), count, pct, days, text.
String formatValue(Object? value, String kind) {
  if (value == null) return '–';
  if (value is! num) return '$value';
  return switch (kind) {
    'money' => aiMoney(value),
    'pct' => '${_num(value)}%',
    'days' => '${_num(value)} d',
    _ => _num(value),
  };
}

List<Map<String, dynamic>> _maps(Object? list) => [for (final x in (list as List? ?? const [])) (x as Map).cast<String, dynamic>()];

// ---- frame ----------------------------------------------------------------------

/// A titled card, as Reports' sections.
class AiSection extends StatelessWidget {
  const AiSection({super.key, required this.title, this.subtitle, this.trailing, required this.children});
  final String title;
  final String? subtitle;
  final Widget? trailing;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(title, style: t.titleMedium?.copyWith(fontWeight: FontWeight.w800)),
                      if (subtitle != null) Text(subtitle!, style: t.bodySmall?.copyWith(color: context.goMuted)),
                    ],
                  ),
                ),
                ?trailing,
              ],
            ),
            const SizedBox(height: 12),
            ...children,
          ],
        ),
      ),
    );
  }
}

/// Two columns side by side when there is room (a tablet or a desktop), one otherwise.
class AiColumns extends StatelessWidget {
  const AiColumns({super.key, required this.children, this.breakpoint = 860});
  final List<Widget> children;
  final double breakpoint;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, box) {
      if (box.maxWidth < breakpoint || children.length < 2) {
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            for (var i = 0; i < children.length; i++) ...[if (i > 0) const SizedBox(height: 12), children[i]],
          ],
        );
      }
      final left = <Widget>[];
      final right = <Widget>[];
      for (var i = 0; i < children.length; i++) {
        (i.isEven ? left : right).add(Padding(padding: const EdgeInsets.only(bottom: 12), child: children[i]));
      }
      return Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: left),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: right),
          ),
        ],
      );
    },
  );
}

/// The Vesopa AI mark: Go's lime tile with a spark.
class AiMark extends StatelessWidget {
  const AiMark({super.key, this.size = 28});
  final double size;

  @override
  Widget build(BuildContext context) => Container(
    width: size,
    height: size,
    decoration: BoxDecoration(color: Tp.lime, borderRadius: BorderRadius.circular(size * 0.28)),
    child: Icon(Icons.auto_awesome_rounded, size: size * 0.6, color: Tp.onLime),
  );
}

// ---- kpis ------------------------------------------------------------------------

class AiStatGrid extends StatelessWidget {
  const AiStatGrid({super.key, required this.items});
  final List<Map<String, dynamic>> items;

  static const _gap = 10.0;
  static const _least = 140.0;

  @override
  Widget build(BuildContext context) {
    if (items.isEmpty) return const SizedBox.shrink();
    return LayoutBuilder(
      builder: (context, box) {
        final fit = ((box.maxWidth + _gap) / (_least + _gap)).floor().clamp(1, items.length);
        final rows = (items.length / fit).ceil();
        final perRow = (items.length / rows).ceil();
        return Column(
          children: [
            for (var start = 0; start < items.length; start += perRow) ...[
              if (start > 0) const SizedBox(height: _gap),
              IntrinsicHeight(
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    for (var i = start; i < start + perRow && i < items.length; i++) ...[if (i > start) const SizedBox(width: _gap), Expanded(child: AiStat(item: items[i]))],
                  ],
                ),
              ),
            ],
          ],
        );
      },
    );
  }
}

class AiStat extends StatelessWidget {
  const AiStat({super.key, required this.item});
  final Map<String, dynamic> item;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final kind = item['kind'] as String? ?? 'count';
    final change = item['change_pct'] as num?;
    final goodUp = (item['good_when'] as String? ?? 'up') == 'up';
    return Semantics(
      label: '${item['label']}: ${formatValue(item['value'], kind)}${change == null ? '' : ', ${change >= 0 ? 'up' : 'down'} ${_num(change.abs())}${kind == 'pct' ? ' points' : ' percent'}'}',
      excludeSemantics: true,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        decoration: BoxDecoration(
          border: Border.all(color: Theme.of(context).colorScheme.outlineVariant),
          borderRadius: BorderRadius.circular(14),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('${item['label']}', style: t.bodySmall, maxLines: 1, overflow: TextOverflow.ellipsis),
            FittedBox(
              fit: BoxFit.scaleDown,
              alignment: Alignment.centerLeft,
              child: Text(
                formatValue(item['value'], kind),
                style: t.titleLarge?.copyWith(fontWeight: FontWeight.w800, fontFeatures: Tp.tabular),
              ),
            ),
            if (change != null) ChangeChip(change: change, goodWhenUp: goodUp, points: kind == 'pct'),
          ],
        ),
      ),
    );
  }
}

/// ▲ 12.5% in green when that is good news, red when it is not.
class ChangeChip extends StatelessWidget {
  const ChangeChip({super.key, required this.change, this.goodWhenUp = true, this.points = false});
  final num change;
  final bool goodWhenUp;
  final bool points;

  @override
  Widget build(BuildContext context) {
    final up = change > 0;
    final flat = change == 0;
    final good = flat ? null : (up == goodWhenUp);
    final colour = good == null ? context.goMuted : (good ? Tp.green : Tp.danger);
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(flat ? Icons.remove_rounded : (up ? Icons.arrow_upward_rounded : Icons.arrow_downward_rounded), size: 14, color: colour),
        Text(
          '${_num(change.abs())}${points ? ' pts' : '%'}',
          style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: colour, fontFeatures: Tp.tabular),
        ),
      ],
    );
  }
}

// ---- bars -------------------------------------------------------------------------

class AiBars extends StatelessWidget {
  const AiBars({super.key, required this.card});
  final Map<String, dynamic> card;

  @override
  Widget build(BuildContext context) {
    final items = _maps(card['items']);
    final t = Theme.of(context).textTheme;
    if (items.isEmpty) return Text('Nothing in this period yet', style: t.bodySmall);
    final hourly = items.length > 1 && items.every((i) => RegExp(r'^\d\d$').hasMatch('${i['label']}'));
    if (hourly) return _HourColumns(items: items, compareLabel: card['compare_label'] as String?, kind: card['kind'] as String? ?? 'money');
    final signed = card['signed'] == true;
    final kind = card['kind'] as String? ?? 'money';
    final top = items.map((i) => ((i['value'] as num?) ?? 0).abs()).fold<num>(0, (a, b) => a > b ? a : b);
    final compareTop = items.map((i) => ((i['compare'] as num?) ?? 0).abs()).fold<num>(0, (a, b) => a > b ? a : b);
    final scale = (top > compareTop ? top : compareTop) <= 0 ? 1 : (top > compareTop ? top : compareTop);
    final track = Theme.of(context).colorScheme.outlineVariant.withValues(alpha: 0.5);
    return Column(
      children: [
        for (final i in items)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 5),
            child: Builder(
              builder: (context) {
                final v = (i['value'] as num?) ?? 0;
                final c = i['compare'] as num?;
                final colour = signed ? (v < 0 ? Tp.danger : Tp.green) : Tp.lime;
                return Semantics(
                  label: '${i['label']}: ${signed && v > 0 ? '+' : ''}${formatValue(v, kind)}${c != null && c != 0 ? ', before ${formatValue(c, kind)}' : ''}',
                  excludeSemantics: true,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Row(
                        children: [
                          Expanded(
                            child: Text('${i['label']}', overflow: TextOverflow.ellipsis, style: t.bodyMedium),
                          ),
                          if (c != null && c != 0)
                            Text(
                              'was ${formatValue(c, kind)}  ',
                              style: t.bodySmall?.copyWith(color: context.goMuted, fontFeatures: Tp.tabular),
                            ),
                          Text(
                            '${signed && v > 0 ? '+' : ''}${formatValue(v, kind)}',
                            style: t.bodyMedium?.copyWith(fontWeight: FontWeight.w700, fontFeatures: Tp.tabular, color: signed ? colour : null),
                          ),
                        ],
                      ),
                      const SizedBox(height: 4),
                      LayoutBuilder(
                        builder: (_, box) => Stack(
                          children: [
                            Container(
                              height: 8,
                              decoration: BoxDecoration(color: track, borderRadius: BorderRadius.circular(4)),
                            ),
                            if (c != null && c != 0)
                              Container(
                                height: 8,
                                width: (box.maxWidth * c.abs() / scale).clamp(4.0, box.maxWidth),
                                decoration: BoxDecoration(
                                  border: Border.all(color: context.goMuted.withValues(alpha: 0.7)),
                                  borderRadius: BorderRadius.circular(4),
                                ),
                              ),
                            TweenAnimationBuilder<double>(
                              tween: Tween(begin: 0, end: v.abs() / scale),
                              duration: const Duration(milliseconds: 500),
                              curve: Curves.easeOutCubic,
                              builder: (_, f, _) => Container(
                                height: 8,
                                width: (box.maxWidth * f).clamp(4.0, box.maxWidth),
                                decoration: BoxDecoration(color: colour, borderRadius: BorderRadius.circular(4)),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                );
              },
            ),
          ),
        if (items.any((i) => i['compare'] != null && i['compare'] != 0)) _Legend(compareLabel: card['compare_label'] as String? ?? 'Before'),
      ],
    );
  }
}

class _Legend extends StatelessWidget {
  const _Legend({required this.compareLabel});
  final String compareLabel;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme.bodySmall?.copyWith(color: context.goMuted);
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Wrap(
        spacing: 14,
        runSpacing: 4,
        children: [
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 14,
                height: 8,
                decoration: BoxDecoration(color: Tp.lime, borderRadius: BorderRadius.circular(3)),
              ),
              const SizedBox(width: 6),
              Text('This period', style: t),
            ],
          ),
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 14,
                height: 8,
                decoration: BoxDecoration(
                  border: Border.all(color: context.goMuted),
                  borderRadius: BorderRadius.circular(3),
                ),
              ),
              const SizedBox(width: 6),
              Flexible(
                child: Text(compareLabel, style: t, overflow: TextOverflow.ellipsis),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// Revenue by hour, as Reports draws it: the busiest hour in full lime, and
/// the comparison as an outline behind each column.
class _HourColumns extends StatelessWidget {
  const _HourColumns({required this.items, this.compareLabel, required this.kind});
  final List<Map<String, dynamic>> items;
  final String? compareLabel;
  final String kind;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final values = [for (final i in items) ((i['value'] as num?) ?? 0)];
    final compares = [for (final i in items) ((i['compare'] as num?) ?? 0)];
    final top = [...values, ...compares].fold<num>(0, (a, b) => a > b ? a : b);
    final best = values.fold<num>(0, (a, b) => a > b ? a : b);
    final busiest = values.indexOf(best);
    final hasCompare = compares.any((c) => c != 0);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SizedBox(
          height: 140,
          // A day with only a few trading hours keeps slim columns, centred.
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              for (var k = 0; k < items.length; k++)
                Flexible(
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 44),
                    child: Tooltip(
                      message: '${items[k]['label']}:00  ${formatValue(values[k], kind)}${hasCompare ? '  (was ${formatValue(compares[k], kind)})' : ''}',
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 2),
                        child: Stack(
                          alignment: Alignment.bottomCenter,
                          children: [
                            if (hasCompare)
                              FractionallySizedBox(
                                heightFactor: top == 0 ? 0.02 : (compares[k] / top).clamp(0.02, 1.0).toDouble(),
                                child: Container(
                                  decoration: BoxDecoration(
                                    border: Border.all(color: context.goMuted.withValues(alpha: 0.7)),
                                    borderRadius: BorderRadius.circular(4),
                                  ),
                                ),
                              ),
                            TweenAnimationBuilder<double>(
                              tween: Tween(begin: 0, end: top == 0 ? 0 : values[k] / top),
                              duration: const Duration(milliseconds: 600),
                              curve: Curves.easeOutCubic,
                              builder: (_, v, _) => FractionallySizedBox(
                                heightFactor: v.clamp(0.02, 1.0),
                                widthFactor: hasCompare ? 0.6 : 1,
                                child: Container(
                                  decoration: BoxDecoration(color: k == busiest ? Tp.lime : Tp.lime.withValues(alpha: 0.45), borderRadius: BorderRadius.circular(4)),
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ),
        const SizedBox(height: 6),
        Row(
          children: [
            Text('${items.first['label']}:00', style: t.bodySmall),
            Expanded(
              child: Text(
                best > 0 ? 'Busiest ${items[busiest]['label']}:00 · ${formatValue(best, kind)}' : '',
                textAlign: TextAlign.center,
                overflow: TextOverflow.ellipsis,
                style: t.bodySmall?.copyWith(fontWeight: FontWeight.w700),
              ),
            ),
            Text('${items.last['label']}:00', style: t.bodySmall),
          ],
        ),
        if (hasCompare) _Legend(compareLabel: compareLabel ?? 'Before'),
      ],
    );
  }
}

// ---- drivers -------------------------------------------------------------------------

class AiDrivers extends StatelessWidget {
  const AiDrivers({super.key, required this.card});
  final Map<String, dynamic> card;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final total = (card['total_minor'] as num?) ?? 0;
    final items = _maps(card['items']);
    Widget row(String label, String detail, num v, {bool bold = false}) => Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(label, style: t.bodyMedium?.copyWith(fontWeight: bold ? FontWeight.w800 : FontWeight.w600)),
                if (detail.isNotEmpty) Text(detail, style: t.bodySmall?.copyWith(color: context.goMuted)),
              ],
            ),
          ),
          Text(
            '${v > 0 ? '+' : ''}${aiMoney(v)}',
            style: t.titleMedium?.copyWith(fontWeight: FontWeight.w800, fontFeatures: Tp.tabular, color: v == 0 ? null : (v < 0 ? Tp.danger : Tp.green)),
          ),
        ],
      ),
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final i in items) row('${i['label']}', '${i['detail'] ?? ''}', (i['value_minor'] as num?) ?? 0),
        Divider(color: context.goLine),
        row('Difference', '', total, bold: true),
      ],
    );
  }
}

// ---- tables ----------------------------------------------------------------------------

class AiTable extends StatelessWidget {
  const AiTable({super.key, required this.columns, required this.rows, this.maxRows});
  final List<Map<String, dynamic>> columns;
  final List<Map<String, dynamic>> rows;
  final int? maxRows;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    if (rows.isEmpty) return Text('Nothing to show for this period', style: t.bodySmall);
    final shown = maxRows == null ? rows : rows.take(maxRows!).toList();
    final head = t.bodySmall?.copyWith(fontWeight: FontWeight.w800, color: context.goMuted);
    final cell = t.bodyMedium?.copyWith(fontFeatures: Tp.tabular);
    return LayoutBuilder(
      builder: (context, box) {
        final first = (box.maxWidth * 0.32).clamp(104.0, 260.0);
        const other = 84.0;
        final width = first + other * (columns.length - 1);
        final table = Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                for (var c = 0; c < columns.length; c++)
                  SizedBox(
                    width: c == 0 ? first : other,
                    child: Text('${columns[c]['label']}', style: head, textAlign: c == 0 ? TextAlign.left : TextAlign.right, overflow: TextOverflow.ellipsis),
                  ),
              ],
            ),
            const SizedBox(height: 6),
            for (final r in shown)
              Container(
                padding: const EdgeInsets.symmetric(vertical: 8),
                decoration: BoxDecoration(
                  border: Border(top: BorderSide(color: context.goLine.withValues(alpha: 0.6))),
                ),
                child: Row(
                  children: [
                    for (var c = 0; c < columns.length; c++)
                      SizedBox(
                        width: c == 0 ? first : other,
                        child: Text(
                          formatValue(r['${columns[c]['key']}'], columns[c]['kind'] as String? ?? 'text'),
                          style: c == 0 ? cell?.copyWith(fontWeight: FontWeight.w600) : cell,
                          textAlign: c == 0 ? TextAlign.left : TextAlign.right,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                  ],
                ),
              ),
          ],
        );
        if (width <= box.maxWidth) return table;
        return SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: SizedBox(width: width, child: table),
        );
      },
    );
  }
}

// ---- alerts and suggestions ----------------------------------------------------------------

class AiAlerts extends StatelessWidget {
  const AiAlerts({super.key, required this.items});
  final List<Map<String, dynamic>> items;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Column(
      children: [
        for (final a in items)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 4),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(
                  switch (a['tone']) {
                    'good' => Icons.trending_up_rounded,
                    'bad' => Icons.error_rounded,
                    _ => Icons.warning_amber_rounded,
                  },
                  color: switch (a['tone']) {
                    'good' => Tp.green,
                    'bad' => Tp.danger,
                    _ => Tp.amber,
                  },
                  size: 22,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('${a['title']}', style: t.bodyMedium?.copyWith(fontWeight: FontWeight.w800)),
                      if (a['detail'] != null) Text('${a['detail']}', style: t.bodySmall),
                    ],
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }
}

/// One suggestion: what to do, and the figure it rests on.
class AiSuggestion extends StatelessWidget {
  const AiSuggestion({super.key, required this.title, this.why, this.onOpen, this.index});
  final String title;
  final String? why;
  final VoidCallback? onOpen;
  final int? index;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return InkWell(
      borderRadius: BorderRadius.circular(12),
      onTap: onOpen,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 4),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              width: 26,
              height: 26,
              alignment: Alignment.center,
              decoration: BoxDecoration(color: Tp.lime.withValues(alpha: 0.22), borderRadius: BorderRadius.circular(8)),
              child: index == null
                  ? Icon(Icons.lightbulb_rounded, size: 16, color: context.goLimeInk)
                  : Text(
                      '$index',
                      style: TextStyle(fontWeight: FontWeight.w800, color: context.goLimeInk),
                    ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, style: t.bodyMedium?.copyWith(fontWeight: FontWeight.w800)),
                  if (why != null && why!.isNotEmpty) Text(why!, style: t.bodySmall),
                ],
              ),
            ),
            if (onOpen != null) Icon(Icons.chevron_right_rounded, color: context.goMuted),
          ],
        ),
      ),
    );
  }
}

// ---- one card, by type --------------------------------------------------------------------

/// A card from the server, in its section.
class AiCard extends StatelessWidget {
  const AiCard({super.key, required this.card, this.compact = false});
  final Map<String, dynamic> card;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final type = card['type'] as String? ?? '';
    final title = card['title'] as String?;
    final body = switch (type) {
      'kpis' => AiStatGrid(items: _maps(card['items'])),
      'bars' => AiBars(card: card),
      'drivers' => AiDrivers(card: card),
      'table' => AiTable(columns: _maps(card['columns']), rows: _maps(card['rows']), maxRows: compact ? 6 : null),
      'alerts' => AiAlerts(items: _maps(card['items'])),
      _ => const SizedBox.shrink(),
    };
    if (type == 'kpis') return body;
    return AiSection(title: title ?? (type == 'alerts' ? 'Needs attention' : ''), children: [body]);
  }
}

// ---- what every figure rests on ---------------------------------------------------------------

/// Period, comparison, branch, definitions, freshness, and the data itself.
class AnswerMeta extends StatelessWidget {
  const AnswerMeta({super.key, required this.meta, this.onViewData, this.aiNote});
  final Map<String, dynamic> meta;
  final VoidCallback? onViewData;
  final String? aiNote;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final period = (meta['period'] as Map?)?['label'] as String?;
    final compare = (meta['compare'] as Map?)?['label'] as String?;
    final site = (meta['site'] as Map?)?['label'] as String?;
    final fresh = meta['freshness'] as Map?;
    final last = fresh?['last_sale_at'] as String?;
    final defs = [for (final d in (meta['definitions'] as List? ?? const [])) '$d'];
    final small = t.bodySmall?.copyWith(color: context.goMuted);
    Widget fact(IconData icon, String text) => Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 14, color: context.goMuted),
          const SizedBox(width: 6),
          Expanded(child: Text(text, style: small)),
        ],
      ),
    );
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 10, 4, 4),
      decoration: BoxDecoration(
        color: context.goRaised.withValues(alpha: context.goDark ? 0.6 : 0.7),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (period != null) fact(Icons.date_range_rounded, compare == null ? period : '$period · against ${compare[0].toLowerCase()}${compare.substring(1)}'),
          if (site != null) fact(Icons.storefront_rounded, site),
          fact(
            Icons.update_rounded,
            last == null
                ? 'No sales recorded yet'
                : 'Latest sale received ${last.substring(0, 16)} · worked out ${(fresh?['computed_at'] as String? ?? '').length >= 16 ? (fresh!['computed_at'] as String).substring(11, 16) : ''}',
          ),
          if (aiNote != null) fact(Icons.info_outline_rounded, aiNote!),
          // Wraps on a narrow phone or with large text, rather than overflowing.
          Wrap(
            alignment: WrapAlignment.spaceBetween,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              if (defs.isNotEmpty)
                TextButton.icon(
                  style: TextButton.styleFrom(minimumSize: const Size(0, 40), padding: const EdgeInsets.symmetric(horizontal: 8)),
                  onPressed: () => showDialog<void>(
                    context: context,
                    builder: (c) => AlertDialog(
                      icon: const Icon(Icons.functions_rounded),
                      title: const Text('How this is worked out'),
                      content: SingleChildScrollView(
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            for (final d in defs) Padding(padding: const EdgeInsets.only(bottom: 8), child: Text(d)),
                            if (fresh?['note'] != null) Text('${fresh!['note']}', style: Theme.of(c).textTheme.bodySmall),
                            const SizedBox(height: 8),
                            Text(
                              'Every figure is calculated by the Vesopa server from your EPOS records. Vesopa AI only explains it and never changes anything.',
                              style: Theme.of(c).textTheme.bodySmall,
                            ),
                          ],
                        ),
                      ),
                      actions: [TextButton(onPressed: () => Navigator.pop(c), child: const Text('Done'))],
                    ),
                  ),
                  icon: const Icon(Icons.functions_rounded, size: 18),
                  label: const Text('Definitions'),
                ),
              if (onViewData != null)
                TextButton.icon(
                  style: TextButton.styleFrom(minimumSize: const Size(0, 40), padding: const EdgeInsets.symmetric(horizontal: 8), foregroundColor: context.goLimeInk),
                  onPressed: onViewData,
                  icon: const Icon(Icons.table_rows_rounded, size: 18),
                  label: const Text('View data'),
                ),
            ],
          ),
        ],
      ),
    );
  }
}
