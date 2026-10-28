import 'package:flutter_test/flutter_test.dart';
import 'package:pdf/pdf.dart';
import 'package:vesopa_go/counter/ui/receipt_print.dart';

void main() {
  const lines = [
    PrintLine('The Vesopa Kitchen', '', true, true),
    PrintLine('1 x Carling Half', '6.05'),
    PrintLine('Total', '£6.05', false, true),
  ];

  test('a receipt makes a PDF on a receipt roll and on A4', () async {
    final roll = await receiptPdf(lines, PdfPageFormat.roll80);
    final a4 = await receiptPdf(lines, PdfPageFormat.a4);
    expect(String.fromCharCodes(roll.take(5)), '%PDF-');
    expect(String.fromCharCodes(a4.take(5)), '%PDF-');
  });

  test('a long report runs on to more pages on A4 instead of failing', () async {
    final long = [for (var i = 0; i < 400; i++) PrintLine('Line $i')];
    final a4 = await receiptPdf(long, PdfPageFormat.a4);
    expect(a4.length, greaterThan(1000));
  });
}
