import Flutter
import UIKit
import UserNotifications

/// The iPhone half of notifications.
///
/// WHAT THIS DOES AND DOES NOT NEED
///
/// APNs needs no configuration file and no third party: the app asks iOS for a
/// device token and iOS gives it one, provided the Push Notifications
/// capability is on the App ID. What the SERVER needs is the .p8 key, the key
/// id, the team id and the bundle id — see APNS_* in the server's .env and
/// src/loyalty_push.js. So this compiles and runs today; what it cannot do
/// until those exist is have anything sent to it.
///
/// Android is the opposite way round: its half is blocked on a Firebase
/// project, because there is no way to wake an Android app without one.
///
/// HOW IT ANSWERS DART
///
/// `vesopa_loyalty/push` → `token` resolves to `{kind: "apns", token: "<hex>"}`,
/// or to nil where the customer declined or the device could not register.
/// data/platform/push_io.dart treats nil as "no notifications" and falls back
/// to the in-app inbox, which is why declining is not an error here.
@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  private var channel: FlutterMethodChannel?

  /// The Dart call waiting for iOS to hand back a token.
  ///
  /// Registration is asynchronous and answers through a delegate method rather
  /// than a completion handler, so the reply has to be parked here. Only ever
  /// one: a second `token` call while the first is outstanding joins it rather
  /// than starting another registration.
  private var pending: [FlutterResult] = []

  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)

    // The messenger from the registrar rather than from the root view
    // controller: the controller is not reliably in place this early, and a
    // force-cast to it is the usual way this file starts crashing on launch.
    guard
      let registrar = engineBridge.pluginRegistry.registrar(forPlugin: "VesopaLoyaltyPush")
    else { return }

    let channel = FlutterMethodChannel(
      name: "vesopa_loyalty/push",
      binaryMessenger: registrar.messenger()
    )
    self.channel = channel
    channel.setMethodCallHandler { [weak self] call, result in
      guard call.method == "token" else {
        result(FlutterMethodNotImplemented)
        return
      }
      self?.deviceToken(result)
    }
  }

  /// Ask the customer, then ask iOS.
  private func deviceToken(_ result: @escaping FlutterResult) {
    UNUserNotificationCenter.current()
      .requestAuthorization(options: [.alert, .badge, .sound]) { granted, _ in
        guard granted else {
          // Declined. Not an error: the app keeps its inbox.
          DispatchQueue.main.async { result(nil) }
          return
        }
        DispatchQueue.main.async {
          self.pending.append(result)
          UIApplication.shared.registerForRemoteNotifications()
        }
      }
  }

  /// iOS hands the token over as bytes; APNs wants it as lower-case hex, which
  /// is also the shape the server checks before putting it in a URL path.
  override func application(
    _ application: UIApplication,
    didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
  ) {
    super.application(application, didRegisterForRemoteNotificationsWithDeviceToken: deviceToken)
    let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
    settle(["kind": "apns", "token": hex])
  }

  override func application(
    _ application: UIApplication,
    didFailToRegisterForRemoteNotificationsWithError error: Error
  ) {
    super.application(application, didFailToRegisterForRemoteNotificationsWithError: error)
    // No token. The app carries on; only notifications are lost, and the inbox
    // still shows everything next time it is opened.
    NSLog("[vesopa] APNs registration failed: \(error.localizedDescription)")
    settle(nil)
  }

  private func settle(_ value: Any?) {
    let waiting = pending
    pending = []
    for reply in waiting { reply(value) }
  }
}
