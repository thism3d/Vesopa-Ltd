/// Google Pay on Go's pay page, on Android (the back office chooses the gateway
/// under Vesopa Go, Card payments).
///
/// The Google account on the phone pays, so this is for a customer's own device
/// or a phone handed to them. A customer at Tap to Pay needs none of this: they
/// tap a Google Pay phone like a card. Google has no such thing on iPhone.
///
/// Google gives Go a token made for the venue's Stripe account; the server
/// charges it (src/stripe.js), so the phone holds no secret key. TEST shows
/// Google's test cards and no money moves until Google has approved Vesopa.
library;

import 'dart:convert';
import 'dart:io';

import 'package:pay/pay.dart';

import '../data/api.dart';

/// What Google is asked for. [environment] is TEST or PRODUCTION; the merchant
/// id is needed only in PRODUCTION. The venue's account follows the key after a
/// slash, which puts the token on that account for a direct charge.
String googlePayConfiguration({
  required String environment,
  required String publishableKey,
  required String account,
  required String venue,
  String? merchantId,
}) => jsonEncode({
  'provider': 'google_pay',
  'data': {
    'environment': environment,
    'apiVersion': 2,
    'apiVersionMinor': 0,
    'merchantInfo': {'merchantName': venue, 'merchantId': ?merchantId},
    'allowedPaymentMethods': [
      {
        'type': 'CARD',
        'parameters': {
          'allowedAuthMethods': ['PAN_ONLY', 'CRYPTOGRAM_3DS'],
          'allowedCardNetworks': ['MASTERCARD', 'VISA'],
        },
        'tokenizationSpecification': {
          'type': 'PAYMENT_GATEWAY',
          'parameters': {
            'gateway': 'stripe',
            'stripe:version': '2018-10-31',
            'stripe:publishableKey': '$publishableKey/$account',
          },
        },
      },
    ],
    'countryCode': 'GB',
    'currencyCode': 'GBP',
  },
});

/// Stripe's token inside what Google hands back.
String googlePayToken(Map<String, dynamic> result) {
  final data = result['paymentMethodData'] as Map;
  final tokenization = data['tokenizationData'] as Map;
  return '${(jsonDecode('${tokenization['token']}') as Map)['id']}';
}

/// Whether the venue's choice, this device and Google all allow the button.
Future<Pay?> googlePayClient(TapApi api, {required String gateway, required String venue}) async {
  if (!Platform.isAndroid || gateway != 'stripe') return null;
  final c = await api.stripeConfig();
  final key = c['publishable_key'] as String?;
  final account = c['account'] as String?;
  if (key == null || account == null || c['enabled'] != true) return null;
  final production = c['google_pay_environment'] == 'PRODUCTION';
  final client = Pay({
    PayProvider.google_pay: PaymentConfiguration.fromJsonString(googlePayConfiguration(
      environment: production ? 'PRODUCTION' : 'TEST',
      publishableKey: key,
      account: account,
      venue: venue,
      merchantId: production ? c['google_pay_merchant_id'] as String? : null,
    )),
  });
  return await client.userCanPay(PayProvider.google_pay) ? client : null;
}

/// Shows Google's own sheet and charges what it gives back. The Stripe id when
/// paid, null when the customer closed the sheet, and a [TapApiError] otherwise.
Future<String?> takeGooglePay(Pay client, TapApi api, {required int amountMinor, required String reference}) async {
  final Map<String, dynamic> result;
  try {
    result = await client.showPaymentSelector(PayProvider.google_pay, [
      PaymentItem(
        label: 'Total',
        amount: (amountMinor / 100).toStringAsFixed(2),
        status: PaymentItemStatus.final_price,
      ),
    ]);
  } on Exception {
    return null;
  }
  final paid = await api.googlePayCharge(amountMinor, googlePayToken(result), reference: reference);
  return paid['id'] as String?;
}
