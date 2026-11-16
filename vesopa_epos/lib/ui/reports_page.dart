import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
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
import 'cash_drawer_sheets.dart';
import 'permission_gate.dart';
import 'widgets/basket_panel.dart' show money;
import 'dart:async';

import '../data/lan/lan_service.dart';
import '../data/terminal_identity.dart';

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
          // Every till of the venue as one report, over the local link.
          const SizedBox(height: 12),
          const _AllTillsKey(),
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

    // Count the drawer first, where the venue asks for it.
    //
    // Before the period is closed, and that order matters: the count is a fact
    // about the shift that is ending, and asking afterwards would mean asking
    // about a drawer that has already been declared balanced.
    //
    // Backing out of the count abandons the Z rather than running it without
    // one. A declaration started and cancelled is not a declaration of zero,
    // and a manager who changed their mind halfway through counting has not
    // asked to close the day.
    final declaration = ref.read(tillSettingsProvider).cashDeclaration;
    int? declared;
    if (declaration.asks) {
      declared = await showCashDeclaration(context, ref, mode: declaration);
      if (declared == null || !context.mounted) return;
    }

    final z = await ref.read(sessionRepositoryProvider).zReport(
          staffName: ref.read(servedByProvider),
          declaredCashMinor: declared,
        );
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
        if (report.expenses.count > 0)
          _Stat(
            label: 'Paid out  [${report.expenses.count}]',
            value: '-${money(report.expenses.amountMinor)}',
          ),
        if (report.wastage.count > 0)
          _Stat(label: 'Wastage entries', value: '${report.wastage.count}'),
        // Takings that were never cash: not missing from the drawer.
        if (report.otherPayments.isNotEmpty) ...[
          const _Heading('Not in the drawer'),
          _Stat(label: 'Card', value: money(report.cardMinor)),
          for (final e in report.otherPayments.entries)
            _Stat(label: '${e.key}  [${e.value.count}]', value: money(e.value.amountMinor)),
        ],
        if (report.gratuityMinor > 0)
          _Stat(
            label: 'Gratuity (owed to staff)',
            value: money(report.gratuityMinor),
          ),
        const _Heading('Cash drawer'),
        _Stat(label: 'Opening float', value: money(report.openingFloatMinor)),
        _Stat(label: '+ Cash sales', value: money(report.cashSalesMinor)),
        // Paid in, paid out and cashback always show, at £0.00 too, so the
        // drawer's sum reads the same every day (Pontardawe, 2026-11-12: a Z
        // with no cashback that day looked as if cashback was never counted).
        _Stat(label: '+ Paid in  [${report.paidIn.count}]', value: money(report.paidIn.amountMinor)),
        _Stat(label: '− Paid out  [${report.expenses.count}]', value: money(report.expenses.amountMinor)),
        if (report.cashRefundsMinor > 0)
          _Stat(label: '− Cash refunds', value: money(report.cashRefundsMinor)),
        _Stat(label: '− Cashback given', value: money(report.cashbackMinor)),
        _Stat(
          label: 'Expected in drawer',
          value: money(report.expectedCashMinor),
          bold: true,
        ),
        // Only where somebody was asked. See TillReport.declaredCashMinor.
        if (report.declaredCashMinor != null) ...[
          _Stat(
            label: 'Counted',
            value: money(report.declaredCashMinor!),
          ),
          _Stat(
            label: switch (report.cashDifferenceMinor!) {
              0 => 'Balanced',
              final d when d > 0 => 'Over',
              _ => 'Short',
            },
            value: money(report.cashDifferenceMinor!.abs()),
            bold: true,
          ),
        ],
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


/// The key that opens the venue-wide report. Shown once another till is
/// heard on the local link, so a single-till venue never sees it.
/// Whether End of Day offers one X or Z for every linked till.
const allTillsReportsKey = 'till.reports_all_tills';

class _AllTillsKey extends ConsumerStatefulWidget {
  const _AllTillsKey();

  @override
  ConsumerState<_AllTillsKey> createState() => _AllTillsKeyState();
}

class _AllTillsKeyState extends ConsumerState<_AllTillsKey> {
  StreamSubscription<void>? _changes;

  /// Each till's X and Z are its own unless the venue turns this on in
  /// Settings, Local network (Nicky, 2026-11-16).
  bool _wanted = false;

  @override
  void initState() {
    super.initState();
    unawaited(SharedPreferences.getInstance().then((p) {
      if (mounted) setState(() => _wanted = p.getBool(allTillsReportsKey) ?? false);
    }));
    _changes = LanService.instance.changes.listen((_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _changes?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final lan = LanService.instance;
    final others = lan.otherTills;
    if (!_wanted || !lan.linked || others.isEmpty) return const SizedBox.shrink();
    final n = others.length + 1;
    return Material(
      color: Pos.brandSoft,
      borderRadius: BorderRadius.circular(14),
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: () => showDialog<void>(context: context, builder: (_) => const _AllTillsDialog()),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          child: Row(
            children: [
              const Icon(Icons.hub_outlined, color: Pos.brandDeep),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('All tills: $n linked', style: const TextStyle(fontWeight: FontWeight.w700, color: Pos.onBrand)),
                    const Text(
                      'One X or Z for the whole venue, from every till on the local network.',
                      style: TextStyle(fontSize: 13, color: Pos.graphite),
                    ),
                  ],
                ),
              ),
              const Icon(Icons.chevron_right, color: Pos.brandDeep),
            ],
          ),
        ),
      ),
    );
  }
}

