/// Where Vesopa Express talks to, and what it calls itself.
library;

class ExpressConfig {
  static const appName = 'Vesopa Express';

  /// Keep in step with `version:` in pubspec.yaml. Sent with every request so
  /// the back office can say which kiosks are on which build.
  static const version = '1.0.1';
  static const build = 2;

  /// The back office. `--dart-define=EXPRESS_API=http://127.0.0.1:4000` points
  /// a development build at a local server.
  static const apiBase = String.fromEnvironment(
    'EXPRESS_API',
    defaultValue: 'https://backoffice.vesopaepos.com',
  );

  static String get resolvedBase =>
      apiBase.endsWith('/') ? apiBase.substring(0, apiBase.length - 1) : apiBase;

  static bool get isLive => resolvedBase == 'https://backoffice.vesopaepos.com';

  /// A kiosk token to start with, for integration tests only.
  ///
  /// Commissioning is a sign-in in a real browser, which a test cannot do
  /// without typing somebody's password. A test mints a kiosk token on the
  /// server for the test venue instead and hands it over here. Blank in every
  /// real build, where it does nothing.
  static const seedToken = String.fromEnvironment('EXPRESS_TOKEN');
}
