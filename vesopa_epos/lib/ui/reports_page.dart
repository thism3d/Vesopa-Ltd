import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/session_repository.dart';
import '../main.dart';
import '../printing/print_service.dart';
import '../printing/print_targets.dart';
import '../printing/receipt_builder.dart';
import 'layout.dart';
import 'printers_page.dart' show printerSettingsProvider;
import 'theme.dart';
import 'widgets/pos_message.dart';
import '../data/till_permissions.dart';
import 'permission_gate.dart';
import 'widgets/basket_panel.dart' show money;

final xReportProvider = FutureProvider<TillReport>(
  // Who is signed on goes on the report, as it does on the reference one this
  // was matched against: a Z is a handover document, and "who took it" is half
  // of what makes it one. There is no terminal name to put beside it — Vesopa
  // has no per-till name to read — so that line is simply not printed rather
  // than filled with something invented.
  (ref) => ref
      .watch(sessionRepositoryProvider)
      .xReport(staffName: ref.watch(servedByProvider)),
);

/// The last Z run on this terminal, held so it can be printed again.
///
/// A Z closes the period, so the moment it is run the screen goes back to
/// showing an empty X — and the report the manager actually needs on paper is
/// no longer anywhere they can reach it. That is the shape of "I ran the Z and
/// nothing came out": the document existed for as long as the toast did.
///
/// Held in memory rather than on disk deliberately. This is the reprint key for
/// a Z run a moment ago on a printer that was switched off; a Z from last
/// Tuesday is a back-office question, and answering it out of a terminal's RAM
/// would be a promise this cannot keep across a restart.
///
/// A Notifier rather than a StateProvider: StateProvider was removed in
/// Riverpod 3, which is what the rest of this app has already been moved off.
class LastZReport extends Notifier<TillReport?> {
  @override
  TillReport? build() => null;

  void set(TillReport report) => state = report;
}

final lastZReportProvider = NotifierProvider<LastZReport, TillReport?>(
  LastZReport.new,
);

/// Send a report to the printer set up for it.
///
/// Throws, and is meant to: every caller has something different to say about a
/// failure. A Z that ran but did not print is not the same event as a reprint
/// that did not print, and the clerk has to be told which one happened.
Future<void> printTillReport(WidgetRef ref, TillReport report) async {
  final printers = await ref.read(printerSettingsProvider.future);

  // Resolved through the fallback chain — an unset "X / Z report" target uses
  // the receipt printer, which is what a till with one printer has always
  // meant. Checked here rather than left to PrintService so the message can
  // name the screen the manager has to go to.
  if (printers.deviceFor(PrintTarget.tillReport) == null) {
    throw StateError(
      'no printer is set up for reports — Settings › Printers › X / Z report',
    );
  }

  final branding = ref.read(brandingProvider);
  final service = PrintService(
    await ReceiptBuilder.create(paperWidthMm: printers.receiptWidthMm),
    PrinterSetup(
      printers: printers,
      shopName: branding.venueName.isNotEmpty
          ? branding.venueName
          : ref.read(sessionProvider).venueName,
      footer: branding.footerMessage,
      logo: branding.showLogo ? branding.logoBytes : null,
    ),
  );
  await service.printTillReport(report);
}

/// X and Z reports. X reads the open trading period; Z closes it.
class ReportsPage extends ConsumerWidget {
  const ReportsPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final report = ref.watch(xReportProvider);
    final lastZ = ref.watch(lastZReportProvider);

    final phone = context.isPhone;

    // Printing whatever is on screen. Disabled while the report is still
    // loading rather than hidden, so the key does not appear and disappear
    // under the finger on every refresh.
    final shown = report.value;
    final onPrintX = shown == null ? null : () => _printX(context, ref, shown);

