/// Card payments on a Vesopa Go card terminal (2026-11-16).
///
/// The owner: a phone running Vesopa Go "to use as only Terminal, can be
/// connected from other till". This is the till's half: it sends the amount to
/// the phone the venue chose in Settings, the customer taps on the phone, and
/// the phone says how it went. The phone takes the card through the venue's
/// own gateway exactly as a tap on it always has; this till records the
/// tender. The wire is vesopa_server src/go_terminal.js.
///
/// It reuses the card screen and the checks built for Teya and Barclaycard
/// ([CloudStatusCard]): a status that can be looked up on the Vesopa server, a
/// cancel the clerk can ask for, and "not confirmed" when nobody can say.
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import '../data/terminal_identity.dart';
import '../main.dart';
import 'payment_provider.dart';
import 'teya_provider.dart';

/// The prefix such a payment's reference carries in the till's records.
const goTerminalRefPrefix = 'goterm:';

bool isGoTerminalReference(String? ref) => ref != null && ref.startsWith(goTerminalRefPrefix);

/// The card terminal this till sends its card payments to.
class GoTerminalChoice {
  const GoTerminalChoice(this.deviceId, this.name);
  final String deviceId;
  final String name;
}

const _idKey = 'go_card_terminal_id';
const _nameKey = 'go_card_terminal_name';

class GoTerminalChoiceController extends AsyncNotifier<GoTerminalChoice?> {
  @override
  Future<GoTerminalChoice?> build() async {
    final prefs = await SharedPreferences.getInstance();
    final id = prefs.getString(_idKey);
    if (id == null || id.isEmpty) return null;
    return GoTerminalChoice(id, prefs.getString(_nameKey) ?? 'Card terminal');
  }

  Future<void> set(GoTerminalChoice? choice) async {
    state = AsyncData(choice);
    final prefs = await SharedPreferences.getInstance();
    if (choice == null) {
      await prefs.remove(_idKey);
      await prefs.remove(_nameKey);
    } else {
      await prefs.setString(_idKey, choice.deviceId);
      await prefs.setString(_nameKey, choice.name);
    }
  }
}

final goTerminalChoiceProvider =
    AsyncNotifierProvider<GoTerminalChoiceController, GoTerminalChoice?>(GoTerminalChoiceController.new);

/// One card terminal awake in the venue.
class GoTerminalSeen {
  const GoTerminalSeen({required this.deviceId, required this.name, this.ready = true, this.busy = false, this.why});
  final String deviceId;
  final String name;
  final bool ready;
  final bool busy;
  final String? why;

  factory GoTerminalSeen.fromJson(Map<String, dynamic> j) => GoTerminalSeen(
    deviceId: '${j['device_id'] ?? ''}',
    name: '${j['name'] ?? 'Card terminal'}',
    ready: j['ready'] != false,
    busy: j['busy'] == true,
    why: j['why'] as String?,
  );
}

/// The venue's card terminals awake now. Empty when the till is not signed in.
Future<List<GoTerminalSeen>> goTerminalsAwake({required String apiBase, required String? token, http.Client? client}) async {
  if (token == null || token.isEmpty) return const [];
  final res = await (client ?? http.Client())
      .get(Uri.parse('$apiBase/api/go/terminals'), headers: {'Authorization': 'Bearer $token'})
      .timeout(const Duration(seconds: 10));
  if (res.statusCode != 200) return const [];
  final body = jsonDecode(res.body) as Map<String, dynamic>;
  return [
    for (final t in body['terminals'] as List? ?? const []) GoTerminalSeen.fromJson(Map<String, dynamic>.from(t as Map)),
  ];
}

/// This till's card route when a card terminal has been chosen, else null.
final goTerminalTillProvider = Provider<GoTerminalProvider?>((ref) {
  final choice = ref.watch(goTerminalChoiceProvider).value;
  if (choice == null) return null;
  final token = ref.watch(sessionProvider).terminalToken;
  if (token == null || token.isEmpty) return null;
  return GoTerminalProvider(
    apiBase: ref.watch(apiBaseProvider),
    token: token,
    deviceId: choice.deviceId,
    deviceName: choice.name,
    tillName: ref.watch(terminalNameProvider),
  );
});

class GoTerminalProvider implements CloudStatusCard {
  GoTerminalProvider({
    required this.apiBase,
    required this.token,
    required this.deviceId,
    required this.deviceName,
    this.tillName,
    this.every = const Duration(seconds: 1),
    http.Client? client,
  }) : _http = client ?? http.Client();

  final String apiBase;
  final String token;
  final String deviceId;
  final String deviceName;
  final String? tillName;

  /// How often the terminal is asked where it has got to.
  final Duration every;
  final http.Client _http;

  @override
  String get brand => 'Vesopa Go';

  @override
  String get method => 'card';

  /// The phone's own gateway decides live or test; the till cannot tell.
  @override
  bool get sandbox => false;

  @override
  String get terminalId => deviceId;

  @override
  String? get terminalName => deviceName;

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

  Future<Map<String, dynamic>> _send(String method, String path, {Object? body}) async {
    final uri = Uri.parse('$apiBase$path');
    final http.Response res;
    try {
      res = await (method == 'POST'
              ? _http.post(uri, headers: _headers, body: jsonEncode(body ?? {}))
              : _http.get(uri, headers: _headers))
          .timeout(const Duration(seconds: 15));
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
      throw TeyaException('${json['error'] ?? 'The card terminal refused the request (HTTP ${res.statusCode}).'}', status: res.statusCode);
    }
    return json;
  }

