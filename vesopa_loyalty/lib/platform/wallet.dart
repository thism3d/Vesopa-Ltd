import 'package:flutter/foundation.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/services.dart';
import 'package:flutter/material.dart';

/// Add to Apple Wallet, on an iPhone.
///
/// The pass is the server's (LoyaltyApi.applePass); the sheet that adds it and
/// the button that opens it are Apple's (ios/Runner/WalletBridge.swift).
/// Android has Google Wallet instead (GoogleWalletButton, below); the web and
/// Windows draw neither.
const _wallet = MethodChannel('vesopa_loyalty/wallet');

bool get _iPhone => !kIsWeb && defaultTargetPlatform == TargetPlatform.iOS;

/// What happened when the member was shown the Add sheet.
enum WalletOutcome { added, cancelled, already }

class AppleWallet {
  AppleWallet._();

  /// Whether this device can take a pass at all (not every iPad has Wallet,
  /// and a device management profile can switch it off).
  static Future<bool> available() async {
    if (!_iPhone) return false;
    try {
      return await _wallet.invokeMethod<bool>('available') ?? false;
    } catch (_) {
      return false;
    }
  }

  /// Show Apple's Add sheet for a signed pass. Throws a [PlatformException]
  /// whose message can be shown as it is.
  static Future<WalletOutcome> add(Uint8List pass) async {
    final answer = await _wallet.invokeMethod<String>('add', pass);
    return switch (answer) {
      'added' => WalletOutcome.added,
      'already' => WalletOutcome.already,
      _ => WalletOutcome.cancelled,
    };
  }

  static final _taps = <int, VoidCallback>{};
  static var _listening = false;

  static void _listen() {
    if (_listening) return;
    _listening = true;
    _wallet.setMethodCallHandler((call) async {
      if (call.method == 'tapped') _taps[call.arguments as int]?.call();
    });
  }
}

/// Apple's own "Add to Apple Wallet" button (PKAddPassButton), which Apple
/// requires rather than a lookalike.
class AppleWalletButton extends StatefulWidget {
  const AppleWalletButton({super.key, required this.onPressed, this.radius = 16});

  final VoidCallback onPressed;

  /// Corner radius, to sit under a card with the same corners.
  final double radius;

  @override
  State<AppleWalletButton> createState() => _AppleWalletButtonState();
}

class _AppleWalletButtonState extends State<AppleWalletButton> {
  int? _id;

  @override
  void dispose() {
    if (_id != null) AppleWallet._taps.remove(_id);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!_iPhone) return const SizedBox.shrink();
    return Semantics(
      button: true,
      label: 'Add to Apple Wallet',
      // As wide as its parent allows (the card's width, from the card page).
      child: SizedBox(
        height: 54,
        width: double.infinity,
        child: UiKitView(
          viewType: 'vesopa_loyalty/wallet_button',
          creationParams: {'radius': widget.radius},
          creationParamsCodec: const StandardMessageCodec(),
          // The native button takes its own taps, including inside the card
          // page's scrolling list.
          gestureRecognizers: {Factory<TapGestureRecognizer>(TapGestureRecognizer.new)},
          onPlatformViewCreated: (id) {
            _id = id;
            AppleWallet._listen();
            AppleWallet._taps[id] = () => widget.onPressed();
          },
        ),
      ),
    );
  }
}


/// Add to Google Wallet, on Android.
///
/// The card is the server's: LoyaltyApi.googleWalletLink is a page that signs
/// the member's card at Google and forwards to Google Wallet's own save page,
/// which Android hands to the Google Wallet app. Once saved, the card updates
/// itself from the server, like the Apple one.
class GoogleWallet {
  GoogleWallet._();

  static bool get available => !kIsWeb && defaultTargetPlatform == TargetPlatform.android;
}

/// Google's own "Add to Google Wallet" button, as its brand guidelines ask:
/// the artwork from Google's kit (assets/google_wallet, drawn from the
/// enGB SVG at 1x, 2x and 3x), unchanged, at least 48 high, never restyled.
class GoogleWalletButton extends StatelessWidget {
  const GoogleWalletButton({super.key, required this.onPressed});

  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    if (!GoogleWallet.available) return const SizedBox.shrink();
    return Semantics(
      button: true,
      label: 'Add to Google Wallet',
      child: Material(
        color: Colors.transparent,
        shape: const StadiumBorder(),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onPressed,
          child: Image.asset(
            'assets/google_wallet/add_to_google_wallet.png',
            // The artwork's own proportions (283 x 50), so the button holds
            // its place before the picture has decoded.
            height: 48,
            width: 48 * 283 / 50,
            fit: BoxFit.contain,
            excludeFromSemantics: true,
          ),
        ),
      ),
    );
  }
}
