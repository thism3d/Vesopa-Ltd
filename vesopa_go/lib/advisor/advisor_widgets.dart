/// The pieces of a Vesopa AI answer on Go: headline, reasons, charts, what to
/// do next, and how it was worked out (period, site, definition, freshness,
/// and the records behind it). Drawn in Go's own colours (theme.dart): lime
/// for "this period", the quiet raised grey for "compared with", danger red
/// only for a loss.
library;

import 'package:flutter/material.dart';

import '../ui/theme.dart';

typedef Json = Map<String, dynamic>;

/// Lime as text: raw lime on a light ground is too pale to read, so Day takes
/// the till's deep lime, as the rest of Go does.
extension AiInk on BuildContext {
  Color get aiInk => goDark ? Tp.lime : const Color(0xFF6E8A0E);
}

List<String> strings(Object? v) => v is List ? v.map((e) => '$e').toList() : const [];
List<Json> maps(Object? v) => v is List ? v.whereType<Map>().map((e) => e.cast<String, dynamic>()).toList() : const [];

String moneyText(num minor) {
  final v = minor / 100;
  final abs = v.abs().toStringAsFixed(2).replaceAllMapped(RegExp(r'\B(?=(\d{3})+(?!\d))'), (_) => ',');
  return '${v < 0 ? '-' : ''}£$abs';
}

String unitText(Object? unit, num v) {
  if (unit == 'money') return moneyText(v);
  if (unit == 'pct' || unit == 'percent') return '$v%';
  return v == v.roundToDouble() ? '${v.toInt()}' : '$v';
}

/// The small lime "AI" tile Vesopa AI wears everywhere.
class AiMark extends StatelessWidget {
  const AiMark({super.key, this.size = 32});
  final double size;
  @override
  Widget build(BuildContext context) => Container(
        width: size,
        height: size,
        alignment: Alignment.center,
        decoration: BoxDecoration(color: Tp.lime, borderRadius: BorderRadius.circular(size * 0.3)),
        child: Text('AI', style: TextStyle(color: Tp.onLime, fontWeight: FontWeight.w900, fontSize: size * 0.38, letterSpacing: .5)),
      );
}

class AnswerCard extends StatelessWidget {
  const AnswerCard({super.key, required this.answer, this.kicker, this.onAsk, this.onRecords});
  final Json answer;
  final String? kicker;
  final void Function(String question)? onAsk;
  final void Function(Json record)? onRecords;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final why = strings(answer['why']);
    final next = strings(answer['next']);
    final charts = maps(answer['charts']);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          if (kicker != null) ...[
            Text(kicker!.toUpperCase(), style: t.labelSmall?.copyWith(color: context.aiInk, fontWeight: FontWeight.w800, letterSpacing: .6)),
            const SizedBox(height: 6),
          ],
          Text('${answer['headline'] ?? ''}', style: t.titleLarge?.copyWith(fontWeight: FontWeight.w800, height: 1.25)),
          if (why.isNotEmpty) ...[
            const SizedBox(height: 10),
            for (final w in why) _Bullet(w),
          ],
          for (final c in charts) ...[
            const SizedBox(height: 16),
            Text('${c['title'] ?? ''}', style: t.labelLarge?.copyWith(color: context.goMuted, fontWeight: FontWeight.w700)),
            const SizedBox(height: 8),
            AdvisorChart(chart: c),
          ],
          if (next.isNotEmpty) ...[
            const SizedBox(height: 14),
            Container(
              padding: const EdgeInsets.fromLTRB(14, 12, 14, 8),
              decoration: BoxDecoration(color: Tp.lime.withValues(alpha: context.goDark ? 0.14 : 0.16), borderRadius: BorderRadius.circular(12)),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('WHAT YOU COULD DO', style: t.labelSmall?.copyWith(fontWeight: FontWeight.w800, color: context.goMuted, letterSpacing: .6)),
                const SizedBox(height: 6),
                for (var i = 0; i < next.length; i++) _Bullet(next[i], number: i + 1),
              ]),
            ),
          ],
          MetaPanel(answer: answer, onRecords: onRecords),
          if (onAsk != null && maps(answer['charts']).isEmpty && strings(answer['follow_ups']).isNotEmpty && answer['intent'] == 'help') ...[
            const SizedBox(height: 8),
            SuggestionChips(questions: strings(answer['follow_ups']), onAsk: onAsk!),
          ],
        ]),
      ),
    );
  }
}