/// One till's part of the venue-wide report.
class _TillPart {
  _TillPart({required this.id, required this.name, this.address});
  final String id;
  final String name;
  final String? address;
  TillReport? report;
  String? problem;
  bool busy = true;
}

/// Every till's X side by side and added up; print it, or Z the lot.
class _AllTillsDialog extends ConsumerStatefulWidget {
  const _AllTillsDialog();

  @override
  ConsumerState<_AllTillsDialog> createState() => _AllTillsDialogState();
}

class _AllTillsDialogState extends ConsumerState<_AllTillsDialog> {
  final List<_TillPart> _parts = [];
  bool _working = false;
  bool _closed = false;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  String get _here => ref.read(terminalNameProvider);

  Future<void> _load() async {
    final lan = LanService.instance;
    _parts
      ..clear()
      ..add(_TillPart(id: lan.deviceId, name: '$_here (this till)'))
      ..addAll([
        for (final p in lan.otherTills) _TillPart(id: p.id, name: p.name, address: p.address.address),
      ]);
    if (mounted) setState(() {});
    await Future.wait([
      for (final part in _parts)
        () async {
          try {
            if (part.id == lan.deviceId) {
              part.report = await ref.read(sessionRepositoryProvider).xReport(
                    terminalName: _here,
                    staffName: ref.read(servedByProvider),
                  );
            } else {
              final got = await lan.call(part.id, 'xreport', null);
              part.report = TillReport.fromJson(got as Map);
            }
          } catch (e) {
            part.problem = _plain(e);
          } finally {
            part.busy = false;
            if (mounted) setState(() {});
          }
        }(),
    ]);
  }

  /// A till that is too old to answer says so in words a manager can act on.
  String _plain(Object e) {
    final text = '$e';
    if (text.contains('is not available on')) return 'Needs updating to answer (EPOS 1.16.53 or newer).';
    if (text.toLowerCase().contains('timeout') || text.contains('TimeoutException')) return 'Did not answer in time.';
    return text;
  }

  List<TillReport> get _reports => [for (final p in _parts) if (p.report != null) p.report!];

  TillReport? get _combined => _reports.isEmpty
      ? null
      : TillReport.combined(
          _reports,
          name: 'All tills (${_reports.length} of ${_parts.length})',
          staffName: ref.read(servedByProvider),
        );

  Future<void> _print() async {
    final all = _combined;
    if (all == null) return;
    if (!await allowed(context, ref, TillPermission.xReport)) return;
    setState(() => _working = true);
    try {
      await printTillReport(ref, all);
      if (mounted) PosMessenger.success(context, 'All tills ${all.isZ ? 'Z' : 'X'} report printed.');
    } catch (e) {
      if (mounted) PosMessenger.error(context, 'Could not print it: $e');
    } finally {
      if (mounted) setState(() => _working = false);
    }
  }

