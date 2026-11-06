import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vesopa_epos/data/terminal_relicense.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  final answer = {
    'token': 't',
    'terminalToken': 't',
    'user': {'name': 'Lounge', 'officeEmail': 'v@x', 'officeName': 'The Club'},
  };

  test('a till with no session gets one back without anybody signing in', () async {
    SharedPreferences.setMockInitialValues({});
    await relicenseIfNeeded(
      apiBase: 'https://x',
      fingerprint: 'abc',
      version: '1',
      client: MockClient((_) async => http.Response(jsonEncode(answer), 200)),
    );
    final prefs = await SharedPreferences.getInstance();
    final saved = jsonDecode(prefs.getString('session')!) as Map<String, dynamic>;
    expect(saved['terminalToken'], 't');
    expect(saved['office'], 'v@x');
  });

  test('a signed-in till asks nothing', () async {
    SharedPreferences.setMockInitialValues({'session': '{}'});
    var asked = false;
    await relicenseIfNeeded(
      apiBase: 'https://x',
      fingerprint: 'abc',
      version: '1',
      client: MockClient((_) async {
        asked = true;
        return http.Response('{}', 200);
      }),
    );
    expect(asked, isFalse);
  });

  test('a refused or withdrawn machine goes to the sign-in page as before', () async {
    SharedPreferences.setMockInitialValues({});
    await relicenseIfNeeded(
      apiBase: 'https://x',
      fingerprint: 'abc',
      version: '1',
      client: MockClient((_) async => http.Response('{}', 404)),
    );
    expect((await SharedPreferences.getInstance()).getString('session'), isNull);
  });

  test('a till somebody signed out on purpose stays signed out', () async {
    SharedPreferences.setMockInitialValues({signedOutKey: true});
    var asked = false;
    await relicenseIfNeeded(
      apiBase: 'https://x',
      fingerprint: 'abc',
      version: '1',
      client: MockClient((_) async {
        asked = true;
        return http.Response('{}', 200);
      }),
    );
    expect(asked, isFalse);
  });

  test('no fingerprint, no request', () async {
    SharedPreferences.setMockInitialValues({});
    await relicenseIfNeeded(
      apiBase: 'https://x',
      fingerprint: null,
      version: '1',
      client: MockClient((_) async => throw StateError('should not call')),
    );
    expect((await SharedPreferences.getInstance()).getString('session'), isNull);
  });

  test('an answer with no office is not a session', () {
    expect(sessionFromLicence({'terminalToken': 't', 'user': <String, dynamic>{}}), isNull);
  });
}
