import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/app_update.dart';

/// What the back office says about a version, as the till reads it.
void main() {
  test('our installer: an address and a hash', () {
    final u = AppUpdate.fromJson({
      'version': '1.15.0',
      'url': 'https://admin.vesopa.com/dl/1/abc/setup.exe',
      'sha256': 'a' * 64,
      'size': 10,
      'downgrade': false,
    })!;
    expect(u.viaStore, isFalse);
    expect(u.version, '1.15.0');
  });

  test('a Store copy is sent to its Store page', () {
    final u = AppUpdate.fromJson({
      'version': '1.15.0',
      'store': true,
      'store_id': '9PDMNJXNFZCW',
      'downgrade': false,
    })!;
    expect(u.viaStore, isTrue);
    expect(u.storeId, '9PDMNJXNFZCW');
  });

  test('anything else is ignored rather than trusted', () {
    expect(AppUpdate.fromJson({'version': '1.15.0', 'store': true, 'store_id': 'ms-settings:'}), isNull);
    expect(AppUpdate.fromJson({'version': '1.15.0', 'url': 'http://x', 'sha256': 'a' * 64}), isNull);
    expect(AppUpdate.fromJson(null), isNull);
  });
}
