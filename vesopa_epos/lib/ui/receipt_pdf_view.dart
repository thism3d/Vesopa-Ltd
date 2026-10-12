import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:printing/printing.dart';

/// A receipt PDF on screen, built once and drawn once.
///
/// This replaces `PdfPreview` for receipts, which was the "loading, loading"
/// the venues saw. PdfPreview takes a build *function*, and every rebuild of
/// the screen around it hands it a new one, so it threw away what it had and
/// started the document again — and each start rasterised the whole roll at
/// the screen's full pixel density. On an iPad that is many seconds per pass,
/// and a screen that rebuilds (a status refresh, a provider update) never
/// reached the end.
///
/// Here the document is built once per [cacheKey], rasterised once at a
/// resolution that is sharp for a receipt and no more, and kept: opening the
/// same receipt again, or redrawing the screen, shows it at once.
class ReceiptPdfView extends StatefulWidget {
  const ReceiptPdfView({
    super.key,
    required this.cacheKey,
    required this.build,
    this.background,
    this.onError,
  });

  /// What makes two documents the same: the receipt id plus anything that
  /// changes what it prints (refunds, reprint, bill). A new key builds anew.
  final String cacheKey;

  /// Makes the PDF bytes. Called at most once per [cacheKey].
  final Future<Uint8List> Function() build;

  final Color? background;

  /// Shown instead of the receipt when it cannot be drawn.
  final Widget Function(BuildContext context, Object error)? onError;

  /// The PDF bytes for [cacheKey], built once and shared with print and share
  /// buttons so they do not build the document a second time.
  static Future<Uint8List> bytesFor(
    String cacheKey,
    Future<Uint8List> Function() build,
  ) {
    final hit = _bytes.remove(cacheKey);
    final future = hit ?? build();
    _bytes[cacheKey] = future;
    _trim(_bytes);
    // A failed build is not kept, so trying again really tries again.
    future.catchError((Object _) {
      _bytes.remove(cacheKey);
      return Uint8List(0);
    });
    return future;
  }

  static final _bytes = <String, Future<Uint8List>>{};
  static final _pages = <String, Future<List<ImageProvider>>>{};

  /// Receipts are small; a few dozen kept is a shift's worth of look-ups.
  static const _keep = 24;

  static void _trim(Map<String, Object> map) {
    while (map.length > _keep) {
      map.remove(map.keys.first);
    }
  }

  /// Forget everything, for tests.
  static void clearCache() {
    _bytes.clear();
    _pages.clear();
  }

  /// 144 dpi: twice a receipt printer's 72 points, crisp on a retina screen,
  /// and a fraction of the pixels PdfPreview drew at.
  static const dpi = 144.0;

  @override
  State<ReceiptPdfView> createState() => _ReceiptPdfViewState();
}

class _ReceiptPdfViewState extends State<ReceiptPdfView> {
  late Future<List<ImageProvider>> _pages;

  @override
  void initState() {
    super.initState();
    _pages = _load();
  }

  @override
  void didUpdateWidget(ReceiptPdfView old) {
    super.didUpdateWidget(old);
    // Only a different document starts again. A new build closure for the
    // same receipt (every rebuild of the parent makes one) does not.
    if (old.cacheKey != widget.cacheKey) _pages = _load();
  }

  Future<List<ImageProvider>> _load() {
    final key = widget.cacheKey;
    final hit = ReceiptPdfView._pages.remove(key);
    final future = hit ?? _raster(key);
    ReceiptPdfView._pages[key] = future;
    ReceiptPdfView._trim(ReceiptPdfView._pages);
    future.catchError((Object _) {
      ReceiptPdfView._pages.remove(key);
      return <ImageProvider>[];
    });
    return future;
  }

  Future<List<ImageProvider>> _raster(String key) async {
    final bytes = await ReceiptPdfView.bytesFor(key, widget.build);
    final pages = <ImageProvider>[];
    await for (final page in Printing.raster(bytes, dpi: ReceiptPdfView.dpi)) {
      pages.add(MemoryImage(await page.toPng()));
    }
    if (pages.isEmpty) throw StateError('The receipt has no pages.');
    return pages;
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      color: widget.background ?? Theme.of(context).colorScheme.surfaceContainerHighest,
      child: FutureBuilder<List<ImageProvider>>(
        future: _pages,
        builder: (context, snap) {
          if (snap.hasError) {
            return widget.onError?.call(context, snap.error!) ??
                Center(child: Text('${snap.error}'));
          }
          final pages = snap.data;
          if (pages == null) {
            return const Center(child: CircularProgressIndicator());
          }
          return SingleChildScrollView(
            padding: const EdgeInsets.symmetric(vertical: 16, horizontal: 12),
            child: Column(
              children: [
                for (final page in pages)
                  Container(
                    constraints: const BoxConstraints(maxWidth: 380),
                    margin: const EdgeInsets.only(bottom: 12),
                    decoration: const BoxDecoration(
                      color: Colors.white,
                      boxShadow: [
                        BoxShadow(color: Color(0x33000000), blurRadius: 6, offset: Offset(0, 2)),
                      ],
                    ),
                    child: Image(
                      image: page,
                      fit: BoxFit.fitWidth,
                      filterQuality: FilterQuality.medium,
                      gaplessPlayback: true,
                    ),
                  ),
              ],
            ),
          );
        },
      ),
    );
  }
}
