import 'dart:typed_data';

import 'package:intl/intl.dart';
import 'package:pdf/pdf.dart';
import 'package:pdf/widgets.dart' as pw;

import '../data/branding.dart';
import '../data/receipt_repository.dart';
import '../printing/receipt_fonts.dart';
import '../data/cash_tally.dart';

String _rawMoney(int minor) =>
    NumberFormat.currency(locale: 'en_GB', symbol: '£').format(minor / 100);

/// Quantities print as "2" not "2.00", but "1.5" stays "1.5" for weighed goods.
String _qty(double q) =>
    q % 1 == 0 ? q.toStringAsFixed(0) : q.toStringAsFixed(2);

final _dateStamp = DateFormat('EEE d MMM yyyy');
final _timeStamp = DateFormat('HH:mm');

/// Thermal-roll receipt.
///
/// Rendered at the real roll width so the on-screen preview is the printed
/// article — a receipt that looks right in a viewer but wraps on the roll is
/// worse than no preview. Typography is monospace-ish and left/right aligned
/// in the way a customer expects to read a till receipt, not a document.
///
/// Everything venue-specific comes from [Branding], which the back office
/// owns; nothing here is hard-coded to one venue.
Future<Uint8List> buildReceiptPdf(
  ReceiptDetail receipt, {
  required String venueName,
  Branding branding = const Branding(),
  bool isReprint = false,
  bool isBill = false,
}) async {
  // A Unicode font when one is bundled; otherwise text is degraded so "£" and
  // non-Western names stay legible instead of silently vanishing.
  final fonts = await ReceiptFonts.load();
  String t(String s) => fonts.safeText(s);
  String money(int minor) => t(_rawMoney(minor));

  final doc = pw.Document(theme: fonts.theme);
  final r = receipt;
  final b = branding;

  // The roll. Height grows to fit; margins are tight because thermal paper is
  // narrow and every millimetre of width is content.
  final widthMm = b.paperWidthMm == 58 ? 58.0 : 80.0;
  final narrow = b.paperWidthMm == 58;
  final format = PdfPageFormat(
    widthMm * PdfPageFormat.mm,
    double.infinity,
    marginAll: (narrow ? 3.5 : 5) * PdfPageFormat.mm,
  );

  // Type scale, tightened on 58mm where there is a third less width.
  final base = narrow ? 7.5 : 8.5;
  final bodyStyle = pw.TextStyle(fontSize: base);
  final boldStyle = pw.TextStyle(fontSize: base, fontWeight: pw.FontWeight.bold);
  final smallStyle =
      pw.TextStyle(fontSize: base - 1, color: PdfColors.grey700);

  // A dashed rule reads as a receipt separator; a solid one reads as a table.
  pw.Widget rule({bool heavy = false}) => pw.Container(
        height: heavy ? 1.1 : 0.5,
        margin: const pw.EdgeInsets.symmetric(vertical: 3),
        color: heavy ? PdfColors.black : PdfColors.grey500,
      );

  pw.Widget row(
    String left,
    String right, {
    bool bold = false,
    double? size,
    PdfColor? color,
  }) {
    final style = pw.TextStyle(
      fontSize: size ?? base,
      fontWeight: bold ? pw.FontWeight.bold : pw.FontWeight.normal,
      color: color,
    );
    return pw.Padding(
      padding: const pw.EdgeInsets.symmetric(vertical: 0.8),
      child: pw.Row(
        crossAxisAlignment: pw.CrossAxisAlignment.start,
        children: [
          // The label takes the slack so long item names wrap instead of
          // shoving the price off the roll.
          pw.Expanded(child: pw.Text(left, style: style)),
          pw.SizedBox(width: 6),
          pw.Text(right, style: style),
        ],
      ),
    );
  }

  pw.Widget centred(String text, {pw.TextStyle? style}) => pw.Center(
        child: pw.Text(
          text,
          textAlign: pw.TextAlign.center,
          style: style ?? bodyStyle,
        ),
      );

  final paid = r.tenders.fold<int>(0, (s, t) => s + t.amountMinor);
  final change = paid - r.summary.totalMinor;
  final s = r.summary;

  // VAT is shown by rate: a venue selling 20% food and 0% cold takeaway has to
  // account for both, and one merged "VAT" line does not let anyone check it.
  final vatByRate = <double, ({int net, int vat})>{};
  if (b.showVatBreakdown) {
    for (final line in r.lines) {
      final rate = line.taxPercentage;
      if (rate <= 0) continue;
      final gross = line.lineTotalMinor;
      final net = (gross / (1 + rate / 100)).round();
      final prev = vatByRate[rate] ?? (net: 0, vat: 0);
      vatByRate[rate] = (net: prev.net + net, vat: prev.vat + (gross - net));
    }
  }

  doc.addPage(
    pw.Page(
      pageFormat: format,
      build: (context) => pw.Column(
        crossAxisAlignment: pw.CrossAxisAlignment.stretch,
        children: [
          // ---- Header --------------------------------------------------
          if (b.hasLogo) ...[
            pw.Center(
              child: pw.Container(
                constraints: pw.BoxConstraints(
                  maxHeight: narrow ? 38 : 48,
                  maxWidth: narrow ? 110 : 150,
                ),
                child: pw.Image(
                  pw.MemoryImage(b.logoBytes!),
                  fit: pw.BoxFit.contain,
                ),
              ),
            ),
            pw.SizedBox(height: 5),
          ],

          centred(
            t((b.venueName.isNotEmpty ? b.venueName : venueName).toUpperCase()),
            style: pw.TextStyle(
              fontSize: narrow ? 11 : 13,
              fontWeight: pw.FontWeight.bold,
              letterSpacing: 0.6,
            ),
          ),

          for (final line in b.addressLines) ...[
            pw.SizedBox(height: 1),
            centred(t(line), style: smallStyle),
          ],
          if (b.phone.isNotEmpty) centred(t('Tel ${b.phone}'), style: smallStyle),
          if (b.website.isNotEmpty) centred(t(b.website), style: smallStyle),
          if (b.vatNumber.isNotEmpty) ...[
            pw.SizedBox(height: 1),
            centred(t('VAT No ${b.vatNumber}'), style: smallStyle),
          ],
          if (b.headerNote.isNotEmpty) ...[
            pw.SizedBox(height: 3),
            centred(t(b.headerNote), style: smallStyle),
          ],

          // A reprint must say so, or it can be passed off as a second sale.
          // An unpaid bill must say so even more loudly — handed over without
          // this line it reads as proof of a payment nobody has made.
          if (isReprint || isBill) ...[
            pw.SizedBox(height: 4),
            pw.Container(
              padding: const pw.EdgeInsets.symmetric(vertical: 2),
              decoration: pw.BoxDecoration(
                border: pw.Border.all(width: 0.8),
              ),
              child: centred(
                isBill ? '*** BILL - NOT A RECEIPT ***' : '*** REPRINT ***',
                style: boldStyle,
              ),
            ),
          ],

          rule(),

          // ---- Sale context --------------------------------------------
          row('Date', _dateStamp.format(s.closedAt), size: base - 0.5),
          row('Time', _timeStamp.format(s.closedAt), size: base - 0.5),
          if (s.tableNumber != null)
            row('Table', '${s.tableNumber}', size: base - 0.5),
          if (s.covers != null && s.covers! > 0)
            row('Covers', '${s.covers}', size: base - 0.5),
          if (b.showServedBy && (s.clerkName?.isNotEmpty ?? false))
            row('Served by', t(s.clerkName!), size: base - 0.5),
          if (s.customerName?.isNotEmpty ?? false)
            row('Customer', t(s.customerName!), size: base - 0.5),

          rule(),

          // ---- Items ----------------------------------------------------
          for (final line in r.lines) ...[
            row(
              t('${_qty(line.quantity)}  ${line.name}'),
              money(line.lineTotalMinor),
            ),
            // Unit price only when it is not obvious from a single item.
            if (line.quantity != 1)
              pw.Padding(
                padding: const pw.EdgeInsets.only(left: 10, bottom: 1),
                child: pw.Text(
                  t('@ ') + money(line.unitPriceMinor) + t(' each'),
                  style: smallStyle,
                ),
              ),
            if (line.note != null)
              pw.Padding(
                padding: const pw.EdgeInsets.only(left: 10, bottom: 1),
                child: pw.Text(
                  t('* ${line.note}'),
                  style: pw.TextStyle(
                    fontSize: base - 1,
                    fontStyle: pw.FontStyle.italic,
                  ),
                ),
              ),
          ],

          rule(),

          // ---- Money ----------------------------------------------------
          // Subtotal only earns its place when something is taken off it.
          if (s.discountMinor > 0 || s.hasVoucher || s.serviceMinor > 0)
            row('Subtotal', money(s.grossMinor)),
          if (s.discountMinor > 0)
            row('Discount', '-${money(s.discountMinor)}'),
          if (s.hasVoucher)
            row(
              s.voucherCode?.isNotEmpty ?? false
                  ? t('Voucher ${s.voucherCode}')
                  : 'Voucher',
              '-${money(s.voucherMinor)}',
            ),
          if (s.serviceMinor > 0) row('Service', money(s.serviceMinor)),

          pw.SizedBox(height: 2),
          pw.Container(
            padding: const pw.EdgeInsets.symmetric(vertical: 3, horizontal: 4),
            color: PdfColors.grey200,
            child: pw.Row(
              children: [
                pw.Expanded(
                  child: pw.Text(
                    'TOTAL',
                    style: pw.TextStyle(
                      fontSize: narrow ? 11 : 12.5,
                      fontWeight: pw.FontWeight.bold,
                    ),
                  ),
                ),
                pw.Text(
                  money(s.totalMinor),
                  style: pw.TextStyle(
                    fontSize: narrow ? 11 : 12.5,
                    fontWeight: pw.FontWeight.bold,
                  ),
                ),
              ],
            ),
          ),
          pw.SizedBox(height: 3),

          // ---- Tenders ---------------------------------------------------
          // On an unpaid bill there are none, and the total is what is owed.
          // Saying so beats a silent gap where the payment lines would be.
          if (isBill)
            row('Due', money(s.totalMinor), bold: true)
          else ...[
            for (final tender in r.tenders) ...[
              row(_tenderLabel(tender.method), money(tender.amountMinor)),
              // What was physically handed over, when the clerk counted notes
              // in on the cash keys. The customer can check the receipt against
              // what left their wallet, which a bare "Cash £60" does not allow.
              if (CashTally.decode(tender.cashBreakdown).isNotEmpty)
                pw.Padding(
                  padding: const pw.EdgeInsets.only(left: 8, bottom: 1),
                  child: pw.Text(
                    t(CashTally.decode(tender.cashBreakdown).describe()),
                    style: smallStyle,
                  ),
                ),
            ],
            if (change > 0) row('Change', money(change), bold: true),
          ],

          // ---- VAT breakdown ---------------------------------------------
          if (vatByRate.isNotEmpty) ...[
            rule(),
            pw.Text('VAT ANALYSIS', style: smallStyle),
            pw.SizedBox(height: 1),
            pw.Row(
              children: [
                pw.Expanded(flex: 3, child: pw.Text('Rate', style: smallStyle)),
                pw.Expanded(
                  flex: 4,
                  child: pw.Text('Net', style: smallStyle,
                      textAlign: pw.TextAlign.right),
                ),
                pw.Expanded(
                  flex: 4,
                  child: pw.Text('VAT', style: smallStyle,
                      textAlign: pw.TextAlign.right),
                ),
              ],
            ),
            for (final entry in (vatByRate.keys.toList()..sort()))
              pw.Row(
                children: [
                  pw.Expanded(
                    flex: 3,
                    child: pw.Text('${_qty(entry)}%', style: smallStyle),
                  ),
                  pw.Expanded(
                    flex: 4,
                    child: pw.Text(money(vatByRate[entry]!.net),
                        style: smallStyle, textAlign: pw.TextAlign.right),
                  ),
                  pw.Expanded(
                    flex: 4,
                    child: pw.Text(money(vatByRate[entry]!.vat),
                        style: smallStyle, textAlign: pw.TextAlign.right),
                  ),
                ],
              ),
          ] else if (s.taxMinor > 0)
            row('VAT included', money(s.taxMinor), size: base - 1),

          // ---- Loyalty ----------------------------------------------------
          if (s.pointsEarned > 0 ||
              s.pointsRedeemed > 0 ||
              s.pointsBalance != null) ...[
            rule(),
            if (s.pointsRedeemed > 0)
              row('Points redeemed', '-${s.pointsRedeemed}', size: base - 0.5),
            if (s.pointsEarned > 0)
              row('Points earned', '${s.pointsEarned}', size: base - 0.5),
            if (s.pointsBalance != null)
              row('Points balance', '${s.pointsBalance}',
                  bold: true, size: base - 0.5),
          ],

          // No order-level note here by design. Notes are taken against the
          // item they belong to and print under that line above; a single note
          // at the foot of the bill could not say which dish it referred to,
          // which is what made it useless to a kitchen and to the customer.

          rule(heavy: true),

          // ---- Footer ------------------------------------------------------
          pw.SizedBox(height: 2),
          if (b.footerMessage.isNotEmpty)
            centred(
              t(b.footerMessage),
              style: pw.TextStyle(
                fontSize: narrow ? 9 : 10,
                fontWeight: pw.FontWeight.bold,
              ),
            ),
          if (b.footerNote.isNotEmpty) ...[
            pw.SizedBox(height: 2),
            centred(t(b.footerNote), style: smallStyle),
          ],
          if (b.socialLine.isNotEmpty) ...[
            pw.SizedBox(height: 2),
            centred(t(b.socialLine), style: smallStyle),
          ],

          // The receipt number as a barcode: this is how a returned item gets
          // looked up at the counter without anyone typing a UUID.
          if (b.showBarcode) ...[
            pw.SizedBox(height: 6),
            pw.Center(
              child: pw.BarcodeWidget(
                barcode: pw.Barcode.code128(),
                data: _receiptNumber(s.id),
                width: narrow ? 120 : 160,
                height: 30,
                drawText: false,
              ),
            ),
          ],
          if (b.showQr && b.qrUrl.isNotEmpty) ...[
            pw.SizedBox(height: 5),
            pw.Center(
              child: pw.BarcodeWidget(
                barcode: pw.Barcode.qrCode(),
                data: b.qrUrl,
                width: 52,
                height: 52,
                drawText: false,
              ),
            ),
          ],

          pw.SizedBox(height: 4),
          centred('Receipt ${_receiptNumber(s.id)}', style: smallStyle),
          if (b.companyNumber.isNotEmpty)
            centred(t('Co. No ${b.companyNumber}'), style: smallStyle),

          if (b.showPoweredBy) ...[
            pw.SizedBox(height: 4),
            centred(
              'Powered by VESOPA EPOS',
              style: pw.TextStyle(fontSize: base - 1.5, color: PdfColors.grey600),
            ),
          ],
          // Feed clear of the tear bar.
          pw.SizedBox(height: 10),
        ],
      ),
    ),
  );

  return doc.save();
}

/// A UUID is unusable at a counter. The first 8 characters are what staff read
/// out and what the barcode encodes.
String _receiptNumber(String id) {
  final clean = id.replaceAll('-', '').toUpperCase();
  return clean.length <= 8 ? clean : clean.substring(0, 8);
}

String _tenderLabel(String method) => switch (method.toLowerCase()) {
      'cash' => 'Cash',
      'card' => 'Card',
      'voucher' => 'Voucher',
      'account' => 'On account',
      _ => method.isEmpty
          ? 'Payment'
          : method[0].toUpperCase() + method.substring(1).toLowerCase(),
    };
