// Add to Google Wallet on Android, as Add to Apple Wallet on an iPhone.

import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vesopa_loyalty/data/api.dart';
import 'package:vesopa_loyalty/data/brand.dart';
import 'package:vesopa_loyalty/platform/wallet.dart';

void main() {
  testWidgets('Google\'s own button on Android, and a tap reaches the app', (tester) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    var taps = 0;
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: Center(child: GoogleWalletButton(onPressed: () => taps++)))));
    expect(find.bySemanticsLabel('Add to Google Wallet'), findsOneWidget);
    final image = tester.widget<Image>(find.byType(Image));
    expect((image.image as AssetImage).assetName, 'assets/google_wallet/add_to_google_wallet.png');
    expect(tester.getSize(find.byType(Image)).height, greaterThanOrEqualTo(48));
    await tester.tap(find.byType(GoogleWalletButton));
    expect(taps, 1);
    debugDefaultTargetPlatformOverride = null;
  });

  testWidgets('nothing on an iPhone, which has Apple Wallet instead', (tester) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: GoogleWalletButton(onPressed: () {}))));
    expect(find.byType(Image), findsNothing);
    debugDefaultTargetPlatformOverride = null;
  });

  test('the Google link is the server\'s, and a club without one says so', () async {
    LoyaltyApi api(Map<String, dynamic> body) => LoyaltyApi(
      base: 'https://loyalty.example',
      slug: 'club',
      client: MockClient((req) async {
        expect(req.url.path, '/loyalty/v1/me/wallet');
        return http.Response(jsonEncode(body), 200, headers: {'content-type': 'application/json'});
      }),
    )..token = 't';

    final link = await api({'apple': 'https://loyalty.example/wallet/c/x?apple=1', 'google': 'https://loyalty.example/wallet/s/x'})
        .googleWalletLink();
    expect(link.toString(), 'https://loyalty.example/wallet/s/x');

    expect(
      () => api({'apple': 'https://loyalty.example/wallet/c/x?apple=1'}).googleWalletLink(),
      throwsA(isA<ApiError>().having((e) => e.message, 'message', contains('not offering Google Wallet'))),
    );
  });

  test('the button is offered only when the club\'s server can issue the card', () {
    String resolve(String u) => u;
    expect(Brand.fromJson({'wallet': {'google': true}}, resolve).googleWallet, isTrue);
    expect(Brand.fromJson({'wallet': {'google': false}}, resolve).googleWallet, isFalse);
    // An older server says nothing: no button rather than one that fails.
    expect(Brand.fromJson({}, resolve).googleWallet, isFalse);
  });
}
