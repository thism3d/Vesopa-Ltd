/// One Vesopa AI answer: what happened, why, what to do next, the charts and
/// tables behind it, and what every figure rests on.
///
/// The headline and the reasons are always the server's own wording, made
/// from the figures. When a model is set up, its explanation of the same
/// figures is shown first, marked as Vesopa AI's; it has already been checked
/// to quote only figures in the data (vesopa_server/src/go_advisor.js).
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/api.dart';
import '../../data/session.dart';
import '../../ui/theme.dart';
import '../advisor_state.dart';
import 'advisor_widgets.dart';

List<Map<String, dynamic>> _maps(Object? list) => [for (final x in (list as List? ?? const [])) (x as Map).cast<String, dynamic>()];

class AnswerView extends StatelessWidget {
  const AnswerView({super.key, required this.answer, this.onFollowUp, this.compact = false, this.showTitle = true});
  final Map<String, dynamic> answer;
  final ValueChanged<String>? onFollowUp;

  /// Shorter tables, for the overview tabs.
  final bool compact;
  final bool showTitle;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final ai = (answer['ai'] as Map?)?.cast<String, dynamic>();
    final why = [for (final w in (ai?['why'] as List? ?? answer['why'] as List? ?? const [])) '$w'];
    final next = _maps(ai?['next'] ?? answer['next']);
    final cards = _maps(answer['cards']);
    final meta = (answer['meta'] as Map?)?.cast<String, dynamic>();
    final follow = [for (final f in (answer['follow_ups'] as List? ?? const [])) '$f'];
    final records = (meta?['records'] as Map?)?.cast<String, dynamic>();
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      if (showTitle && answer['title'] != null) ...[
        Text('${answer['title']}'.toUpperCase(), style: t.labelSmall?.copyWith(letterSpacing: 1.1, fontWeight: FontWeight.w800, color: context.goLimeInk)),
        const SizedBox(height: 4),
      ],
      if (ai != null) ...[
        Text('${ai['answer']}', style: t.titleMedium?.copyWith(fontWeight: FontWeight.w700, height: 1.35)),
        const SizedBox(height: 6),
        Text('${answer['headline']}', style: t.bodySmall?.copyWith(color: context.goMuted)),
      ] else
        Text('${answer['headline']}', style: t.titleMedium?.copyWith(fontWeight: FontWeight.w700, height: 1.35)),
      if (why.isNotEmpty) ...[
        const SizedBox(height: 12),
        for (final w in why)
          Padding(
            padding: const EdgeInsets.only(bottom: 6),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Padding(padding: const EdgeInsets.only(top: 7), child: Container(width: 6, height: 6, decoration: BoxDecoration(color: Tp.lime, shape: BoxShape.circle))),
              const SizedBox(width: 10),
              Expanded(child: Text(w, style: t.bodyMedium)),
            ]),
          ),
      ],
      if (next.isNotEmpty) ...[
        const SizedBox(height: 8),
        AiSection(title: 'What you could do next', children: [
          for (var i = 0; i < next.length; i++) AiSuggestion(index: i + 1, title: '${next[i]['title']}', why: next[i]['why'] as String?),
        ]),
      ],
      for (final c in cards) ...[const SizedBox(height: 12), AiCard(card: c, compact: compact)],
      if (meta != null && meta['period'] != null) ...[
        const SizedBox(height: 12),
        Consumer(
          builder: (context, ref, _) => AnswerMeta(
            meta: meta,
            aiNote: answer['ai_note'] as String?,
            onViewData: records == null || records['source'] == null
                ? null
                : () => showRecords(context, ref, source: '${records['source']}', period: '${records['period'] ?? 'today'}', site: (records['site'] as num?)?.toInt()),
          ),
        ),
      ],
      if (onFollowUp != null && follow.isNotEmpty) ...[
        const SizedBox(height: 12),
        Wrap(spacing: 8, runSpacing: 8, children: [
          for (final f in follow) ActionChip(avatar: Icon(Icons.subdirectory_arrow_right_rounded, size: 16, color: context.goLimeInk), label: Text(f), onPressed: () => onFollowUp!(f)),
        ]),
      ],
    ]);
  }
}

// ---- the data behind it -----------------------------------------------------------------

/// The rows an answer was worked out from: sales, products, stock or staff.
Future<void> showRecords(BuildContext context, WidgetRef ref, {required String source, required String period, int? site}) =>
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      showDragHandle: true,
      constraints: const BoxConstraints(maxWidth: 900),
      builder: (_) => FractionallySizedBox(heightFactor: 0.88, child: _Records(source: source, period: period, site: site)),
    );

class _Records extends ConsumerStatefulWidget {
  const _Records({required this.source, required this.period, this.site});
  final String source;
  final String period;
  final int? site;
  @override
  ConsumerState<_Records> createState() => _RecordsState();
}

class _RecordsState extends ConsumerState<_Records> {
  Map<String, dynamic>? _data;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final token = ref.read(advisorProvider).session?.token;
    if (token == null) return setState(() => _error = 'Vesopa AI is not open.');
    try {
      final d = await ref.read(apiProvider).aiRecords(token, source: widget.source, period: widget.period, site: widget.site);
      if (mounted) setState(() => _data = d);
    } on TapApiError catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final d = _data;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Text(d?['title'] as String? ?? 'Supporting data', style: t.titleLarge),
        if (d != null)
          Text('${(d['period'] as Map?)?['label'] ?? ''} · ${(d['site'] as Map?)?['label'] ?? ''}', style: t.bodySmall?.copyWith(color: context.goMuted)),
        const SizedBox(height: 12),
        Expanded(
          child: _error != null
              ? Center(child: Text(_error!, textAlign: TextAlign.center))
              : d == null
                  ? const Center(child: CircularProgressIndicator())
                  : SingleChildScrollView(
                      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                        AiTable(columns: _maps(d['columns']), rows: _maps(d['rows'])),
                        if (d['note'] != null) Padding(padding: const EdgeInsets.only(top: 12), child: Text('${d['note']}', style: t.bodySmall)),
                      ]),
                    ),
        ),
      ]),
    );
  }
}
