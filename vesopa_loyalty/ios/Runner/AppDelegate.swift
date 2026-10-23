import Flutter
import UIKit
import UserNotifications

/// The iPhone half of notifications.
///
/// WHAT THIS DOES AND DOES NOT NEED
///
/// APNs needs no configuration file and no third party: the app asks iOS for a
/// device token and iOS gives it one, provided the Push Notifications
/// capability is on the App ID (Runner.entitlements carries aps-environment).
/// What the SERVER needs is the .p8 key, the key id, the team id and the bundle
/// id com.vesopaepos.thevesopakitchen -- APNS_* in the server's .env and
/// src/loyalty_push.js.
///
/// A notification that arrives while the app is open is shown as a banner
/// (iOS hides it otherwise), and tapping one opens the news: `open` is sent to
/// Dart with `/inbox/<id>`, or kept for Dart's `opened` call when the tap is
/// what launched the app.
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

  /// A tapped notification's address, waiting for Dart to start and ask.
  private var opened: String?
  private var dartListening = false

  /// Held for the life of the app; each owns its channel.
  private var wallet: WalletBridge?
  private var watch: WatchBridge?
  private var auth: AuthBridge?
  private var phone: PhoneBridge?
  private var dojo: DojoBridge?

  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    // Before launch finishes, or the tap that launched the app is not delivered.
    UNUserNotificationCenter.current().delegate = self
    // Firebase phone sign-in: set up now and given an APNs token, which needs
    // no permission (it is only for silent pushes). PhoneBridge.swift says why.
    if PhoneBridge.configured() { application.registerForRemoteNotifications() }
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  /// Firebase's silent push proving the app for a phone sign-in code; any
  /// other goes on as before.
  override func application(
    _ application: UIApplication,
    didReceiveRemoteNotification userInfo: [AnyHashable: Any],
    fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
  ) {
    if PhoneBridge.handles(notification: userInfo) {
      completionHandler(.noData)
      return
    }
    super.application(application, didReceiveRemoteNotification: userInfo, fetchCompletionHandler: completionHandler)
  }

  /// Firebase's check page coming back when there is no scene to take it.
  override func application(
    _ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    if PhoneBridge.handles(url: url) { return true }
    return super.application(app, open: url, options: options)
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
      switch call.method {
      case "token":
        self?.deviceToken(result)
      case "permission":
        self?.askPermission(result)
      case "opened":
        self?.dartListening = true
        result(self?.opened)
        self?.opened = nil
      default:
        result(FlutterMethodNotImplemented)
      }
    }

    if let registrar = engineBridge.pluginRegistry.registrar(forPlugin: "VesopaLoyaltyWallet") {
      let wallet = WalletBridge(messenger: registrar.messenger())
      registrar.register(WalletButtonFactory(channel: wallet.channel), withId: "vesopa_loyalty/wallet_button")
      self.wallet = wallet
    }
    if let registrar = engineBridge.pluginRegistry.registrar(forPlugin: "VesopaLoyaltyWatch") {
      watch = WatchBridge(messenger: registrar.messenger())
    }
    // Sign in with Apple, passkeys and Google's sheet (AuthBridge.swift).
    if let registrar = engineBridge.pluginRegistry.registrar(forPlugin: "VesopaLoyaltyAuth") {
      auth = AuthBridge(messenger: registrar.messenger())
    }
    // Mobile numbers proved by Firebase, any country (PhoneBridge.swift).
    if let registrar = engineBridge.pluginRegistry.registrar(forPlugin: "VesopaLoyaltyPhone") {
      let bridge = PhoneBridge(messenger: registrar.messenger())
      registrar.addSceneDelegate(bridge)
      phone = bridge
    }
    // Paying for a membership in Dojo's own checkout, not a browser (DojoBridge.swift).
    if let registrar = engineBridge.pluginRegistry.registrar(forPlugin: "VesopaLoyaltyDojo") {
      dojo = DojoBridge(messenger: registrar.messenger())
    }
  }

  /// In the foreground too: the member sees the message, and the news badge
  /// catches up when Dart next refreshes.
  override func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([.banner, .list, .sound])
  }

  /// Tapped: straight to the news.
  override func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let info = response.notification.request.content.userInfo
    // A points or membership notification says where it belongs (`open`:
    // "card", src/loyalty_push.js notifyMember); news has an id and opens
    // that message.
    if (info["open"] as? String) == "card" {
      open("/card")
    } else {
      let id = (info["id"] as? CustomStringConvertible)?.description ?? ""
      open(id.isEmpty ? "/inbox" : "/inbox/\(id)")
    }
    completionHandler()
  }

  /// Send Dart to `/card` or `/inbox[/<id>]`: now if it is listening,
  /// otherwise when it starts and asks (`opened`).
  func open(_ address: String) {
    if dartListening, let channel = channel {
      channel.invokeMethod("open", arguments: address)
    } else {
      opened = address
    }
  }

  /// Siri's way in (SiriShortcuts.swift): the same road as a tapped
  /// notification.
  static func openFromSiri(_ address: String) {
    (UIApplication.shared.delegate as? AppDelegate)?.open(address)
  }

  /// Only the question, for the welcome before sign-in (lib/ui/onboarding.dart).
  /// Answers whether they said yes. A yes registers with APNs straight away so
  /// the token is ready for the first `token` call after signing in; nobody
  /// is waiting on that registration, so its answer simply goes nowhere.
  private func askPermission(_ result: @escaping FlutterResult) {
    UNUserNotificationCenter.current()
      .requestAuthorization(options: [.alert, .badge, .sound]) { granted, _ in
        DispatchQueue.main.async {
          if granted { UIApplication.shared.registerForRemoteNotifications() }
          result(granted)
        }
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
    PhoneBridge.apnsToken(deviceToken)
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
