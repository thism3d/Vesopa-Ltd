import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

/// What the till should do about a payment whose outcome is unknown.
///
/// A timed-out card transaction may or may not have taken the money, so it can
/// never be booked as either. Connect's integration checklist is specific about
/// what happens next, and it depends on whether the reader is still reachable —
/// which is a different instruction to the clerk in each case.
enum PaymentUncertainty {
  /// Not uncertain: the outcome is known.
  none,

  /// The reader is available. Ask the clerk to check the last transaction on
  /// the PDQ (or pull a duplicate) and record it if it went through.
  checkTerminal,

  /// The reader is busy or gone. Something is wrong with the device itself.
  terminalUnreachable,
}

/// Outcome of asking a payment method for money.
class PaymentResult {
  const PaymentResult({
    required this.approved,
    required this.amountMinor,
    this.reference,
    this.message,
    this.cashbackMinor = 0,
    this.gratuityMinor = 0,
    this.uncertainty = PaymentUncertainty.none,
    this.receiptLines = const [],
  });

  final bool approved;
  final int amountMinor;

  /// The acquirer's transaction reference, kept against the sale for
  /// reconciliation and refunds.
  final String? reference;
  final String? message;

  /// Cashback the customer took at the reader, on top of the sale.
  ///
  /// Added on the PDQ, not on the till, so the till only learns about it from
  /// the result — and it has to be recorded, or the drawer and the Z report
  /// disagree with the bank by exactly this much.
  final int cashbackMinor;

  /// Gratuity the customer added at the reader. Same reasoning: the till did
  /// not ask for it, so it must read it back off the transaction.
  final int gratuityMinor;

  /// Whether the till can trust this outcome at all.
  final PaymentUncertainty uncertainty;

  /// The acquirer's own receipt text, when it supplies one. A card receipt has
  /// to carry the acquirer's wording verbatim.
  final List<String> receiptLines;

  /// What the customer was actually charged: the sale, plus anything they added
  /// at the reader.
  int get chargedMinor => amountMinor + cashbackMinor + gratuityMinor;
}

/// A created Dojo payment intent.
///
/// Carries the three ways the card can then be presented:
///  * [clientSecret] — for the native Android drop-in SDK;
///  * [paymentLink] — Dojo's hosted checkout page, which is how a desktop till
///    with no card reader takes the card;
///  * the id itself — for the Terminal API, which pushes the payment to a
///    physical Dojo reader.
class DojoIntent {
  const DojoIntent({required this.id, this.clientSecret, this.paymentLink});
  final String id;
  final String? clientSecret;
  final String? paymentLink;
}

/// A card machine that can be sent a payment.
class DojoTerminal {
  const DojoTerminal({required this.id, required this.tid, required this.status});

  final String id;

  /// The number printed on the device, which is how staff tell two readers
  /// apart — the opaque `tm_…` id means nothing on the counter.
  final String tid;
  final String status;

  bool get available => status.toLowerCase() == 'available';

  factory DojoTerminal.fromJson(Map<String, dynamic> j) => DojoTerminal(
    id: j['id'] as String,
    tid: (j['properties'] as Map<String, dynamic>?)?['tid'] as String? ?? '',
    status: j['status'] as String? ?? '',
  );

  /// e.g. "VCMtestSIS0 (available)".
  String get label => tid.isEmpty ? id : tid;
}

/// A pay-at-counter session: one attempt to take a card on a reader.
class DojoSession {
  const DojoSession({
    required this.id,
    required this.status,
    this.lastNotification,
  });

  final String id;
  final String status;

  /// The most recent prompt from the reader — "PresentCard", "PleaseWait" —
  /// so the till can tell the clerk what the customer is being asked to do.
  final String? lastNotification;

  /// Money is in.
  ///
  /// Only `Captured` counts. `Authorized` is NOT included: on a signature sale
  /// the session passes through Authorized *before* the signature is verified,
  /// so treating it as paid books money that a rejected signature then
  /// declines.
  bool get captured => status.toLowerCase() == 'captured';

  /// The card was accepted but the sale is not finished — typically waiting on
  /// signature verification.
  bool get authorized => status.toLowerCase() == 'authorized';

