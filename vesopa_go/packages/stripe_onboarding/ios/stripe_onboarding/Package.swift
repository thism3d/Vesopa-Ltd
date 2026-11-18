// swift-tools-version: 6.1
// Stripe's Identity, Connect and card sheet for Vesopa Go's sign-up
// (../../lib/stripe_onboarding.dart).
import PackageDescription

let package = Package(
    name: "stripe_onboarding",
    platforms: [.iOS("15.0")],
    products: [
        .library(name: "stripe-onboarding", targets: ["stripe_onboarding"]),
    ],
    dependencies: [
        // The Identity trait links MediaPipe for Stripe Identity's 3D face
        // capture (stripe-ios 26.16.1: "enable the Identity trait"). Package
        // traits need swift-tools 6.1.
        .package(url: "https://github.com/stripe/stripe-ios-spm", from: "26.16.1", traits: [.defaults, "Identity"]),
    ],
    targets: [
        .target(
            name: "stripe_onboarding",
            dependencies: [
                .product(name: "StripeIdentity", package: "stripe-ios-spm"),
                .product(name: "StripeConnect", package: "stripe-ios-spm"),
                .product(name: "StripePaymentSheet", package: "stripe-ios-spm"),
            ],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
