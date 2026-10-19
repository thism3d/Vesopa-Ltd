import 'dart:async';
import 'dart:convert';
import 'dart:io' show Platform;

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import '../config/constants.dart';
import '../data/terminal_identity.dart';
import '../main.dart';
import 'payment_provider.dart';
import 'teya_sdk.dart';
import 'teya_sdk_provider.dart';

/// Teya card machines, the second acquirer beside Dojo (2026-10-19).
///
/// The till holds no Teya credential. The venue connects Teya once in the back
/// office (Card Payments › Teya); the server keeps the store's credentials and
/// the till asks it, over its own terminal token, to send a payment to this
/// till's Teya machine and to say where it is (vesopa_server/src/teya.js).
///
/// Off unless the back office says this venue's tills use Teya: every other
/// venue keeps Dojo exactly as before.

/// One Teya card machine in the venue's store.
class TeyaTerminal {
  const TeyaTerminal({required this.id, required this.name, this.serial = ''});
  final String id;
  final String name;
  final String serial;

  String get label =>
      name.isNotEmpty ? name : (serial.isNotEmpty ? serial : id);

  factory TeyaTerminal.fromJson(Map<String, dynamic> j) => TeyaTerminal(
    id: '${j['id'] ?? ''}',
    name: '${j['name'] ?? ''}',
    serial: '${j['serial'] ?? ''}',
  );
}

/// What the back office says about Teya for this venue.
class TeyaConfig {
  const TeyaConfig({
    this.enabled = false,
    this.environment = 'sandbox',
    this.storeName,
    this.defaultTerminalId,
    this.assignedTerminalId,
    this.terminals = const [],
    this.terminalsError,
    this.sdk,
  });

  /// The tills use Teya card machines.
  final bool enabled;
  final String environment;
  final String? storeName;
  final String? defaultTerminalId;

  /// The machine the back office gave this till. Wins over a choice made on
  /// the till itself.
  final String? assignedTerminalId;
  final List<TeyaTerminal> terminals;
  final String? terminalsError;

  /// What a Windows till needs to run Teya's SDK app (teya_sdk.dart).
  final TeyaSdkInfo? sdk;

  bool get sandbox => environment != 'live';

  factory TeyaConfig.fromJson(Map<String, dynamic> j) => TeyaConfig(
    // A Windows till runs Teya's SDK app, which needs no back office store
    // link, so the SDK block alone switches it on.
    enabled: j['enabled'] == true || (Platform.isWindows && TeyaSdkInfo.fromJson(j['sdk']) != null),
    environment: '${j['environment'] ?? 'sandbox'}',
    storeName: j['store_name'] as String?,
    defaultTerminalId: j['default_terminal_id'] as String?,
    assignedTerminalId: j['assigned_terminal_id'] as String?,
    terminals: [
      for (final t in (j['terminals'] as List?) ?? const [])
        if (t is Map<String, dynamic>) TeyaTerminal.fromJson(t),
    ],
    terminalsError: j['terminals_error'] as String?,
    sdk: TeyaSdkInfo.fromJson(j['sdk']),
  );
}

const _configCacheKey = 'teya_config_cache';
const _terminalKey = 'teya_terminal_id';

/// The venue's Teya settings, from the server, refreshed whenever the back
/// office changes them. Offline, the last answer is kept, so a till that loses
/// the internet still knows which acquirer it uses.
class TeyaConfigController extends AsyncNotifier<TeyaConfig> {
  @override
  Future<TeyaConfig> build() async {
    final session = ref.watch(sessionProvider);
    final apiBase = ref.watch(apiBaseProvider);
    ref.listen(syncEventsProvider, (_, next) {
      final type = next.value?.type;
      if (type == 'teya-settings' || type == 'dojo-settings') {
        ref.invalidateSelf();
      }
    });
    final token = session.terminalToken;
    final prefs = await SharedPreferences.getInstance();
    if (token == null || token.isEmpty) return const TeyaConfig();
    try {
      final res = await http
          .get(
            Uri.parse('$apiBase/api/till/teya/config'),
            headers: {'Authorization': 'Bearer $token'},
          )
          .timeout(const Duration(seconds: 15));
      if (res.statusCode == 200) {
        await prefs.setString(_configCacheKey, res.body);
        return TeyaConfig.fromJson(
          jsonDecode(res.body) as Map<String, dynamic>,
        );
      }
      // A server without Teya yet (404) means Teya is off.
      if (res.statusCode == 404) return const TeyaConfig();
    } catch (_) {
      // Offline: fall back to the last answer below.
    }
    final cached = prefs.getString(_configCacheKey);
    if (cached != null) {
      try {
        return TeyaConfig.fromJson(jsonDecode(cached) as Map<String, dynamic>);
      } catch (_) {}
    }
    return const TeyaConfig();
  }

