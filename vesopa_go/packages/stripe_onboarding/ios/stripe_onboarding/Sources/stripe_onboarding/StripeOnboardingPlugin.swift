// Stripe's own native screens for Vesopa Go's sign-up, on the channel
// com.vesopa.go/stripe_onboarding (lib/stripe_onboarding.dart):
//
//   verifyIdentity     Stripe Identity: photo ID and a live selfie
//   accountOnboarding  Stripe Connect: the business, its people, its bank
//   collectCard        the card sheet, for the licence's SetupIntent
//
// Each answers "completed", "canceled" or "failed:<why>". Go never sees a
// card number, an ID image or a secret key.

import Flutter
import StripeConnect  // re-exports StripeCore (STPAPIClient)
import StripeIdentity
import StripePaymentSheet
import UIKit

public class StripeOnboardingPlugin: NSObject, FlutterPlugin, AccountOnboardingControllerDelegate {
    private var channel: FlutterMethodChannel?
    private var onboardingResult: FlutterResult?
    private var onboarding: AccountOnboardingController?
    private var manager: EmbeddedComponentManager?
    private var paymentSheet: PaymentSheet?
    private var identitySheet: IdentityVerificationSheet?

    public static func register(with registrar: FlutterPluginRegistrar) {
        let channel = FlutterMethodChannel(name: "com.vesopa.go/stripe_onboarding", binaryMessenger: registrar.messenger())
        let instance = StripeOnboardingPlugin()
        instance.channel = channel
        registrar.addMethodCallDelegate(instance, channel: channel)
    }

    public func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
        let args = call.arguments as? [String: Any] ?? [:]
        guard let top = Self.topController() else {
            result("failed:Vesopa Go is not on screen.")
            return
        }
        if let key = args["publishableKey"] as? String, !key.isEmpty {
            STPAPIClient.shared.publishableKey = key
        }
        switch call.method {
        case "verifyIdentity":
            guard let session = args["sessionId"] as? String, let ephemeral = args["ephemeralKeySecret"] as? String else {
                result("failed:No verification session.")
                return
            }
            let logo = UIImage(named: "AppIcon") ?? UIImage(systemName: "checkmark.shield") ?? UIImage()
            let sheet = IdentityVerificationSheet(
                verificationSessionId: session,
                ephemeralKeySecret: ephemeral,
                configuration: IdentityVerificationSheet.Configuration(brandLogo: logo)
            )
            identitySheet = sheet
            sheet.present(from: top) { [weak self] outcome in
                self?.identitySheet = nil
                switch outcome {
                case .flowCompleted: result("completed")
                case .flowCanceled: result("canceled")
                case .flowFailed(let error): result("failed:\(error.localizedDescription)")
                @unknown default: result("failed:Unknown result.")
                }
            }

        case "accountOnboarding":
            let channel = self.channel
            let manager = EmbeddedComponentManager(fetchClientSecret: {
                await withCheckedContinuation { (cont: CheckedContinuation<String?, Never>) in
                    DispatchQueue.main.async {
                        channel?.invokeMethod("fetchClientSecret", arguments: nil) { answer in
                            cont.resume(returning: answer as? String)
                        }
                    }
                }
            })
            self.manager = manager
            let controller = manager.createAccountOnboardingController(
                fullTermsOfServiceUrl: (args["termsUrl"] as? String).flatMap(URL.init(string:)),
                privacyPolicyUrl: (args["privacyUrl"] as? String).flatMap(URL.init(string:))
            )
            controller.title = args["title"] as? String
            controller.delegate = self
            onboarding = controller
            onboardingResult = result
            controller.present(from: top)

        case "collectCard":
            guard let secret = args["clientSecret"] as? String else {
                result("failed:No card session.")
                return
            }
            var config = PaymentSheet.Configuration()
            config.merchantDisplayName = (args["merchantName"] as? String) ?? "Vesopa Software Ltd"
            config.allowsDelayedPaymentMethods = false
            let sheet = PaymentSheet(setupIntentClientSecret: secret, configuration: config)
            paymentSheet = sheet
            sheet.present(from: top) { [weak self] outcome in
                self?.paymentSheet = nil
                switch outcome {
                case .completed: result("completed")
                case .canceled: result("canceled")
                case .failed(let error): result("failed:\(error.localizedDescription)")
                @unknown default: result("failed:Unknown result.")
                }
            }

        default:
            result(FlutterMethodNotImplemented)
        }
    }

    // MARK: AccountOnboardingControllerDelegate

    public func accountOnboardingDidExit(_ accountOnboarding: AccountOnboardingController) {
        finishOnboarding("completed")
    }

    public func accountOnboarding(_ accountOnboarding: AccountOnboardingController, didFailLoadWithError error: Error) {
        finishOnboarding("failed:\(error.localizedDescription)")
    }

    private func finishOnboarding(_ answer: String) {
        onboardingResult?(answer)
        onboardingResult = nil
        onboarding = nil
        manager = nil
    }

    private static func topController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let window = scenes.flatMap { $0.windows }.first { $0.isKeyWindow } ?? scenes.first?.windows.first
        var top = window?.rootViewController
        while let next = top?.presentedViewController { top = next }
        return top
    }
}