class _Bullet extends StatelessWidget {
  const _Bullet(this.text, {this.number});
  final String text;
  final int? number;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 6),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          SizedBox(
            width: 22,
            child: number == null
                ? Padding(padding: const EdgeInsets.only(top: 8), child: Container(width: 6, height: 6, decoration: BoxDecoration(color: context.aiInk, shape: BoxShape.circle)))
                : Text('$number.', style: const TextStyle(fontWeight: FontWeight.w800)),
          ),
          Expanded(child: Text(text, style: const TextStyle(fontSize: 15, height: 1.4))),
        ]),
      );
}

/// Period · compared with · site, and on a tap the definition, the data's
/// freshness, how the words were written, and the records.
class MetaPanel extends StatelessWidget {
  const MetaPanel({super.key, required this.answer, this.onRecords});
  final Json answer;
  final void Function(Json record)? onRecords;

  @override
  Widget build(BuildContext context) {
    final m = answer['meta'];
    if (m is! Map) return const SizedBox.shrink();
    final meta = m.cast<String, dynamic>();
    final records = maps(answer['records']);
    final source = answer['source'] == 'ai'
        ? 'Explained by DeepSeek. Every figure checked against your sales.'
        : '${answer['checked'] ?? ''} Written from your figures.'.trim();
    Widget pill(String text) => Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
          decoration: BoxDecoration(color: context.goRaised, borderRadius: BorderRadius.circular(20)),
          child: Text(text, style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: context.goText)),
        );
    Widget row(String k, Object? v) => v == null || '$v'.isEmpty
        ? const SizedBox.shrink()
        : Padding(
            padding: const EdgeInsets.only(bottom: 6),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              SizedBox(width: 110, child: Text(k, style: TextStyle(color: context.goMuted, fontSize: 13))),
              Expanded(child: Text('$v', style: const TextStyle(fontSize: 13, height: 1.35))),
            ]),
          );
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: Theme(
        data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
        child: ExpansionTile(
          tilePadding: EdgeInsets.zero,
          childrenPadding: const EdgeInsets.only(bottom: 4),
          shape: Border(top: BorderSide(color: context.goLine)),
          collapsedShape: Border(top: BorderSide(color: context.goLine)),
          title: Wrap(spacing: 6, runSpacing: 6, children: [
            if (meta['period'] != null) pill('${meta['period']}'),
            if (meta['compare'] != null) pill('vs ${meta['compare']}'),
            if (meta['site'] != null) pill('${meta['site']}'),
          ]),
          subtitle: Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Text('How this was worked out', style: TextStyle(color: context.aiInk, fontWeight: FontWeight.w700, fontSize: 13)),
          ),
          children: [
            row('Period', meta['from'] == null ? meta['period'] : '${meta['period']} (${'${meta['from']}'.substring(0, 16)} to ${'${meta['to']}'.substring(0, 16)})'),
            row('Compared with', meta['compare']),
            row('Site', meta['site']),
            row('Definition', meta['definition']),
            row('Data freshness', meta['freshness']),
            row('Missing data', meta['notice']),
            row('Wording', source),
            if (records.isNotEmpty && onRecords != null)
              Align(
                alignment: Alignment.centerLeft,
                child: Wrap(spacing: 8, runSpacing: 8, children: [
                  for (final r in records)
                    OutlinedButton.icon(
                      style: OutlinedButton.styleFrom(minimumSize: const Size(0, 44)),
                      icon: const Icon(Icons.table_rows_rounded, size: 18),
                      label: Text('See the records: ${r['label']}', style: const TextStyle(fontSize: 13)),
                      onPressed: () => onRecords!(r),
                    ),
                ]),
              ),
          ],
        ),
      ),
    );
  }
}