  Future<void> refresh() async {
    ref.invalidateSelf();
    await future;
  }
}

final teyaConfigProvider =
    AsyncNotifierProvider<TeyaConfigController, TeyaConfig>(
      TeyaConfigController.new,
    );

/// This till's own Teya card machine ("chosen per till"), kept on the till.
/// Empty means the venue's default machine.
class TeyaTerminalController extends AsyncNotifier<String> {
  @override
  Future<String> build() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_terminalKey) ?? '';
  }

  Future<void> choose(String id) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_terminalKey, id);
    state = AsyncData(id);
  }
}

final teyaTerminalProvider =
    AsyncNotifierProvider<TeyaTerminalController, String>(
      TeyaTerminalController.new,
    );

/// Where a Teya payment has got to, as the server reports it.
class TeyaPaymentState {
  const TeyaPaymentState({
    required this.id,
    required this.status,
    this.progress,
    this.reason,
    this.finalState = false,
    this.outcome = 'pending',
    this.message = '',
    this.gatewayPaymentId,
    this.cardLast4,
    this.cardBrand,
    this.authCode,
    this.tipMinor = 0,
  });

  final String id;
  final String status;
  final String? progress;
  final String? reason;
  final bool finalState;
  final String outcome;
  final String message;
  final String? gatewayPaymentId;
  final String? cardLast4;
  final String? cardBrand;
  final String? authCode;
  final int tipMinor;

  bool get paid => status == 'SUCCESSFUL';

  factory TeyaPaymentState.fromJson(Map<String, dynamic> j) => TeyaPaymentState(
    id: '${j['id'] ?? ''}',
    status: '${j['status'] ?? 'NEW'}',
    progress: j['progress'] as String?,
    reason: j['reason'] as String?,
    finalState: j['final'] == true,
    outcome: '${j['outcome'] ?? 'pending'}',
    message: '${j['message'] ?? ''}',
    gatewayPaymentId: j['gateway_payment_id'] as String?,
    cardLast4: j['card_last4'] as String?,
    cardBrand: j['card_brand'] as String?,
    authCode: j['auth_code'] as String?,
    tipMinor: (j['tip_minor'] as num?)?.toInt() ?? 0,
  );
}

/// A Teya error, in a sentence the clerk can act on.
class TeyaException implements Exception {
  TeyaException(this.message, {this.status = 0, this.code});
  final String message;
  final int status;

  /// Teya's own code, when the server passed one on.
  final String? code;

  bool get busy =>
      code == 'TRANSACTION_ALREADY_IN_PROGRESS' || code == 'TERMINAL_BUSY';
  @override
  String toString() => message;
}

/// The prefix a Teya payment's reference carries in the till's records, so a
/// refund knows which acquirer to go back to.
const teyaRefPrefix = 'teya:';

bool isTeyaReference(String? ref) =>
    ref != null && ref.startsWith(teyaRefPrefix);

/// Card payments on a Teya card machine, through the Vesopa server.
/// A Teya card route on this till: Teya's SDK app (Windows), or the Vesopa
/// server's link to Teya (where there is no SDK route yet).
abstract class TeyaCard implements PaymentProvider {
  String get terminalId;
  String? get terminalName;
  bool get sandbox;
  void Function(String? progress, String message)? onProgress;
  void Function(bool accepted, String message)? onCancelAnswered;
  void requestCancel();
  void stopWaiting();
  Future<({bool ok, String message, String? refundId})> refund(String reference, int amountMinor);
}

class TeyaProvider implements TeyaCard {
  TeyaProvider({
    required this.apiBase,
    required this.token,
    required this.terminalId,
    this.terminalName,
    this.environment = 'sandbox',
    this.tillName,
    http.Client? client,
  }) : _http = client ?? http.Client();

  final String apiBase;
  final String token;
  final String terminalId;
  final String? terminalName;
  final String environment;
  final String? tillName;
  final http.Client _http;

  @override
  String get method => 'card';

  bool get sandbox => environment != 'live';

  /// The machine's latest step, for the payment screen: Teya's progress word
  /// (WAITING_FOR_CARD_ENTRY, PIN_ENTRY…) and the sentence to show.
  void Function(String? progress, String message)? onProgress;

  /// What became of a cancel the clerk asked for.
  void Function(bool accepted, String message)? onCancelAnswered;

  bool _cancelRequested = false;
  bool _cancelSent = false;
  bool _abandoned = false;

