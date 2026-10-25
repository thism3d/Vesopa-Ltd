/// Where Vesopa Tap talks to, fixed at build time with --dart-define so a
/// test build can never reach a live venue by accident.
library;

/// The back office every Vesopa terminal talks to.
const apiBase = String.fromEnvironment('VESOPA_API_BASE', defaultValue: 'https://backoffice.vesopaepos.com');

/// Vesopa sign-in (passwordless OAuth/OIDC).
const authIssuer = String.fromEnvironment('VESOPA_AUTH_ISSUER', defaultValue: 'https://auth.vesopa.com');

/// The public client. Until auth.vesopa.com has a `vesopa-tap` client of its
/// own (docs/PLAN.md, phase 1), the till's `vesopa-epos` one: a Tap phone IS
/// a till as far as the back office is concerned.
const authClientId = String.fromEnvironment('VESOPA_TAP_CLIENT_ID', defaultValue: 'vesopa-epos');

/// Dojo's environment for the Tap to Pay SDK: `staging` (sandbox) or `production`.
/// The server says which one a venue is on; this is only the build's ceiling.
const dojoEnvironment = String.fromEnvironment('DOJO_ENV', defaultValue: 'staging');

/// The app's name everywhere a person reads it.
const appName = 'Vesopa Tap';

/// UK contactless limit without a PIN. Above it the card asks for one
/// (Tap to Pay on iPhone shows its own PIN pad).
const contactlessLimitMinor = 10000;
