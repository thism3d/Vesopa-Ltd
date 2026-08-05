import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

/// What the venue prints around the sale: logo, address, VAT number, footer
/// copy and the layout switches the back-office Receipt Designer drives.
///
/// Held separately from the sale itself because it changes on a different
/// clock — a venue edits its footer once a year, and every receipt printed
/// afterwards should pick it up without a terminal being reconfigured.
class Branding {
  const Branding({
    this.venueName = '',
    this.logoUrl,
    this.addressLine1 = '',
    this.addressLine2 = '',
    this.city = '',
    this.postcode = '',
    this.phone = '',
    this.website = '',
    this.vatNumber = '',
    this.companyNumber = '',
    this.headerNote = '',
    this.footerMessage = 'Thank you for your custom',
    this.footerNote = '',
    this.socialLine = '',
    this.paperWidthMm = 80,
    this.showLogo = true,
    this.showVatBreakdown = true,
    this.showBarcode = true,
    this.showQr = false,
    this.qrUrl = '',
    this.showServedBy = true,
    this.showPoweredBy = true,
    this.logoBytes,
  });

  final String venueName;
  final String? logoUrl;
  final String addressLine1;
  final String addressLine2;
  final String city;
  final String postcode;
  final String phone;
  final String website;
  final String vatNumber;
  final String companyNumber;
  final String headerNote;
  final String footerMessage;
  final String footerNote;
  final String socialLine;

  /// 80mm receipt roll or 58mm. Anything else is not a real roll width.
  final int paperWidthMm;

  final bool showLogo;
  final bool showVatBreakdown;
  final bool showBarcode;
  final bool showQr;
  final String qrUrl;
  final bool showServedBy;
  final bool showPoweredBy;

  /// The logo, already downloaded. Kept as bytes rather than a URL because the
  /// printer must work when the network does not — a till mid-service cannot
  /// wait on an image fetch, and a receipt without a logo still has to print.
  final Uint8List? logoBytes;

  /// The address as printed: blank parts are dropped rather than leaving gaps.
  List<String> get addressLines => [
        addressLine1,
        addressLine2,
        [city, postcode].where((s) => s.isNotEmpty).join(' '),
      ].where((s) => s.trim().isNotEmpty).toList();

  bool get hasLogo => showLogo && logoBytes != null;

  Branding copyWith({Uint8List? logoBytes}) => Branding(
        venueName: venueName,
        logoUrl: logoUrl,
        addressLine1: addressLine1,
        addressLine2: addressLine2,
        city: city,
        postcode: postcode,
        phone: phone,
        website: website,
        vatNumber: vatNumber,
        companyNumber: companyNumber,
        headerNote: headerNote,
        footerMessage: footerMessage,
        footerNote: footerNote,
        socialLine: socialLine,
        paperWidthMm: paperWidthMm,
        showLogo: showLogo,
        showVatBreakdown: showVatBreakdown,
        showBarcode: showBarcode,
        showQr: showQr,
        qrUrl: qrUrl,
        showServedBy: showServedBy,
        showPoweredBy: showPoweredBy,
        logoBytes: logoBytes ?? this.logoBytes,
      );

  // The server sends MySQL TINYINT(1) for the switches, which arrives as 0/1
  // rather than a bool.
  static bool _flag(Object? v) => v == 1 || v == true || v == '1';

  factory Branding.fromJson(Map<String, dynamic> j) => Branding(
        venueName: j['venue_name'] as String? ?? '',
        logoUrl: j['logo_url'] as String?,
        addressLine1: j['address_line1'] as String? ?? '',
        addressLine2: j['address_line2'] as String? ?? '',
        city: j['city'] as String? ?? '',
        postcode: j['postcode'] as String? ?? '',
        phone: j['phone'] as String? ?? '',
        website: j['website'] as String? ?? '',
        vatNumber: j['vat_number'] as String? ?? '',
        companyNumber: j['company_number'] as String? ?? '',
        headerNote: j['header_note'] as String? ?? '',
        footerMessage:
            j['footer_message'] as String? ?? 'Thank you for your custom',
        footerNote: j['footer_note'] as String? ?? '',
        socialLine: j['social_line'] as String? ?? '',
        paperWidthMm: (j['paper_width_mm'] as num?)?.toInt() == 58 ? 58 : 80,
        showLogo: _flag(j['show_logo']),
        showVatBreakdown: _flag(j['show_vat_breakdown']),
        showBarcode: _flag(j['show_barcode']),
        showQr: _flag(j['show_qr']),
        qrUrl: j['qr_url'] as String? ?? '',
        showServedBy: _flag(j['show_served_by']),
        showPoweredBy: _flag(j['show_powered_by']),
      );
}

/// Fetches branding for the till, logo included.
class BrandingRepository {
  BrandingRepository({
    required this.apiBase,
    required this.office,
    http.Client? client,
  }) : _client = client ?? http.Client();

  final String apiBase;
  final String office;
  final http.Client _client;

  /// Cached so a receipt never blocks on the network. Printing is on the
  /// critical path of serving a customer.
  Branding? _cached;
  Branding? get cached => _cached;

  /// Reads branding, falling back to whatever was last cached — and then to
  /// plain defaults. A venue that cannot reach the server still prints.
  Future<Branding> load({Duration timeout = const Duration(seconds: 6)}) async {
    try {
      final uri = Uri.parse(
        '$apiBase/api/branding/public?office=${Uri.encodeComponent(office)}',
      );
      final res = await _client.get(uri).timeout(timeout);
      if (res.statusCode != 200) return _cached ?? const Branding();

      var branding =
          Branding.fromJson(jsonDecode(res.body) as Map<String, dynamic>);

      // Pull the logo in the same pass so the first receipt of the day is not
      // the one that goes out without it.
      final logo = branding.logoUrl;
      if (branding.showLogo && logo != null && logo.isNotEmpty) {
        final bytes = await _fetchLogo(logo, timeout);
        if (bytes != null) branding = branding.copyWith(logoBytes: bytes);
      }

      _cached = branding;
      return branding;
    } catch (_) {
      // Offline, slow, or malformed: keep printing with what we had.
      return _cached ?? const Branding();
    }
  }

  Future<Uint8List?> _fetchLogo(String url, Duration timeout) async {
    try {
      final uri = url.startsWith('http')
          ? Uri.parse(url)
          : Uri.parse('$apiBase$url');
      final res = await _client.get(uri).timeout(timeout);
      return res.statusCode == 200 ? res.bodyBytes : null;
    } catch (_) {
      return null;
    }
  }
}