  /// Ask the machine to cancel. Only a request: if the card is already in,
  /// the payment carries on and its real result still comes back.
  void requestCancel() => _cancelRequested = true;

  /// Stop waiting altogether. The result is "not confirmed", never declined.
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
      res =
          await (method == 'POST'
                  ? _http.post(
                      uri,
                      headers: _headers,
                      body: jsonEncode(body ?? {}),
                    )
                  : _http.get(uri, headers: _headers))
              .timeout(timeout);
    } on TimeoutException {
      throw TeyaException('The Vesopa server did not answer in time.');
    } catch (_) {
      throw TeyaException(
        'Could not reach the Vesopa server. Check the internet connection.',
      );
    }
    Map<String, dynamic> json = const {};
    try {
      final decoded = jsonDecode(res.body);
      if (decoded is Map<String, dynamic>) json = decoded;
    } catch (_) {}
    if (res.statusCode >= 400) {
      throw TeyaException(
        '${json['error'] ?? json['message'] ?? 'Teya refused the request (HTTP ${res.statusCode}).'}',
        status: res.statusCode,
        code: json['code'] as String?,
      );
    }
    return json;
  }

  /// Where a payment is now, waiting up to [waitSeconds] for it to move.
  Future<TeyaPaymentState> status(
    String paymentRequestId, {
    int waitSeconds = 1,
  }) async {
    final j = await _send(
      'GET',
      '/api/till/teya/payments/${Uri.encodeComponent(paymentRequestId)}?wait=$waitSeconds',
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
  }) {
    return _run(amountMinor, orderId: orderId, type: 'SALE');
  }

  /// A refund taken on the card machine with no original sale (unlinked).
  Future<PaymentResult> refundOnMachine(int amountMinor, {String? orderId}) =>
      _run(amountMinor, orderId: orderId, type: 'REFUND');

  Future<PaymentResult> _run(
    int amountMinor, {
    String? orderId,
    required String type,
  }) async {
    _cancelRequested = false;
    _cancelSent = false;
    _abandoned = false;
    onProgress?.call(null, 'Sending to the card machine…');
    final reference =
        'vesopa-${orderId ?? 'sale'}-${DateTime.now().millisecondsSinceEpoch.toRadixString(36)}'
            .replaceAll(RegExp(r'[^A-Za-z0-9_.:-]'), '');
    String id;
    try {
      final created = await _send(
        'POST',
        '/api/till/teya/payments',
        body: {
          'terminal_id': terminalId,
          'amount_minor': amountMinor,
          'type': type,
          'reference': reference,
          'idempotency_key': reference,
          'order_id': orderId,
          'till_name': tillName,
        },
      );
      id = '${created['id'] ?? ''}';
      if (id.isEmpty) throw TeyaException('Teya did not accept the payment.');
    } on TeyaException catch (e) {
      // Nothing reached the machine: a clean failure, safe to try again.
      return PaymentResult(
        approved: false,
        amountMinor: amountMinor,
        message: e.message,
        outcome: e.busy ? CardOutcome.busy : CardOutcome.failed,
        acquirerStatus: 'NOT_SENT',
      );
    }

    // Follow it. A failed read is not a failed payment: reads are retried for
    // three minutes, and only then is the result "not confirmed".
    var lastProgress = '';
    var failures = 0;
    TeyaPaymentState? last;
    final deadline = DateTime.now().add(const Duration(minutes: 6));
    while (DateTime.now().isBefore(deadline)) {
      if (_cancelRequested && !_cancelSent) {
        _cancelSent = true;
        try {
          final r = await _send(
            'POST',
            '/api/till/teya/payments/${Uri.encodeComponent(id)}/cancel',
          );
          onCancelAnswered?.call(r['ok'] == true, '${r['message'] ?? ''}');
        } on TeyaException catch (e) {
          onCancelAnswered?.call(false, e.message);
        }
      }
      if (_abandoned) break;
      try {
        final st = await status(id, waitSeconds: 15);
        failures = 0;
        last = st;
        final key = '${st.status}|${st.progress}';
        if (key != lastProgress) {
          lastProgress = key;
          onProgress?.call(st.progress ?? st.status, st.message);
        }
        if (st.finalState) return _result(st, amountMinor);
      } on TeyaException catch (e) {
        failures += 1;
        if (e.status == 404 || failures > 12) break;
        await Future<void>.delayed(const Duration(seconds: 3));
      }
    }
    // No answer: the money may or may not have gone. Never booked as either.
    return PaymentResult(
      approved: false,
      amountMinor: amountMinor,
      reference: '$teyaRefPrefix$id',
      sessionId: id,
      message:
          'No answer from the card machine. Check its screen before trying again: the payment may still have gone through.',
      uncertainty: PaymentUncertainty.checkTerminal,
      outcome: CardOutcome.unknown,
      acquirerStatus: last?.status,
    );
  }

  PaymentResult _result(TeyaPaymentState st, int amountMinor) {
    final outcome = switch (st.outcome) {
      'approved' => CardOutcome.approved,
      'declined' => CardOutcome.declined,
      'cancelled' => CardOutcome.cancelled,
      _ => st.reason == 'TERMINAL_BUSY' ? CardOutcome.busy : CardOutcome.failed,
    };
    return PaymentResult(
      approved: st.paid,
      amountMinor: amountMinor,
      // The gateway payment id once paid: it is what a refund needs.
      reference:
          '$teyaRefPrefix${st.paid && (st.gatewayPaymentId ?? '').isNotEmpty ? st.gatewayPaymentId : st.id}',
      sessionId: st.id,
      message: st.message.isEmpty ? outcome.title : st.message,
      outcome: outcome,
      acquirerStatus: st.reason == null
          ? st.status
          : '${st.status} ${st.reason}',
      gratuityMinor: st.tipMinor,
      authCode: st.authCode,
      cardLast4: st.cardLast4,
      cardType: st.cardBrand,
    );
  }

  /// Refund a Teya payment back to its card, by the reference the sale was
  /// recorded with. No card needed.
  Future<({bool ok, String message, String? refundId})> refund(
    String reference,
    int amountMinor,
  ) async {
    final gw = reference.startsWith(teyaRefPrefix)
        ? reference.substring(teyaRefPrefix.length)
        : reference;
    try {
      final r = await _send(
        'POST',
        '/api/till/teya/refunds',
        body: {
          'gateway_payment_id': gw,
          'amount_minor': amountMinor,
          'terminal_id': terminalId,
          'reference':
              'vesopa-refund-${DateTime.now().millisecondsSinceEpoch.toRadixString(36)}',
        },
      );
      return (
        ok: r['ok'] == true,
        message: '${r['message'] ?? ''}',
        refundId: r['refund_id'] as String?,
      );
    } on TeyaException catch (e) {
      return (ok: false, message: e.message, refundId: null);
    }
  }
}

