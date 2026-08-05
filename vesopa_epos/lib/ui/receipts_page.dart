import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';
import 'package:printing/printing.dart';

import '../data/receipt_repository.dart';
import '../main.dart';
import 'receipt_pdf.dart';
import 'theme.dart';
import 'widgets/basket_panel.dart' show money;

final _receiptRepoProvider = Provider<ReceiptRepository>(
  (ref) => ReceiptRepository(
    apiBase: ref.watch(apiBaseProvider),
    office: ref.watch(officeProvider),
  ),
);

/// The date window the list is filtered to.
class ReceiptFilter {
  const ReceiptFilter({this.from, this.to});
  final DateTime? from;
  final DateTime? to;
}

final receiptFilterProvider =
    NotifierProvider<ReceiptFilterNotifier, ReceiptFilter>(
        ReceiptFilterNotifier.new);

class ReceiptFilterNotifier extends Notifier<ReceiptFilter> {
  @override
  ReceiptFilter build() => const ReceiptFilter();
  void set(ReceiptFilter f) => state = f;
}

final receiptListProvider = FutureProvider<List<ReceiptSummary>>((ref) {
  final filter = ref.watch(receiptFilterProvider);
  return ref
      .watch(_receiptRepoProvider)
      .list(from: filter.from, to: filter.to);
});

/// Past receipts: filter by date, open one to view or reprint. History is
/// server-backed — it spans every terminal in the venue, which no single till
/// holds — so this screen needs the network.
class ReceiptsPage extends ConsumerWidget {
  const ReceiptsPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final receipts = ref.watch(receiptListProvider);
    final filter = ref.watch(receiptFilterProvider);
    final fmt = DateFormat('dd/MM/yyyy HH:mm');

    return Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Text(
                'Receipts',
                style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700),
              ),
              const Spacer(),
              IconButton(
                tooltip: 'Refresh',
                icon: const Icon(Icons.refresh),
                onPressed: () => ref.invalidate(receiptListProvider),
              ),
            ],
          ),
          const SizedBox(height: 12),

          // Date filter — the common presets plus a custom range.
          Wrap(
            spacing: 8,
            children: [
              _Chip(
                label: 'All',
                selected: filter.from == null && filter.to == null,
                onTap: () => ref
                    .read(receiptFilterProvider.notifier)
                    .set(const ReceiptFilter()),
              ),
              _Chip(
                label: 'Today',
                selected: _isToday(filter),
                onTap: () {
                  final now = DateTime.now();
                  ref.read(receiptFilterProvider.notifier).set(
                        ReceiptFilter(
                          from: DateTime(now.year, now.month, now.day),
                          to: DateTime(now.year, now.month, now.day),
                        ),
                      );
                },
              ),
              _Chip(
                label: filter.from != null && !_isToday(filter)
                    ? '${DateFormat('d MMM').format(filter.from!)} – ${DateFormat('d MMM').format(filter.to ?? filter.from!)}'
                    : 'Pick dates…',
                selected: filter.from != null && !_isToday(filter),
                onTap: () => _pickRange(context, ref),
              ),
            ],
          ),
          const SizedBox(height: 12),

          Expanded(
            child: receipts.when(
              loading: () => const Center(child: CircularProgressIndicator()),
              error: (e, _) => Center(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Icon(Icons.cloud_off, size: 40),
                    const SizedBox(height: 12),
                    const Text('Receipt history needs the network.'),
                    const SizedBox(height: 4),
                    Text('$e',
                        style: TextStyle(
                            fontSize: 12, color: Theme.of(context).hintColor)),
                  ],
                ),
              ),
              data: (list) => list.isEmpty
                  ? const Center(child: Text('No receipts in this period.'))
                  : Card(
                      margin: EdgeInsets.zero,
                      clipBehavior: Clip.antiAlias,
                      child: ListView.separated(
                        itemCount: list.length,
                        separatorBuilder: (_, _) => const Divider(height: 1),
                        itemBuilder: (context, i) {
                          final r = list[i];
                          return ListTile(
                            leading: const Icon(Icons.receipt_long),
                            title: Text(money(r.totalMinor)),
                            subtitle: Text(
                              '${fmt.format(r.closedAt)}'
                              '${r.tableNumber != null ? ' · Table ${r.tableNumber}' : ''}',
                            ),
                            trailing: const Icon(Icons.chevron_right),
                            onTap: () => _open(context, ref, r.id),
                          );
                        },
                      ),
                    ),
            ),
          ),
        ],
      ),
    );
  }

  bool _isToday(ReceiptFilter f) {
    if (f.from == null) return false;
    final now = DateTime.now();
    return f.from!.year == now.year &&
        f.from!.month == now.month &&
        f.from!.day == now.day &&
        f.to?.day == now.day;
  }

  Future<void> _pickRange(BuildContext context, WidgetRef ref) async {
    final range = await showDateRangePicker(
      context: context,
      firstDate: DateTime(2020),
      lastDate: DateTime.now(),
    );
    if (range != null) {
      ref
          .read(receiptFilterProvider.notifier)
          .set(ReceiptFilter(from: range.start, to: range.end));
    }
  }

  Future<void> _open(BuildContext context, WidgetRef ref, String id) async {
    showDialog<void>(
      context: context,
      builder: (_) => _ReceiptDialog(id: id),
    );
  }
}

class _ReceiptDialog extends ConsumerWidget {
  const _ReceiptDialog({required this.id});

  final String id;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final detail = ref.watch(_detailProvider(id));

    return Dialog(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 460, maxHeight: 640),
        child: detail.when(
          loading: () => const SizedBox(
            height: 200,
            child: Center(child: CircularProgressIndicator()),
          ),
          error: (e, _) => SizedBox(
            height: 200,
            child: Center(child: Text('$e')),
          ),
          data: (r) => Column(
            children: [
              Expanded(
                // Render the actual PDF, so what the clerk sees is exactly what
                // reprints — no second "preview" layout to drift out of sync.
                child: PdfPreview(
                  // Marked a reprint, and rendered with the venue's branding —
                  // a second copy that looks identical to the original can be
                  // passed off as a second sale.
                  build: (_) => buildReceiptPdf(
                    r,
                    venueName: ref.read(sessionProvider).venueName,
                    branding: ref.read(brandingProvider),
                    isReprint: true,
                  ),
                  allowSharing: true,
                  canChangePageFormat: false,
                  canChangeOrientation: false,
                  actions: [
                    PdfPreviewAction(
                      icon: const Icon(Icons.print),
                      onPressed: (_, build, format) async {
                        await Printing.layoutPdf(
                          onLayout: (f) => buildReceiptPdf(
                            r,
                            venueName: ref.read(sessionProvider).venueName,
                            branding: ref.read(brandingProvider),
                            isReprint: true,
                          ),
                        );
                      },
                    ),
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsets.all(8),
                child: TextButton(
                  onPressed: () => Navigator.pop(context),
                  child: const Text('Close'),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

final _detailProvider = FutureProvider.family<ReceiptDetail, String>(
  (ref, id) => ref.watch(_receiptRepoProvider).detail(id),
);

class _Chip extends StatelessWidget {
  const _Chip({
    required this.label,
    required this.selected,
    required this.onTap,
  });

  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return ChoiceChip(
      label: Text(label),
      selected: selected,
      onSelected: (_) => onTap(),
      selectedColor: Pos.brand,
      labelStyle: TextStyle(
        color: selected ? Pos.onBrand : null,
      ),
    );
  }
}
