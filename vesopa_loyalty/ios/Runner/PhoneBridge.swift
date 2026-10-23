import Flutter
import FirebaseCore
import FirebaseAuth
import UIKit

/// Proving a mobile number with Firebase Authentication (2026-10-13).
///
/// The iPhone half of android/.../PhoneBridge.kt: Firebase texts the code, to
/// any country, and answers a Firebase ID token whose phone_number is the
/// proved number, which the server checks (vesopa_server/src/firebase_phone.js).
///
///   start(phone)               -> {"verification": id} once the text is sent
///   confirm(verification, code) -> idToken
///
/// Firebase is configured from the venue's Info.plist keys (VesopaFirebase*,
/// written by vesopa_loyalty/tool/make_venue_app.py from the venue's
/// GoogleService-Info.plist), so no plist file has to ride in the bundle. A
/// build without them answers "unavailable" and the app keeps the texted code
/// it has always had. Firebase checks the app with a silent push where it can
/// and with a web page otherwise; the page comes back on the
/// app-<GOOGLE_APP_ID> URL scheme the same tool adds.
final class PhoneBridge: NSObject, FlutterSceneLifeCycleDelegate {
  private let channel: FlutterMethodChannel

  init(messenger: FlutterBinaryMessenger) {
    channel = FlutterMethodChannel(name: "vesopa_loyalty/phone", binaryMessenger: messenger)
    super.init()
    channel.setMethodCallHandler { [weak self] call, result in
      guard let self else { return }
      let args = call.arguments as? [String: Any] ?? [:]
      switch call.method {
      case "start": self.start(phone: args["phone"] as? String ?? "", result: result)
      case "confirm":
        self.confirm(
          verification: args["verification"] as? String ?? "",
          code: args["code"] as? String ?? "",
          result: result)
      default: result(FlutterMethodNotImplemented)
      }
    }
  }

  /// The web page Firebase checks the app with, coming back on the
  /// app-<GOOGLE_APP_ID> URL scheme (registered with addSceneDelegate).
  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) -> Bool {
    guard FirebaseApp.app() != nil else { return false }
    return URLContexts.contains { Auth.auth().canHandle($0.url) }
  }

  /*
   * FIREBASE'S SILENT PUSH, HANDED OVER BY HAND.
   *
   * Firebase proves the app is genuine with a silent push to it, or with a
   * web check page when that does not come. It finds the push by swizzling the
   * app delegate, which misses when Firebase is configured after launch and
   * the delegate is Flutter's: the check then failed or hung, and no code was
   * texted (owner, 2026-10-23: "phone OTP not working"). So the token and the
   * push are passed to it here, as Firebase's own guide does with swizzling off.
   */

  /// The APNs token, for Firebase as well as for the venue's notifications.
  static func apnsToken(_ token: Data) {
    guard FirebaseApp.app() != nil else { return }
    Auth.auth().setAPNSToken(token, type: .unknown)
  }

  /// True when the push was Firebase's own check, which is then finished with.
  static func handles(notification: [AnyHashable: Any]) -> Bool {
    guard FirebaseApp.app() != nil else { return false }
    return Auth.auth().canHandleNotification(notification)
  }

  /// The check page coming back, for a launch without scenes.
  static func handles(url: URL) -> Bool {
    guard FirebaseApp.app() != nil else { return false }
    return Auth.auth().canHandle(url)
  }

  /// Firebase, configured once from the venue's keys. False when the build has
  /// none. Called at launch too (AppDelegate), so Firebase has the APNs token
  /// and sees its silent push before the first code is asked for.
  @discardableResult
  static func configured() -> Bool {
    if FirebaseApp.app() != nil { return true }
    let info = Bundle.main.infoDictionary ?? [:]
    guard
      let appId = info["VesopaFirebaseAppID"] as? String, !appId.isEmpty,
      let sender = info["VesopaFirebaseSenderID"] as? String, !sender.isEmpty,
      let apiKey = info["VesopaFirebaseAPIKey"] as? String, !apiKey.isEmpty,
      let project = info["VesopaFirebaseProjectID"] as? String, !project.isEmpty
    else { return false }
    let options = FirebaseOptions(googleAppID: appId, gcmSenderID: sender)
    options.apiKey = apiKey
    options.projectID = project
    options.bundleID = Bundle.main.bundleIdentifier ?? ""
    FirebaseApp.configure(options: options)
    return true
  }

  private func start(phone: String, result: @escaping FlutterResult) {
    guard PhoneBridge.configured() else {
      result(FlutterError(code: "unavailable", message: "Phone sign-in is not set up in this build.", details: nil))
      return
    }
    PhoneAuthProvider.provider().verifyPhoneNumber(phone, uiDelegate: nil) { id, error in
      if let error {
        result(FlutterError(code: "failed", message: PhoneBridge.friendly(error), details: nil))
      } else if let id {
        result(["verification": id])
      } else {
        result(FlutterError(code: "failed", message: "That number could not be checked. Please try again.", details: nil))
      }
    }
  }

  private func confirm(verification: String, code: String, result: @escaping FlutterResult) {
    guard PhoneBridge.configured(), !verification.isEmpty, !code.isEmpty else {
      result(FlutterError(code: "failed", message: "Enter the code from the text message.", details: nil))
      return
    }
    let credential = PhoneAuthProvider.provider().credential(withVerificationID: verification, verificationCode: code)
    Auth.auth().signIn(with: credential) { signedIn, error in
      if let error {
        result(FlutterError(code: "failed", message: PhoneBridge.friendly(error), details: nil))
        return
      }
      signedIn?.user.getIDTokenForcingRefresh(true) { token, error in
        // Firebase is only the proof; the venue's own session signs them in.
        try? Auth.auth().signOut()
        if let token {
          result(token)
        } else {
          result(FlutterError(code: "failed", message: error.map(PhoneBridge.friendly) ?? "That code is not right. Please try again.", details: nil))
        }
      }
    }
  }

  private static func friendly(_ error: Error) -> String {
    let code = AuthErrorCode(rawValue: (error as NSError).code)
    switch code {
    case .invalidVerificationCode, .sessionExpired: return "That code is not right. Please try again."
    case .invalidPhoneNumber, .missingPhoneNumber: return "That does not look like a mobile number. Check the country and the number."
    case .quotaExceeded, .tooManyRequests: return "Too many codes asked for. Please try again later."
    case .operationNotAllowed: return "Phone sign-in is not switched on for this app yet."
    case .webContextCancelled: return "The check was cancelled."
    default: return "That number could not be checked. Please try again."
    }
  }
}
