import CoreImage
import Flutter
import UIKit
import WatchConnectivity

/// The iPhone half of the Apple Watch app (ios/VesopaWatch).
///
/// Dart sends the card as a plain map whenever the member's figures or news
/// change (lib/data/watch_card.dart); this passes it on as the application
/// context, which watchOS keeps and delivers even when the watch app is not
/// running. Only the latest context is ever kept, so sending often costs
/// nothing.
///
/// `vesopa_loyalty/watch`:
///   update(map)
final class WatchBridge: NSObject, WCSessionDelegate {
  private let channel: FlutterMethodChannel
  private var latest: [String: Any] = [:]

  init(messenger: FlutterBinaryMessenger) {
    channel = FlutterMethodChannel(name: "vesopa_loyalty/watch", binaryMessenger: messenger)
    super.init()
    channel.setMethodCallHandler { [weak self] call, result in
      guard call.method == "update", let card = call.arguments as? [String: Any] else {
        result(FlutterMethodNotImplemented)
        return
      }
      self?.update(card)
      result(nil)
    }
    if WCSession.isSupported() {
      WCSession.default.delegate = self
      WCSession.default.activate()
    }
  }

  private func update(_ card: [String: Any]) {
    var context = (Self.plist(card) as? [String: Any]) ?? [:]
    // watchOS has no Core Image, so the code is drawn here and sent as a PNG.
    if let qr = card["qr"] as? String, !qr.isEmpty, let png = Self.qrPng(qr) {
      context["qrPng"] = png
    }
    latest = context
    send()
  }

  private func send() {
    guard WCSession.isSupported(), !latest.isEmpty else { return }
    let session = WCSession.default
    guard session.activationState == .activated, session.isPaired, session.isWatchAppInstalled else { return }
    do {
      try session.updateApplicationContext(latest)
    } catch {
      NSLog("[vesopa] watch update failed: \(error.localizedDescription)")
    }
  }

  func session(_ session: WCSession, activationDidCompleteWith state: WCSessionActivationState, error: Error?) {
    DispatchQueue.main.async { self.send() }
  }

  func sessionDidBecomeInactive(_ session: WCSession) {}

  /// Switching to another watch: activate again for the new one.
  func sessionDidDeactivate(_ session: WCSession) {
    session.activate()
  }

  /// The watch app was just installed, or a different watch paired.
  func sessionWatchStateDidChange(_ session: WCSession) {
    DispatchQueue.main.async { self.send() }
  }

  /// The watch app opened and asked for the latest card.
  func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
    DispatchQueue.main.async { self.send() }
  }

  /// Only property-list values cross to the watch: Flutter's nulls go.
  private static func plist(_ value: Any) -> Any? {
    switch value {
    case is NSNull:
      return nil
    case let map as [String: Any]:
      return map.compactMapValues { plist($0) }
    case let list as [Any]:
      return list.compactMap { plist($0) }
    case is String, is NSNumber, is Data, is Date:
      return value
    case let bytes as FlutterStandardTypedData:
      return bytes.data
    default:
      return nil
    }
  }

  private static func qrPng(_ text: String) -> Data? {
    guard let filter = CIFilter(name: "CIQRCodeGenerator") else { return nil }
    filter.setValue(Data(text.utf8), forKey: "inputMessage")
    filter.setValue("M", forKey: "inputCorrectionLevel")
    guard let image = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)) else { return nil }
    guard let cg = CIContext().createCGImage(image, from: image.extent) else { return nil }
    return UIImage(cgImage: cg).pngData()
  }
}
