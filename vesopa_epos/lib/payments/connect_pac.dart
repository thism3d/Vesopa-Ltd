import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'connect_ws.dart';
import 'payment_provider.dart';

/// A card machine on a Paymentsense Connect account.
class ConnectTerminal {
  const ConnectTerminal({
    required this.tid,
    required this.status,
    this.currency = 'GBP',
  });

  /// The number printed on the device. On Connect this *is* the identifier —
  /// there is no opaque id behind it, which is why it is what gets saved.
  final String tid;

  /// 'AVAILABLE' — able to take a request now. 'BUSY' — mid-transaction.
  final String status;
  final String currency;

  bool get available => status.toUpperCase() == 'AVAILABLE';

  factory ConnectTerminal.fromJson(Map<String, dynamic> j) => ConnectTerminal(
    tid: j['tid'] as String? ?? '',
    status: j['status'] as String? ?? '',
    currency: j['currency'] as String? ?? 'GBP',
  );
}

/// Where a Connect transaction has got to, in words a clerk can act on.
///
/// Connect reports progress as a stream of notification values rather than a
/// status field, so the till has to keep the last one it saw: between two polls
/// the transaction may be sitting on `PIN_ENTRY` with no other indication that
/// anything is happening.
class ConnectProgress {
  const ConnectProgress({required this.notification, this.userMessage});

  final String notification;
  final String? userMessage;

  bool get needsSignature => notification == 'SIGNATURE_VERIFICATION';

  /// The reader's prompt, in words the clerk can read out.
  String get prompt =>
      userMessage ??
      switch (notification) {
        'CONNECTING' || 'CONNECTION_MADE' => 'Connecting to the card machine…',
        'REQUEST_SENT' || 'TRANSACTION_STARTED' => 'Sent to the card machine',
        'PRESENT_CARD' => 'Ask the customer to present their card',
        'INSERT_CARD' => 'Ask the customer to insert their card',
        'RE_PRESENT_CARD' => 'Ask the customer to present the card again',
        'PRESENT_ONLY_ONE_CARD' => 'Only one card at a time, please',
        'PIN_ENTRY' => 'Customer is entering their PIN',
        'REMOVE_CARD' => 'Ask the customer to remove their card',
        'PLEASE_WAIT' || 'RETRYING' => 'Please wait…',
        'SIGNATURE_VERIFICATION' => 'Check the signature',
        'SIGNATURE_VERIFICATION_IN_PROGRESS' => 'Checking the signature…',
        'BAD_SWIPE' => 'Bad swipe — ask them to try again',
        'CARD_EXPIRED' => 'That card has expired',
        'CARD_NOT_SUPPORTED' => 'That card is not accepted',
        'CARD_ERROR' => 'The card could not be read',
        'APPROVED' => 'Approved',
        'DECLINED' || 'DECLINED_BY_CARD' => 'Declined',
        'CANCELLING' || 'ATTEMPTING_CANCEL' => 'Cancelling…',
        _ => 'Waiting for the card machine…',
      };
}

