import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:printing/printing.dart';

import '../data/branding.dart';
import '../data/receipt_repository.dart';
// Re-exports print_targets.dart, which is where PrintTarget lives.
import '../printing/printer_transport.dart';
import '../printing/receipt_builder.dart';
import 'kitchen_ticket_pdf.dart';
import 'printers_page.dart' show printerSettingsProvider;
import 'receipt_pdf.dart';
import 'widgets/pos_message.dart';

/// What the clerk chose to do with a finished sale.
enum PrintChoice { customerReceipt, kitchenTicket, both, none }

/// Post-payment print sheet.
///
/// Replaces a bare "Print a receipt?" prompt. A clerk at a counter needs to
/// see what will come out of the printer before it does — a receipt with the
/// wrong logo or a missing voucher line is discovered at the customer's hand
/// otherwise — and needs the common actions reachable in one tap.
class PrintReceiptSheet extends ConsumerStatefulWidget {
  const PrintReceiptSheet({
    super.key,
    required this.receipt,
    required this.venueName,
    required this.branding,
    this.showKitchenOption = true,
    this.isReprint = false,
    this.isBill = false,
    this.title,
  });

  final ReceiptDetail receipt;
  final String venueName;
  final Branding branding;

  /// Kitchen tickets only make sense where there is a kitchen.
  final bool showKitchenOption;

  /// Stamp the document as a second copy. A reprint that looks identical to the
  /// original can be passed off as a second sale.
  final bool isReprint;

  /// This is the bill *before* payment, not a receipt for one. Changes the
  /// wording throughout: nothing has been paid yet.
  final bool isBill;

  /// Overrides the heading. Defaults to the paid-and-printing wording.
  final String? title;

  /// Shows the sheet. Returns what was printed, or [PrintChoice.none].
  static Future<PrintChoice> show(
    BuildContext context, {
    required ReceiptDetail receipt,
    required String venueName,
    required Branding branding,
    bool showKitchenOption = true,
    bool isReprint = false,
    bool isBill = false,
    String? title,
  }) async {
    final choice = await showModalBottomSheet<PrintChoice>(
      context: context,
      isScrollControlled: true,
      useRootNavigator: true,
      builder: (_) => PrintReceiptSheet(
        receipt: receipt,
        venueName: venueName,
        branding: branding,
        showKitchenOption: showKitchenOption,
        isReprint: isReprint,
        isBill: isBill,
        title: title,
      ),
    );
    return choice ?? PrintChoice.none;
  }

  @override
  ConsumerState<PrintReceiptSheet> createState() => _PrintReceiptSheetState();
}

class _PrintReceiptSheetState extends ConsumerState<PrintReceiptSheet> {
  bool _busy = false;

  Future<Uint8List> _receiptPdf() => buildReceiptPdf(
        widget.receipt,
        venueName: widget.venueName,
        branding: widget.branding,
        isReprint: widget.isReprint,
        isBill: widget.isBill,
      );

  Future<Uint8List> _kitchenPdf() => buildKitchenTicketPdf(
        widget.receipt,
        branding: widget.branding,
      );

  /// The printer a target will actually use, or null if none is set up.
  PrinterConfig? _printerFor(PrintTarget target) =>
      ref.read(printerSettingsProvider).value?.deviceFor(target);

  /// What to print across the top of the receipt.
  ///
  /// The venue's trading name as set in the back office, and only then the
  /// session's fallback. [Session.venueName] is the back-office *account* name,
  /// which for a sole trader is a person's name — so a till that had branding
  /// configured still headed every reprint with the owner's name in
  /// double-height text. The PDF path has always preferred branding here; this
  /// is the direct path catching up.
  String get _shopName => widget.branding.venueName.isNotEmpty
      ? widget.branding.venueName
      : widget.venueName;

