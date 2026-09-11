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
            leading: CircleAvatar(
              backgroundColor: (negative ? theme.colorScheme.error : theme.colorScheme.primary).withValues(alpha: 0.12),
              child: Icon(negative ? Icons.remove : Icons.add, color: negative ? theme.colorScheme.error : theme.colorScheme.primary),
            ),
            title: Text(_label(kind)),
            subtitle: Text(detail),
            trailing: Text(
              '${negative ? '-' : '+'}${points.abs()}',
              style: theme.textTheme.titleMedium?.copyWith(
                fontWeight: FontWeight.w800,
                color: negative ? theme.colorScheme.error : theme.colorScheme.primary,
              ),
            ),
          );
        },
      ),
    );
  }
}
