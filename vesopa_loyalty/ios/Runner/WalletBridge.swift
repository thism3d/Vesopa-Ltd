import Flutter
import PassKit
import UIKit

/// Add to Apple Wallet.
///
/// The pass is built and signed by the server, exactly as the one a printed QR
/// code hands out (vesopa_server/src/wallet_apple_service.js); Dart downloads
/// it (LoyaltyApi.applePass) and this side does the one thing only iOS can:
/// show Apple's own "Add" sheet. A pass added here updates itself from the
/// server afterwards, and Wallet copies it to a paired Apple Watch.
///
/// `vesopa_loyalty/wallet`:
///   available      -> Bool
///   add(bytes)     -> "added" | "cancelled" | "already" (Wallet is opened at the card)
///   tapped(viewId) <- from the button below, to Dart
final class WalletBridge: NSObject, PKAddPassesViewControllerDelegate {
  let channel: FlutterMethodChannel
  private var pending: (result: FlutterResult, pass: PKPass)?

  init(messenger: FlutterBinaryMessenger) {
    channel = FlutterMethodChannel(name: "vesopa_loyalty/wallet", binaryMessenger: messenger)
    super.init()
    channel.setMethodCallHandler { [weak self] call, result in
      self?.handle(call, result)
    }
  }

  private func handle(_ call: FlutterMethodCall, _ result: @escaping FlutterResult) {
    switch call.method {
    case "available":
      result(PKPassLibrary.isPassLibraryAvailable() && PKAddPassesViewController.canAddPasses())
    case "add":
      guard let bytes = call.arguments as? FlutterStandardTypedData else {
        result(FlutterError(code: "no_pass", message: "Your card could not be downloaded.", details: nil))
        return
      }
      add(bytes.data, result)
    default:
      result(FlutterMethodNotImplemented)
    }
  }

  private func add(_ data: Data, _ result: @escaping FlutterResult) {
    guard pending == nil else {
      result(FlutterError(code: "busy", message: "Apple Wallet is already open.", details: nil))
      return
    }
    let pass: PKPass
    do {
      pass = try PKPass(data: data)
    } catch {
      result(FlutterError(code: "invalid", message: "Apple Wallet could not read this card.", details: error.localizedDescription))
      return
    }
    // Already there: show it rather than an Add sheet that can only say so.
    if PKPassLibrary().containsPass(pass) {
      if let url = pass.passURL { UIApplication.shared.open(url) }
      result("already")
      return
    }
    guard let sheet = PKAddPassesViewController(pass: pass), let top = Self.topController() else {
      result(FlutterError(code: "unavailable", message: "Apple Wallet is not available on this device.", details: nil))
      return
    }
    sheet.delegate = self
    pending = (result, pass)
    top.present(sheet, animated: true)
  }

  func addPassesViewControllerDidFinish(_ controller: PKAddPassesViewController) {
    controller.dismiss(animated: true) {
      guard let waiting = self.pending else { return }
      self.pending = nil
      waiting.result(PKPassLibrary().containsPass(waiting.pass) ? "added" : "cancelled")
    }
  }

  static func topController() -> UIViewController? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let windows = scenes.flatMap { $0.windows }
    var top = (windows.first { $0.isKeyWindow } ?? windows.first)?.rootViewController
    while let presented = top?.presentedViewController { top = presented }
    return top
  }
}

/// Apple's own Add to Apple Wallet button, drawn by PassKit.
///
/// Apple's rules for the button are strict (its artwork, its wording in every
/// language, its proportions), and PKAddPassButton meets all of them, so it is
/// put into the Flutter page as a native view rather than imitated.
final class WalletButtonFactory: NSObject, FlutterPlatformViewFactory {
  private let channel: FlutterMethodChannel

  init(channel: FlutterMethodChannel) {
    self.channel = channel
    super.init()
  }

  func create(withFrame frame: CGRect, viewIdentifier viewId: Int64, arguments args: Any?) -> FlutterPlatformView {
    WalletButtonView(frame: frame, viewId: viewId, channel: channel)
  }

  func createArgsCodec() -> FlutterMessageCodec & NSObjectProtocol {
    FlutterStandardMessageCodec.sharedInstance()
  }
}

final class WalletButtonView: NSObject, FlutterPlatformView {
  private let button = PKAddPassButton(addPassButtonStyle: .black)
  private let viewId: Int64
  private let channel: FlutterMethodChannel

  init(frame: CGRect, viewId: Int64, channel: FlutterMethodChannel) {
    self.viewId = viewId
    self.channel = channel
    super.init()
    button.frame = frame
    button.addTarget(self, action: #selector(tapped), for: .touchUpInside)
  }

  func view() -> UIView { button }

  @objc private func tapped() {
    channel.invokeMethod("tapped", arguments: viewId)
  }
}