  /// The words for each step the phone reports, as the till's clerk reads them.
  static String wordsFor(String status, String? step) {
    if (status == 'waiting') return 'Waking the card terminal…';
    return switch (step) {
      'waitingForCard' => 'Ask the customer to hold their card or phone to the card terminal.',
      'pin' => 'The customer is entering their PIN.',
      'confirming' => 'Authorising with the bank.',
      'cancelling' => 'Cancelling on the card terminal…',
      _ => 'Getting the card terminal ready…',
    };
  }

  /// The server's request as the state the card screen already understands.
  static TeyaPaymentState stateOf(Map<String, dynamic> r) {
    final status = '${r['status'] ?? 'waiting'}';
    final uncertain = r['uncertain'] == true;
    final done = const {'paid', 'declined', 'cancelled', 'failed', 'expired'}.contains(status);
    return TeyaPaymentState(
      id: '${r['id'] ?? ''}',
      status: status == 'paid' ? 'SUCCESSFUL' : status.toUpperCase(),
      progress: r['step'] as String?,
      reason: uncertain ? 'UNCERTAIN' : status.toUpperCase(),
      // A failure nobody can vouch for is not final: the clerk must check.
      finalState: done && !uncertain,
      outcome: status,
      message: (r['message'] as String?) ?? (done ? '' : wordsFor(status, r['step'] as String?)),
      gatewayPaymentId: r['payment_id'] as String?,
    );
  }

  @override
  Future<TeyaPaymentState> status(String id, {int waitSeconds = 1}) async =>
      stateOf(await _send('GET', '/api/go/terminal/requests/${Uri.encodeComponent(id)}'));

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
    onProgress?.call(null, 'Sending to $deviceName…');
    String id;
    try {
      final created = await _send('POST', '/api/go/terminal/pay', body: {
        'device_id': deviceId,
        'amount_minor': amountMinor,
        'reference': orderId,
        'from': tillName ?? 'Till',
      });
      id = '${created['id'] ?? ''}';
      if (id.isEmpty) throw TeyaException('The card terminal did not take the request.');
    } on TeyaException catch (e) {
      // Refused before the phone heard of it: nothing was taken.
      return PaymentResult(
        approved: false,
        amountMinor: amountMinor,
        message: e.message,
        outcome: e.status == 409 ? CardOutcome.busy : CardOutcome.failed,
        acquirerStatus: 'NOT_SENT',
      );
    }

    var last = '';
    var failures = 0;
    final deadline = DateTime.now().add(const Duration(minutes: 6));
    while (DateTime.now().isBefore(deadline)) {
      if (_cancelRequested && !_cancelSent) {
        _cancelSent = true;
        try {
          final r = await _send('POST', '/api/go/terminal/requests/${Uri.encodeComponent(id)}/cancel');
          final stopped = r['status'] == 'cancelled';
          onCancelAnswered?.call(true, stopped ? 'Cancelled. No money was taken.' : 'Asked the card terminal to stop.');
          if (stopped) {
            return PaymentResult(
              approved: false,
              amountMinor: amountMinor,
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
      await Future<void>.delayed(every);
      try {
        final st = await status(id);
        failures = 0;
        final key = '${st.status}|${st.progress}|${st.message}';
        if (key != last) {
          last = key;
          onProgress?.call(st.progress ?? st.status, st.message);
        }
        if (st.finalState) return _result(st, amountMinor);
        if (st.reason == 'UNCERTAIN') break;
      } on TeyaException catch (e) {
        failures += 1;
        if (e.status == 404 || failures > 30) break;
      }
    }
    return PaymentResult(
      approved: false,
      amountMinor: amountMinor,
      sessionId: id,
      message: 'No answer from $deviceName. Look at its screen before trying again: the payment may have gone through.',
      uncertainty: PaymentUncertainty.checkTerminal,
      outcome: CardOutcome.unknown,
    );
  }

  PaymentResult _result(TeyaPaymentState st, int amountMinor) {
    final outcome = switch (st.outcome) {
      'paid' => CardOutcome.approved,
      'declined' => CardOutcome.declined,
      'cancelled' => CardOutcome.cancelled,
      'expired' => CardOutcome.failed,
      _ => CardOutcome.failed,
    };
    return PaymentResult(
      approved: st.paid,
      amountMinor: amountMinor,
      reference: st.paid ? '$goTerminalRefPrefix${st.gatewayPaymentId ?? st.id}' : null,
      sessionId: st.id,
      message: st.message.isEmpty ? outcome.title : st.message,
      outcome: outcome,
      acquirerStatus: st.status,
    );
  }

  /// The phone took the card, so the phone gives it back: its own gateway
  /// holds the payment. Said plainly rather than failing somewhere else.
  @override
  Future<({bool ok, String message, String? refundId})> refund(String reference, int amountMinor) async => (
    ok: false,
    message: 'This card payment was taken on a Vesopa Go card terminal. Refund it on that device: '
        'Vesopa Go, More, Card payments on this phone.',
    refundId: null,
  );
}
