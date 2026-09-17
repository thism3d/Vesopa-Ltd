import 'package:flutter/foundation.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

/// Add to Apple Wallet, on an iPhone.
///
/// The pass is the server's (LoyaltyApi.applePass); the sheet that adds it and
/// the button that opens it are Apple's (ios/Runner/WalletBridge.swift). Every
/// other platform answers "not available" and draws nothing: Android members
/// already have the app's own card, and a Google Wallet button is a separate
/// piece of work with its own rules.
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
  const AppleWalletButton({super.key, required this.onPressed});

  final VoidCallback onPressed;

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
      child: SizedBox(
        height: 48,
        width: 280,
        child: UiKitView(
          viewType: 'vesopa_loyalty/wallet_button',
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
