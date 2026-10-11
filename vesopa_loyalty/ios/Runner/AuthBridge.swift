import AuthenticationServices
import Flutter
import UIKit

/// Signing in with what the iPhone and iPad already have: Sign in with Apple,
/// passkeys, and Google's own sign-in sheet. No web page of ours opens.
///
/// `vesopa_loyalty/auth`:
///   available                        -> {apple: Bool, passkeys: Bool}
///   apple                            -> {identity_token, user, email?, given_name?, family_name?}
///   passkeyGet(json options)         -> WebAuthn assertion as JSON (the web build's shape)
///   passkeyCreate(json options)      -> WebAuthn attestation as JSON
///   webAuth({url, scheme})           -> the address the sign-in came back to
///
/// A cancel answers FlutterError code "cancelled"; Dart treats it as nothing
/// happening. Every other failure carries a message that can be shown.
///
/// PASSKEYS BELONG TO A DOMAIN, NOT TO THE APP. iOS hands this app a passkey
/// for loyalty.vesopa.com only because Runner.entitlements names
/// `webcredentials:loyalty.vesopa.com` AND that site's
/// /.well-known/apple-app-site-association names this app (the back office
/// serves it: vesopa_server/src/loyalty_host.js). The same passkey therefore
/// works in the app and on the web page.
final class AuthBridge: NSObject, ASAuthorizationControllerDelegate,
  ASAuthorizationControllerPresentationContextProviding, ASWebAuthenticationPresentationContextProviding
{
  let channel: FlutterMethodChannel
  private var pending: FlutterResult?
  private var kind = ""
  private var webSession: ASWebAuthenticationSession?

  init(messenger: FlutterBinaryMessenger) {
    channel = FlutterMethodChannel(name: "vesopa_loyalty/auth", binaryMessenger: messenger)
    super.init()
    channel.setMethodCallHandler { [weak self] call, result in
      self?.handle(call, result)
    }
  }

  private func handle(_ call: FlutterMethodCall, _ result: @escaping FlutterResult) {
    switch call.method {
    case "available":
      result(["apple": true, "passkeys": true])
    case "apple":
      let request = ASAuthorizationAppleIDProvider().createRequest()
      request.requestedScopes = [.fullName, .email]
      run(request, kind: "apple", result)
    case "passkeyGet":
      guard let o = options(call), let rp = o["rpId"] as? String,
        let challenge = data(o["challenge"])
      else { return bad(result) }
      let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rp)
      let request = provider.createCredentialAssertionRequest(challenge: challenge)
      let allowed = (o["allowCredentials"] as? [[String: Any]] ?? []).compactMap { data($0["id"]) }
      if !allowed.isEmpty {
        request.allowedCredentials = allowed.map { ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: $0) }
      }
      if let uv = o["userVerification"] as? String {
        request.userVerificationPreference = ASAuthorizationPublicKeyCredentialUserVerificationPreference(rawValue: uv)
      }
      run(request, kind: "get", result)
    case "passkeyCreate":
      guard let o = options(call), let rp = (o["rp"] as? [String: Any])?["id"] as? String,
        let challenge = data(o["challenge"]), let user = o["user"] as? [String: Any],
        let userId = data(user["id"])
      else { return bad(result) }
      let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rp)
      let request = provider.createCredentialRegistrationRequest(
        challenge: challenge, name: (user["name"] as? String) ?? "", userID: userId)
      if let display = user["displayName"] as? String { request.displayName = display }
      run(request, kind: "create", result)
    case "webAuth":
      guard let args = call.arguments as? [String: Any], let address = args["url"] as? String,
        let url = URL(string: address), let scheme = args["scheme"] as? String
      else { return bad(result) }
      webAuth(url, scheme: scheme, result)
    default:
      result(FlutterMethodNotImplemented)
    }
  }

  // ---- The Apple and passkey sheets ------------------------------------------

  private func run(_ request: ASAuthorizationRequest, kind: String, _ result: @escaping FlutterResult) {
    if let earlier = pending { earlier(FlutterError(code: "cancelled", message: nil, details: nil)) }
    pending = result
    self.kind = kind
    let controller = ASAuthorizationController(authorizationRequests: [request])
    controller.delegate = self
    controller.presentationContextProvider = self
    controller.performRequests()
  }

  func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization auth: ASAuthorization) {
    guard let result = pending else { return }
    pending = nil
    switch auth.credential {
    case let apple as ASAuthorizationAppleIDCredential:
      var answer: [String: Any] = ["user": apple.user]
      if let token = apple.identityToken { answer["identity_token"] = String(decoding: token, as: UTF8.self) }
      if let email = apple.email { answer["email"] = email }
      if let given = apple.fullName?.givenName { answer["given_name"] = given }
      if let family = apple.fullName?.familyName { answer["family_name"] = family }
      result(answer)
    case let key as ASAuthorizationPlatformPublicKeyCredentialAssertion:
      var response: [String: Any] = [
        "clientDataJSON": b64url(key.rawClientDataJSON),
        "authenticatorData": b64url(key.rawAuthenticatorData),
        "signature": b64url(key.signature),
      ]
      response["userHandle"] = key.userID.isEmpty ? NSNull() : b64url(key.userID)
      result(json([
        "id": b64url(key.credentialID), "rawId": b64url(key.credentialID), "type": "public-key",
        "clientExtensionResults": [String: Any](), "response": response,
      ]))
    case let key as ASAuthorizationPlatformPublicKeyCredentialRegistration:
      guard let attestation = key.rawAttestationObject else {
        return result(FlutterError(code: "failed", message: "The passkey could not be made.", details: nil))
      }
      result(json([
        "id": b64url(key.credentialID), "rawId": b64url(key.credentialID), "type": "public-key",
        "transports": ["internal", "hybrid"], "clientExtensionResults": [String: Any](),
        "response": ["clientDataJSON": b64url(key.rawClientDataJSON), "attestationObject": b64url(attestation)],
      ]))
    default:
      result(FlutterError(code: "failed", message: "That sign-in could not be completed.", details: nil))
    }
  }

  func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
    guard let result = pending else { return }
    pending = nil
    let code = (error as? ASAuthorizationError)?.code
    if code == .canceled {
      result(FlutterError(code: "cancelled", message: nil, details: nil))
    } else if kind == "get", code == .failed || code == .unknown {
      // No passkey for this site on this device is reported as a failure.
      result(FlutterError(code: "none", message: "There is no passkey for your card on this device yet.", details: nil))
    } else {
      result(FlutterError(code: "failed", message: error.localizedDescription, details: nil))
    }
  }

  // ---- Google's sheet ------------------------------------------------------------

  /// Google's sign-in page in the system's own sign-in sheet, exactly as
  /// Google's own SDK shows it. It returns to `scheme:` and nothing else.
  private func webAuth(_ url: URL, scheme: String, _ result: @escaping FlutterResult) {
    let session = ASWebAuthenticationSession(url: url, callbackURLScheme: scheme) { [weak self] back, error in
      self?.webSession = nil
      if let back = back { return result(back.absoluteString) }
      if (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin {
        return result(FlutterError(code: "cancelled", message: nil, details: nil))
      }
      result(FlutterError(code: "failed", message: error?.localizedDescription ?? "That sign-in could not be completed.", details: nil))
    }
    session.presentationContextProvider = self
    session.prefersEphemeralWebBrowserSession = false
    webSession = session
    if !session.start() {
      webSession = nil
      result(FlutterError(code: "failed", message: "That sign-in could not be started.", details: nil))
    }
  }

  // ---- Where the sheets appear ------------------------------------------------------

  private func window() -> ASPresentationAnchor {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    return scenes.flatMap { $0.windows }.first { $0.isKeyWindow } ?? scenes.first?.windows.first ?? ASPresentationAnchor()
  }

  func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor { window() }
  func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor { window() }

  // ---- Helpers ------------------------------------------------------------------

  private func options(_ call: FlutterMethodCall) -> [String: Any]? {
    guard let text = call.arguments as? String, let raw = text.data(using: .utf8) else { return nil }
    return (try? JSONSerialization.jsonObject(with: raw)) as? [String: Any]
  }

  private func bad(_ result: FlutterResult) {
    result(FlutterError(code: "failed", message: "That sign-in could not be started.", details: nil))
  }

  private func data(_ value: Any?) -> Data? {
    guard var s = value as? String else { return nil }
    s = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while s.count % 4 != 0 { s += "=" }
    return Data(base64Encoded: s)
  }

  private func b64url(_ d: Data) -> String {
    d.base64EncodedString().replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }

  private func json(_ value: [String: Any]) -> String {
    guard let raw = try? JSONSerialization.data(withJSONObject: value) else { return "" }
    return String(decoding: raw, as: UTF8.self)
  }
}