class SuggestionChips extends StatelessWidget {
  const SuggestionChips({super.key, required this.questions, required this.onAsk});
  final List<String> questions;
  final void Function(String) onAsk;
  @override
  Widget build(BuildContext context) => Wrap(spacing: 8, runSpacing: 8, children: [
        for (final q in questions)
          ActionChip(
            label: Text(q, style: TextStyle(color: context.aiInk, fontWeight: FontWeight.w700)),
            backgroundColor: Tp.lime.withValues(alpha: context.goDark ? 0.12 : 0.14),
            side: BorderSide.none,
            onPressed: () => onAsk(q),
          ),
      ]);
}

/// The answer's charts: ranked bars, this period against the one before,
/// winners and losers either side of nought, a plain bar per day, or a table.
class AdvisorChart extends StatelessWidget {
  const AdvisorChart({super.key, required this.chart});
  final Json chart;

  @override
  Widget build(BuildContext context) {
    final rows = maps(chart['rows']);
    final unit = chart['unit'];
    if (rows.isEmpty) return Text('No sales to draw.', style: TextStyle(color: context.goMuted));
    num v(Json r, [String k = 'value']) => (r[k] as num?) ?? 0;
    switch (chart['type']) {
      case 'ranked':
      case 'bar':
        final max = rows.map((r) => v(r).abs()).fold<num>(1, (a, b) => b > a ? b : a);
        return Column(children: [
          for (final r in rows)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                Row(children: [
                  Expanded(child: Text('${r['label']}', maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w600))),
                  Text(unitText(unit, v(r)), style: const TextStyle(fontWeight: FontWeight.w700, fontFeatures: Tp.tabular)),
                ]),
                const SizedBox(height: 4),
                _Track(fraction: v(r) / max, colour: Tp.lime),
                if (r['meta'] != null) Padding(padding: const EdgeInsets.only(top: 2), child: Text('${r['meta']}', style: TextStyle(fontSize: 12, color: context.goMuted))),
              ]),
            ),
        ]);
      case 'pair':
      case 'pairbars':
        final max = rows.expand((r) => [v(r), v(r, 'compare')]).fold<num>(1, (a, b) => b > a ? b : a);
        final legend = strings(chart['legend']);
        return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Wrap(spacing: 12, runSpacing: 4, children: [
            Row(mainAxisSize: MainAxisSize.min, children: [_Key(colour: Tp.lime), Text(legend.isNotEmpty ? legend[0] : 'This period', style: TextStyle(fontSize: 12, color: context.goMuted))]),
            Row(mainAxisSize: MainAxisSize.min, children: [_Key(colour: context.goLine), Text(legend.length > 1 ? legend[1] : 'Compared with', style: TextStyle(fontSize: 12, color: context.goMuted))]),
          ]),
          const SizedBox(height: 8),
          SizedBox(
            height: 150,
            child: ListView(scrollDirection: Axis.horizontal, children: [
              for (final r in rows)
                Tooltip(
                  message: '${r['label']}: ${unitText(unit, v(r))} against ${unitText(unit, v(r, 'compare'))}',
                  child: SizedBox(
                    width: chart['type'] == 'pairbars' ? 72 : 40,
                    child: Column(children: [
                      Expanded(
                        child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
                          const SizedBox(width: 4),
                          Expanded(child: _Bar(fraction: v(r) / max, colour: Tp.lime)),
                          const SizedBox(width: 2),
                          Expanded(child: _Bar(fraction: v(r, 'compare') / max, colour: context.goLine)),
                          const SizedBox(width: 4),
                        ]),
                      ),
                      const SizedBox(height: 4),
                      Text('${r['label']}', maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 11, color: context.goMuted)),
                    ]),
                  ),
                ),
            ]),
          ),
        ]);
      case 'diverging':
        final max = rows.map((r) => v(r).abs()).fold<num>(1, (a, b) => b > a ? b : a);
        return Column(children: [
          for (final r in rows)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Row(children: [
                Expanded(flex: 4, child: Text('${r['label']}', maxLines: 1, overflow: TextOverflow.ellipsis)),
                Expanded(
                  flex: 5,
                  child: Row(children: [
                    Expanded(child: Align(alignment: Alignment.centerRight, child: v(r) < 0 ? _Track(fraction: v(r).abs() / max, colour: Tp.danger, reverse: true) : const SizedBox())),
                    Container(width: 1, height: 14, color: context.goLine),
                    Expanded(child: v(r) > 0 ? _Track(fraction: v(r) / max, colour: Tp.lime) : const SizedBox()),
                  ]),
                ),
                SizedBox(
                  width: 84,
                  child: Text('${v(r) > 0 ? '+' : ''}${unitText(unit, v(r))}', textAlign: TextAlign.right,
                      style: TextStyle(fontWeight: FontWeight.w700, fontFeatures: Tp.tabular, color: v(r) < 0 ? Tp.danger : null)),
                ),
              ]),
            ),
        ]);
      case 'table':
        return RecordsTable(columns: strings(chart['columns']), rows: [for (final r in rows) ['${r['label']}', ...(r['cells'] as List? ?? const []).map((x) => '$x')]]);
    }
    return const SizedBox.shrink();
  }
}

