import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/commerce.dart';

/// Manual card without Dojo (Pontardawe going live, 12 Oct 2026).
void main() {
  test('Manual card stays off Dojo unless the venue switches it on', () {
    expect(const TenderSettings().manualViaDojo, isFalse);
    expect(TenderSettings.fromJson(const {}).manualViaDojo, isFalse);
    expect(TenderSettings.fromJson(const {'allow_manual_dojo': 0}).manualViaDojo, isFalse);
    expect(TenderSettings.fromJson(const {'allow_manual_dojo': 1}).manualViaDojo, isTrue);
  });
}
