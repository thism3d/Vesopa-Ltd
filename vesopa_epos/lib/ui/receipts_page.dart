import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';
import 'package:path_provider/path_provider.dart';
import 'package:printing/printing.dart';
import 'package:url_launcher/url_launcher.dart';

import '../data/receipt_repository.dart';
import '../data/refund_ledger.dart';
import '../main.dart';
import '../payments/payment_provider.dart';
import 'dojo_refund.dart';
import 'failed_card_payments.dart';
import 'receipt_pdf.dart';
import 'receipt_pdf_view.dart';
import 'refund_page.dart' show showRefund;
import 'theme.dart';
import 'widgets/basket_panel.dart' show money;
import 'widgets/pos_message.dart';
import 'widgets/receipt_status_badge.dart';

/// Public because the refund screen reads the same receipts. One repository
/// and one filter, so "the sale I can see" and "the sale I can refund" are the
/// same list rather than two that can disagree.
final receiptRepoProvider = Provider<ReceiptRepository>(
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

final receiptListProvider = FutureProvider<List<ReceiptSummary>>((ref) async {
  final filter = ref.watch(receiptFilterProvider);
  final list = await ref
      .watch(receiptRepoProvider)
      .list(from: filter.from, to: filter.to);
  // Refunds this till has given that the server has not had yet, so a bill
  // reads Refunded the moment it is, not after the outbox drains.
  final local = await RefundLedger.instance.totals();
  if (local.isEmpty) return list;
  return [
    for (final r in list)
      if ((local[r.id]?.minor ?? 0) > r.refundedMinor)
        r.withRefunds(local[r.id]!.minor)
      else
        r,
  ];
});

/// Which list the Receipts screen shows: paid receipts, or the card
/// payments that failed.
final receiptsTabProvider = NotifierProvider<ReceiptsTabNotifier, bool>(
  ReceiptsTabNotifier.new,
);

class ReceiptsTabNotifier extends Notifier<bool> {
  @override
  bool build() => false;
  void showFailed(bool v) => state = v;
}

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
    final failedTab = ref.watch(receiptsTabProvider);
    final tabs = SegmentedButton<bool>(
      segments: const [
        ButtonSegment(
          value: false,
          icon: Icon(Icons.receipt_long),
          label: Text('Receipts'),
        ),
        ButtonSegment(
          value: true,
          icon: Icon(Icons.credit_card_off),
          label: Text('Failed card payments'),
        ),
      ],
      selected: {failedTab},
      onSelectionChanged: (v) =>
          ref.read(receiptsTabProvider.notifier).showFailed(v.first),
    );
    if (failedTab) {
      return Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'Receipts',
              style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 12),
            tabs,
            const SizedBox(height: 12),
            const Expanded(child: FailedCardPayments()),
          ],
        ),
      );
    }

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
          tabs,
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
                            title: Text(
                              money(r.totalMinor),
                              style: TextStyle(
                                fontWeight: FontWeight.w700,
                                decoration: r.status == ReceiptStatus.refunded
                                    ? TextDecoration.lineThrough
                                    : null,
                              ),
                            ),
                            subtitle: Text(
                              '${fmt.format(r.closedAt)}'
                              '${r.tableNumber != null ? ' · Table ${r.tableNumber}' : ''}',
                            ),
                            // How it was paid and where it stands, at a
                            // glance: card or cash, paid or refunded.
                            trailing: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                ReceiptStatusBadge(receipt: r),
                                const SizedBox(width: 6),
                                const Icon(Icons.chevron_right),
                              ],
                            ),
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

  Future<void> _refund(BuildContext context, WidgetRef ref, ReceiptDetail r) async {
    Navigator.pop(context);
    await showRefund(context, ref, receipt: r.summary);
    ref.invalidate(_detailProvider(id));
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final detail = ref.watch(_detailProvider(id));

    // Marked a reprint, and rendered with the venue's branding — a second
    // copy that looks identical to the original can be passed off as a second
    // sale. One key per receipt and refund state, so print, share and the
    // preview all use the one built document.
    String keyFor(ReceiptDetail r) =>
        'reprint:${r.summary.id}:${r.summary.refundedMinor}:${r.refunds.length}';
    Future<Uint8List> pdf(ReceiptDetail r) => ReceiptPdfView.bytesFor(
      keyFor(r),
      () => buildReceiptPdf(
        r,
        venueName: ref.read(sessionProvider).venueName,
        branding: ref.read(brandingProvider),
        isReprint: true,
      ),
    );

    return Dialog(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 520, maxHeight: 720),
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
              _StatusHeader(
                detail: r,
                onRefund: r.summary.status == ReceiptStatus.refunded
                    ? null
                    : () => _refund(context, ref, r),
              ),
              Expanded(
                // The actual PDF, so what the clerk sees is exactly what
                // reprints. Built and drawn once per receipt (see
                // ReceiptPdfView): PdfPreview started again on every rebuild.
                child: ReceiptPdfView(
                  cacheKey: keyFor(r),
                  build: () => buildReceiptPdf(
                    r,
                    venueName: ref.read(sessionProvider).venueName,
                    branding: ref.read(brandingProvider),
                    isReprint: true,
                  ),
                  // "The receipt PDF cannot be viewed on the computer." When
                  // the preview cannot draw it, say so and offer the file in
                  // the computer's own PDF viewer rather than a blank panel.
                  onError: (context, error) => _PreviewFailed(
                    error: error,
                    onOpen: () => _openPdfFile(context, r, pdf),
                  ),
                ),
              ),
              // How the card share was paid, as Dojo has it now: paid,
              // refunded, part refunded.
              for (final t in r.tenders.where((t) => t.isDojo))
                _DojoTenderRow(
                  tender: t,
                  refundedMinor: r.cardRefundedMinor[t.reference] ?? 0,
                ),
              Padding(
                padding: const EdgeInsets.all(8),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.end,
                  children: [
                    IconButton(
                      tooltip: 'Print',
                      onPressed: () => Printing.layoutPdf(
                        onLayout: (_) => pdf(r),
                        name: 'Receipt',
                      ),
                      icon: const Icon(Icons.print),
                    ),
                    IconButton(
                      tooltip: 'Share',
                      onPressed: () async => Printing.sharePdf(
                        bytes: await pdf(r),
                        filename: 'receipt-${r.summary.id.substring(0, 8)}.pdf',
                      ),
                      icon: const Icon(Icons.share),
                    ),
                    TextButton.icon(
                      onPressed: () => _openPdfFile(context, r, pdf),
                      icon: const Icon(Icons.picture_as_pdf_outlined),
                      label: const Text('Open PDF'),
                    ),
                    const SizedBox(width: 8),
                    TextButton(
                      onPressed: () => Navigator.pop(context),
                      child: const Text('Close'),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Write the receipt to a file and open it in the computer's PDF viewer.
///
/// The in-app preview needs the PDF renderer the printing plugin ships; a
/// file opened by the system works on any computer with a PDF reader, and can
/// be saved, emailed or printed from there.
Future<void> _openPdfFile(
  BuildContext context,
  ReceiptDetail r,
  Future<Uint8List> Function(ReceiptDetail) build,
) async {
  try {
    final bytes = await build(r);
    final dir = await getTemporaryDirectory();
    final file = File(
      '${dir.path}${Platform.pathSeparator}receipt-${r.summary.id.substring(0, 8)}.pdf',
    );
    await file.writeAsBytes(bytes, flush: true);
    final ok = await launchUrl(Uri.file(file.path));
    if (!ok) {
      // No viewer registered: the share sheet (Save as… on Windows) instead.
      await Printing.sharePdf(bytes: bytes, filename: file.uri.pathSegments.last);
    }
  } catch (e) {
    if (context.mounted) {
      PosMessenger.error(context, 'Could not open the receipt PDF: $e');
    }
  }
}

class _PreviewFailed extends StatelessWidget {
  const _PreviewFailed({required this.error, required this.onOpen});

  final Object error;
  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.picture_as_pdf_outlined, size: 40),
          const SizedBox(height: 10),
          const Text(
            'The receipt could not be shown here.',
            textAlign: TextAlign.center,
            style: TextStyle(fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 4),
          Text(
            '$error',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 12, color: Theme.of(context).hintColor),
          ),
          const SizedBox(height: 14),
          FilledButton.icon(
            onPressed: onOpen,
            icon: const Icon(Icons.open_in_new),
            label: const Text('Open the PDF'),
          ),
        ],
      ),
    ),
  );
}

