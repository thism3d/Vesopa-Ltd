// swift-tools-version: 5.9
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
        .package(url: "https://github.com/stripe/stripe-ios-spm", from: "26.16.0"),
    ],
    targets: [
        .target(
            name: "stripe_onboarding",
            dependencies: [
                .product(name: "StripeIdentity", package: "stripe-ios-spm"),
                .product(name: "StripeConnect", package: "stripe-ios-spm"),
                .product(name: "StripePaymentSheet", package: "stripe-ios-spm"),
            ]
        ),
    ]
)