  /// Will never complete.
  bool get failed => const {
    'declined',
    'expired',
    'canceled',
    'cancelled',
  }.contains(status.toLowerCase());

  /// The clerk must accept or reject the cardholder's signature before this
  /// session can finish.
  bool get needsSignature =>
      status.toLowerCase() == 'signatureverificationrequired';

  /// The reader's prompt, in words the clerk can act on. Observed in the
  /// sandbox: PresentCard → EnterPin → RemoveCard on a chip-and-PIN sale.
  String get prompt => switch (lastNotification) {
    'PresentCard' => 'Ask the customer to present their card',
    'EnterPin' => 'Customer is entering their PIN',
    'RemoveCard' => 'Ask the customer to remove their card',
    'PleaseWait' => 'Please wait…',
    _ when needsSignature => 'Check the signature',
    _ => 'Waiting for the card machine…',
  };

  factory DojoSession.fromJson(Map<String, dynamic> j) {
    final events = (j['notificationEvents'] as List?) ?? const [];
    return DojoSession(
      id: j['id'] as String,
      status: j['status'] as String? ?? '',
      lastNotification: events.isEmpty
          ? null
          : (events.last as Map<String, dynamic>)['notificationType'] as String?,
    );
  }
}

/// A way of taking money. Cash needs no device; card goes to the acquirer.
abstract class PaymentProvider {
  String get method;

  /// Take [amountMinor].
  ///
  /// [manual] asks for the **keyed** route rather than a presented card: the
  /// number is typed in instead of dipped or tapped. It is a mode of the same
  /// payment rather than a separate provider because every acquirer expresses
  /// it differently — Connect flags the transaction card-not-present so the PDQ
  /// opens its keypad, Dojo routes it to card-entry UI instead of the reader —
  /// and the till should not have to know which.
  Future<PaymentResult> take(
    int amountMinor, {
    String? orderId,
    bool manual = false,
  });
}

/// Cash. Always succeeds — the clerk has the money in their hand.
class CashProvider implements PaymentProvider {
  @override
  String get method => 'cash';

  @override
  Future<PaymentResult> take(
    int amountMinor, {
    String? orderId,
    bool manual = false,
  }) async {
    return PaymentResult(approved: true, amountMinor: amountMinor);
  }
}

/// Dojo card payments.
///
/// Verified against the sandbox: base URL, `Basic` auth, and the mandatory
/// `version` header are all confirmed working. Creating an intent returns
/// status `Created` — an intent is only a request for money, NOT a payment.
/// The card still has to be presented, after which the intent moves to
/// `Succeeded`/`Captured`. Treating `Created` as paid would book money that was
/// never taken, so [take] polls until the intent actually settles.
///
/// NOT covered here: sending the intent to a physical card terminal. That path
/// needs a `software-house-id` header, which Dojo issues to integration
/// partners on onboarding — the sandbox key alone is rejected with
/// "A software house ID header is required". Set [softwareHouseId] once Dojo
/// grant one and the terminal call below becomes live.
class DojoProvider implements PaymentProvider {
  DojoProvider({
    required this.apiKey,
    this.terminalId,
    this.softwareHouseId,
    this.resellerId,
    this.baseUrl = 'https://api.dojo.tech',
    // The terminal endpoints (/terminals, /terminal-sessions) were added in
    // this API version; the older 2024-01-01 does not serve them.
    this.apiVersion = '2024-02-05',
    this.pollTimeout = const Duration(minutes: 2),
    http.Client? client,
  }) : _client = client ?? http.Client();

  final String apiKey;

  /// The physical card machine. Null means card-not-present.
  final String? terminalId;

  /// Partner credentials required by Dojo's terminal endpoints. BOTH are
  /// needed — a missing reseller-id fails the call just as a missing
  /// software-house-id does.
  final String? softwareHouseId;
  final String? resellerId;

  final String baseUrl;
  final String apiVersion;
  final Duration pollTimeout;
  final http.Client _client;

  @override
  String get method => 'card';

  Map<String, String> get _headers => {
        // Dojo uses Basic auth with the raw key — NOT Bearer, and NOT
        // base64-encoded. Bearer is rejected with 401.
        'Authorization': 'Basic $apiKey',
        'version': apiVersion,
        'Content-Type': 'application/json',
      };

