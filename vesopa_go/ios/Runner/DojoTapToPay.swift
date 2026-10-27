import Flutter
import Foundation
import ProximityReader

#if canImport(DojoTapToPayOniPhoneSDK)
import DojoTapToPayOniPhoneSDK
#endif

/// Dojo's Tap to Pay on iPhone SDK, reached from Dart over the
/// `com.vesopa.go/dojo` channel (lib/payments/payment_service.dart).
///
/// The calls are Dojo's own, in Dojo's order, as SDK 0.0.11's interface has
/// them (DojoTapToPayOniPhoneSDK.swiftinterface; iOS 16.7 and later):
///
///   DojoTapToPayOniPhone(env: .staging | .prod)
///   activateTerminal(secret) -> DojoTerminalStatus
///   getTerminalActivationStatus(notifyWhenOperational: true, secret:)
///   isAccountLinked(secret) / linkAccount(secret)
///   startPayment(paymentIntentId:secret:) -> result.status
///     (.success, .decline, .alreadyPaid, .canceled)
///
/// The secret comes from our server (POST /api/tap/secret), made with the
/// venue's Dojo key, which never reaches the phone. This file never sees card
/// data: Apple's sheet reads the card and Dojo's SDK talks to Dojo.
///
/// The package (https://github.com/dojo-engineering/dojo-tap-to-pay-on-iphone-sdk,
/// exactly 0.0.11, product DojoTapToPayOniPhoneSDK) is in the Runner target
/// (project.pbxproj). A build without it answers `unsupported` to every call
/// and the app offers the card machine instead.
final class DojoTapToPayBridge {
  private let channel: FlutterMethodChannel
  /// The SDK object, kept as Any: its class exists only on iOS 16.7+.
  private var sdk: Any?
  private var sdkEnv = ""

  init(messenger: FlutterBinaryMessenger) {
    channel = FlutterMethodChannel(name: "com.vesopa.go/dojo", binaryMessenger: messenger)
    channel.setMethodCallHandler { [weak self] call, result in
      guard let self else { return }
      Task { @MainActor in await self.handle(call, result) }
    }
  }

  /// Tap to Pay on iPhone needs an iPhone XS or newer on iOS 16.7 or later.
  private var supported: Bool {
    #if canImport(DojoTapToPayOniPhoneSDK)
    if #available(iOS 16.7, *) { return PaymentCardReader.isSupported }
    #endif
    return false
  }

  @MainActor
  private func handle(_ call: FlutterMethodCall, _ result: @escaping FlutterResult) async {
    if call.method == "isSupported" {
      result(supported)
      return
    }
    guard supported else {
      result(FlutterError(code: "unsupported", message: "Tap to Pay needs an iPhone XS or newer on iOS 16.7 or later.", details: nil))
      return
    }
    #if canImport(DojoTapToPayOniPhoneSDK)
    if #available(iOS 16.7, *) {
      await run(call, result)
      return
    }
    #endif
    result(FlutterError(code: "unsupported", message: "This build has no Dojo Tap to Pay SDK.", details: nil))
  }

  #if canImport(DojoTapToPayOniPhoneSDK)
  @available(iOS 16.7, *)
  @MainActor
  private func run(_ call: FlutterMethodCall, _ result: @escaping FlutterResult) async {
    let args = call.arguments as? [String: Any] ?? [:]
    let secret = args["secret"] as? String ?? ""
    do {
      switch call.method {
      case "activate":
        let dojo = sdkFor(args["env"] as? String ?? "staging")
        let first = try await dojo.activateTerminal(secret)
        if first != .operational {
          // Not ready yet: wait until Dojo says the terminal is operational.
          let now = try await dojo.getTerminalActivationStatus(notifyWhenOperational: true, secret: secret)
          if now == .failed {
            result(FlutterError(code: "dojo", message: "Dojo could not activate this iPhone for Tap to Pay.", details: nil))
            return
          }
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
        result([
          "status": String(describing: outcome.status),
          "cancelled": outcome.status == .canceled,
          "transactionId": outcome.data?.transactionId as Any,
        ])

      default:
        result(FlutterMethodNotImplemented)
      }
    } catch {
      if let reader = error as? PaymentCardReaderError, case .unsupported = reader {
        result(FlutterError(code: "unsupported", message: reader.localizedDescription, details: nil))
        return
      }
      let ns = error as NSError
      if let code = DojoSDKErrorCode(rawValue: ns.code), ns.domain.contains("Dojo") {
        result(FlutterError(code: code == .terminalNotOperational ? "unsupported" : "dojo",
                            message: "Dojo: \(code) (\(ns.localizedDescription))", details: nil))
        return
      }
      result(FlutterError(code: "dojo", message: ns.localizedDescription, details: nil))
    }
  }

  @available(iOS 16.7, *)
  private func sdkFor(_ env: String) -> DojoTapToPayOniPhone {
    if let made = sdk as? DojoTapToPayOniPhone, sdkEnv == env { return made }
    let made = DojoTapToPayOniPhone(env: env == "production" ? .prod : .staging)
    sdk = made
    sdkEnv = env
    return made
  }

  @available(iOS 16.7, *)
  private func current() throws -> DojoTapToPayOniPhone {
    guard let made = sdk as? DojoTapToPayOniPhone else {
      throw NSError(domain: "VesopaGo", code: 1, userInfo: [NSLocalizedDescriptionKey: "Tap to Pay is not activated yet."])
    }
    return made
  }
  #endif
}