  /// Print straight to the assigned printer as ESC/POS.
  ///
  /// No print dialog, no driver, and on a USB or network printer no spooler
  /// either — the bytes go from here to the paper. That is the whole point: a
  /// clerk mid-service should never be handed a Windows print dialog, and a
  /// receipt should not be waiting behind whatever else is in a queue.
  ///
  /// Falls back to the PDF path when nothing is set up, so a till being
  /// configured — or one with no thermal printer at all — can still put a
  /// receipt in a customer's hand.
  Future<void> _printDirect(PrintTarget target) async {
    if (_busy) return;

    final printer = _printerFor(target);
    if (printer == null) {
      await _printViaWindows();
      return;
    }

    setState(() => _busy = true);
    try {
      // Laid out for the roll in *this* printer, not a default. The bill and
      // the receipt can be assigned to different printers taking different
      // paper.
      final builder = await ReceiptBuilder.create(
        paperWidthMm: printer.paperWidthMm,
      );
      await PrinterTransport.of(printer).send(
        builder.receiptFromDetail(
          widget.receipt,
          shopName: _shopName,
          footer: widget.branding.footerMessage,
          logo: widget.branding.showLogo ? widget.branding.logoBytes : null,
          heading: switch (target) {
            PrintTarget.merchantCopy => 'MERCHANT COPY',
            _ when widget.isBill => 'BILL - NOT A RECEIPT',
            _ when widget.isReprint => 'REPRINT',
            _ => null,
          },
        ),
      );
      if (!mounted) return;
      // The merchant copy is an extra, not the outcome: printing one must not
      // close the sheet before the customer's copy has been dealt with.
      if (target == PrintTarget.merchantCopy) {
        PosMessenger.success(context, 'Merchant copy printed.');
      } else {
        Navigator.of(context).pop(PrintChoice.customerReceipt);
      }
    } catch (e) {
      if (mounted) {
        PosMessenger.error(context, 'Could not print on ${printer.name}.\n\n$e');
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// The old path: render a PDF and hand it to Windows.
  ///
  /// Kept deliberately. It is what a till with no thermal printer uses, what a
  /// venue reaches for when a printer has died mid-service, and the only way to
  /// get a receipt onto an A4 office printer.
  Future<void> _printViaWindows([PrintChoice choice = PrintChoice.customerReceipt]) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      if (choice == PrintChoice.customerReceipt || choice == PrintChoice.both) {
        await Printing.layoutPdf(
          onLayout: (_) => _receiptPdf(),
          name: 'Receipt',
        );
      }
      if (choice == PrintChoice.kitchenTicket || choice == PrintChoice.both) {
        await Printing.layoutPdf(
          onLayout: (_) => _kitchenPdf(),
          name: 'Kitchen ticket',
        );
      }
      if (mounted) Navigator.of(context).pop(choice);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final media = MediaQuery.of(context);

    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: media.size.height * 0.92),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const SizedBox(height: 8),
            Container(
              width: 40,
              height: 4,
              decoration: BoxDecoration(
                color: scheme.outlineVariant,
                borderRadius: BorderRadius.circular(2),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 16, 20, 8),
              child: Row(
                children: [
                  Icon(
                    widget.isBill
                        ? Icons.receipt_long
                        : widget.isReprint
                            ? Icons.copy_all
                            : Icons.check_circle,
                    color: widget.isBill || widget.isReprint
                        ? scheme.primary
                        : Colors.green.shade600,
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      widget.title ??
                          (widget.isBill
                              ? 'Bill for the customer'
                              : 'Paid — print receipt?'),
                      style: theme.textTheme.titleLarge
                          ?.copyWith(fontWeight: FontWeight.w700),
                    ),
                  ),
                  // The roll width is worth surfacing: printing an 80mm layout
                  // on a 58mm roll silently crops the right-hand column.
                  Chip(
                    visualDensity: VisualDensity.compact,
                    label: Text('${widget.branding.paperWidthMm}mm'),
                  ),
                ],
              ),
            ),

            // Live preview of the actual PDF that will print.
            //
            // The preview is the point: a till with no printer configured can
            // still generate the document, show it, and share or save it as a
            // PDF. Sharing is left on for exactly that — a venue setting up, or
            // one whose printer has died mid-service, can still put a receipt
            // in the customer's hand.
            Expanded(
              child: Container(
                margin: const EdgeInsets.symmetric(horizontal: 16),
                decoration: BoxDecoration(
                  color: scheme.surfaceContainerHighest,
                  borderRadius: BorderRadius.circular(12),
                ),
                clipBehavior: Clip.antiAlias,
                child: PdfPreview(
                  build: (_) => _receiptPdf(),
                  useActions: true,
                  allowPrinting: false,
                  allowSharing: true,
                  canChangePageFormat: false,
                  canChangeOrientation: false,
                  canDebug: false,
                  pdfFileName: widget.isBill ? 'bill.pdf' : 'receipt.pdf',
                  scrollViewDecoration: BoxDecoration(
                    color: scheme.surfaceContainerHighest,
                  ),
                  loadingWidget: const Center(
                    child: CircularProgressIndicator(),
                  ),
                ),
              ),
            ),

            Padding(
              padding: const EdgeInsets.fromLTRB(16, 14, 16, 16),
              child: Column(
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: SizedBox(
                          height: 56,
                          child: OutlinedButton.icon(
                            onPressed: _busy
                                ? null
                                : () =>
                                    Navigator.of(context).pop(PrintChoice.none),
                            icon: const Icon(Icons.close),
                            label: Text(
                              widget.isBill || widget.isReprint
                                  ? 'Done'
                                  : 'No receipt',
                            ),
                          ),
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        flex: 2,
                        child: SizedBox(
                          height: 56,
                          child: FilledButton.icon(
                            onPressed: _busy
                                ? null
                                : () => _printDirect(
                                    widget.isBill
                                        ? PrintTarget.bill
                                        : PrintTarget.customerReceipt,
                                  ),
                            icon: _busy
                                ? const SizedBox(
                                    width: 18,
                                    height: 18,
                                    child: CircularProgressIndicator(
                                        strokeWidth: 2),
                                  )
                                : const Icon(Icons.print),
                            label: const Text('Print receipt'),
                          ),
                        ),
                      ),
                    ],
                  ),

                  const SizedBox(height: 6),
                  // The secondary row. Everything here is an escape hatch, so
                  // it is deliberately quieter than the key above it — the one
                  // a clerk hits a hundred times a shift.
                  Row(
                    children: [
                      if (_printerFor(PrintTarget.merchantCopy) != null)
                        Expanded(
                          child: TextButton.icon(
                            onPressed: _busy
                                ? null
                                : () =>
                                      _printDirect(PrintTarget.merchantCopy),
                            icon: const Icon(Icons.content_copy, size: 18),
                            label: const Text('Merchant copy'),
                          ),
                        ),
                      if (widget.showKitchenOption)
                        Expanded(
                          child: TextButton.icon(
                            onPressed: _busy
                                ? null
                                : () => _printViaWindows(
                                    PrintChoice.kitchenTicket,
                                  ),
                            icon: const Icon(
                              Icons.soup_kitchen_outlined,
                              size: 18,
                            ),
                            label: const Text('Kitchen ticket'),
                          ),
                        ),
                      Expanded(
                        child: TextButton.icon(
                          onPressed: _busy ? null : () => _printViaWindows(),
                          icon: const Icon(Icons.desktop_windows_outlined,
                              size: 18),
                          label: const Text('Windows / PDF'),
                        ),
                      ),
                    ],
                  ),

                  // Says which printer the big key will use, because "Print
                  // receipt" doing something different on two tills in the same
                  // venue is exactly the confusion per-document printers
                  // introduce if nobody is told.
                  if (_printerFor(
                        widget.isBill
                            ? PrintTarget.bill
                            : PrintTarget.customerReceipt,
                      )
                      case final printer?)
                    Padding(
                      padding: const EdgeInsets.only(top: 2),
                      child: Text(
                        printer.isDirect
                            ? 'Prints directly on ${printer.name} — no '
                                  'Windows dialog, no spooler.'
                            : 'Prints on ${printer.name} through the Windows '
                                  'spooler.',
                        textAlign: TextAlign.center,
                        style: theme.textTheme.bodySmall,
                      ),
                    )
                  else
                    Padding(
                      padding: const EdgeInsets.only(top: 2),
                      child: Text(
                        'No receipt printer set up on this till, so this opens '
                        'the Windows print dialog.',
                        textAlign: TextAlign.center,
                        style: theme.textTheme.bodySmall,
                      ),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