  /// Create the intent.
  ///
  /// The request body uses PascalCase `Amount`/`Value`/`CurrencyCode`: the Dojo
  /// API rejects `{"amount": …}` with "The Amount field is required." Verified
  /// against the sandbox — this shape returns a `pi_sandbox_…` intent.
  ///
  /// [withClientSecret] fetches the drop-in's client session secret as well.
  /// Creating an intent does **not** return one: the response carries a zeroed
  /// `clientSessionSecretExpirationDate` and no secret at all, and it has to be
  /// asked for separately ([refreshClientSecret]). Only the native card-entry
  /// path needs it, so the terminal route does not pay for the extra round trip.
  ///
  /// [cardHolderNotPresent] marks the payment as keyed rather than presented.
  /// It carries different interchange and different liability, so a manual card
  /// must be flagged as one rather than passed off as a dipped card.
  ///
  /// Dojo ignores `Idempotency-Key` — posting the same body twice creates two
  /// distinct intents. The caller must therefore hold onto the id it gets back
  /// and reuse it on retry, or a flaky connection will charge the customer
  /// twice. That is why this is separate from [confirm].
  Future<DojoIntent> createIntent(
    int amountMinor, {
    String? orderId,
    bool withClientSecret = false,
    bool cardHolderNotPresent = false,
  }) async {
    final res = await _client
        .post(
          Uri.parse('$baseUrl/payment-intents'),
          headers: _headers,
          body: jsonEncode({
            'Amount': {'Value': amountMinor, 'CurrencyCode': 'GBP'},
            'Reference': orderId ?? 'vesopa',
            'CaptureMode': 'Auto',
            if (cardHolderNotPresent) 'CardHolderNotPresent': true,
          }),
        )
        .timeout(const Duration(seconds: 30));

    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw DojoException('Could not start payment: ${res.body}');
    }

    final json = jsonDecode(res.body) as Map<String, dynamic>;
    final intent = DojoIntent(
      id: json['id'] as String,
      clientSecret: json['clientSessionSecret'] as String?,
      // Hosted checkout for this intent — what the desktop till opens when it
      // has no card reader attached.
      paymentLink: json['paymentLink'] as String?,
    );