class _Key extends StatelessWidget {
  const _Key({required this.colour});
  final Color colour;
  @override
  Widget build(BuildContext context) => Container(width: 10, height: 10, margin: const EdgeInsets.only(right: 6), decoration: BoxDecoration(color: colour, borderRadius: BorderRadius.circular(3)));
}

class _Track extends StatelessWidget {
  const _Track({required this.fraction, required this.colour, this.reverse = false});
  final num fraction;
  final Color colour;
  final bool reverse;
  @override
  Widget build(BuildContext context) => ClipRRect(
        borderRadius: BorderRadius.circular(5),
        child: Container(
          height: 10,
          color: context.goRaised,
          alignment: reverse ? Alignment.centerRight : Alignment.centerLeft,
          child: FractionallySizedBox(widthFactor: fraction.clamp(0.02, 1).toDouble(), child: Container(color: colour)),
        ),
      );
}

class _Bar extends StatelessWidget {
  const _Bar({required this.fraction, required this.colour});
  final num fraction;
  final Color colour;
  @override
  Widget build(BuildContext context) => FractionallySizedBox(
        heightFactor: fraction.clamp(0.015, 1).toDouble(),
        alignment: Alignment.bottomCenter,
        child: Container(decoration: BoxDecoration(color: colour, borderRadius: const BorderRadius.vertical(top: Radius.circular(3)))),
      );
}

class RecordsTable extends StatelessWidget {
  const RecordsTable({super.key, required this.columns, required this.rows});
  final List<String> columns;
  final List<List<String>> rows;
  @override
  Widget build(BuildContext context) => SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: DataTable(
          headingTextStyle: TextStyle(color: context.goMuted, fontWeight: FontWeight.w700, fontSize: 12),
          dataTextStyle: TextStyle(color: context.goText, fontSize: 13, fontFeatures: Tp.tabular),
          columnSpacing: 18,
          horizontalMargin: 4,
          headingRowHeight: 36,
          dataRowMinHeight: 36,
          dataRowMaxHeight: 44,
          columns: [for (var i = 0; i < columns.length; i++) DataColumn(label: Text(columns[i]), numeric: i > 0)],
          rows: [
            for (final r in rows)
              DataRow(cells: [for (var i = 0; i < columns.length; i++) DataCell(Text(i < r.length ? r[i] : ''))]),
          ],
        ),
      );
}
