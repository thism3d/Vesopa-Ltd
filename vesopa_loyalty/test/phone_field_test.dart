import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_loyalty/ui/phone_field.dart';

/// Members type their number however they like: with the first 0 or without,
/// with spaces, or with their own +country code.
void main() {
  final uk = countries.first;
  final bd = countries.firstWhere((c) => c.iso == 'BD');

  test('the UK is the default country', () => expect(uk.dial, '44'));

  test('a UK number with or without the first 0 is the same number', () {
    expect(toInternational(uk, '07700 900123'), '+447700900123');
    expect(toInternational(uk, '7700 900123'), '+447700900123');
  });

  test('another country is used as picked', () {
    expect(toInternational(bd, '01714526039'), '+8801714526039');
    expect(toInternational(bd, '1714526039'), '+8801714526039');
  });

  test('a typed +code or 00 wins over the picked country', () {
    expect(toInternational(uk, '+880 1714 526039'), '+8801714526039');
    expect(toInternational(uk, '00353 85 123 4567'), '+353851234567');
  });

  test('too short or empty is not a number', () {
    expect(toInternational(uk, ''), isNull);
    expect(toInternational(uk, '0123'), isNull);
  });
}