/// Card payments through **Paymentsense Connect** Pay-At-Counter.
///
/// A different product from [DojoProvider] despite the shared brand. Connect
/// gives every merchant their own host (`<account>.connect.paymentsense.cloud`)
/// and drives the PDQ directly over REST — there are no payment intents, no
/// hosted checkout and no client secret. That is why the base URL is part of
/// the terminal's configuration: a live Connect key is meaningless without the
/// host it belongs to.
///
/// Verified against the live account: `GET /pac/terminals` answers with
/// `{"terminals":[…]}` for `Accept: application/connect.v2+json` and Basic auth
/// carrying the API key as the *password*. v0 and v1 reject the
/// `Software-House-Id` header outright, so the version header is not optional.
///
/// Flow, from the published transaction diagram and changelog:
///   1. `POST /pac/terminals/{tid}/transactions` → a `requestId`
///   2. `GET  /pac/terminals/{tid}/transactions/{requestId}` — polled at 1s
///      until `transactionResult` appears; notifications carry the prompts
///   3. `PUT  …/{requestId}/signature` when the reader asks for a signature —
///      the transaction stalls there until answered
///   4. `DELETE …/{requestId}` to cancel, which is only honoured before the
///      card is presented
class ConnectPacProvider implements PaymentProvider {
  ConnectPacProvider({
    required this.baseUrl,
    required this.apiKey,
    this.terminalId,
    this.softwareHouseId,
    this.installerId,
    this.currency = 'GBP',
    this.pollTimeout = const Duration(minutes: 3),
    // Connect's own guidance: poll once a second. Rate limiting kicks in at
    // 0.1s, so anything faster is refused rather than quicker.
    this.pollInterval = const Duration(seconds: 1),
    http.Client? client,
  }) : _client = client ?? http.Client();

  final String baseUrl;
  final String apiKey;

  /// The TID of the card machine. Null means no reader is paired with this
  /// till, and Connect then has no way to present a card at all.
  final String? terminalId;

  /// Sent as `Software-House-Id` and `Installer-Id`. Paymentsense issues both;
  /// the software-house id is fixed per EPoS vendor, the installer id per
  /// installing partner.
  final String? softwareHouseId;
  final String? installerId;

  final String currency;
  final Duration pollTimeout;
  final Duration pollInterval;
  final http.Client _client;

  /// The live socket, when one is available.
  ///
  /// A card sale is a conversation — the reader pushes "present card", "enter
  /// PIN", "remove card" as they happen — so the socket is the better transport
  /// and is tried first. REST is kept as the fallback rather than removed: if
  /// the socket cannot open, or drops mid-service, the venue still has to be
  /// able to take money.
  ConnectSocket? socket;

  /// Set once a socket attempt has failed, so the till stops paying the
  /// connection timeout on every subsequent sale and just uses REST.
  bool _socketUnavailable = false;

  /// Whether this payment should go over the socket.
  bool get _preferSocket => socket != null && !_socketUnavailable;

  @override
  String get method => 'card';

  /// Progress from the reader, for the till's payment dialog.
  void Function(ConnectProgress progress)? onProgress;

  /// Asked when the reader wants the cardholder's signature checked. Returning
  /// true accepts it. Connect auto-accepts if nothing answers before its own
  /// timeout, so a till that never asks still completes — but it completes
  /// without anyone having looked at the signature, which is the bad outcome
  /// this callback exists to avoid.
  Future<bool> Function()? onSignatureRequested;

  /// Set when the clerk abandons the wait. Checked between polls.
  bool _abandoned = false;

  void abandon() => _abandoned = true;

  /// Whether this till can actually send a payment to a reader.
  bool get canUseTerminal => terminalId?.trim().isNotEmpty ?? false;

  Map<String, String> get _headers => {
    // Basic auth with the API key as the *password* and any username. Not a
    // bearer token — the docs are explicit, and the live host confirms it.
    'Authorization':
        'Basic ${base64Encode(utf8.encode('epos:${apiKey.trim()}'))}',
    // Without an explicit version Connect serves v0, which does not understand
    // the partner headers below and answers 415.
    'Accept': 'application/connect.v2+json',
    'Content-Type': 'application/json',
    'Software-House-Id': ?softwareHouseId,
    'Installer-Id': ?installerId,
  };

  Uri _uri(String path) => Uri.parse('$baseUrl$path');

