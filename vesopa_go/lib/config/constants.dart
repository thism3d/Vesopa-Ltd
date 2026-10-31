/// Where Vesopa Go talks to, fixed at build time with --dart-define so a
/// test build can never reach a live venue by accident.
library;

/// The back office, at Go's own address (go.vesopaepos.com: the same back office
/// as the tills, its /ws proxied for live updates).
const apiBase = String.fromEnvironment('VESOPA_API_BASE', defaultValue: 'https://go.vesopaepos.com');

/// Vesopa sign-in (passwordless OAuth/OIDC).
const authIssuer = String.fromEnvironment('VESOPA_AUTH_ISSUER', defaultValue: 'https://auth.vesopa.com');

/// The Vesopa Auth client is not built in: the back office says which to use
/// (TapApi.signInClient, /api/go/vesopa/enabled), so Go signs in as its own app
/// once Vesopa Auth has it, and as the till's until then.

/// Dojo's environment for the Tap to Pay SDK: `staging` (sandbox) or `production`.
/// The server says which one a venue is on; this is only the build's ceiling.
const dojoEnvironment = String.fromEnvironment('DOJO_ENV', defaultValue: 'staging');

/// The app's name everywhere a person reads it.
const appName = 'Vesopa Go';

/// UK contactless limit without a PIN. Above it the card asks for one
/// (Tap to Pay on iPhone shows its own PIN pad).
const contactlessLimitMinor = 10000;

/// The app's version, as pubspec.yaml has it (kept in step with every bump),
/// for the back office's device list.
const goAppVersion = '1.2.21';
