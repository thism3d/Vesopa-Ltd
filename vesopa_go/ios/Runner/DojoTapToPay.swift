import Flutter
import Foundation
import ProximityReader
import UserNotifications

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
    if call.method == "showEducation" {
      await showEducation(result)
      return
    }
    // Apple 5.12: a payment that was not approved while the app was closed
    // is told in a notification; permission is asked well before checkout.
    if call.method == "askNotify" {
      UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { ok, _ in
        DispatchQueue.main.async { result(ok) }
      }
      return
    }
    if call.method == "notify" {
      let args = call.arguments as? [String: Any] ?? [:]
      let content = UNMutableNotificationContent()
      content.title = args["title"] as? String ?? "Vesopa Go"
      content.body = args["body"] as? String ?? ""
      content.sound = .default
      let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
      UNUserNotificationCenter.current().add(request) { _ in DispatchQueue.main.async { result(nil) } }
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
      // 2026-11-04: activation in three steps, so Apple's terms can come in
      // between (Apple's reader cannot finish preparing until the merchant
      // has accepted them, and waiting for "operational" first waited for
      // ever). Never deactivated on a stall: that threw away the progress.
      case "status":
        let dojo = sdkFor(args["env"] as? String ?? "staging")
        result(String(describing: try await dojo.getTerminalActivationStatus(secret: secret)))

      case "activate":
        let dojo = sdkFor(args["env"] as? String ?? "staging")
        // The venue's Dojo location, when the back office knows it.
        if let location = args["location"] as? String, !location.isEmpty { dojo.setLocation(location) }
        result(String(describing: try await dojo.activateTerminal(secret)))

      // What Dojo's activation is built from, for the server's log
      // (2026-11-04: activation answered "unknown", "Order-id is missing").
      case "diagnose":
        let dojo = sdkFor(args["env"] as? String ?? "staging")
        let fp = dojo.getFingerprint()
        result([
          "fingerprint": fp.map { "present (\($0.count) chars)" } ?? "MISSING",
          "location": (args["location"] as? String) ?? "none",
          "readerSupported": PaymentCardReader.isSupported,
          "sdkEnv": String(describing: dojo.getEnvironment()),
          "ios": UIDevice.current.systemVersion,
          "model": UIDevice.current.model,
        ])

      case "waitOperational":
        let now = try await current().getTerminalActivationStatus(notifyWhenOperational: true, secret: secret)
        if now == .failed {
          result(FlutterError(code: "dojo", message: "Dojo could not activate this iPhone for Tap to Pay.", details: ["code": -1, "name": "failed"]))
          return
        }
        result(String(describing: now))

      case "reset":
        // Only on purpose (a failed status), never on a time-out.
        (sdk as? DojoTapToPayOniPhone)?.deactiveTerminal()
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
        let outcome = try await current().startPayment(paymentIntentId: intent, secret: secret, isRefund: args["isRefund"] as? Bool ?? false)
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
      // Apple 1.4: before iOS 17.6 the reader may need a newer iOS; say so plainly.
      if let reader = error as? PaymentCardReaderError, case .osVersionNotSupported = reader {
        result(FlutterError(code: "unsupported", message: "Update this iPhone to the latest version of iOS to use Tap to Pay on iPhone (Settings > General > Software Update).", details: nil))
        return
      }
      if let reader = error as? PaymentCardReaderError, case .unsupported = reader {
        result(FlutterError(code: "unsupported", message: reader.localizedDescription, details: nil))
        return
      }
      let ns = error as NSError
      // Dojo's domain is "dojo-tap-to-pay-sdk-error" (lower case), and most of
      // its errors carry no description, so iOS says only "The operation
      // couldn't be completed". The code goes to Dart as details, where the
      // step it failed at turns it into words.
      // Everything the error carries, for the server's log (2026-11-04: a
      // bare "networkError" said nothing about what Dojo refused).
      let info = Self.describe(ns)
      if ns.domain.lowercased().contains("dojo") {
        let known = DojoSDKErrorCode(rawValue: ns.code).map { String(describing: $0) }
        let said = ns.userInfo[NSLocalizedDescriptionKey] as? String
        result(FlutterError(code: known == "terminalNotOperational" ? "unsupported" : "dojo",
                            message: known == "terminalNotOperational"
                              ? "Dojo is still setting up Tap to Pay on this iPhone. Keep Vesopa Go open and try again in a minute."
                              : (said ?? known ?? "Dojo error \(ns.code)"),
                            details: ["domain": ns.domain, "code": ns.code, "name": known ?? "", "info": info]))
        return
      }
      result(FlutterError(code: "dojo", message: ns.localizedDescription,
                          details: ["domain": ns.domain, "code": ns.code, "name": "", "info": info]))
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

  #endif

  /// Apple's own "how to use Tap to Pay on iPhone" for merchants
  /// (ProximityReaderDiscovery, iOS 18), kept up to date and in the right
  /// language by Apple. Apple's guidelines ask for it in the app's settings
  /// and after the terms are accepted.
  @MainActor
  private func showEducation(_ result: @escaping FlutterResult) async {
    guard #available(iOS 18.0, *) else {
      result(FlutterError(code: "unsupported", message: "Apple's Tap to Pay guide needs iOS 18 or later.", details: nil))
      return
    }
    guard let root = UIApplication.shared.connectedScenes
      .compactMap({ ($0 as? UIWindowScene)?.keyWindow?.rootViewController }).first else {
      result(FlutterError(code: "no_window", message: "No screen to show the guide on.", details: nil))
      return
    }
    var top = root
    while let shown = top.presentedViewController { top = shown }
    do {
      let discovery = ProximityReaderDiscovery()
      let content = try await discovery.content(for: ProximityReaderDiscovery.Topic.payment(.howToTap))
      try await discovery.presentContent(content, from: top)
      result(nil)
    } catch {
      result(FlutterError(code: "guide", message: error.localizedDescription, details: nil))
    }
  }

  /// An error and the ones under it, with their user info, in one line.
  static func describe(_ e: NSError, depth: Int = 0) -> String {
    var parts = ["\(e.domain)#\(e.code)"]
    for (k, v) in e.userInfo where k != NSUnderlyingErrorKey {
      parts.append("\(k)=\(String(describing: v).prefix(300))")
    }
    if depth < 3, let under = e.userInfo[NSUnderlyingErrorKey] as? NSError {
      parts.append("under: " + describe(under, depth: depth + 1))
    }
    return parts.joined(separator: "; ")
  }

  #if canImport(DojoTapToPayOniPhoneSDK)
  @available(iOS 16.7, *)
  private func current() throws -> DojoTapToPayOniPhone {
    guard let made = sdk as? DojoTapToPayOniPhone else {
      throw NSError(domain: "VesopaGo", code: 1, userInfo: [NSLocalizedDescriptionKey: "Tap to Pay is not activated yet."])
    }
    return made
  }
  #endif
}
