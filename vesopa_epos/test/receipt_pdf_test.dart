import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/branding.dart';
import 'package:vesopa_epos/data/receipt_repository.dart';
import 'package:vesopa_epos/printing/receipt_fonts.dart';
import 'package:vesopa_epos/ui/kitchen_ticket_pdf.dart';
import 'package:vesopa_epos/ui/receipt_pdf.dart';

/// A PDF that throws while building is a till that cannot print, so these
/// exercise the real builders end to end rather than mocking them out. The
/// awkward cases are the ones a venue actually hits: a voucher and a discount
/// on the same sale, mixed VAT rates, and a receipt with nothing optional set.
ReceiptDetail _receipt({
  int discountMinor = 0,
  int voucherMinor = 0,
  String? voucherCode,
  String? customerName,
  int serviceMinor = 0,
  int pointsEarned = 0,
  int? pointsBalance,
  String? clerkName,
  String? orderNote,
  int? tableNumber,
  int? covers,
  List<ReceiptLine>? lines,
  List<ReceiptTender>? tenders,
}) =>
    ReceiptDetail(
      summary: ReceiptSummary(
        id: '3f2a91b4-77cc-4d1e-9a2b-5e6f7a8b9c0d',
        totalMinor: 2450,
        taxMinor: 408,
        discountMinor: discountMinor,
        closedAt: DateTime(2026, 7, 18, 19, 42),
        tableNumber: tableNumber,
        covers: covers,
        customerName: customerName,
        voucherCode: voucherCode,
        voucherMinor: voucherMinor,
        serviceMinor: serviceMinor,
        pointsEarned: pointsEarned,
        pointsBalance: pointsBalance,
        clerkName: clerkName,
        orderNote: orderNote,
      ),
      lines: lines ??
          const [
            ReceiptLine(
              name: 'Chicken Biryani',
              quantity: 2,
              unitPriceMinor: 895,
              taxPercentage: 20,
              note: 'extra spicy, no coriander',
            ),
            ReceiptLine(
              name: 'Mango Lassi',
              quantity: 1,
              unitPriceMinor: 360,
              taxPercentage: 0,
            ),
          ],
      tenders: tenders ??
          const [ReceiptTender(method: 'card', amountMinor: 2450)],
    );