/// This till's Teya provider, or null when the venue's tills use Dojo.
final teyaProvider = Provider<TeyaCard?>((ref) {
  final config = ref.watch(teyaConfigProvider).value;
  if (config == null || !config.enabled) return null;
  // Windows: Teya's own SDK app, as Teya require where an SDK exists.
  final sdk = config.sdk;
  if (Platform.isWindows && sdk != null) {
    final assigned = config.assignedTerminalId ?? '';
    String? name;
    for (final t in config.terminals) {
      if (t.id == assigned) name = t.label;
    }
    return TeyaSdkProvider(
      info: sdk,
      appVersion: VesopaBrand.appVersion,
      eposInstanceId: ref.watch(terminalNameProvider),
      assignedTerminalId: assigned.isEmpty ? null : assigned,
      terminalName: name,
    );
  }
  final session = ref.watch(sessionProvider);
  final token = session.terminalToken;
  if (token == null || token.isEmpty) return null;
  final chosen = ref.watch(teyaTerminalProvider).value ?? '';
  final assigned = config.assignedTerminalId ?? '';
  final terminalId = assigned.isNotEmpty
      ? assigned
      : chosen.isNotEmpty
      ? chosen
      : (config.defaultTerminalId ?? '');
  if (terminalId.isEmpty) return null;
  TeyaTerminal? machine;
  for (final t in config.terminals) {
    if (t.id == terminalId) machine = t;
  }
  return TeyaProvider(
    apiBase: ref.watch(apiBaseProvider),
    token: token,
    terminalId: terminalId,
    terminalName: machine?.label,
    environment: config.environment,
    tillName: ref.watch(terminalNameProvider),
  );
});

/// Start Teya's SDK app in the background on a Windows till at a Teya venue,
/// so the first card payment does not wait for the download. No sign-in
/// screens here: those come on the first payment, or from Settings.
final teyaSdkWarmupProvider = Provider<void>((ref) {
  if (!Platform.isWindows) return;
  final sdk = ref.watch(teyaConfigProvider).value?.sdk;
  if (sdk == null) {
    unawaited(TeyaSdk.instance.stop());
    return;
  }
  unawaited(TeyaSdk.instance
      .start(sdk, version: VesopaBrand.appVersion, eposInstanceId: ref.read(terminalNameProvider))
      .catchError((Object _) {}));
});
