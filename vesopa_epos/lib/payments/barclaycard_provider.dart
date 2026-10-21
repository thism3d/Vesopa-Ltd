import 'dart:async';
import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import '../data/terminal_identity.dart';
import '../main.dart';
import 'payment_provider.dart';
import 'teya_provider.dart';

/// Barclaycard Smartpay Fuse on the tills (2026-10-21).
///
/// Barclaycard has no card machine API, so the till takes the card on the
/// customer's own phone: it asks the Vesopa server for a payment page, shows
/// it as a QR code (on the till and the customer display), and follows the
/// payment until the customer has paid by card, Apple Pay or Google Pay.
/// The till holds no Barclaycard credential.
///
/// Chosen per venue in the back office (Card Payments, Who takes the cards).
/// Off everywhere else, where Dojo or Teya carry on exactly as before.

/// The prefix a Barclaycard payment's reference carries in the till's records.
const barclaycardRefPrefix = 'barclays:';

bool isBarclaycardReference(String? ref) =>
    ref != null && ref.startsWith(barclaycardRefPrefix);

class BarclaycardConfig {
  const BarclaycardConfig({this.enabled = false, this.environment = 'sandbox'});
  final bool enabled;
  final String environment;
  bool get sandbox => environment != 'live';

  factory BarclaycardConfig.fromJson(Map<String, dynamic> j) => BarclaycardConfig(
    enabled: j['enabled'] == true,
    environment: '${j['environment'] ?? 'sandbox'}',
  );
}

const _cacheKey = 'barclaycard_config_cache';

/// Whether this venue's tills take cards with Barclaycard, from the server,
/// refreshed the moment the back office switches. Offline, the last answer.
class BarclaycardConfigController extends AsyncNotifier<BarclaycardConfig> {
  @override
  Future<BarclaycardConfig> build() async {
    final session = ref.watch(sessionProvider);
    final apiBase = ref.watch(apiBaseProvider);
    ref.listen(syncEventsProvider, (_, next) {
      final type = next.value?.type;
      if (type == 'barclaycard-settings' || type == 'teya-settings' || type == 'dojo-settings') {
        ref.invalidateSelf();
      }
    });
    final token = session.terminalToken;
    final prefs = await SharedPreferences.getInstance();
    if (token == null || token.isEmpty) return const BarclaycardConfig();
    try {
      final res = await http
          .get(
            Uri.parse('$apiBase/api/till/barclaycard/config'),
            headers: {'Authorization': 'Bearer $token'},
          )
          .timeout(const Duration(seconds: 15));
      if (res.statusCode == 200) {
        await prefs.setString(_cacheKey, res.body);
        return BarclaycardConfig.fromJson(jsonDecode(res.body) as Map<String, dynamic>);
      }
      // A server without Barclaycard (404) means it is off.
      if (res.statusCode == 404) return const BarclaycardConfig();
    } catch (_) {
      // Offline: the last answer below.
    }
    final cached = prefs.getString(_cacheKey);
    if (cached != null) {
      try {
        return BarclaycardConfig.fromJson(jsonDecode(cached) as Map<String, dynamic>);
      } catch (_) {}
    }
    return const BarclaycardConfig();
  }
}

final barclaycardConfigProvider =
    AsyncNotifierProvider<BarclaycardConfigController, BarclaycardConfig>(
      BarclaycardConfigController.new,
    );

/// This till's Barclaycard route, or null when the venue's tills do not use it.
final barclaycardTillProvider = Provider<BarclaycardProvider?>((ref) {
  final config = ref.watch(barclaycardConfigProvider).value;
  if (config == null || !config.enabled) return null;
  final token = ref.watch(sessionProvider).terminalToken;
  if (token == null || token.isEmpty) return null;
  return BarclaycardProvider(
    apiBase: ref.watch(apiBaseProvider),
    token: token,
    environment: config.environment,
    tillName: ref.watch(terminalNameProvider),
  );
});

class BarclaycardProvider implements CloudStatusCard {
  BarclaycardProvider({
    required this.apiBase,
    required this.token,
    this.environment = 'sandbox',
    this.tillName,
    http.Client? client,
  }) : _http = client ?? http.Client();

  final String apiBase;
  final String token;
  final String environment;
  final String? tillName;
  final http.Client _http;

  @override
  String get brand => 'Barclaycard';

  @override
  String get method => 'card';

  @override
  bool get sandbox => environment != 'live';

  /// No machine: the customer's phone.
  @override
  String get terminalId => 'phone';

  @override
  String? get terminalName => 'Customer\'s phone';

  @override
  void Function(String? progress, String message)? onProgress;

  @override
  void Function(bool accepted, String message)? onCancelAnswered;

  @override
  void Function(String url)? onPayLink;

  bool _cancelRequested = false;
  bool _cancelSent = false;
  bool _abandoned = false;

  @override
  void requestCancel() => _cancelRequested = true;

  @override
  void stopWaiting() {
    _cancelRequested = true;
    _abandoned = true;
  }

  Map<String, String> get _headers => {
    'Authorization': 'Bearer $token',
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };

