# Used only where Swift Package Manager is off; Package.swift is the main way.
Pod::Spec.new do |s|
  s.name             = 'stripe_onboarding'
  s.version          = '1.0.0'
  s.summary          = "Stripe's native sign-up screens for Vesopa Go."
  s.homepage         = 'https://go.vesopa.com'
  s.license          = { :type => 'Proprietary' }
  s.author           = { 'Vesopa Software Ltd' => 'support@vesopa.com' }
  s.source           = { :path => '.' }
  s.source_files     = 'stripe_onboarding/Sources/stripe_onboarding/**/*.swift'
  s.dependency 'Flutter'
  s.dependency 'StripeIdentity', '~> 26.16', '>= 26.16.1'
  s.dependency 'StripeConnect', '~> 26.16'
  s.dependency 'StripePaymentSheet', '~> 26.16'
  s.platform         = :ios, '15.0'
  s.swift_version    = '5.9'
end
