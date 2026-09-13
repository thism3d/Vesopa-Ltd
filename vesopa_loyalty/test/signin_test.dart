import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_loyalty/data/signin.dart';

void main() {
  test('a venue that has set nothing still has a way in', () {
    final c = SignInConfig.fromJson(null);
    expect(c.offered, contains('code_email'));
    expect(c.leads, 'code_email');
  });

  test('an empty list of methods is not a locked door', () {
    // The server should never send this, but an app that drew a sign-in page
    // with no buttons on it would be unusable and unreportable.
    final c = SignInConfig.fromJson({'methods': <String>[], 'policy': 'code_first'});
    expect(c.usable, contains('code_email'));
  });

  test('the policy only decides what leads, never what is possible', () {
    final c = SignInConfig.fromJson({
      'methods': ['code_email', 'password'],
      'policy': 'password_first',
    });
    expect(c.leads, 'password');
    expect(c.alternatives, contains('code_email'));
  });

  test('a policy naming a method the venue does not offer falls back', () {
    final c = SignInConfig.fromJson({
      'methods': ['code_email'],
      'policy': 'vesopa_first',
    });
    expect(c.leads, 'code_email');
  });

  test('a method this device cannot do is never offered', () {
    // Passkeys are a browser API. On Windows, Android and iOS the button must
    // not be drawn at all -- one that does nothing when tapped reads as a
    // broken app rather than an unsupported device.
    final c = SignInConfig.fromJson({
      'methods': ['code_email', 'passkey'],
      'policy': 'code_first',
    });
    expect(c.offered, contains('passkey'));
    expect(c.has('passkey'), SignInConfig.deviceCan('passkey'));
    if (!SignInConfig.deviceCan('passkey')) {
      expect(c.usable, isNot(contains('passkey')));
      expect(c.alternatives, isNot(contains('passkey')));
    }
  });

  test('what leads is never also listed underneath', () {
    final c = SignInConfig.fromJson({
      'methods': ['code_email', 'password', 'code_sms'],
      'policy': 'password_first',
    });
    expect(c.alternatives, isNot(contains(c.leads)));
  });

  test('self service is on unless the venue says otherwise', () {
    expect(SignInConfig.fromJson({'methods': ['code_email']}).selfService, isTrue);
    expect(
      SignInConfig.fromJson({'methods': ['code_email'], 'self_service': false}).selfService,
      isFalse,
    );
  });
}
