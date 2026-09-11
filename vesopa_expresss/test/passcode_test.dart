import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_express/data/passcode.dart';

/// The exit passcode is hashed by the SERVER (Node's crypto.pbkdf2Sync) and
/// checked by the KIOSK (this Dart). If the two ever disagree by one byte, no
/// passcode opens any kiosk -- so the vectors below were computed by Node, not
/// by this code:
///
///   node -e "require('crypto').pbkdf2Sync('13579','abcdef0123456789abcdef0123456789',1000,32,'sha256').toString('hex')"
void main() {
  test('PBKDF2 agrees with Node byte for byte', () {
    expect(
      pbkdf2Hex('13579', 'abcdef0123456789abcdef0123456789', 1000),
      '1142381b579070a40f5a5793fec734cbcea4bf18f89299b1a3bdc83a1f381e87',
    );
  });

  test("and at the server's real iteration count", () {
    expect(
      pbkdf2Hex('2468', '0f1e2d3c4b5a69788796a5b4c3d2e1f0', 120000),
      'a3f2d4e73e0702b04ba1beb3cc049df8db9ee1bec1dd124cce0c861781bda742',
    );
  });

  test('the right passcode opens the kiosk and a near miss does not', () {
    const check = ExitCheck(
      salt: 'abcdef0123456789abcdef0123456789',
      hash: '1142381b579070a40f5a5793fec734cbcea4bf18f89299b1a3bdc83a1f381e87',
      iterations: 1000,
    );
    expect(passcodeMatches('13579', check), isTrue);
    expect(passcodeMatches('13578', check), isFalse);
    expect(passcodeMatches('', check), isFalse);
  });

  test('a config with no passcode, or a mangled one, reads as none', () {
    expect(ExitCheck.fromJson(null), isNull);
    expect(ExitCheck.fromJson({'salt': 'x'}), isNull);
    expect(ExitCheck.fromJson({'salt': 'x', 'hash': 'y', 'iterations': '1000'}), isNull);
    expect(
      ExitCheck.fromJson({'salt': 'x', 'hash': 'y', 'iterations': 1000})?.iterations,
      1000,
    );
  });
}
