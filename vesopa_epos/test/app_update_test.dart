import 'package:flutter/services.dart';
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

  test('a Store copy updates through the Store', () {
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

  test('a Store copy set back is moved to our installer', () {
    final u = AppUpdate.fromJson({
      'version': '1.14.2',
      'url': 'https://admin.vesopa.com/dl/1/abc/setup.exe',
      'sha256': 'b' * 64,
      'downgrade': true,
      'switch': true,
    })!;
    expect(u.switchToDirect, isTrue);
    expect(u.downgrade, isTrue);
    expect(u.viaStore, isFalse);
  });

  test('a Store copy says it can ask the Store itself', () {
    const store = Installation(version: '1.15.1', kind: 'store', deviceId: 'd', deviceName: '');
    const ours = Installation(version: '1.15.1', kind: 'direct', deviceId: 'd', deviceName: '');
    expect(store.headers['X-Vesopa-Store-Check'], '1');
    expect(ours.headers.containsKey('X-Vesopa-Store-Check'), isFalse);
  });

  group('asking the Store', () {
    TestWidgetsFlutterBinding.ensureInitialized();
    const channel = MethodChannel('vesopa/store_update');
    final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    tearDown(() => messenger.setMockMethodCallHandler(channel, null));

    test('the version the Store has', () async {
      messenger.setMockMethodCallHandler(channel, (call) async =>
          call.method == 'check' ? {'available': true, 'version': '1.15.1.0'} : 'completed');
      expect(await StoreUpdate.available(), '1.15.1.0');
      expect(await StoreUpdate.install(), 'completed');
    });

    test('nothing yet, or not a Store copy', () async {
      messenger.setMockMethodCallHandler(channel, (call) async => {'available': false, 'version': ''});
      expect(await StoreUpdate.available(), isNull);
      messenger.setMockMethodCallHandler(channel, (call) async => null);
      expect(await StoreUpdate.available(), isNull);
    });

    test('a Windows side that is missing is not an error', () async {
      expect(await StoreUpdate.available(), isNull);
      expect(await StoreUpdate.install(), 'failed');
    });
  });
}
