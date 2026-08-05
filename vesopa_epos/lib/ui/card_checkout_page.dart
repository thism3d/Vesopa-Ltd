import 'dart:async';
// Only used by the disabled webview branches below (`_start()`).
// import 'dart:io' show Platform;

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
// TEMPORARILY DISABLED — see the note by `_start()` below. Restoring the
// in-app webview means uncommenting these two imports, the matching packages
// in pubspec.yaml, and the commented-out blocks further down this file.
// import 'package:webview_flutter/webview_flutter.dart';
// import 'package:webview_windows/webview_windows.dart' as win;

import 'theme.dart';

/// The hosted card page, rendered **inside the till**.
///
/// Handing a payment to the system browser works, but it is the wrong shape for
/// an EPOS: the clerk loses the sale off screen, a kiosked Windows till may
/// have no browser to hand it to, and on Android the customer ends up holding
/// the operator's whole device. So the checkout runs in an embedded webview and
/// the till stays in charge of the screen.
///
/// This page never decides whether money was taken. The provider polling the
/// acquirer does that — a customer can close this window after paying, and a
/// page that reported its own success would book a sale that never settled.
/// Closing here only stops *showing* the page.
class CardCheckoutPage extends StatefulWidget {
  const CardCheckoutPage({
    super.key,
    required this.url,
    required this.amountLabel,
    this.title = 'Card payment',
  });

  final String url;
  final String amountLabel;
  final String title;

  /// Names every route this flow puts on the stack, so the payment screen can
  /// tear the flow down with `popUntil` when the acquirer answers. Popping a
  /// fixed number of times instead would take the sale screen with it whenever
  /// the customer had already closed the checkout themselves.
  static const routeName = 'card-flow';

  /// Opens the checkout full-screen. Completes when the clerk or the customer
  /// closes it; the payment result comes from the provider, not from here.
  static Future<void> show(
    BuildContext context, {
    required String url,
    required String amountLabel,
    String title = 'Card payment',
  }) => Navigator.of(context, rootNavigator: true).push(
    MaterialPageRoute<void>(
      fullscreenDialog: true,
      settings: const RouteSettings(name: routeName),
      builder: (_) =>
          CardCheckoutPage(url: url, amountLabel: amountLabel, title: title),
    ),
  );

  /// Whether this platform can host the page in-app at all.
  ///
  /// TEMPORARILY `false` everywhere — the embedded webview is disabled, see
  /// `_start()`. iOS/Android and Windows normally could; restore the line
  /// below once the webview packages are back in pubspec.yaml.
  static bool get supported => false;
  // Platform.isAndroid || Platform.isIOS || Platform.isWindows;

  @override
  State<CardCheckoutPage> createState() => _CardCheckoutPageState();
}

class _CardCheckoutPageState extends State<CardCheckoutPage> {
  // TEMPORARILY DISABLED, along with everything else in this file that
  // touches webview_flutter/webview_windows — see `_start()`.
  // /// Android/iOS.
  // WebViewController? _mobile;
  //
  // /// Windows (WebView2).
  // win.WebviewController? _desktop;

  // Only read by the disabled webview body in build() below.
  // bool _loading = true;

  /// Set when the embedded view cannot start — no WebView2 runtime on the
  /// Windows box, say. The page then offers the browser rather than showing a
  /// blank rectangle, because a till that cannot present a card must say so.
  String? _unavailable;

  @override
  void initState() {
    super.initState();
    unawaited(_start());
  }

  // TEMPORARILY DISABLED: webview_windows 0.4.0's CMake step (NuGet fetch +
  // WebView2 SDK download) is blocking Windows builds, so the embedded
  // webview is off on every platform for now rather than only on Windows —
  // this file drives both from the one code path. Nothing is deleted: the
  // real implementation is commented out below `_start()`'s body, ready to
  // restore once webview_windows is sorted (see pubspec.yaml). Meanwhile the
  // page falls straight to the same "open in a browser" screen it already
  // used for genuine webview failures, so card checkout keeps working.
  Future<void> _start() async {
    setState(
      () => _unavailable =
          'In-app card checkout is switched off for now — opening in your '
          'browser instead.',
    );
  }