    if (!withClientSecret || intent.clientSecret != null) return intent;
    return DojoIntent(
      id: intent.id,
      clientSecret: await refreshClientSecret(intent.id),
      paymentLink: intent.paymentLink,
    );
  }

  /// Mint a client session secret for an existing intent.
  ///
  /// This is the step the drop-in SDK cannot work without, and it is a separate
  /// call by design — the secret is short-lived (30 minutes) and is handed to
  /// the customer's device, unlike the API key. Verified against the sandbox:
  /// creating an intent yields no secret; this returns one.
  Future<String?> refreshClientSecret(String intentId) async {
    final res = await _client
        .post(
          Uri.parse('$baseUrl/payment-intents/$intentId/refresh-client-session-secret'),
          headers: _headers,
        )
        .timeout(const Duration(seconds: 30));

    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw DojoException(
        'Could not start card entry for this payment: ${res.body}',
      );
    }
    final json = jsonDecode(res.body) as Map<String, dynamic>;
    return json['clientSessionSecret'] as String?;
  }

  /// Read an intent's current state.
  Future<Map<String, dynamic>> fetchIntent(String intentId) async {
    final res = await _client
        .get(Uri.parse('$baseUrl/payment-intents/$intentId'),
            headers: _headers)
        .timeout(const Duration(seconds: 20));

    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw DojoException('Could not read payment: ${res.body}');
    }
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  /// Headers for the terminal endpoints.
  ///
  /// These need the two partner ids on top of the usual auth. Both are
  /// mandatory: with the software-house id alone Dojo answers 401, which is
  /// what made the terminal route look unavailable.
  Map<String, String> get _terminalHeaders => {
    ..._headers,
    'Accept': 'application/json',
    // Null-aware map entries: the header is omitted entirely when the id is
    // not configured, rather than sent empty.
    'software-house-id': ?softwareHouseId,
    'reseller-id': ?resellerId,
  };

  /// The card machines this account can send a payment to.
  Future<List<DojoTerminal>> listTerminals({String status = 'Available'}) async {
    final res = await _client
        .get(
          Uri.parse('$baseUrl/terminals?statuses=$status'),
          headers: _terminalHeaders,
        )
        .timeout(const Duration(seconds: 20));

    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw DojoException('Could not list card machines: ${res.body}');
    }
    return (jsonDecode(res.body) as List)
        .map((t) => DojoTerminal.fromJson(t as Map<String, dynamic>))
        .toList();
  }

  /// Ask the card machine to take the payment.
  ///
  /// Returns the terminal *session* id: the payment is then tracked through
  /// that session, not through the intent, until it captures.
  Future<String> startTerminalSession(String intentId) async {
    if (terminalId == null || softwareHouseId == null || resellerId == null) {
      throw DojoException(
        'Card machine not configured. A terminal id, software-house-id and '
        'reseller-id are all required for pay-at-counter.',
      );
    }

    final res = await _client
        .post(
          Uri.parse('$baseUrl/terminal-sessions'),
          headers: _terminalHeaders,
          body: jsonEncode({
            'terminalId': terminalId,
            'details': {
              'sessionType': 'Sale',
              'sale': {'paymentIntentId': intentId},
            },
          }),
        )
        .timeout(const Duration(seconds: 30));

    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw DojoException('The card machine refused the payment: ${res.body}');
    }
    return (jsonDecode(res.body) as Map<String, dynamic>)['id'] as String;
  }

  /// Read a terminal session: its status, and any prompt the clerk should act
  /// on ("present card", "please wait").
  Future<DojoSession> fetchSession(String sessionId) async {
    final res = await _client
        .get(
          Uri.parse('$baseUrl/terminal-sessions/$sessionId'),
          headers: _terminalHeaders,
        )
        .timeout(const Duration(seconds: 20));

    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw DojoException('Could not read the card machine: ${res.body}');
    }
    return DojoSession.fromJson(jsonDecode(res.body) as Map<String, dynamic>);
  }

  /// Accept or reject the cardholder's signature, when the terminal asks for
  /// one. Until this is answered the session sits unresolved.
  Future<void> answerSignature(String sessionId, {required bool accepted}) async {
    final res = await _client
        .put(
          Uri.parse('$baseUrl/terminal-sessions/$sessionId/signature'),
          headers: _terminalHeaders,
          body: jsonEncode({'accepted': accepted}),
        )
        .timeout(const Duration(seconds: 20));

    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw DojoException('Could not confirm the signature: ${res.body}');
    }
  }

  /// Cancel a session. Dojo only honours this before a card is presented, so a
  /// failure here is expected and is reported to the caller rather than thrown.
  Future<bool> cancelSession(String sessionId) async {
    try {
      final res = await _client
          .put(
            Uri.parse('$baseUrl/terminal-sessions/$sessionId/cancel'),
            headers: _terminalHeaders,
          )
          .timeout(const Duration(seconds: 20));
      return res.statusCode >= 200 && res.statusCode < 300;
    } catch (_) {
      return false;
    }
  }

  /// Intent statuses that mean the money is in, and the ones that mean it will
  /// never arrive. Public so every provider judges an intent the same way —
  /// two copies of this would eventually disagree about what counts as paid.
  static const paidStatuses = {'succeeded', 'captured'};
  static const failedStatuses = {'failed', 'cancelled', 'canceled', 'expired'};

  static const _paid = paidStatuses;
  static const _failed = failedStatuses;

  /// Wait for the customer to present their card.
  Future<PaymentResult> confirm(String intentId, int amountMinor) async {
    final deadline = DateTime.now().add(pollTimeout);

    while (DateTime.now().isBefore(deadline)) {
      final intent = await fetchIntent(intentId);
      final status = (intent['status'] as String? ?? '').toLowerCase();

      if (_paid.contains(status)) {
        return PaymentResult(
          approved: true,
          amountMinor: amountMinor,
          reference: intentId,
          message: status,
        );
      }
      if (_failed.contains(status)) {
        return PaymentResult(
          approved: false,
          amountMinor: amountMinor,
          reference: intentId,
          message: 'Card payment $status',
        );
      }

      await Future<void>.delayed(const Duration(seconds: 2));
    }

    // Timed out with the intent still open. This is NOT a decline — the money
    // may yet be taken — so it must never be recorded as either paid or
    // refused. The clerk has to check the terminal.
    return PaymentResult(
      approved: false,
      amountMinor: amountMinor,
      reference: intentId,
      message: 'Timed out waiting for the card. Check the terminal before '
          'retrying — the payment may still have gone through.',
    );
  }

  /// Called while a terminal payment is running, with the reader's latest
  /// prompt ("PresentCard", "PleaseWait") so the till can show the clerk what
  /// the customer is being asked to do.
  void Function(DojoSession session)? onTerminalUpdate;

  /// Asked when the reader wants the cardholder's signature checked. Returning
  /// true accepts it. Defaults to accepting: the sandbox always asks, and a
  /// session left unanswered never completes.
  Future<bool> Function()? onSignatureRequested;

  /// Follow a terminal session to its conclusion.
  ///
  /// Verified against the sandbox, where a session runs
  /// `InitiateRequested → SignatureVerificationRequired → Captured`. The
  /// signature step is not optional — the session stalls there until answered.
  Future<PaymentResult> awaitTerminal(
    String sessionId,
    String intentId,
    int amountMinor,
  ) async {
    final deadline = DateTime.now().add(pollTimeout);
    var signatureAnswered = false;

    while (DateTime.now().isBefore(deadline)) {
      final session = await fetchSession(sessionId);
      onTerminalUpdate?.call(session);

      if (session.captured) {
        return PaymentResult(
          approved: true,
          amountMinor: amountMinor,
          reference: intentId,
          message: session.status,
        );
      }
      if (session.failed) {
        return PaymentResult(
          approved: false,
          amountMinor: amountMinor,
          reference: intentId,
          message: 'Card payment ${session.status.toLowerCase()}',
        );
      }
      if (session.needsSignature && !signatureAnswered) {
        signatureAnswered = true;
        final accepted = await (onSignatureRequested?.call() ?? Future.value(true));
        await answerSignature(sessionId, accepted: accepted);
        if (!accepted) {
          return PaymentResult(
            approved: false,
            amountMinor: amountMinor,
            reference: intentId,
            message: 'Signature rejected',
          );
        }
      }

      await Future<void>.delayed(const Duration(seconds: 2));
    }

    // Out of time with the session unresolved. The card may still be mid-flight
    // on the reader, so this is "unknown", never a decline.
    return PaymentResult(
      approved: false,
      amountMinor: amountMinor,
      reference: intentId,
      message: 'Timed out at the card machine. Check it before retrying — the '
          'payment may still have gone through.',
    );
  }

  /// Whether this till has everything it needs to send a payment to a reader.
  bool get canUseTerminal =>
      (terminalId?.isNotEmpty ?? false) &&
      (softwareHouseId?.isNotEmpty ?? false) &&
      (resellerId?.isNotEmpty ?? false);

  @override
  Future<PaymentResult> take(
    int amountMinor, {
    String? orderId,
    bool manual = false,
  }) async {
    try {
      final intent = await createIntent(amountMinor, orderId: orderId);

      // With a reader configured the payment is driven through a terminal
      // session; polling the intent alone would wait forever, because nothing
      // would ever present the card.
      //
      // A keyed card deliberately skips the reader even on a till that has
      // one: a card machine can only take a card that is physically there, and
      // "manual" exists precisely for a chip that will not read or a customer
      // on the telephone.
      if (canUseTerminal && !manual) {
        final sessionId = await startTerminalSession(intent.id);
        return awaitTerminal(sessionId, intent.id, amountMinor);
      }

      return confirm(intent.id, amountMinor);
    } catch (e) {
      // An errored card payment is NOT a payment. Never fall back to assuming
      // it worked — the till would record money it never took.
      return PaymentResult(
        approved: false,
        amountMinor: amountMinor,
        message: '$e',
      );
    }
  }
}

class DojoException implements Exception {
  DojoException(this.message);
  final String message;

  @override
  String toString() => message;
}
