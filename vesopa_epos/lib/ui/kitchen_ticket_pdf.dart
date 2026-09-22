import 'dart:typed_data';

import 'package:intl/intl.dart';
import 'package:pdf/pdf.dart';
import 'package:pdf/widgets.dart' as pw;

import '../data/branding.dart';
import '../data/receipt_repository.dart';
import '../printing/receipt_fonts.dart';

final _time = DateFormat('HH:mm');
final _date = DateFormat('dd/MM/yy');

String _qty(double q) =>
    q % 1 == 0 ? q.toStringAsFixed(0) : q.toStringAsFixed(2);

/// The kitchen's copy of an order.
///
/// Deliberately not a receipt: no money, no branding, no VAT. A chef reads
/// this from a metre away in a hot room, so item names are large and the
/// things that cause mistakes — quantities and modifiers — are the loudest
/// elements on the page.
Future<Uint8List> buildKitchenTicketPdf(
  ReceiptDetail receipt, {
  Branding branding = const Branding(),
  String station = 'KITCHEN',
  bool isVoid = false,
}) async {
  // Same font handling as the customer receipt: an unbundled Unicode font must
  // not silently drop a modifier a chef needs to read.
  final fonts = await ReceiptFonts.load();
  String t(String v) => fonts.safeText(v);

  final doc = pw.Document(theme: fonts.theme);
  final s = receipt.summary;

  final narrow = branding.paperWidthMm == 58;
  final widthMm = narrow ? 58.0 : 80.0;
  final format = PdfPageFormat(
    widthMm * PdfPageFormat.mm,
    double.infinity,
    marginAll: (narrow ? 3.5 : 5) * PdfPageFormat.mm,
  );

  final base = narrow ? 9.0 : 11.0;

  pw.Widget rule({double thickness = 0.6}) => pw.Container(
        height: thickness,
        margin: const pw.EdgeInsets.symmetric(vertical: 4),
        color: PdfColors.black,
      );

  doc.addPage(
    pw.Page(
      pageFormat: format,
      build: (context) => pw.Column(
        crossAxisAlignment: pw.CrossAxisAlignment.stretch,
        children: [
          // Station banner — inverted so the right printer's ticket is
          // identifiable in a stack of them.
          pw.Container(
            width: double.infinity,
            padding: const pw.EdgeInsets.symmetric(vertical: 4),
            color: isVoid ? PdfColors.grey800 : PdfColors.black,
            child: pw.Center(
              child: pw.Text(
                t(isVoid ? 'VOID - $station' : station),
                style: pw.TextStyle(
                  fontSize: narrow ? 13 : 16,
                  fontWeight: pw.FontWeight.bold,
                  color: PdfColors.white,
                  letterSpacing: 1.2,
                ),
              ),
            ),
          ),
          pw.SizedBox(height: 5),

          // Table is the single most important routing fact on the ticket.
          if (s.tableNumber != null)
            pw.Center(
              child: pw.Text(
                'TABLE ${s.tableNumber}',
                style: pw.TextStyle(
                  fontSize: narrow ? 18 : 24,
                  fontWeight: pw.FontWeight.bold,
                ),
              ),
            )
          else
            pw.Center(
              child: pw.Text(
                'TAKEAWAY',
                style: pw.TextStyle(
                  fontSize: narrow ? 15 : 19,
                  fontWeight: pw.FontWeight.bold,
                ),
              ),
            ),

          pw.SizedBox(height: 3),
          pw.Row(
            mainAxisAlignment: pw.MainAxisAlignment.spaceBetween,
            children: [
              pw.Text(_time.format(s.closedAt),
                  style: pw.TextStyle(
                      fontSize: base, fontWeight: pw.FontWeight.bold)),
              pw.Text(_date.format(s.closedAt),
                  style: pw.TextStyle(fontSize: base - 2)),
            ],
          ),
          if (s.covers != null && s.covers! > 0)
            pw.Text('Covers: ${s.covers}',
                style: pw.TextStyle(fontSize: base - 1)),
          if (s.clerkName?.isNotEmpty ?? false)
            pw.Text(t('Ordered by ${s.clerkName}'),
                style: pw.TextStyle(fontSize: base - 2)),
          if (s.customerName?.isNotEmpty ?? false)
            pw.Text(t(s.customerName!),
                style: pw.TextStyle(
                    fontSize: base - 1, fontWeight: pw.FontWeight.bold)),

          rule(thickness: 1.2),

          // Items. Quantity is boxed and oversized: "2" misread as "1" is the
          // expensive mistake this ticket exists to prevent.
          for (final line in receipt.lines) ...[
            pw.Padding(
              padding: const pw.EdgeInsets.only(bottom: 4),
              child: pw.Row(
                crossAxisAlignment: pw.CrossAxisAlignment.start,
                children: [
                  pw.Container(
                    width: narrow ? 22 : 26,
                    padding: const pw.EdgeInsets.symmetric(vertical: 1),
                    decoration: pw.BoxDecoration(
                      border: pw.Border.all(width: 1),
                    ),
                    child: pw.Center(
                      child: pw.Text(
                        _qty(line.quantity),
                        style: pw.TextStyle(
                          fontSize: base + 2,
                          fontWeight: pw.FontWeight.bold,
                        ),
                      ),
                    ),
                  ),
                  pw.SizedBox(width: 6),
                  pw.Expanded(
                    child: pw.Column(
                      crossAxisAlignment: pw.CrossAxisAlignment.start,
                      children: [
                        pw.Text(
                          t(line.name.toUpperCase()),
                          style: pw.TextStyle(
                            fontSize: base + 1,
                            fontWeight: pw.FontWeight.bold,
                          ),
                        ),
                        // Modifiers are where orders go wrong, so they are
                        // marked rather than tucked away in small print.
                        if (line.note != null)
                          pw.Container(
                            margin: const pw.EdgeInsets.only(top: 2),
                            padding: const pw.EdgeInsets.symmetric(
                                horizontal: 3, vertical: 1.5),
                            color: PdfColors.grey300,
                            child: pw.Text(
                              t('>> ${line.note!.toUpperCase()}'),
                              style: pw.TextStyle(
                                fontSize: base - 1,
                                fontWeight: pw.FontWeight.bold,
                              ),
                            ),
                          ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ],

          rule(thickness: 1.2),

          if (s.orderNote?.isNotEmpty ?? false) ...[
            pw.Container(
              width: double.infinity,
              padding: const pw.EdgeInsets.all(4),
              decoration: pw.BoxDecoration(border: pw.Border.all(width: 1)),
              child: pw.Column(
                crossAxisAlignment: pw.CrossAxisAlignment.start,
                children: [
                  pw.Text('ORDER NOTE',
                      style: pw.TextStyle(
                          fontSize: base - 3, color: PdfColors.grey700)),
                  pw.SizedBox(height: 1),
                  pw.Text(t(s.orderNote!),
                      style: pw.TextStyle(
                          fontSize: base, fontWeight: pw.FontWeight.bold)),
                ],
              ),
            ),
            pw.SizedBox(height: 4),
          ],

          pw.Center(
            child: pw.Text(
              '#${s.id.replaceAll('-', '').toUpperCase().substring(0, 6)}',
              style: pw.TextStyle(fontSize: base - 3, color: PdfColors.grey700),
            ),
          ),
          pw.SizedBox(height: 10),
        ],
      ),
    ),
  );

  return doc.save();
}