  // Future<void> _start() async {
  //   try {
  //     if (Platform.isWindows) {
  //       final controller = win.WebviewController();
  //       await controller.initialize();
  //       await controller.loadUrl(widget.url);
  //       if (!mounted) {
  //         await controller.dispose();
  //         return;
  //       }
  //       setState(() {
  //         _desktop = controller;
  //         _loading = false;
  //       });
  //     } else if (Platform.isAndroid || Platform.isIOS) {
  //       final controller = WebViewController()
  //         ..setJavaScriptMode(JavaScriptMode.unrestricted)
  //         ..setNavigationDelegate(
  //           NavigationDelegate(
  //             onPageFinished: (_) {
  //               if (mounted) setState(() => _loading = false);
  //             },
  //             onWebResourceError: (e) {
  //               // A sub-resource failing is normal on a payment page; only a
  //               // failure of the page itself is worth surfacing.
  //               if (e.isForMainFrame == true && mounted) {
  //                 setState(() => _unavailable = e.description);
  //               }
  //             },
  //           ),
  //         )
  //         ..loadRequest(Uri.parse(widget.url));
  //       if (!mounted) return;
  //       setState(() => _mobile = controller);
  //     } else {
  //       setState(() => _unavailable = 'No in-app browser on this platform.');
  //     }
  //   } catch (e) {
  //     if (mounted) setState(() => _unavailable = '$e');
  //   }
  // }

  @override
  void dispose() {
    // unawaited(_desktop?.dispose());
    super.dispose();
  }

  Future<void> _openExternally() async {
    await launchUrl(Uri.parse(widget.url), mode: LaunchMode.externalApplication);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        backgroundColor: Pos.chrome,
        foregroundColor: Colors.white,
        title: Text('${widget.title} · ${widget.amountLabel}'),
        leading: IconButton(
          icon: const Icon(Icons.close),
          tooltip: 'Close the card page',
          onPressed: () => Navigator.of(context).pop(),
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.open_in_new),
            tooltip: 'Open in a browser instead',
            onPressed: _openExternally,
          ),
        ],
      ),
      // Always the fallback while the embedded webview is disabled — see
      // `_start()`. The commented-out Stack below is the real webview body,
      // restorable alongside it.
      body: _Fallback(reason: _unavailable ?? '', onOpen: _openExternally),
      // body: _unavailable != null
      //     ? _Fallback(reason: _unavailable!, onOpen: _openExternally)
      //     : Stack(
      //         children: [
      //           if (_desktop != null)
      //             win.Webview(_desktop!)
      //           else if (_mobile != null)
      //             WebViewWidget(controller: _mobile!),
      //           if (_loading)
      //             const Center(child: CircularProgressIndicator()),
      //         ],
      //       ),
      // The till keeps waiting on the acquirer behind this page, so the clerk
      // needs to be told that closing it is not the same as cancelling.
      bottomNavigationBar: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
          child: Text(
            'The till is watching this payment. Close this page once the '
            'customer is finished — the sale settles on its own.',
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.bodySmall,
          ),
        ),
      ),
    );
  }
}

class _Fallback extends StatelessWidget {
  const _Fallback({required this.reason, required this.onOpen});

  final String reason;
  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(28),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.public_off, size: 44),
          const SizedBox(height: 14),
          Text(
            'The card page could not open inside the till.',
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.titleMedium,
          ),
          const SizedBox(height: 8),
          Text(
            reason,
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.bodySmall,
          ),
          const SizedBox(height: 20),
          FilledButton.icon(
            onPressed: onOpen,
            icon: const Icon(Icons.open_in_new),
            label: const Text('Open in a browser'),
          ),
        ],
      ),
    ),
  );
}