    return Padding(
      padding: EdgeInsets.all(phone ? 16 : 24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // The title and the keys do not fit across a phone, so stack them
          // rather than let the row overflow.
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
                    label: const Text('X'),
                    onPressed: () => ref.invalidate(xReportProvider),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: OutlinedButton.icon(
                    icon: const Icon(Icons.print_outlined, size: 18),
                    label: const Text('Print X'),
                    onPressed: onPrintX,
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: FilledButton.icon(
                    style: FilledButton.styleFrom(backgroundColor: Pos.red),
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
                OutlinedButton.icon(
                  icon: const Icon(Icons.print_outlined),
                  label: const Text('Print X'),
                  onPressed: onPrintX,
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
          // The way back from a printer that was off when the Z ran. Shown only
          // once there is a Z to reprint, and it names its number so a manager
          // holding a torn-off strip can tell whether it is the one in hand.
          if (lastZ != null) ...[
            const SizedBox(height: 12),
            _ReprintZ(report: lastZ),
          ],
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

  /// Print the X on screen. Nothing is closed and nothing is reset, so a
  /// failure here costs the manager one more press of the same key.
  Future<void> _printX(
    BuildContext context,
    WidgetRef ref,
    TillReport report,
  ) async {
    if (!await _mayPrintX(context, ref)) return;
    if (!context.mounted) return;
    try {
      await printTillReport(ref, report);
      if (context.mounted) PosMessenger.success(context, 'X report printed.');
    } catch (e) {
      if (context.mounted) {
        PosMessenger.error(context, 'Could not print the X report: $e');
      }
    }
  }

  /// Whether this clerk may take the X report off the screen and onto paper.
  ///
  /// Only the printing is gated, not the figures on screen. A venue that did
  /// not want its staff seeing the day's takings would not have put the totals
  /// on the sale screen, and refusing to *draw* a page somebody is already
  /// looking at would be theatre.
  Future<bool> _mayPrintX(BuildContext context, WidgetRef ref) =>
      allowed(context, ref, TillPermission.xReport);

  /// A Z is irreversible — it closes the trading period and resets the totals.
  /// Never fire it on a single tap.
  Future<void> _confirmZ(BuildContext context, WidgetRef ref) async {
    // Asked before the confirmation, not after. Somebody who cannot run a Z
    // should be told so instead of being walked up to an irreversible button
    // and refused at the last press.
    if (!await allowed(context, ref, TillPermission.zReport)) return;
    if (!context.mounted) return;

    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Run Z Report?'),
        content: const Text(
          'This closes the current trading period and resets the totals. '
          'It cannot be undone.\n\n'
          'The report prints as soon as it has run.',
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

    final z = await ref
        .read(sessionRepositoryProvider)
        .zReport(staffName: ref.read(servedByProvider));
    ref.invalidate(xReportProvider);
    // Held before the printing is attempted, not after. The period is closed
    // either way, and this reprint key is the only thing standing between a
    // printer that would not answer and a Z nobody can produce on paper.
    ref.read(lastZReportProvider.notifier).set(z);

    if (!context.mounted) return;

    try {
      await printTillReport(ref, z);
      if (!context.mounted) return;
      PosMessenger.success(
        context,
        'Z #${z.zNumber} — ${money(z.grossMinor)} taken. Printed.',
      );
    } catch (e) {
      if (!context.mounted) return;
      // The period *is* closed. Saying so first is the point: a manager who
      // reads only "could not print" runs the Z again looking for paper, and
      // the second one totals nothing.
      PosMessenger.error(
        context,
        'Z #${z.zNumber} ran and the period is closed, but it did not print '
        '($e). Use Reprint Z #${z.zNumber} once the printer is ready.',
      );
    }
  }
}

/// The reprint key for the Z just run.
///
/// Its own widget only so it can hold the "printing…" state: the press is a
/// round trip to a printer that may be off, and a key that does nothing visible
/// for four seconds is one that gets pressed four times.
class _ReprintZ extends ConsumerStatefulWidget {
  const _ReprintZ({required this.report});

  final TillReport report;

  @override
  ConsumerState<_ReprintZ> createState() => _ReprintZState();
}

class _ReprintZState extends ConsumerState<_ReprintZ> {
  bool _busy = false;

  @override
  Widget build(BuildContext context) {
    final z = widget.report;
    return Row(
      children: [
        OutlinedButton.icon(
          icon: _busy
              ? const SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Icon(Icons.print_outlined),
          label: Text('Reprint Z #${z.zNumber}'),
          onPressed: _busy ? null : _print,
        ),
        const SizedBox(width: 12),
        Flexible(
          child: Text(
            '${money(z.grossMinor)} taken, closed at '
            '${TimeOfDay.fromDateTime(z.closedAt ?? z.openedAt).format(context)}',
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              fontSize: 13,
              color: Theme.of(context).colorScheme.onSurfaceVariant,
            ),
          ),
        ),
      ],
    );
  }

  Future<void> _print() async {
    setState(() => _busy = true);
    try {
      await printTillReport(ref, widget.report);
      if (mounted) {
        PosMessenger.success(context, 'Z #${widget.report.zNumber} printed.');
      }
    } catch (e) {
      if (mounted) PosMessenger.error(context, 'Still could not print: $e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
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
        _Stat(label: 'Covers', value: '${report.covers}'),
        _Stat(label: 'Average spend', value: money(report.averageSpendMinor)),
        // The count beside the money, as on the printed report: an average
        // that has moved is the thing worth asking about, and it cannot be seen
        // from the total alone.
        if (report.byMethod.isNotEmpty) ...[
          const _Heading('By tender'),
          for (final e in report.byMethod.entries)
            _Stat(
              label: '${e.key}  [${e.value.count}]',
              value: money(e.value.amountMinor),
            ),
        ],
        if (report.byDepartment.isNotEmpty) ...[
          const _Heading('By department'),
          for (final e in report.byDepartment.entries)
            _Stat(
              label: '${e.key}  [${e.value.count}]',
              value: money(e.value.amountMinor),
            ),
        ],
        const _Heading('Voids & no sales'),
        _Stat(
          label: 'Voids  [${report.voids.count}]',
          value: money(report.voids.amountMinor),
        ),
        _Stat(label: 'No sales', value: '${report.noSales.count}'),
        if (report.gratuityMinor > 0)
          _Stat(
            label: 'Gratuity (owed to staff)',
            value: money(report.gratuityMinor),
          ),
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
