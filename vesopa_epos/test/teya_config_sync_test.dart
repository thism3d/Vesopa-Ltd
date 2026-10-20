import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/payments/teya_provider.dart';

/// Teya set up in the back office is what the till uses (the owner,
/// 2026-10-20): no sign-in on the till, and the same machine on both screens.
void main() {
  final sdk = {
    'client_id': 'x',
    'client_secret': 'y',
    'production': false,
    'windows': {'version': '1.9.0', 'url': 'https://example.com/a.zip', 'thumbprint': 'ab'},
  };

  test('a store connected in the back office never needs the SDK sign-in', () {
    final c = TeyaConfig.fromJson({
      'enabled': true,
      'assigned_terminal_id': 'T2',
      'default_terminal_id': 'T2',
      'terminals': [
        {'id': 'T1', 'name': 'Bar'},
        {'id': 'T2', 'name': 'Kitchen'},
      ],
      'sdk': sdk,
    });
    expect(c.connected, isTrue);
    expect(c.useSdk, isFalse);
    expect(c.machineId, 'T2');
    expect(c.machineName, 'Kitchen');
  });

  test('without its own machine a till uses the venue default', () {
    final c = TeyaConfig.fromJson({
      'enabled': true,
      'default_terminal_id': 'T1',
      'terminals': [
        {'id': 'T1', 'name': 'Bar'},
      ],
    });
    expect(c.machineId, 'T1');
    expect(c.machineName, 'Bar');
  });

  test('Teya off is off', () {
    final c = TeyaConfig.fromJson({'enabled': false});
    expect(c.connected, isFalse);
    expect(c.machineId, '');
  });
}