  Future<Map<String, dynamic>> _send(
    String method,
    String path, {
    Object? body,
    Duration timeout = const Duration(seconds: 20),
  }) async {
    final uri = Uri.parse('$apiBase$path');
    final http.Response res;
    try {
      res = await (method == 'POST'
              ? _http.post(uri, headers: _headers, body: jsonEncode(body ?? {}))
              : _http.get(uri, headers: _headers))
          .timeout(timeout);
    } on TimeoutException {
      throw TeyaException('The Vesopa server did not answer in time.');
    } catch (_) {
      throw TeyaException('Could not reach the Vesopa server. Check the internet connection.');
    }
    Map<String, dynamic> json = const {};
    try {
      final decoded = jsonDecode(res.body);
      if (decoded is Map<String, dynamic>) json = decoded;
    } catch (_) {}
    if (res.statusCode >= 400) {
      throw TeyaException(
        '${json['error'] ?? 'Barclaycard refused the request (HTTP ${res.statusCode}).'}',
        status: res.statusCode,
      );
    }
    return json;
  }

  @override
  Future<TeyaPaymentState> status(String id, {int waitSeconds = 1}) async {
    final j = await _send(
      'GET',
      '/api/till/barclaycard/payments/${Uri.encodeComponent(id)}?wait=$waitSeconds',
      timeout: Duration(seconds: waitSeconds + 15),
    );
    return TeyaPaymentState.fromJson(j);
  }

  @override
  Future<PaymentResult> take(
    int amountMinor, {
    String? orderId,
    bool manual = false,
    int cashbackMinor = 0,
  }) async {
    _cancelRequested = false;
    _cancelSent = false;
    _abandoned = false;
    onProgress?.call(null, 'Making the payment code…');
    final reference =
        'vesopa-${orderId ?? 'sale'}-${DateTime.now().millisecondsSinceEpoch.toRadixString(36)}'
            .replaceAll(RegExp(r'[^A-Za-z0-9_.:-]'), '');
    String id;
    try {
      final created = await _send('POST', '/api/till/barclaycard/payments', body: {
        'amount_minor': amountMinor,
        'order_id': orderId,
        'reference': reference,
        'till_name': tillName,
      });
      id = '${created['id'] ?? ''}';
      final url = '${created['url'] ?? ''}';
      if (id.isEmpty || !url.startsWith('https://')) {
        throw TeyaException('Barclaycard did not give a payment page.');
      }
      onPayLink?.call(url);
      onProgress?.call(null, 'Ask the customer to scan the code and pay on their phone.');
    } on TeyaException catch (e) {
      return PaymentResult(
        approved: false,
        amountMinor: amountMinor,
        message: e.message,
        outcome: CardOutcome.failed,
        acquirerStatus: 'NOT_SENT',
      );
    }

    var last = '';
    var failures = 0;
    final deadline = DateTime.now().add(const Duration(minutes: 16));
    while (DateTime.now().isBefore(deadline)) {
      if (_cancelRequested && !_cancelSent) {
        _cancelSent = true;
        try {
          final r = await _send('POST', '/api/till/barclaycard/payments/${Uri.encodeComponent(id)}/cancel');
          onCancelAnswered?.call(r['ok'] == true, '${r['message'] ?? ''}');
          if (r['ok'] == true) {
            return PaymentResult(
              approved: false,
              amountMinor: amountMinor,
              reference: '$barclaycardRefPrefix$id',
              sessionId: id,
              message: 'Cancelled. No money was taken.',
              outcome: CardOutcome.cancelled,
            );
          }
        } on TeyaException catch (e) {
          onCancelAnswered?.call(false, e.message);
        }
      }
      if (_abandoned) break;
      try {
        final st = await status(id, waitSeconds: 10);
        failures = 0;
        final key = '${st.status}|${st.progress}|${st.message}';
        if (key != last) {
          last = key;
          onProgress?.call(st.progress ?? st.status, st.message);
        }
        if (st.finalState) return _result(st, amountMinor);
      } on TeyaException catch (e) {
        failures += 1;
        if (e.status == 404 || failures > 12) break;
        await Future<void>.delayed(const Duration(seconds: 3));
      }
    }
    return PaymentResult(
      approved: false,
      amountMinor: amountMinor,
      reference: '$barclaycardRefPrefix$id',
      sessionId: id,
      message: 'No answer yet. Check with the customer before trying again: the payment may still have gone through.',
      uncertainty: PaymentUncertainty.checkTerminal,
      outcome: CardOutcome.unknown,
    );
  }

  PaymentResult _result(TeyaPaymentState st, int amountMinor) {
    final outcome = st.paid
        ? CardOutcome.approved
        : st.reason == 'EXPIRED'
        ? CardOutcome.expired
        : CardOutcome.cancelled;
    return PaymentResult(
      approved: st.paid,
      amountMinor: amountMinor,
      // Barclaycard's payment id once paid: it is what a refund needs.
      reference: '$barclaycardRefPrefix${st.paid && (st.gatewayPaymentId ?? '').isNotEmpty ? st.gatewayPaymentId : st.id}',
      sessionId: st.id,
      message: st.message.isEmpty ? outcome.title : st.message,
      outcome: outcome,
      acquirerStatus: st.status,
      authCode: st.authCode,
      cardLast4: st.cardLast4,
      cardType: st.cardBrand,
    );
  }

  @override
  Future<({bool ok, String message, String? refundId})> refund(
    String reference,
    int amountMinor,
  ) async {
    final id = reference.startsWith(barclaycardRefPrefix)
        ? reference.substring(barclaycardRefPrefix.length)
        : reference;
    try {
      final r = await _send('POST', '/api/till/barclaycard/refunds', body: {
        'gateway_payment_id': id,
        'amount_minor': amountMinor,
      });
      return (ok: r['ok'] == true, message: '${r['message'] ?? ''}', refundId: r['refund_id'] as String?);
    } on TeyaException catch (e) {
      return (ok: false, message: e.message, refundId: null);
    }
  }
}
