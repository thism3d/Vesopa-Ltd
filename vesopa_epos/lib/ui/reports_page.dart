import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/session_repository.dart';
import '../main.dart';
import 'layout.dart';
import 'theme.dart';
import 'widgets/pos_message.dart';
import 'widgets/basket_panel.dart' show money;

final xReportProvider = FutureProvider<TillReport>(
  (ref) => ref.watch(sessionRepositoryProvider).xReport(),
);

/// X and Z reports. X reads the open trading period; Z closes it.
class ReportsPage extends ConsumerWidget {
  const ReportsPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final report = ref.watch(xReportProvider);

    final phone = context.isPhone;

    return Padding(
      padding: EdgeInsets.all(phone ? 16 : 24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // The title and two labelled buttons do not fit across a phone, so
          // stack them rather than let the row overflow.
          if (phone) ...[
            const Text(
              'End of Day',
              style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton.icon(
                    icon: const Icon(Icons.refresh, size: 18),
                    label: const Text('X Report'),
                    onPressed: () => ref.invalidate(xReportProvider),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: FilledButton.icon(
                    style:
                        FilledButton.styleFrom(backgroundColor: Pos.red),
                    icon: const Icon(Icons.lock_clock, size: 18),
                    label: const Text('Z Report'),
                    onPressed: () => _confirmZ(context, ref),
                  ),
                ),
              ],
            ),
          ] else
            Row(
              children: [
                const Text(
                  'End of Day',
                  style: TextStyle(fontSize: 24, fontWeight: FontWeight.w600),
                ),
                const Spacer(),
                OutlinedButton.icon(
                  icon: const Icon(Icons.refresh),
                  label: const Text('X Report'),
                  onPressed: () => ref.invalidate(xReportProvider),
                ),
                const SizedBox(width: 12),
                FilledButton.icon(
                  style: FilledButton.styleFrom(backgroundColor: Pos.red),
                  icon: const Icon(Icons.lock_clock),
                  label: const Text('Z Report (reset)'),
                  onPressed: () => _confirmZ(context, ref),
                ),
              ],
            ),
          const SizedBox(height: 20),
          Expanded(
            child: report.when(
              loading: () => const Center(child: CircularProgressIndicator()),
              error: (e, _) => Center(child: Text('$e')),
              data: (r) => _ReportBody(report: r),
            ),
          ),
        ],
      ),
    );
  }

  /// A Z is irreversible — it closes the trading period and resets the totals.
  /// Never fire it on a single tap.
  Future<void> _confirmZ(BuildContext context, WidgetRef ref) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Run Z Report?'),
        content: const Text(
          'This closes the current trading period and resets the totals. '
          'It cannot be undone.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: Pos.red),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Run Z'),
          ),
        ],
      ),
    );

    if (ok != true || !context.mounted) return;

    final z = await ref.read(sessionRepositoryProvider).zReport();
    ref.invalidate(xReportProvider);

    if (!context.mounted) return;
    PosMessenger.success(
      context,
      'Z #${z.zNumber} — ${money(z.grossMinor)} taken.',
    );
  }
}

class _ReportBody extends StatelessWidget {
  const _ReportBody({required this.report});

  final TillReport report;

  @override
  Widget build(BuildContext context) {
    return ListView(
      children: [
        _Stat(label: 'Orders', value: '${report.orderCount}'),
        _Stat(label: 'Gross takings', value: money(report.grossMinor)),
        _Stat(label: 'Discounts', value: '-${money(report.discountMinor)}'),
        _Stat(label: 'VAT', value: money(report.taxMinor)),
        if (report.byMethod.isNotEmpty) ...[
          const _Heading('By tender'),
          for (final e in report.byMethod.entries)
            _Stat(label: e.key, value: money(e.value)),
        ],
        if (report.byDepartment.isNotEmpty) ...[
          const _Heading('By department'),
          for (final e in report.byDepartment.entries)
            _Stat(label: e.key, value: money(e.value)),
        ],
        const _Heading('Cash drawer'),
        _Stat(label: 'Opening float', value: money(report.openingFloatMinor)),
        _Stat(
          label: 'Expected in drawer',
          value: money(report.expectedCashMinor),
          bold: true,
        ),
      ],
    );
  }
}

class _Heading extends StatelessWidget {
  const _Heading(this.text);
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(top: 24, bottom: 8),
        child: Text(
          text,
          style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
        ),
      );
}

class _Stat extends StatelessWidget {
  const _Stat({required this.label, required this.value, this.bold = false});

  final String label;
  final String value;
  final bool bold;

  @override
  Widget build(BuildContext context) {
    final style = TextStyle(
      fontSize: 16,
      fontWeight: bold ? FontWeight.bold : FontWeight.normal,
    );
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Flexible(child: Text(label, style: style)),
          Text(value, style: style),
        ],
      ),
    );
  }
}
