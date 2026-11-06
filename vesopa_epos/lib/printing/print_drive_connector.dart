import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;
import 'package:image/image.dart' as img;
import 'package:pdf/pdf.dart';
import 'package:pdf/widgets.dart' as pw;
import 'package:printing/printing.dart';

import 'printer_transport.dart';

/// This till is the way out for its printers' online drives
/// (vesopa_server/src/print_drive.js).
///
/// A Windows printer gets the PDF through its own driver, so an office printer
/// prints a proper A4 page. A receipt printer gets each page as a picture at its
/// paper's width, through the same connection its receipts take.
///
/// One job at a time. The till says how each went, and only ever takes a job
/// once: if it dies part way, the back office shows that and a person decides.

/// ESC/POS for one page: GS v 0, a one-bit picture [dots] wide.
///
/// [rgba] is [width] x [height] pixels. Dark pixels print. White is added under
/// transparency, because a logo on a clear background would otherwise be black.
List<int> pageToEscPos(Uint8List rgba, int width, int height, int dots) {
  final source = img.Image.fromBytes(
    width: width,
    height: height,
    bytes: rgba.buffer,
    bytesOffset: rgba.offsetInBytes,
    numChannels: 4,
    order: img.ChannelOrder.rgba,
  );
  final scaled = img.copyResize(source, width: dots, interpolation: img.Interpolation.average);
  final bytesWide = (dots + 7) ~/ 8;
  final rows = scaled.height;
  final out = BytesBuilder(copy: false)
    ..add([0x1D, 0x76, 0x30, 0x00, bytesWide & 0xFF, bytesWide >> 8, rows & 0xFF, rows >> 8]);
  for (var y = 0; y < rows; y++) {
    final row = Uint8List(bytesWide);
    for (var x = 0; x < dots; x++) {
      final p = scaled.getPixel(x, y);
      final a = p.a / 255;
      final light = (p.r * 0.3 + p.g * 0.59 + p.b * 0.11) * a + 255 * (1 - a);
      if (light < 128) row[x ~/ 8] |= 0x80 >> (x % 8);
    }
    out.add(row);
  }
  return out.takeBytes();
}

/// Dots across a roll: 8 a millimetre, less the margins a head cannot reach.
int dotsFor(int paperWidthMm) => paperWidthMm <= 58 ? 384 : 576;

class PrintDriveConnector {
  PrintDriveConnector({
    required this.apiBase,
    required this.token,
    required this.deviceId,
    required this.printers,
    http.Client? client,
    this.printPage,
  }) : _http = client ?? http.Client();

  final String apiBase;
  final String token;
  final String deviceId;

  /// The printers this till has, read fresh each round.
  final Future<List<PrinterConfig>> Function() printers;

  /// Replaced by a test: the real one needs a printer.
  final Future<void> Function(PrinterConfig printer, Uint8List pdf)? printPage;

  final http.Client _http;
  Timer? _timer;
  bool _busy = false;

  Map<String, String> get _auth => {'Authorization': 'Bearer $token'};

  void start() {
    _timer?.cancel();
    _timer = Timer.periodic(const Duration(seconds: 10), (_) => round());
    unawaited(round());
  }

  void stop() {
    _timer?.cancel();
    _timer = null;
  }

  /// Everything waiting, one at a time. Never throws, and never overlaps.
  Future<void> round() async {
    if (_busy) return;
    _busy = true;
    try {
      final uri = Uri.parse('$apiBase/api/device/print-jobs')
          .replace(queryParameters: {'device_id': deviceId, 'kind': 'till'});
      final res = await _http.get(uri, headers: _auth).timeout(const Duration(seconds: 10));
      if (res.statusCode != 200) return;
      final jobs = (jsonDecode(res.body) as Map<String, dynamic>)['jobs'] as List<dynamic>? ?? const [];
      for (final job in jobs) {
        await _one(job as Map<String, dynamic>);
      }
    } catch (_) {
      // Offline: the jobs wait in the drive for the next round.
    } finally {
      _busy = false;
    }
  }

  Future<void> _one(Map<String, dynamic> job) async {
    final id = job['id'] as String;
    final res = await _http
        .get(Uri.parse('$apiBase/api/device/print-jobs/$id/file'), headers: _auth)
        .timeout(const Duration(seconds: 60));
    // Another round has it, or it was cancelled a moment ago.
    if (res.statusCode != 200) return;
    String? error;
    try {
      final mine = await printers();
      final wanted = job['printer_id'] as String?;
      final printer = mine.where((p) => p.id == wanted).firstOrNull;
      if (printer == null) throw StateError('This till no longer has that printer.');
      final pdf = await _asPdf(res.bodyBytes, job['mime'] as String?);
      await (printPage ?? _print)(printer, pdf);
    } catch (e) {
      error = '$e';
    }
    await _http
        .post(
          Uri.parse('$apiBase/api/device/print-jobs/$id/status'),
          headers: {..._auth, 'Content-Type': 'application/json'},
          body: jsonEncode({'printed': error == null, 'error': ?error}),
        )
        .timeout(const Duration(seconds: 15));
  }

  /// A picture on a page of its own, so everything prints the same way.
  Future<Uint8List> _asPdf(Uint8List bytes, String? mime) async {
    if (mime == 'application/pdf') return bytes;
    final doc = pw.Document();
    final image = pw.MemoryImage(bytes);
    doc.addPage(pw.Page(pageFormat: PdfPageFormat.a4, build: (_) => pw.Center(child: pw.Image(image))));
    return doc.save();
  }

  Future<void> _print(PrinterConfig printer, Uint8List pdf) async {
    if (printer.kind == PrinterKind.windowsQueue) {
      final ok = await Printing.directPrintPdf(
        printer: Printer(url: printer.windowsQueueName ?? printer.name),
        onLayout: (_) async => pdf,
      );
      if (!ok) throw StateError('Windows would not print it.');
      return;
    }
    final dots = dotsFor(printer.paperWidthMm);
    final transport = PrinterTransport.of(printer);
    await for (final page in Printing.raster(pdf, dpi: 150)) {
      await transport.send([
        ...pageToEscPos(page.pixels, page.width, page.height, dots),
        0x1B, 0x64, 0x04, // feed
        0x1D, 0x56, 0x42, 0x00, // cut
      ]);
    }
  }
}
