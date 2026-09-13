import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/session.dart';
import 'widgets.dart';

/// Points earned and spent, newest first -- the same record the venue's back
/// office and till keep.
class HistoryPage extends ConsumerStatefulWidget {
  const HistoryPage({super.key});

  @override
  ConsumerState<HistoryPage> createState() => _HistoryPageState();
}

class _HistoryPageState extends ConsumerState<HistoryPage> {
  final _items = <Map<String, dynamic>>[];
  var _more = false;
  var _loading = true;
  Object? _error;

  @override
  void initState() {
    super.initState();
    _load(fresh: true);
  }

  Future<void> _load({bool fresh = false}) async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      DateTime? before;
      if (!fresh && _items.isNotEmpty) before = DateTime.tryParse('${_items.last['created_at']}');
      final page = await ref.read(apiProvider).history(before: before);
      final items = (page['items'] as List? ?? const []).cast<Map<String, dynamic>>();
      setState(() {
        if (fresh) _items.clear();
        _items.addAll(items);
        _more = page['more'] == true;
      });
    } catch (e) {
      setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  static String _label(String? kind) => switch (kind) {
    'earn' => 'Points earned',
    'redeem' => 'Points spent',
    'expire' => 'Points expired',
    'adjust' => 'Adjusted by the venue',
    'bonus' => 'Bonus points',
    'join' => 'Welcome bonus',
    _ => 'Points',
  };

  /// One line, opened out.
  ///
  /// The list has to fit a date, a spend, a note and a number on one row of a
  /// phone, so it abbreviates and sometimes truncates. Somebody checking what
  /// a particular visit actually was needs the whole of it -- which table,
  /// what it cost, what the balance became -- and that is what this is.
  Future<void> _detail(Map<String, dynamic> t) async {
    final theme = Theme.of(context);
    final points = (t['points'] as num?)?.toInt() ?? 0;
    final spend = (t['spend_minor'] as num?)?.toInt() ?? 0;
    final value = (t['value_minor'] as num?)?.toInt() ?? 0;
    final balance = (t['balance_after'] as num?)?.toInt();
    final kind = t['kind'] as String?;
    final note = (t['note'] as String?)?.trim();
    final negative = points < 0 || kind == 'redeem' || kind == 'expire';
    final tone = negative ? theme.colorScheme.error : theme.colorScheme.primary;

    final rows = <(String, String)>[
      ('When', when(t['created_at'])),
      if (spend > 0) ('You spent', money(spend)),
      if (kind == 'redeem' && value > 0) ('You saved', money(value)),
      if (kind == 'earn' && spend > 0 && points > 0)
        ('Rate', '${(points / (spend / 100)).toStringAsFixed(points % spend == 0 ? 0 : 1)} points per £'),
      if (balance != null) ('Balance after', '$balance points'),
      if (note != null && note.isNotEmpty) ('Where', note),
    ];

    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (sheet) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 28),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  CircleAvatar(
                    backgroundColor: tone.withValues(alpha: 0.12),
                    child: Icon(negative ? Icons.remove : Icons.add, color: tone),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text(
                      _label(kind),
                      style: theme.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800),
                    ),
                  ),
                  Text(
                    '${negative ? '-' : '+'}${points.abs()}',
                    style: theme.textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w900, color: tone),
                  ),
                ],
              ),
              const SizedBox(height: 18),
              for (final (label, value) in rows)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 7),
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Text(label, style: theme.textTheme.bodyMedium?.copyWith(color: theme.textTheme.bodySmall?.color)),
                      Flexible(
                        child: Text(
                          value,
                          textAlign: TextAlign.right,
                          style: theme.textTheme.bodyLarge?.copyWith(fontWeight: FontWeight.w600),
                        ),
                      ),
                    ],
                  ),
                ),
              const SizedBox(height: 10),
              Text(
                'Anything here look wrong? The venue can check it against the till.',
                style: theme.textTheme.bodySmall,
              ),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    if (_error != null && _items.isEmpty) {
      return LoadFailed(error: _error!, onRetry: () => _load(fresh: true));
    }
    if (_loading && _items.isEmpty) return const Center(child: CircularProgressIndicator());
    if (_items.isEmpty) {
      return RefreshIndicator(
        onRefresh: () => _load(fresh: true),
        child: ListView(
          children: const [
            SizedBox(height: 120),
            Center(child: Text('Nothing yet. Your points will show here after your first visit.', textAlign: TextAlign.center)),
          ],
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: () => _load(fresh: true),
      child: ListView.separated(
        padding: const EdgeInsets.symmetric(vertical: 8),
        itemCount: _items.length + (_more ? 1 : 0),
        separatorBuilder: (_, _) => const Divider(height: 1),
        itemBuilder: (context, i) {
          if (i == _items.length) {
            return Padding(
              padding: const EdgeInsets.all(16),
              child: Center(
                child: _loading
                    ? const CircularProgressIndicator()
                    : OutlinedButton(onPressed: _load, child: const Text('Show older')),
              ),
            );
          }
          final t = _items[i];
          final points = (t['points'] as num?)?.toInt() ?? 0;
          final spend = (t['spend_minor'] as num?)?.toInt() ?? 0;
          final value = (t['value_minor'] as num?)?.toInt() ?? 0;
          final kind = t['kind'] as String?;
          final negative = points < 0 || kind == 'redeem' || kind == 'expire';
          final detail = [
            when(t['created_at']),
            if (spend > 0) 'spent ${money(spend)}',
            if (kind == 'redeem' && value > 0) 'saved ${money(value)}',
            if ((t['note'] as String?)?.trim().isNotEmpty ?? false) (t['note'] as String).trim(),
          ].join(' · ');
          return ListTile(
            onTap: () => _detail(t),
            leading: CircleAvatar(
              backgroundColor: (negative ? theme.colorScheme.error : theme.colorScheme.primary).withValues(alpha: 0.12),
              child: Icon(negative ? Icons.remove : Icons.add, color: negative ? theme.colorScheme.error : theme.colorScheme.primary),
            ),
            title: Text(_label(kind)),
            subtitle: Text(detail),
            trailing: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  '${negative ? '-' : '+'}${points.abs()}',
                  style: theme.textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w800,
                    color: negative ? theme.colorScheme.error : theme.colorScheme.primary,
                  ),
                ),
                // Faint, but there: without it nobody discovers the row opens.
                Icon(Icons.chevron_right, size: 18, color: theme.textTheme.bodySmall?.color),
              ],
            ),
          );
        },
      ),
    );
  }
}
