import Flutter
import UIKit
import dojo_ios_sdk_drop_in_ui

/// Paying for a membership with Dojo's own iOS checkout (2026-10-23).
///
/// The server makes the Dojo payment intent exactly as it does for the web
/// (vesopa_server/src/memberships.js startCheckout) and hands the app its id;
/// this shows Dojo's drop-in checkout over the app (DojoSDKDropInUI, from
/// github.com/dojo-engineering/dojo-ios-sdk-drop-in-ui), so the member never
/// leaves for a browser (owner, 2026-10-23: "Do not open dojo in web").
/// Card numbers go from Dojo's own screens to Dojo; the app never sees them.
///
/// `vesopa_loyalty/dojo`:
///   pay({intent, dark}) -> Dojo's result code: 0 paid, 7780 closed by the
///                          member, anything else not paid (Dojo's table).
///
/// Whatever the code says, the membership changes only when the server reads
/// the intent from Dojo (POST .../checkout/<id>/check), as for the web.
///
/// Cards only: Apple Pay is not offered (owner, 2026-10-25: removed for now,
/// perhaps in a later release, which would need a Merchant ID, Dojo's payment
/// processing certificate and the in-app payments entitlement).
final class DojoBridge: NSObject {
  private let channel: FlutterMethodChannel
  private let dojo = DojoSDKDropInUI()
  private var paying = false

  init(messenger: FlutterBinaryMessenger) {
    channel = FlutterMethodChannel(name: "vesopa_loyalty/dojo", binaryMessenger: messenger)
    super.init()
    channel.setMethodCallHandler { [weak self] call, result in
      guard let self else { return }
      switch call.method {
      case "pay":
        let args = call.arguments as? [String: Any] ?? [:]
        self.pay(intent: args["intent"] as? String ?? "", dark: args["dark"] as? Bool ?? false, result: result)
      default:
        result(FlutterMethodNotImplemented)
      }
    }
  }

  private func pay(intent: String, dark: Bool, result: @escaping FlutterResult) {
    guard !intent.isEmpty else {
      result(FlutterError(code: "no_intent", message: "The payment could not be started. Please try again.", details: nil))
      return
    }
    guard !paying else {
      result(FlutterError(code: "busy", message: "A payment is already open.", details: nil))
      return
    }
    guard let top = WalletBridge.topController() else {
      result(FlutterError(code: "unavailable", message: "The payment could not be shown.", details: nil))
      return
    }
    paying = true
    dojo.startPaymentFlow(
      paymentIntentId: intent,
      controller: top,
      applePayConfig: nil,
      themeSettings: dark ? DojoThemeSettings.getDarkTheme() : DojoThemeSettings.getLightTheme()
    ) { [weak self] code in
      DispatchQueue.main.async {
        self?.paying = false
        result(code)
      }
    }
  }
}
