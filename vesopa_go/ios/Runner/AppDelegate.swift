import Flutter
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  private var nsd: GoNsd?

  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
    // The venue's TVs found on the Wi-Fi by Bonjour (GoNsd below).
    if let registrar = engineBridge.pluginRegistry.registrar(forPlugin: "GoNsd") {
      nsd = GoNsd(messenger: registrar.messenger())
    }
  }
}

/// The venue's screens finding each other on the Wi-Fi by themselves (owner,
/// 2026-11-27: "use local connection to find out the TV"): Bonjour, as Google
/// TV's remote does. A TV running Kitchen or Customer display announces
/// "_vesopago._tcp" (Android NsdManager, GoNsd.kt); this browses for it and
/// hands each one's IPv4 address, port and device id to Dart
/// (lib/remote/nsd.dart). Declared in Info.plist NSBonjourServices; iOS asks
/// the Local Network question the first time. No multicast entitlement needed.
final class GoNsd: NSObject, NetServiceBrowserDelegate, NetServiceDelegate {
  private let channel: FlutterMethodChannel
  private var browser: NetServiceBrowser?
  private var services: [NetService] = []

  init(messenger: FlutterBinaryMessenger) {
    channel = FlutterMethodChannel(name: "com.vesopa.go/nsd", binaryMessenger: messenger)
    super.init()
    channel.setMethodCallHandler { [weak self] call, result in
      guard let self = self else { return }
      switch call.method {
      case "discover":
        self.stop()
        let b = NetServiceBrowser()
        b.delegate = self
        self.browser = b
        b.searchForServices(ofType: "_vesopago._tcp.", inDomain: "local.")
        result(true)
      case "stop":
        self.stop()
        result(true)
      case "register", "unregister":
        // A phone or tablet does not announce itself: only TVs (Android) do.
        result(false)
      default:
        result(FlutterMethodNotImplemented)
      }
    }
  }

  private func stop() {
    browser?.stop()
    browser = nil
    services.forEach { $0.stop() }
    services.removeAll()
  }

  func netServiceBrowser(_ browser: NetServiceBrowser, didFind service: NetService, moreComing: Bool) {
    services.append(service)
    service.delegate = self
    service.resolve(withTimeout: 5)
  }

  func netServiceBrowser(_ browser: NetServiceBrowser, didRemove service: NetService, moreComing: Bool) {
    channel.invokeMethod("lost", arguments: ["service": service.name])
    services.removeAll { $0 == service }
  }

  func netServiceBrowser(_ browser: NetServiceBrowser, didNotSearch errorDict: [String: NSNumber]) {
    channel.invokeMethod("log", arguments: ["line": "search failed \(errorDict)"])
  }

  func netService(_ sender: NetService, didNotResolve errorDict: [String: NSNumber]) {
    channel.invokeMethod("log", arguments: ["line": "could not resolve \(sender.name) \(errorDict)"])
  }

  func netServiceDidResolveAddress(_ sender: NetService) {
    var txt: [String: String] = [:]
    if let data = sender.txtRecordData() {
      for (k, v) in NetService.dictionary(fromTXTRecord: data) {
        txt[k] = String(data: v, encoding: .utf8) ?? ""
      }
    }
    for data in sender.addresses ?? [] {
      let host: String? = data.withUnsafeBytes { raw -> String? in
        guard let base = raw.baseAddress, raw.count >= MemoryLayout<sockaddr_in>.size else { return nil }
        let sa = base.assumingMemoryBound(to: sockaddr.self)
        guard sa.pointee.sa_family == sa_family_t(AF_INET) else { return nil }
        var addr = base.assumingMemoryBound(to: sockaddr_in.self).pointee.sin_addr
        var buf = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
        guard inet_ntop(AF_INET, &addr, &buf, socklen_t(INET_ADDRSTRLEN)) != nil else { return nil }
        return String(cString: buf)
      }
      if let host = host {
        channel.invokeMethod("found", arguments: [
          "id": txt["id"] ?? "", "name": txt["name"] ?? "", "mode": txt["mode"] ?? "",
          "host": host, "port": sender.port, "service": sender.name,
        ])
        return
      }
    }
  }
}