/// The top of an open receipt: where it stands, what went back, and Refund.
class _StatusHeader extends StatelessWidget {
  const _StatusHeader({required this.detail, this.onRefund});

  final ReceiptDetail detail;
  final VoidCallback? onRefund;

  @override
  Widget build(BuildContext context) {
    final s = detail.summary;
    final look = ReceiptStatusBadge.look(s.status);
    final when = DateFormat('d MMM HH:mm');
    return Container(
      width: double.infinity,
      color: look.bg,
      padding: const EdgeInsets.fromLTRB(16, 12, 12, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(child: ReceiptStatusBadge(receipt: s)),
              FilledButton.icon(
                onPressed: onRefund,
                style: FilledButton.styleFrom(backgroundColor: Pos.red),
                icon: const Icon(Icons.undo, size: 18),
                label: Text(
                  s.status == ReceiptStatus.refunded ? 'Refunded' : 'Refund',
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            ReceiptStatusBadge.explain(s),
            style: TextStyle(color: look.fg, fontWeight: FontWeight.w600),
          ),
          for (final f in detail.refunds)
            Padding(
              padding: const EdgeInsets.only(top: 3),
              child: Text(
                [
                  'Refund ${money(f.amountMinor)} on ${when.format(f.at)}',
                  if (f.staffName?.isNotEmpty ?? false) f.staffName!,
                  if (f.reason?.isNotEmpty ?? false) f.reason!,
                ].join('  ·  '),
                style: TextStyle(color: look.fg, fontSize: 12),
              ),
            ),
        ],
      ),
    );
  }
}