  /// The card machines paired with this account.
  ///
  /// An empty list is a real answer, not an error: it means no PDQ is currently
  /// online against this account, and no card can be taken until one is.
  Future<List<ConnectTerminal>> listTerminals() async {
    // The socket answers this faster and proves the connection works at the
    // same time, which is exactly what the settings screen wants to know.
    if (_preferSocket) {
      try {
        return await socket!.connectedTerminals();
      } catch (_) {
        // Fall through to REST, and stop trying the socket this session.
        _socketUnavailable = true;
      }
    }

    final res = await _client
        .get(_uri('/pac/terminals'), headers: _headers)
        .timeout(const Duration(seconds: 20));

    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw ConnectException(_error(res, 'Could not list card machines'));
    }
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    return ((body['terminals'] as List?) ?? const [])
        .cast<Map<String, dynamic>>()
        .map(ConnectTerminal.fromJson)
        .toList();
  }

  /// Refund a card at the reader.
  ///
  /// Required by Connect's integration checklist alongside SALE, and it is a
  /// genuinely separate operation rather than a negative sale: the customer has
  /// to present the card again, and the reader runs its own flow. Returns a
  /// [PaymentResult] whose `approved` means "the money went back".
  Future<PaymentResult> refund(int amountMinor, {String? orderId}) async {
    _abandoned = false;
    String? requestId;
    try {
      final tid = terminalId?.trim();
      final live = socket;
      if (_preferSocket && live != null && (tid?.isNotEmpty ?? false)) {
        try {
          live.onProgress = (p) => onProgress?.call(p);
          await live.connect();
          final result = await live.performTransaction(
            tid: tid!,
            amountMinor: amountMinor,
            method: 'refund',
            currency: currency,
          );
          return _resultOf(result, amountMinor, reference: null);
        } on ConnectException {
          rethrow; // The reader was engaged; do not run the refund twice.
        } catch (_) {
          _socketUnavailable = true; // Never opened; REST can take it.
        }
      }

      requestId = await startTransaction(amountMinor, type: 'REFUND');
      return await _follow(requestId, amountMinor);
    } on ConnectException catch (e) {
      return PaymentResult(
        approved: false,
        amountMinor: amountMinor,
        reference: requestId,
        message: e.message,
      );
    } catch (e) {
      return PaymentResult(
        approved: false,
        amountMinor: amountMinor,
        reference: requestId,
        message: '$e',
      );
    }
  }

  /// Start a transaction on the reader. Returns the request id the result is
  /// then polled under.
  ///
  /// [cardholderNotPresent] is the keyed-entry route: the PDQ skips its
  /// "Present card" screen and goes straight to "Key card number", which is how
  /// a telephone order or an unreadable chip is taken on a Connect account.
  Future<String> startTransaction(
    int amountMinor, {
    String type = 'SALE',
    bool cardholderNotPresent = false,
  }) async {
    final tid = terminalId?.trim();
    if (tid == null || tid.isEmpty) {
      throw ConnectException(
        'No card machine is set for this till. Add its TID in '
        'Settings › Card payments.',
      );
    }

    final res = await _client
        .post(
          _uri('/pac/terminals/$tid/transactions'),
          headers: _headers,
          body: jsonEncode({
            'transactionType': type,
            'amount': amountMinor,
            'currency': currency,
            if (cardholderNotPresent) 'cardholderNotPresent': true,
          }),
        )
        .timeout(const Duration(seconds: 30));

    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw ConnectException(_error(res, 'The card machine refused the payment'));
    }

    // Connect answers 202 with the request id in the body; older responses put
    // it only in the Location header, so both are accepted rather than failing
    // on a difference that does not change what happens next.
    final body = _decode(res.body);
    final id =
        body['requestId'] as String? ??
        body['id'] as String? ??
        res.headers['location']?.split('/').last;
    if (id == null || id.isEmpty) {
      throw ConnectException(
        'The card machine accepted the payment but did not return a reference, '
        'so the till cannot follow it. Check the PDQ before retrying.',
      );
    }
    return id;
  }

  /// Read a running transaction.
  Future<Map<String, dynamic>> fetchTransaction(String requestId) async {
    final res = await _client
        .get(
          _uri('/pac/terminals/${terminalId!.trim()}/transactions/$requestId'),
          headers: _headers,
        )
        .timeout(const Duration(seconds: 20));

    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw ConnectException(_error(res, 'Could not read the card machine'));
    }
    return _decode(res.body);
  }

  /// Accept or reject the cardholder's signature.
  Future<void> answerSignature(
    String requestId, {
    required bool accepted,
  }) async {
    final res = await _client
        .put(
          _uri(
            '/pac/terminals/${terminalId!.trim()}'
            '/transactions/$requestId/signature',
          ),
          headers: _headers,
          body: jsonEncode({'accepted': accepted}),
        )
        .timeout(const Duration(seconds: 20));

    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw ConnectException(_error(res, 'Could not confirm the signature'));
    }
  }

  /// Ask the reader to cancel. Connect returns 202 for anything well-formed and
  /// reports the real outcome as a notification, so this is best-effort by
  /// design — a false return means "could not ask", never "not cancelled".
  Future<bool> cancel(String requestId) async {
    try {
      final res = await _client
          .delete(
            _uri(
              '/pac/terminals/${terminalId!.trim()}/transactions/$requestId',
            ),
            headers: _headers,
          )
          .timeout(const Duration(seconds: 20));
      return res.statusCode >= 200 && res.statusCode < 300;
    } catch (_) {
      return false;
    }
  }

  /// Outcomes that mean the money is in, and the ones that mean it never will
  /// be. `VOID` is deliberately a failure: a voided sale took nothing.
  static const paidResults = {'SUCCESSFUL', 'APPROVED'};
  ///
  /// `TIMED_OUT` is in neither set on purpose. It is the one outcome where the
  /// money may or may not have moved, so it can be recorded as neither paid nor
  /// refused — it goes to [_afterTimeout] instead.
  static const failedResults = {
    'DECLINED',
    'VOID',
    'UNSUCCESSFUL',
    'CANCELLED',
  };

  @override
  Future<PaymentResult> take(
    int amountMinor, {
    String? orderId,
    bool manual = false,
  }) async {
    _abandoned = false;
    String? requestId;
    try {
      if (_preferSocket) {
        final overSocket = await _takeOverSocket(
          amountMinor,
          manual: manual,
        );
        if (overSocket != null) return overSocket;
        // Null means the socket could not be used at all. It never means the
        // payment failed — a payment that got as far as the reader resolves on
        // the socket or not at all, because retrying it over REST would ask the
        // customer for their card a second time.
      }

      requestId = await startTransaction(
        amountMinor,
        cardholderNotPresent: manual,
      );
      return await _follow(requestId, amountMinor);
    } on ConnectException catch (e) {
      return PaymentResult(
        approved: false,
        amountMinor: amountMinor,
        reference: requestId,
        message: e.message,
      );
    } catch (e) {
      // An errored card payment is NOT a payment. Never fall back to assuming
      // it worked — the till would record money it never took.
      return PaymentResult(
        approved: false,
        amountMinor: amountMinor,
        reference: requestId,
        message: '$e',
      );
    }
  }

  /// Run the sale over the live socket.
  ///
  /// Returns null when the socket could not be used *before the reader was
  /// asked for anything* — the caller may then safely fall back to REST.
  /// Anything after that point resolves here or not at all: re-running a
  /// transaction the reader has already started would ask the customer to
  /// present their card twice and risks taking the money twice.
  Future<PaymentResult?> _takeOverSocket(
    int amountMinor, {
    required bool manual,
  }) async {
    final tid = terminalId?.trim();
    final live = socket;
    if (live == null || tid == null || tid.isEmpty) return null;

    // Wire the callbacks through before connecting, so the very first prompt is
    // not missed while the socket is still opening.
    live.onProgress = (p) => onProgress?.call(p);
    live.onSignatureRequested = () async =>
        await (onSignatureRequested?.call() ?? Future.value(true));

    try {
      await live.connect();
    } catch (_) {
      _socketUnavailable = true;
      return null; // Nothing was asked of the reader; REST can take over.
    }

    try {
      final result = await live.performTransaction(
        tid: tid,
        amountMinor: amountMinor,
        method: 'sale',
        currency: currency,
        cardholderNotPresent: manual,
      );
      return _resultOf(result, amountMinor, reference: null);
    } on ConnectException catch (e) {
      // The reader was already engaged, so this is an outcome, not a reason to
      // try again down another pipe.
      return PaymentResult(
        approved: false,
        amountMinor: amountMinor,
        uncertainty: PaymentUncertainty.checkTerminal,
        message: e.message,
      );
    }
  }

  /// Read a finished transaction, whichever transport carried it. Shared so the
  /// socket and REST paths cannot drift into judging a payment differently.
  PaymentResult _resultOf(
    Map<String, dynamic> body,
    int amountMinor, {
    required String? reference,
  }) {
    final result = (body['transactionResult'] as String? ?? '').toUpperCase();
    final authCode = (body['authCode'] as String?)?.trim();

    if (paidResults.contains(result)) {
      return PaymentResult(
        approved: true,
        amountMinor: (body['amountBase'] as num?)?.toInt() ?? amountMinor,
        cashbackMinor: (body['amountCashback'] as num?)?.toInt() ?? 0,
        gratuityMinor: (body['amountGratuity'] as num?)?.toInt() ?? 0,
        reference: authCode?.isNotEmpty ?? false ? authCode : reference,
        message: body['userMessage'] as String?,
        receiptLines: _receiptText(body, 'CUSTOMER'),
      );
    }
    if (failedResults.contains(result)) {
      return PaymentResult(
        approved: false,
        amountMinor: amountMinor,
        reference: reference,
        message: body['userMessage'] as String? ??
            'Card payment ${result.toLowerCase().replaceAll('_', ' ')}',
      );
    }
    // Including TIMED_OUT and anything unrecognised: neither paid nor refused.
    return PaymentResult(
      approved: false,
      amountMinor: amountMinor,
      reference: reference,
      uncertainty: PaymentUncertainty.checkTerminal,
      message: body['userMessage'] as String? ??
          'The card machine did not give a final answer. Check it before '
              'retrying — the payment may still have gone through.',
    );
  }

  /// Poll a transaction to its conclusion, relaying prompts as they arrive.
  Future<PaymentResult> _follow(String requestId, int amountMinor) async {
    final deadline = DateTime.now().add(pollTimeout);
    var signatureAnswered = false;

    while (DateTime.now().isBefore(deadline)) {
      if (_abandoned) {
        await cancel(requestId);
        return PaymentResult(
          approved: false,
          amountMinor: amountMinor,
          reference: requestId,
          message:
              'Payment abandoned on the till. If the customer completed it, '
              'check the card machine before charging again.',
        );
      }

      final body = await fetchTransaction(requestId);
      final progress = _progressOf(body);
      if (progress != null) onProgress?.call(progress);

      // The reader is waiting on the clerk. Until this is answered the
      // transaction does not move, and Connect eventually auto-accepts.
      if (progress?.needsSignature == true && !signatureAnswered) {
        signatureAnswered = true;
        final accepted = await (onSignatureRequested?.call() ??
            Future.value(true));
        await answerSignature(requestId, accepted: accepted);
        if (!accepted) {
          return PaymentResult(
            approved: false,
            amountMinor: amountMinor,
            reference: requestId,
            message: 'Signature rejected',
          );
        }
      }

      final result = (body['transactionResult'] as String? ?? '').toUpperCase();
      if (paidResults.contains(result)) {
        return PaymentResult(
          approved: true,
          // `amountBase` is the sale; cashback and gratuity the customer added
          // at the reader are separate, and are reported separately so the till
          // can book them rather than silently absorb them into the sale.
          amountMinor: (body['amountBase'] as num?)?.toInt() ?? amountMinor,
          cashbackMinor: (body['amountCashback'] as num?)?.toInt() ?? 0,
          gratuityMinor: (body['amountGratuity'] as num?)?.toInt() ?? 0,
          // The auth code is what a chargeback is argued with; keep it over the
          // request id, which means nothing to the acquirer.
          reference: (body['authCode'] as String?)?.trim().isNotEmpty ?? false
              ? body['authCode'] as String
              : requestId,
          message: body['userMessage'] as String?,
          receiptLines: _receiptText(body, 'CUSTOMER'),
        );
      }
      // TIMED_OUT is deliberately NOT in this set: it is the one outcome where
      // the money may or may not have moved, and it is handled below.
      if (failedResults.contains(result)) {
        return PaymentResult(
          approved: false,
          amountMinor: amountMinor,
          reference: requestId,
          message:
              body['userMessage'] as String? ??
              'Card payment ${result.toLowerCase().replaceAll('_', ' ')}',
        );
      }
      if (result == 'TIMED_OUT') return _afterTimeout(requestId, amountMinor);

      await Future<void>.delayed(pollInterval);
    }

    // Out of time on the till's own clock, with the transaction unresolved.
    // Same problem, same handling.
    return _afterTimeout(requestId, amountMinor);
  }

  /// What to do when a transaction times out.
  ///
  /// The money may or may not have been taken, so this never reports paid or
  /// declined. Connect's checklist asks for the reader to be checked, because
  /// the right instruction to the clerk depends on what it says:
  ///
  ///  * **available** — the PDQ is fine, so the transaction itself is what is
  ///    in doubt. Pull the last transaction off it and see whether this sale
  ///    went through.
  ///  * **busy or gone** — the device is the problem, and no amount of checking
  ///    the transaction will help until it is back.
  Future<PaymentResult> _afterTimeout(String requestId, int amountMinor) async {
    ConnectTerminal? reader;
    try {
      final tid = terminalId?.trim();
      reader = (await listTerminals())
          .where((t) => t.tid == tid)
          .firstOrNull;
    } catch (_) {
      // Cannot reach the account at all — treat as unreachable, below.
    }

    if (reader != null && reader.available) {
      // Best effort: if the reader will tell us what it did last, say so. It
      // saves the clerk walking over to the device.
      String? last;
      try {
        final duplicate = await lastTransaction();
        final outcome = (duplicate['transactionResult'] as String?)?.toUpperCase();
        final total = (duplicate['amountTotal'] as num?)?.toInt();
        if (outcome != null) {
          last = ' Its last transaction reads $outcome'
              '${total == null ? '' : ' for ${(total / 100).toStringAsFixed(2)}'}.';
        }
      } catch (_) {
        // No duplicate available; the manual check below still stands.
      }

      return PaymentResult(
        approved: false,
        amountMinor: amountMinor,
        reference: requestId,
        uncertainty: PaymentUncertainty.checkTerminal,
        message:
            'Timed out, but the card machine is still available and the payment '
            'may have gone through.${last ?? ''} Check the machine before '
            'charging again, and record the sale by hand if it was taken.',
      );
    }

    return PaymentResult(
      approved: false,
      amountMinor: amountMinor,
      reference: requestId,
      uncertainty: PaymentUncertainty.terminalUnreachable,
      message:
          'The card machine is not responding, and this payment may or may not '
          'have been taken. Check that the PDQ is idle with nothing prompted on '
          'its screen, that its power and network cables are connected and that '
          'it is not in Standalone Mode. Restart it, and contact support if the '
          'problem persists.',
    );
  }

  /// Ask the reader to produce a report. Returns the id it is polled under.
  Future<String> startReport(String tid, String type) async {
    final res = await _client
        .post(
          _uri('/pac/terminals/$tid/reports'),
          headers: _headers,
          body: jsonEncode({'reportType': type}),
        )
        .timeout(const Duration(seconds: 30));

    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw ConnectException(_error(res, 'The card machine refused the report'));
    }
    final body = _decode(res.body);
    final id = body['requestId'] as String? ??
        body['id'] as String? ??
        res.headers['location']?.split('/').last;
    if (id == null || id.isEmpty) {
      throw ConnectException('The card machine did not return a report id.');
    }
    return id;
  }

  /// Read a running report.
  Future<Map<String, dynamic>> fetchReport(String tid, String requestId) async {
    final res = await _client
        .get(_uri('/pac/terminals/$tid/reports/$requestId'), headers: _headers)
        .timeout(const Duration(seconds: 20));

    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw ConnectException(_error(res, 'Could not read the report'));
    }
    return _decode(res.body);
  }

  /// A report's printable text. Shaped like a receipt, and read the same way.
  static List<String> reportText(Map<String, dynamic> body) {
    final receipts = body['receiptLines'];
    if (receipts is Map) {
      for (final copy in ['MERCHANT', 'CUSTOMER']) {
        final lines = _receiptText(body, copy);
        if (lines.isNotEmpty) return lines;
      }
    }
    final direct = body['reportLines'] ?? body['lines'];
    if (direct is List) {
      return [
        for (final line in direct)
          if (line is String)
            line
          else if (line is Map && line['text'] is String)
            line['text'] as String,
      ];
    }
    return const [];
  }

  /// The reader's most recent transaction — a duplicate, in Connect's terms.
  /// Used to work out what happened after a timeout.
  Future<Map<String, dynamic>> lastTransaction() async {
    final res = await _client
        .get(
          _uri('/pac/terminals/${terminalId!.trim()}/transactions/last'),
          headers: _headers,
        )
        .timeout(const Duration(seconds: 20));

    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw ConnectException(_error(res, 'No duplicate available'));
    }
    return _decode(res.body);
  }

  /// Pull the acquirer's own receipt text out of a result.
  ///
  /// Connect returns receipt lines as objects with formatting, not plain
  /// strings, and a card receipt has to carry the acquirer's wording as
  /// written — so the text is taken verbatim and only the layout is dropped.
  static List<String> _receiptText(Map<String, dynamic> body, String copy) {
    final receipts = body['receiptLines'];
    if (receipts is! Map) return const [];
    final lines = receipts[copy];
    if (lines is! List) return const [];
    return [
      for (final line in lines)
        if (line is String)
          line
        else if (line is Map && line['text'] is String)
          line['text'] as String,
    ];
  }

  /// The latest notification, whatever shape Connect wrapped it in. The REST
  /// interface has carried these as bare strings and as objects across API
  /// versions, and a till that only understood one would go silent on the
  /// other.
  ConnectProgress? _progressOf(Map<String, dynamic> body) {
    final message = (body['userMessage'] as String?)?.trim();
    final raw = body['notifications'] ?? body['notification'];

    String? value;
    if (raw is List && raw.isNotEmpty) {
      final last = raw.last;
      value = last is String
          ? last
          : last is Map
          ? last['notificationValue'] as String?
          : null;
    } else if (raw is String) {
      value = raw;
    }

    if (value == null && (message == null || message.isEmpty)) return null;
    return ConnectProgress(
      notification: (value ?? '').toUpperCase(),
      userMessage: message?.isEmpty ?? true ? null : message,
    );
  }

  static Map<String, dynamic> _decode(String body) {
    if (body.trim().isEmpty) return const {};
    final decoded = jsonDecode(body);
    return decoded is Map<String, dynamic> ? decoded : const {};
  }

  /// Connect puts a clerk-readable explanation in `userMessage` and validation
  /// detail in `messages.error`. Preferring those to the raw body is the
  /// difference between "That card has expired" and a wall of JSON.
  static String _error(http.Response res, String fallback) {
    try {
      final body = _decode(res.body);
      final user = (body['userMessage'] as String?)?.trim();
      if (user != null && user.isNotEmpty) return user;
      final errors = (body['messages'] as Map?)?['error'];
      if (errors is List && errors.isNotEmpty) return '${errors.first}';
    } catch (_) {
      // Fall through to the generic message below.
    }
    return '$fallback (${res.statusCode}).';
  }
}

