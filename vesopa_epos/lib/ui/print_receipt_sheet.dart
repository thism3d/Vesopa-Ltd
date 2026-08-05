import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:printing/printing.dart';

import '../data/branding.dart';
import '../data/receipt_repository.dart';
import 'kitchen_ticket_pdf.dart';
import 'receipt_pdf.dart';

/// What the clerk chose to do with a finished sale.
enum PrintChoice { customerReceipt, kitchenTicket, both, none }

/// Post-payment print sheet.
///
/// Replaces a bare "Print a receipt?" prompt. A clerk at a counter needs to
/// see what will come out of the printer before it does — a receipt with the
/// wrong logo or a missing voucher line is discovered at the customer's hand
/// otherwise — and needs the common actions reachable in one tap.
class PrintReceiptSheet extends StatefulWidget {
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
  State<PrintReceiptSheet> createState() => _PrintReceiptSheetState();
}

class _PrintReceiptSheetState extends State<PrintReceiptSheet> {
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

  /// Sends straight to the configured printer, falling back to the system
  /// dialog when there is none — a till with a bound thermal printer should
  /// never make the clerk pick it again mid-service.
  Future<void> _print(PrintChoice choice) async {
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
                                : () => _print(PrintChoice.customerReceipt),
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
                  if (widget.showKitchenOption) ...[
                    const SizedBox(height: 10),
                    Row(
                      children: [
                        Expanded(
                          child: TextButton.icon(
                            onPressed: _busy
                                ? null
                                : () => _print(PrintChoice.kitchenTicket),
                            icon: const Icon(Icons.soup_kitchen_outlined),
                            label: const Text('Kitchen ticket'),
                          ),
                        ),
                        Expanded(
                          child: TextButton.icon(
                            onPressed:
                                _busy ? null : () => _print(PrintChoice.both),
                            icon: const Icon(Icons.done_all),
                            label: const Text('Both'),
                          ),
                        ),
                      ],
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
