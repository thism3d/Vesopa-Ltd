import Flutter
import Foundation
import ProximityReader

#if canImport(DojoTapToPayOniPhoneSDK)
import DojoTapToPayOniPhoneSDK
#endif

/// Dojo's Tap to Pay on iPhone SDK, reached from Dart over the
/// `com.vesopa.tap/dojo` channel (lib/payments/payment_service.dart).
///
/// The calls are Dojo's own, in Dojo's order
/// (https://docs.dojo.tech/tap-to-pay-on-iphone, SDK 0.0.11):
///
///   DojoTapToPayOniPhone(env: .staging | .production)
///   activateTerminal(secret) -> status
///   getTerminalActivationStatus(notifyWhenOperational: true, secret:)
///   isAccountLinked(secret) / linkAccount(secret)
///   startPayment(paymentIntentId:secret:) -> result.status
///
/// The secret comes from our server (POST /api/tap/secret), made with the
/// venue's Dojo key, which never reaches the phone. This file never sees card
/// data: Apple's sheet reads the card and Dojo's SDK talks to Dojo.
///
/// Add the package in Xcode (on a Mac): File > Add Packages >
/// https://github.com/dojo-engineering/dojo-tap-to-pay-on-iphone-sdk, 0.0.11,
/// product DojoTapToPayOniPhoneSDK, to the Runner target. Until then every
/// call answers `unsupported` and the app offers the card machine instead.
final class DojoTapToPayBridge {
  private let channel: FlutterMethodChannel

  #if canImport(DojoTapToPayOniPhoneSDK)
  private var sdk: DojoTapToPayOniPhone?
  private var sdkEnv = ""
  #endif

  init(messenger: FlutterBinaryMessenger) {
    channel = FlutterMethodChannel(name: "com.vesopa.tap/dojo", binaryMessenger: messenger)
    channel.setMethodCallHandler { [weak self] call, result in
      guard let self else { return }
      Task { @MainActor in await self.handle(call, result) }
    }
  }

  /// Tap to Pay on iPhone needs an iPhone XS or newer on iOS 16.7 or later.
  private var supported: Bool {
    guard #available(iOS 16.7, *) else { return false }
    #if canImport(DojoTapToPayOniPhoneSDK)
    return PaymentCardReader.isSupported
    #else
    return false
    #endif
  }

  @MainActor
  private func handle(_ call: FlutterMethodCall, _ result: @escaping FlutterResult) async {
    let args = call.arguments as? [String: Any] ?? [:]
    let secret = args["secret"] as? String ?? ""

    if call.method == "isSupported" {
      result(supported)
      return
    }
    guard supported else {
      result(FlutterError(code: "unsupported", message: "Tap to Pay needs an iPhone XS or newer on iOS 16.7 or later.", details: nil))
      return
    }

    #if canImport(DojoTapToPayOniPhoneSDK)
    do {
      switch call.method {
      case "activate":
        let env = args["env"] as? String ?? "staging"
        let dojo = sdkFor(env)
        let first = try await dojo.activateTerminal(secret)
        if !Self.isOperational(first) {
          // Not ready yet: wait until Dojo says the terminal is operational.
          _ = try await dojo.getTerminalActivationStatus(notifyWhenOperational: true, secret: secret)
        }
        result(nil)

      case "isAccountLinked":
        result(try await current().isAccountLinked(secret))

      case "linkAccount":
        // Apple shows its own Tap to Pay terms sheet to the venue's Apple ID the first time.
        try await current().linkAccount(secret)
        result(nil)

      case "startPayment":
        guard let intent = args["paymentIntentId"] as? String else {
          result(FlutterError(code: "bad_args", message: "No payment intent.", details: nil))
          return
        }
        let outcome = try await current().startPayment(paymentIntentId: intent, secret: secret)
        // The status is reported, never trusted: the server asks Dojo for the
        // intent before the bill is settled.
        result(["status": String(describing: outcome.status)])

      default:
        result(FlutterMethodNotImplemented)
      }
    } catch {
      let dojoError = AnyDojoSDKError(error: error)
      if let reader = error as? PaymentCardReaderError, case .unsupported = reader {
        result(FlutterError(code: "unsupported", message: reader.localizedDescription, details: nil))
        return
      }
      if let read = error as? PaymentCardReaderSession.ReadError, case .cancelled = read {
        result(FlutterError(code: "cancelled", message: "Cancelled", details: nil))
        return
      }
      result(FlutterError(code: "dojo", message: String(describing: dojoError), details: nil))
    }
    #else
    result(FlutterError(code: "unsupported", message: "This build has no Dojo Tap to Pay SDK. Add the package in Xcode.", details: nil))
    #endif
  }

  #if canImport(DojoTapToPayOniPhoneSDK)
  private func sdkFor(_ env: String) -> DojoTapToPayOniPhone {
    if let sdk, sdkEnv == env { return sdk }
    let made = DojoTapToPayOniPhone(env: env == "production" ? .production : .staging)
    sdk = made
    sdkEnv = env
    return made
  }

  private func current() throws -> DojoTapToPayOniPhone {
    guard let sdk else {
      throw NSError(domain: "VesopaTap", code: 1, userInfo: [NSLocalizedDescriptionKey: "Tap to Pay is not activated yet."])
    }
    return sdk
  }

  /// Dojo's status names, read loosely so an SDK update that renames a case
  /// does not stop payments: anything saying "operational" is ready.
  private static func isOperational(_ status: Any) -> Bool {
    String(describing: status).lowercased().contains("operational")
  }
  #endif
}