/// The reports a Connect PDQ can produce.
///
/// End of day is the one that matters — it closes the reader's own banking day,
/// and on a PAC integration it can only be started from the till, so a venue
/// with no button for it cannot cash up at all. The balances are optional in
/// Connect's checklist but cost nothing to offer once the plumbing exists.
enum ConnectReport {
  endOfDay('END_OF_DAY', 'End of day'),
  banking('BANKING', 'Banking'),
  xBalance('X_BALANCE', 'X balance'),
  zBalance('Z_BALANCE', 'Z balance');

  const ConnectReport(this.wire, this.label);
  final String wire;
  final String label;
}

/// A finished PDQ report: the printable text, and whether it actually ran.
class ConnectReportResult {
  const ConnectReportResult({
    required this.report,
    required this.finished,
    this.lines = const [],
    this.message,
  });

  final ConnectReport report;
  final bool finished;
  final List<String> lines;
  final String? message;
}

extension ConnectReports on ConnectPacProvider {
  /// Run a report on the reader and wait for it.
  ///
  /// Reports behave like transactions: the POST starts one and the result is
  /// polled until the reader says it has finished. A report left unpolled is a
  /// report the venue never sees.
  Future<ConnectReportResult> runReport(
    ConnectReport report, {
    Duration timeout = const Duration(minutes: 2),
  }) async {
    final tid = terminalId?.trim();
    if (tid == null || tid.isEmpty) {
      return ConnectReportResult(
        report: report,
        finished: false,
        message: 'No card machine is set for this till.',
      );
    }

    try {
      // Over the socket a report is a single call that resolves when the reader
      // has finished, rather than a start-then-poll.
      final live = socket;
      if (live != null) {
        try {
          await live.connect();
          final body = await live.report(report, tid);
          final lines = ConnectPacProvider.reportText(body);
          return ConnectReportResult(
            report: report,
            finished: true,
            lines: lines,
            message: body['userMessage'] as String?,
          );
        } on ConnectException {
          rethrow;
        } catch (_) {
          // Socket unavailable; fall through to REST below.
        }
      }

      final requestId = await startReport(tid, report.wire);
      final deadline = DateTime.now().add(timeout);

      while (DateTime.now().isBefore(deadline)) {
        final body = await fetchReport(tid, requestId);
        final lines = ConnectPacProvider.reportText(body);

        // The reader signals completion with a notification rather than a
        // status field, exactly as transactions do.
        final notifications = (body['notifications'] as List?) ?? const [];
        final finished = notifications.any((n) {
          final value = n is String ? n : (n is Map ? n['notificationValue'] : null);
          return value == 'REPORT_FINISHED';
        });

        if (finished || lines.isNotEmpty) {
          return ConnectReportResult(
            report: report,
            finished: true,
            lines: lines,
            message: body['userMessage'] as String?,
          );
        }
        await Future<void>.delayed(pollInterval);
      }

      return ConnectReportResult(
        report: report,
        finished: false,
        message: 'The card machine did not finish the ${report.label} report '
            'in time. Check it before running another.',
      );
    } on ConnectException catch (e) {
      return ConnectReportResult(
        report: report,
        finished: false,
        message: e.message,
      );
    } catch (e) {
      return ConnectReportResult(
        report: report,
        finished: false,
        message: '$e',
      );
    }
  }
}

class ConnectException implements Exception {
  ConnectException(this.message);
  final String message;

  @override
  String toString() => message;
}