/// One Dojo card payment on a receipt: what Dojo says about it now. Refunds
/// go through Refund at the top, so the receipt, the Z report and the card
/// all agree on what went back.
class _DojoTenderRow extends ConsumerStatefulWidget {
  const _DojoTenderRow({required this.tender, this.refundedMinor = 0});

  final ReceiptTender tender;

  /// Approved card refunds against it, from every till's card log.
  final int refundedMinor;

  @override
  ConsumerState<_DojoTenderRow> createState() => _DojoTenderRowState();
}

class _DojoTenderRowState extends ConsumerState<_DojoTenderRow> {
  String? _status;
  bool _loading = false;

  Future<void> _check() async {
    final dojo = tillDojo(ref);
    if (dojo == null) {
      setState(() => _status = 'Card payments are not set up on this till.');
      return;
    }
    setState(() => _loading = true);
    try {
      final st = await dojo.paymentStatus(widget.tender.reference!);
      if (mounted) setState(() => _status = st.summary);
    } catch (e) {
      if (mounted) {
        setState(() => _status =
            e is DojoException ? e.clerkMessage : 'Could not reach Dojo.');
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = widget.tender;
    final refunded = widget.refundedMinor;
    return ListTile(
      dense: true,
      leading: Icon(
        refunded > 0 ? Icons.undo : Icons.credit_card,
        color: refunded > 0 ? const Color(0xFFA3221A) : Pos.blue,
      ),
      title: Text(
        refunded > 0
            ? 'Card ${money(t.amountMinor)} on Dojo  ·  ${money(refunded)} refunded'
            : 'Card ${money(t.amountMinor)} on Dojo  ·  Paid',
      ),
      subtitle: Text(
        _status ?? 'Tap Status to see what Dojo says about this payment.',
        style: const TextStyle(fontSize: 12),
      ),
      trailing: TextButton(
        onPressed: _loading ? null : _check,
        child: Text(_loading ? 'Checking…' : 'Status'),
      ),
    );
  }
}

final _detailProvider = FutureProvider.family<ReceiptDetail, String>(
  (ref, id) async => (await ref.watch(receiptRepoProvider).detail(id))
      .withLocal(await RefundLedger.instance.forOrder(id)),
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