void main() {
  group('receipt PDF', () {
    test('renders a plain sale', () async {
      final bytes = await buildReceiptPdf(_receipt(), venueName: 'Vesopa');
      expect(bytes.length, greaterThan(1000));
      // A real PDF, not an empty document.
      expect(String.fromCharCodes(bytes.take(5)), '%PDF-');
    });

    test('renders discount, voucher and service on one sale', () async {
      final bytes = await buildReceiptPdf(
        _receipt(
          discountMinor: 200,
          voucherMinor: 500,
          voucherCode: 'WELCOME5',
          serviceMinor: 245,
        ),
        venueName: 'Vesopa',
      );
      expect(bytes.length, greaterThan(1000));
    });

    test('renders the full receipt: customer, loyalty, notes, table', () async {
      final bytes = await buildReceiptPdf(
        _receipt(
          customerName: 'A. Khan',
          clerkName: 'Sam',
          tableNumber: 12,
          covers: 4,
          pointsEarned: 24,
          pointsBalance: 310,
          orderNote: 'Birthday — bring dessert with a candle',
        ),
        venueName: 'Vesopa',
        branding: const Branding(
          venueName: 'The Vesopa Kitchen',
          addressLine1: '12 High Street',
          city: 'London',
          postcode: 'E1 6AN',
          vatNumber: 'GB123456789',
          phone: '020 7946 0000',
          footerMessage: 'Thank you — see you soon!',
          socialLine: '@vesopakitchen',
          showQr: true,
          qrUrl: 'https://vesopa.co.uk',
        ),
      );
      expect(bytes.length, greaterThan(1000));
    });

    test('renders on a 58mm roll', () async {
      final bytes = await buildReceiptPdf(
        _receipt(customerName: 'A. Khan', tableNumber: 3),
        venueName: 'Vesopa',
        branding: const Branding(paperWidthMm: 58),
      );
      expect(bytes.length, greaterThan(1000));
    });

    test('marks a reprint', () async {
      final bytes = await buildReceiptPdf(
        _receipt(),
        venueName: 'Vesopa',
        isReprint: true,
      );
      expect(bytes.length, greaterThan(1000));
    });

    test('survives a receipt with no lines and no tenders', () async {
      final bytes = await buildReceiptPdf(
        _receipt(lines: const [], tenders: const []),
        venueName: 'Vesopa',
      );
      expect(bytes.length, greaterThan(500));
    });

    test('cash sale shows change', () async {
      final bytes = await buildReceiptPdf(
        _receipt(
          tenders: const [ReceiptTender(method: 'cash', amountMinor: 3000)],
        ),
        venueName: 'Vesopa',
      );
      expect(bytes.length, greaterThan(1000));
    });
  });

  group('kitchen ticket PDF', () {
    test('renders a table order with modifiers', () async {
      final bytes = await buildKitchenTicketPdf(
        _receipt(tableNumber: 7, covers: 2, clerkName: 'Sam'),
      );
      expect(String.fromCharCodes(bytes.take(5)), '%PDF-');
    });

    test('renders a takeaway with an order note', () async {
      final bytes = await buildKitchenTicketPdf(
        _receipt(orderNote: 'Allergy: nuts'),
        station: 'BAR',
      );
      expect(bytes.length, greaterThan(800));
    });

    test('renders a void ticket', () async {
      final bytes = await buildKitchenTicketPdf(
        _receipt(tableNumber: 7),
        isVoid: true,
      );
      expect(bytes.length, greaterThan(800));
    });

    test('renders on a 58mm roll', () async {
      final bytes = await buildKitchenTicketPdf(
        _receipt(tableNumber: 7),
        branding: const Branding(paperWidthMm: 58),
      );
      expect(bytes.length, greaterThan(800));
    });
  });

  group('font fallback', () {
    // The built-in Helvetica cannot draw "£" and fails silently. Without a
    // bundled Unicode font the receipt must degrade to something readable
    // rather than printing a price with no currency on it.
    tearDown(ReceiptFonts.debugReset);

    test('substitutes currency and punctuation when no font is bundled', () {
      final fonts = ReceiptFonts.noUnicodeForTest();
      expect(fonts.safeText('£24.50'), 'GBP 24.50');
      expect(fonts.safeText('VOID — KITCHEN'), 'VOID - KITCHEN');
      expect(fonts.safeText('Chef’s special'), "Chef's special");
    });

    test('marks characters it cannot render rather than dropping them', () {
      final fonts = ReceiptFonts.noUnicodeForTest();
      // A name the font cannot draw must leave evidence, not a blank.
      expect(fonts.safeText('Ali 中文'), 'Ali ??');
    });

    test('passes text through untouched when a Unicode font is present', () {
      final fonts = ReceiptFonts.unicodeForTest();
      expect(fonts.safeText('£24.50 — Chef’s 中文'), '£24.50 — Chef’s 中文');
    });

    test('a receipt still builds with no Unicode font', () async {
      ReceiptFonts.debugSet(ReceiptFonts.noUnicodeForTest());
      final bytes = await buildReceiptPdf(
        _receipt(customerName: 'Ali', voucherCode: 'SAVE5', voucherMinor: 500),
        venueName: 'Vesopa',
      );
      expect(String.fromCharCodes(bytes.take(5)), '%PDF-');
    });
  });

  group('receipt totals', () {
    final when = DateTime(2026, 7, 18, 19, 42);

    test('grossMinor backs out discounts, vouchers and service', () {
      final s = ReceiptSummary(
        id: 'x',
        totalMinor: 2450,
        taxMinor: 0,
        discountMinor: 200,
        voucherMinor: 500,
        serviceMinor: 245,
        closedAt: when,
      );
      // 2450 total = goods - 200 - 500 + 245, so goods came to 2905.
      expect(s.grossMinor, 2905);
    });

    test('a sale with no voucher does not claim one', () {
      final s = ReceiptSummary(
        id: 'x',
        totalMinor: 100,
        taxMinor: 0,
        discountMinor: 0,
        closedAt: when,
      );
      expect(s.hasVoucher, isFalse);
    });

    test('parses server rows, including older ones missing new columns', () {
      final s = ReceiptSummary.fromJson({
        'id': 'abc',
        'total_minor': 500,
        'closed_at': '2026-07-18T19:42:00.000Z',
      });
      expect(s.voucherMinor, 0);
      expect(s.customerName, isNull);
      expect(s.hasVoucher, isFalse);
    });
  });
}