  Future<void> _zAll() async {
    if (!await allowed(context, ref, TillPermission.zReport)) return;
    if (!mounted) return;
    final missing = [for (final p in _parts) if (p.report == null) p.name];
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        icon: const Icon(Icons.lock_clock, color: Pos.red, size: 32),
        title: Text('Run the Z on ${_parts.length - missing.length} till${_parts.length - missing.length == 1 ? '' : 's'}?'),
        content: Text(
          'Each till closes its own trading period and prints its own Z on its own printer. '
          'This till then prints one Z for them all. It cannot be undone.\n\n'
          'A till with a sale open is left alone and named afterwards.'
          '${missing.isEmpty ? '' : '\n\nNot answering, and left out: ${missing.join(', ')}.'}',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: Pos.red),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Run every Z'),
          ),
        ],
      ),
    );
    if (ok != true || !mounted) return;

    setState(() => _working = true);
    final lan = LanService.instance;
    final by = ref.read(servedByProvider) ?? '';
    final done = <TillReport>[];
    final left = <String>[];
    // The others first: if one refuses, this till has not closed anything yet
    // and the manager can still walk over and finish the sale.
    for (final part in _parts.where((p) => p.report != null && p.id != lan.deviceId)) {
      setState(() => part.busy = true);
      try {
        final got = await lan.call(part.id, 'zreport', {'by': by}, timeout: const Duration(seconds: 20));
        part.report = TillReport.fromJson(got as Map);
        done.add(part.report!);
      } catch (e) {
        part.problem = _plain(e);
        left.add(part.name);
      } finally {
        part.busy = false;
        if (mounted) setState(() {});
      }
    }
    final mine = _parts.first;
    try {
      final z = await ref.read(sessionRepositoryProvider).zReport(terminalName: _here, staffName: by.isEmpty ? null : by);
      ref.invalidate(xReportProvider);
      ref.read(lastZReportProvider.notifier).set(z);
      mine.report = z;
      done.add(z);
      try {
        await printTillReport(ref, z);
      } catch (_) {
        // Reprint Z on the End of Day page has it.
      }
    } catch (e) {
      mine.problem = '$e';
      left.add(mine.name);
    }
    _closed = true;
    if (done.isNotEmpty) {
      final all = TillReport.combined(done, name: 'All tills (${done.length} of ${_parts.length})', staffName: by.isEmpty ? null : by);
      try {
        await printTillReport(ref, all);
      } catch (e) {
        if (mounted) PosMessenger.error(context, 'Every Z ran, but the combined one did not print ($e). Print it from here again.');
      }
    }
    if (!mounted) return;
    setState(() => _working = false);
    if (left.isEmpty) {
      PosMessenger.success(context, 'Z run on ${done.length} till${done.length == 1 ? '' : 's'}.');
    } else {
      PosMessenger.error(context, 'Z run on ${done.length}. Not run on: ${left.join(', ')}.');
    }
  }

  @override
  Widget build(BuildContext context) {
    final all = _combined;
    final loading = _parts.any((p) => p.busy);
    final wide = MediaQuery.sizeOf(context).width >= 900;
    final tills = ListView.separated(
      shrinkWrap: true,
      // Inside the one scrolling column on a narrow screen.
      physics: wide ? null : const NeverScrollableScrollPhysics(),
      itemCount: _parts.length,
      separatorBuilder: (_, _) => const SizedBox(height: 8),
      itemBuilder: (context, i) {
        final p = _parts[i];
        final r = p.report;
        return Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: p.problem != null ? Pos.red.withValues(alpha: 0.5) : Theme.of(context).dividerColor),
          ),
          child: Row(
            children: [
              Icon(
                p.problem != null ? Icons.error_outline : Icons.point_of_sale,
                color: p.problem != null ? Pos.red : Pos.brandDeep,
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(p.name, style: const TextStyle(fontWeight: FontWeight.w700)),
                    Text(
                      p.problem ??
                          (r == null
                              ? 'Asking…'
                              : '${r.isZ ? 'Z #${r.zNumber ?? ''} run' : '${r.orderCount} sale${r.orderCount == 1 ? '' : 's'}'}'
                                  ' · cash expected ${money(r.expectedCashMinor)}'
                                  '${p.address == null ? '' : ' · ${p.address}'}'),
                      style: TextStyle(fontSize: 13, color: p.problem != null ? Pos.red : Pos.graphite),
                    ),
                  ],
                ),
              ),
              if (p.busy)
                const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
              else if (r != null)
                Text(money(r.grossMinor), style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
            ],
          ),
        );
      },
    );
    final body = all == null
        ? Center(child: Text(loading ? 'Asking every till…' : 'No till answered.'))
        : _ReportBody(report: all);

    return Dialog(
      insetPadding: const EdgeInsets.all(20),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 1040, maxHeight: 760),
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  const Icon(Icons.hub_outlined, color: Pos.brandDeep),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      _closed ? 'All tills: Z run' : 'All tills: X report',
                      style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w700),
                    ),
                  ),
                  IconButton(
                    tooltip: 'Ask every till again',
                    onPressed: _working || _closed ? null : _load,
                    icon: const Icon(Icons.refresh),
                  ),
                  IconButton(tooltip: 'Close', onPressed: () => Navigator.pop(context), icon: const Icon(Icons.close)),
                ],
              ),
              if (all != null) ...[
                const SizedBox(height: 4),
                Text(
                  '${money(all.grossMinor)} taken on ${_reports.length} of ${_parts.length} tills · '
                  'cash expected across the drawers ${money(all.expectedCashMinor)}',
                  style: const TextStyle(color: Pos.graphite),
                ),
              ],
              const SizedBox(height: 16),
              Expanded(
                child: wide
                    ? Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          SizedBox(width: 380, child: tills),
                          const SizedBox(width: 20),
                          Expanded(child: body),
                        ],
                      )
                    : ListView(children: [tills, const SizedBox(height: 16), SizedBox(height: 520, child: body)]),
              ),
              const SizedBox(height: 16),
              Wrap(
                alignment: WrapAlignment.end,
                spacing: 12,
                runSpacing: 8,
                children: [
                  OutlinedButton.icon(
                    icon: const Icon(Icons.print_outlined),
                    label: Text(_closed ? 'Print the combined Z again' : 'Print combined X'),
                    onPressed: all == null || _working ? null : _print,
                  ),
                  if (!_closed)
                    FilledButton.icon(
                      style: FilledButton.styleFrom(backgroundColor: Pos.red),
                      icon: const Icon(Icons.lock_clock),
                      label: Text(_working ? 'Running…' : 'Z every till (reset)'),
                      onPressed: all == null || _working || loading ? null : _zAll,
                    ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
