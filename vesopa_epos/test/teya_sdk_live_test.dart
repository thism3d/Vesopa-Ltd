@Tags(['live'])
library;

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:path_provider_platform_interface/path_provider_platform_interface.dart';
import 'package:plugin_platform_interface/plugin_platform_interface.dart';
import 'package:vesopa_epos/payments/teya_sdk.dart';

/// Runs Teya's real Windows SDK app: download, Teya's signature, unpack, start,
/// initialize. Only when TEYA_SDK_ZIP_URL, TEYA_TEST_CLIENT_ID and
/// TEYA_TEST_CLIENT_SECRET are set (sandbox credentials), on Windows.
class _Dirs extends PathProviderPlatform with MockPlatformInterfaceMixin {
  _Dirs(this.root);
  final String root;
  @override
  Future<String?> getApplicationSupportPath() async => root;
}

void main() {
  final url = Platform.environment['TEYA_SDK_ZIP_URL'] ?? '';
  final id = Platform.environment['TEYA_TEST_CLIENT_ID'] ?? '';
  final secret = Platform.environment['TEYA_TEST_CLIENT_SECRET'] ?? '';
  final skip = !Platform.isWindows || url.isEmpty || id.isEmpty || secret.isEmpty;

  test('installs, verifies and initializes Teya\'s SDK app', () async {
    final root = await Directory.systemTemp.createTemp('teya_sdk_test');
    PathProviderPlatform.instance = _Dirs(root.path);
    final info = TeyaSdkInfo(
      clientId: id,
      clientSecret: secret,
      production: false,
      version: '1.9.0',
      url: url,
      thumbprint: 'E6AB81F92407D2747FE621FD58A5DAF0F904330B',
    );
    final steps = <String>[];
    await TeyaSdk.instance.start(info, version: 'test', eposInstanceId: 'vesopa-test', onStatus: steps.add);
    expect(TeyaSdk.instance.running, isTrue);
    expect(steps, contains('Teya installed'));
    final r = await TeyaSdk.instance.call('getTerminals', {'forceRefresh': true});
    expect(r['failureReason'], 'SETUP_NOT_COMPLETED');
    await TeyaSdk.instance.stop();

    // A file that is not signed by Teya is refused.
    final bad = TeyaSdkInfo(clientId: id, clientSecret: secret, production: false, version: 'bad', url: url, thumbprint: '00');
    await expectLater(TeyaSdk.instance.install(bad), throwsA(isA<TeyaSdkException>()));
    try {
      await root.delete(recursive: true);
    } catch (_) {}
  }, skip: skip, timeout: const Timeout(Duration(minutes: 8)));
}
