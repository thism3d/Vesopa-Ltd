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

/// What became of a card payment, in the words the till shows for it.
///
/// Dojo's accreditation tests each of these as its own scenario, and each needs
/// a different screen: a decline is final, a busy machine is worth another go,
/// and an expired session might still have taken the money.
enum CardOutcome {
  approved('Payment approved'),
  declined('Payment declined'),
  cancelled('Payment cancelled'),
  signatureRejected('Signature rejected'),
  busy('Card machine busy'),
  expired('Result not confirmed'),
  unknown('Result not confirmed'),
  failed('Payment failed');

  const CardOutcome(this.title);
  final String title;

  /// Outcomes where the money might still have been taken.
  bool get uncertain => this == expired || this == unknown;
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
    this.outcome,
    this.sessionId,
    this.acquirerStatus,
    this.authCode,
    this.cardLast4,
    this.cardType,
  });

  /// Set by the Dojo providers. Left null by the others, which [kind] then
  /// works out from [approved] and [uncertainty].
  final CardOutcome? outcome;

  /// The Dojo terminal session the payment ran on, for the log and support.
  final String? sessionId;

  /// The acquirer's own status word: Captured, Declined, Expired…
  final String? acquirerStatus;

  /// From the card machine, when it says: printed on the receipt and the log.
  final String? authCode;
  final String? cardLast4;
  final String? cardType;

  CardOutcome get kind =>
      outcome ??
      (approved
          ? CardOutcome.approved
          : uncertainty != PaymentUncertainty.none
          ? CardOutcome.unknown
          : CardOutcome.declined);

  PaymentResult copyWith({
    bool? approved,
    String? message,
    CardOutcome? outcome,
    PaymentUncertainty? uncertainty,
    String? acquirerStatus,
  }) => PaymentResult(
    approved: approved ?? this.approved,
    amountMinor: amountMinor,
    reference: reference,
    message: message ?? this.message,
    cashbackMinor: cashbackMinor,
    gratuityMinor: gratuityMinor,
    uncertainty: uncertainty ?? this.uncertainty,
    receiptLines: receiptLines,
    outcome: outcome ?? this.outcome,
    sessionId: sessionId,
    acquirerStatus: acquirerStatus ?? this.acquirerStatus,
    authCode: authCode,
    cardLast4: cardLast4,
    cardType: cardType,
  );

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
    this.receiptLines = const [],
    this.authCode,
    this.cardLast4,
    this.cardType,
  });

  final String id;
  final String status;

  /// The card machine's own slip text, which Dojo return on a finished session.
  final List<String> receiptLines;
  final String? authCode;
  final String? cardLast4;
  final String? cardType;

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
    // Newest by Dojo's own timestamp, not by list position. Each event carries
    // a `createdAt`; ordering by it means a list that ever arrives out of
    // order cannot put an old "Present card" back on the screen.
    final events = [
      for (final e in (j['notificationEvents'] as List?) ?? const [])
        if (e is Map<String, dynamic>) e,
    ];
    events.sort(
      (a, b) => '${a['createdAt'] ?? ''}'.compareTo('${b['createdAt'] ?? ''}'),
    );
    final details = j['paymentDetails'] as Map<String, dynamic>?;
    final card = details?['card'] as Map<String, dynamic>?;
    final pan = (card?['last4PAN'] ?? card?['cardNumber'] ?? '') as String;
    return DojoSession(
      id: j['id'] as String,
      status: j['status'] as String? ?? '',
      lastNotification: events.isEmpty
          ? null
          : events.last['notificationType'] as String?,
      receiptLines: receiptText(j['receipt']),
      authCode: details?['authCode'] as String?,
      cardLast4: pan.length >= 4 ? pan.substring(pan.length - 4) : null,
      cardType: card?['cardType'] as String?,
    );
  }

  /// Dojo's receipt is a list of typed lines; only the text ones print.
  static List<String> receiptText(Object? receipt) {
    if (receipt is! Map) return const [];
    return [
      for (final l in (receipt['lines'] as List?) ?? const [])
        if (l is Map && l['text'] is Map)
          '${(l['text'] as Map)['value'] ?? ''}'.trimRight(),
    ];
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

/// One line of the basket, as the card machine and the Dojo receipt show it.
///
/// Deliberately not the till's own order-line type. That one carries tax rates,
/// promotion ids, kitchen notes and who rang it up — none of which the acquirer
/// has any business holding, and some of which is arguably personal data once
/// it is sitting on someone else's server. This is the subset that makes an
/// itemised bill legible and nothing more.
class DojoItemLine {
  const DojoItemLine({
    required this.name,
    required this.quantity,
    required this.totalMinor,
    this.plu,
    this.modifiers = const [],
  });

  final String name;
  final int quantity;

  /// The line total in pence, before discounts and tax — Dojo's `amountTotal`.
  final int totalMinor;

  /// The till's own product code, so a line on a Dojo receipt can be traced
  /// back to a button on the sale screen.
  final String? plu;

  /// What was done to the item: "Oat milk", "No ice". Dojo display these under
  /// the line, and the checklist asks specifically that discounts appear here
  /// as modifiers rather than silently shrinking the total.
  final List<DojoModifier> modifiers;

  Map<String, dynamic> toJson() => {
    'name': name,
    'quantity': quantity,
    'amountTotal': {'value': totalMinor, 'currencyCode': 'GBP'},
    if (plu != null && plu!.isNotEmpty) 'plu': plu,
    if (modifiers.isNotEmpty)
      'modifiers': [for (final m in modifiers) m.toJson()],
  };
}

/// A modifier on an item line: an extra, or a discount.
///
/// [amountMinor] is negative for a discount, which is how the checklist expects
/// a promotion to appear — visible as its own line on the bill rather than
/// silently shrinking the item's price. Dojo require all four fields; a
/// modifier missing [id] or [quantity] fails the whole intent with a 400.
///
/// The amount is *excluded* from the parent line's `amountTotal`, per Dojo's
/// schema — a modifier is added to the line, not already inside it.
class DojoModifier {
  const DojoModifier({
    required this.id,
    required this.name,
    required this.amountMinor,
    this.quantity = 1,
  });

  /// Machine-readable id — the till's own option or promotion code.
  final String id;
  final String name;
  final int amountMinor;

  /// How many times this modifier applies to a *single* item. Two burgers each
  /// with double cheese is a quantity of 2, not 4.
  final int quantity;

  Map<String, dynamic> toJson() => {
    'id': id,
    'name': name,
    'quantity': quantity,
    'amountPerModifier': {'value': amountMinor, 'currencyCode': 'GBP'},
  };
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
    // Long enough for a signature checked after 80 seconds and a slow
    // customer: Dojo end the session themselves (Expired) well inside this,
    // so it is a backstop for a reader that stops answering altogether.
    this.pollTimeout = const Duration(minutes: 6),
    this.pollInterval = const Duration(seconds: 1),
    http.Client? client,
  }) : _client = client ?? http.Client();

  /// Dojo's sheet asks for one read per second while a terminal session runs.
  final Duration pollInterval;

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

  /// Every request carries the partner ids, not only the terminal ones.
  ///
  /// Dojo's accreditation sheet failed "Identifying Headers" because the
  /// software house id was null on the payment intent and terminal session
  /// requests: their logs identify the integrator by these headers on every
  /// call, whichever endpoint it is.
  Map<String, String> get _headers => {
        // Dojo uses Basic auth with the raw key — NOT Bearer, and NOT
        // base64-encoded. Bearer is rejected with 401.
        'Authorization': 'Basic $apiKey',
        'version': apiVersion,
        'Content-Type': 'application/json',
        'software-house-id': ?softwareHouseId,
        'reseller-id': ?resellerId,
      };

  /// What the headers actually carry, for the payment screen and the log.
  String get partnerLabel =>
      'Software house ${softwareHouseId ?? '—'} · Reseller ${resellerId ?? '—'}';

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
  /// [itemLines] puts the basket on the card machine's screen and on the
  /// customer's Dojo receipt, which is what lets a PDQ print an itemised bill
  /// rather than just a total.
  ///
  /// [preAuth] switches the intent to `Manual` capture: the card is authorised
  /// now and the money taken later with [capture]. Dojo make `autoExpireIn` and
  /// `autoExpireAction` mandatory in that mode — an authorisation that is never
  /// captured has to resolve itself one way or the other — and reject anything
  /// under 30 seconds or over 7 days, so [preAuthExpiry] is clamped to that.
  Future<DojoIntent> createIntent(
    int amountMinor, {
    String? orderId,
    bool withClientSecret = false,
    bool cardHolderNotPresent = false,
    List<DojoItemLine> itemLines = const [],
    bool preAuth = false,
    Duration preAuthExpiry = const Duration(days: 6),
    int tipsMinor = 0,
    int cashbackMinor = 0,
    int serviceChargeMinor = 0,
  }) async {
    final res = await _client
        .post(
          Uri.parse('$baseUrl/payment-intents'),
          headers: _headers,
          body: jsonEncode({
            'Amount': {'Value': amountMinor, 'CurrencyCode': 'GBP'},
            'Reference': orderId ?? 'vesopa',
            'CaptureMode': preAuth ? 'Manual' : 'Auto',
            // Tip, cashback and service charge all belong on the intent at
            // creation, not on a later call: this account rejects the
            // /tips-amount endpoint outright (405, "Tips are not allowed on
            // payment intent"), and each of these adds to `totalAmount` — the
            // figure the card machine actually asks the customer to approve.
            if (tipsMinor > 0)
              'tipsAmount': {'value': tipsMinor, 'currencyCode': 'GBP'},
            if (cashbackMinor > 0)
              'cashbackAmount': {'value': cashbackMinor, 'currencyCode': 'GBP'},
            if (serviceChargeMinor > 0)
              'serviceChargeAmount': {
                'value': serviceChargeMinor,
                'currencyCode': 'GBP',
              },
            if (preAuth) ...{
              'autoExpireIn': _dojoTimeSpan(preAuthExpiry),
              // Release, not Capture: an authorisation nobody came back for
              // should let the customer's money go, not help itself to it.
              'autoExpireAction': 'Release',
            },
            if (cardHolderNotPresent) 'CardHolderNotPresent': true,
            if (itemLines.isNotEmpty)
              'itemLines': [for (final l in itemLines) l.toJson()],
          }),
        )
        .timeout(const Duration(seconds: 30));

    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw _exception(res, 'Could not start the payment');
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
      throw _exception(res, 'Could not read the payment');
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
  Future<List<DojoTerminal>> listTerminals({String? status = 'Available'}) async {
    final res = await _client
        .get(
          Uri.parse(
            status == null ? '$baseUrl/terminals' : '$baseUrl/terminals?statuses=$status',
          ),
          headers: _terminalHeaders,
        )
        .timeout(const Duration(seconds: 20));

    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw _exception(res, 'Could not list the card machines');
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
      throw _exception(res, 'The card machine refused the payment');
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
      throw _exception(res, 'Could not read the card machine');
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
      throw _exception(res, 'Could not confirm the signature');
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

  // ---- Refunds ------------------------------------------------------------
  //
  // Dojo mandate that at least one refund route works before they will
  // accredit an integration. There are two, and they are not interchangeable:
  //
  //   * [refundToCard] puts the money back on the original card without anyone
  //     re-presenting it. This is the one a manager wants for "they phoned up
  //     about last Tuesday".
  //   * [startRefundSession] sends a refund to the PDQ, with (matched) or
  //     without (unlinked) a reference to the original sale. The customer and
  //     their card have to be standing there.
  //
  // Both are implemented, because they fail in different circumstances: a card
  // refund needs a settled transaction to reverse, and an unlinked refund
  // needs nothing at all — which is exactly why it is the one that needs a
  // manager's authority behind it in the UI.

  /// Refund an already-captured payment back to the original card.
  ///
  /// [amountMinor] may be less than the original for a partial refund, in
  /// which case the intent stays `Captured` and carries a `refundedAmount`
  /// rather than moving to `Refunded`.
  ///
  /// Dojo require an `idempotencyKey` header here — unusually, since they
  /// ignore idempotency on intent creation. Without one the call is a 400. The
  /// caller passes it so a retry after a dropped connection reuses the same key
  /// and cannot refund twice; a fresh key per attempt would defeat the point.
  Future<String> refundToCard(
    String intentId, {
    required int amountMinor,
    required String idempotencyKey,
    String? reason,
  }) async {
    final res = await _client
        .post(
          Uri.parse('$baseUrl/payment-intents/$intentId/refunds'),
          headers: {..._terminalHeaders, 'idempotencyKey': idempotencyKey},
          body: jsonEncode({
            'amount': amountMinor,
            if (reason != null && reason.trim().isNotEmpty) 'refundReason': reason,
          }),
        )
        .timeout(const Duration(seconds: 30));

    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw _exception(res, 'The refund was not accepted');
    }
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    return (body['refundId'] ?? body['id'] ?? '') as String;
  }

  /// Send a refund to the card machine.
  ///
  /// With [intentId] this is a *matched* refund: Dojo ties it to the original
  /// sale and will not give back more than was taken. Without one it is an
  /// *unlinked* refund, which has no such protection — it will return any
  /// amount to any card — so the caller is responsible for putting a manager
  /// behind it.
  ///
  /// Returns the session id, polled through [fetchSession] exactly as a sale is.
  Future<String> startRefundSession({
    required int amountMinor,
    String? intentId,
  }) async {
    if (terminalId == null || softwareHouseId == null || resellerId == null) {
      throw DojoException(
        'Card machine not configured. A terminal id, software-house-id and '
        'reseller-id are all required to refund at the counter.',
      );
    }

    final matched = intentId != null && intentId.isNotEmpty;
    final res = await _client
        .post(
          Uri.parse('$baseUrl/terminal-sessions'),
          headers: _terminalHeaders,
          body: jsonEncode({
            'terminalId': terminalId,
            'details': matched
                ? {
                    'sessionType': 'MatchedRefund',
                    'matchedRefund': {'paymentIntentId': intentId},
                  }
                : {
                    'sessionType': 'UnlinkedRefund',
                    'unlinkedRefund': {
                      'amount': {'value': amountMinor, 'currencyCode': 'GBP'},
                    },
                  },
          }),
        )
        .timeout(const Duration(seconds: 30));

    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw _exception(res, 'The card machine refused the refund');
    }
    return (jsonDecode(res.body) as Map<String, dynamic>)['id'] as String;
  }

  // ---- Intent management --------------------------------------------------

  /// Change the amount on an intent that has not been authorised yet, or
  /// increase a pre-authorised one.
  ///
  /// Dojo reject zero outright, and reject any change to an intent that has
  /// already captured. Both are surfaced rather than swallowed: the checklist
  /// tests that the till explains *why* rather than showing a generic failure.
  Future<void> setAmount(String intentId, int amountMinor) async {
    if (amountMinor <= 0) {
      throw DojoException('A payment has to be for more than nothing.');
    }
    final res = await _client
        .post(
          Uri.parse('$baseUrl/payment-intents/$intentId/amount'),
          headers: _terminalHeaders,
          body: jsonEncode({
            'amount': {'value': amountMinor, 'currencyCode': 'GBP'},
          }),
        )
        .timeout(const Duration(seconds: 20));

    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw _exception(res, 'Could not change the amount');
    }
  }

  /// Record the gratuity against the intent, so it lands on the acquirer's
  /// side of the books and not only on ours.
  Future<void> setTips(String intentId, int tipsMinor) async {
    final res = await _client
        .post(
          Uri.parse('$baseUrl/payment-intents/$intentId/tips-amount'),
          headers: _terminalHeaders,
          body: jsonEncode({
            'tipsAmount': {'value': tipsMinor, 'currencyCode': 'GBP'},
          }),
        )
        .timeout(const Duration(seconds: 20));

    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw _exception(res, 'Could not record the gratuity');
    }
  }

  /// Take the money on a pre-authorised (`Manual` capture) intent.
  ///
  /// [amountMinor] may be less than was authorised, and Dojo allow several
  /// partial captures against one authorisation.
  ///
  /// Note the shape: `amount` here is a bare integer of minor units, not the
  /// `{value, currencyCode}` object every other endpoint takes. Sending the
  /// object fails with a deserialisation error, not a helpful message.
  Future<void> capture(
    String intentId,
    int amountMinor, {
    int tipsMinor = 0,
  }) async {
    final res = await _client
        .post(
          Uri.parse('$baseUrl/payment-intents/$intentId/captures'),
          headers: {
            ..._terminalHeaders,
            'idempotencyKey': 'capture-$intentId',
          },
          body: jsonEncode({
            'amount': amountMinor,
            if (tipsMinor > 0) 'tipsAmount': tipsMinor,
          }),
        )
        .timeout(const Duration(seconds: 30));

    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw _exception(res, 'Could not capture the payment');
    }
  }

  /// Abandon an intent that was never authorised, so it does not sit open
  /// against the account.
  ///
  /// Returns false rather than throwing when Dojo refuse: an intent that has
  /// already been paid cannot be cancelled, and that is not an error worth
  /// interrupting the clerk over.
  Future<bool> cancelIntent(String intentId) async {
    try {
      final res = await _client
          .delete(
            Uri.parse('$baseUrl/payment-intents/$intentId'),
            headers: _terminalHeaders,
          )
          .timeout(const Duration(seconds: 20));
      return res.statusCode >= 200 && res.statusCode < 300;
    } catch (_) {
      return false;
    }
  }

  /// Format a duration the way .NET parses a `TimeSpan`: `d.hh:mm:ss`.
  ///
  /// Dojo's API is .NET underneath and `autoExpireIn` is a TimeSpan, so an ISO
  /// 8601 duration ("P6D") is rejected. Clamped to the documented window —
  /// longer than 30 seconds, shorter than 7 days — because both ends are a 400
  /// and neither is worth discovering at the counter.
  static String _dojoTimeSpan(Duration d) {
    const min = Duration(seconds: 31);
    const max = Duration(days: 6, hours: 23);
    final clamped = d < min ? min : (d > max ? max : d);
    final hh = clamped.inHours.remainder(24).toString().padLeft(2, '0');
    final mm = clamped.inMinutes.remainder(60).toString().padLeft(2, '0');
    final ss = clamped.inSeconds.remainder(60).toString().padLeft(2, '0');
    return '${clamped.inDays}.$hh:$mm:$ss';
  }

  /// Turn a failed response into an exception the till can act on.
  ///
  /// Dojo use at least three error shapes: `{Detail}` on the payment-intent
  /// endpoints, `{detail, title}` on the terminal ones, and
  /// `{errors: {field: [...]}}` for validation. All three are tried, in the
  /// order that yields the most specific sentence, before falling back.
  DojoException _exception(http.Response res, String fallback) {
    String? detail;
    String? trace;
    try {
      final body = jsonDecode(res.body);
      if (body is Map<String, dynamic>) {
        trace = body['traceId'] as String?;
        detail = (body['Detail'] ?? body['detail'] ?? body['title']) as String?;
        if (detail == null || detail.trim().isEmpty) {
          final errors = body['errors'];
          if (errors is Map && errors.isNotEmpty) {
            final first = errors.values.first;
            if (first is List && first.isNotEmpty) detail = '${first.first}';
          }
        }
      }
    } catch (_) {
      // A non-JSON body (an empty 401, an HTML gateway page) is not worth
      // reporting verbatim to someone serving a customer.
    }
    final message = (detail != null && detail.trim().isNotEmpty)
        ? detail.trim()
        : fallback;
    return DojoException(message, statusCode: res.statusCode, traceId: trace);
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

  /// Told what happened to a cancel the clerk asked for: true once Dojo has
  /// accepted it, false when the machine refused (the card was already in),
  /// with Dojo's reason.
  void Function(bool accepted, String message)? onCancelAnswered;

  // ---- Cancelling from the till -------------------------------------------

  bool _cancelRequested = false;
  bool _abandoned = false;

  /// Ask Dojo to cancel the running sale on the card machine.
  ///
  /// Dojo's "Cancel transaction from POS" scenario. Only a request: Dojo
  /// cancel it if the card has not gone in yet, and refuse with a 422 when it
  /// has, in which case the sale carries on and its real result still comes
  /// back. [awaitTerminal] sends it on its next poll.
  void requestCancel() => _cancelRequested = true;

  /// Stop waiting for the machine altogether.
  ///
  /// For a machine that has stopped answering. The payment is reported as not
  /// confirmed (never as declined), so the till offers to check its status
  /// with Dojo before anyone charges the card again.
  void abandon() {
    _cancelRequested = true;
    _abandoned = true;
  }

  /// Follow a terminal session to its conclusion.
  ///
  /// Verified against the sandbox, where a session runs
  /// `InitiateRequested → Initiated → SignatureVerificationRequired → Captured`
  /// with notifications PresentCard then PleaseWait. The signature step is not
  /// optional — the session stalls there until answered.
  ///
  /// A failed read is not a failed payment. The tablet's Wi-Fi dropping for a
  /// few seconds used to end the sale with an error while the card went on to
  /// be approved; now reads are retried, and only a machine silent for
  /// [_maxSilence] ends the wait, as "not confirmed".
  Future<PaymentResult> awaitTerminal(
    String sessionId,
    String intentId,
    int amountMinor,
  ) async {
    final deadline = DateTime.now().add(pollTimeout);
    var signatureAnswered = false;
    var cancelSent = false;
    DateTime? lastHeard = DateTime.now();
    DojoSession? last;

    PaymentResult unconfirmed(String message) => PaymentResult(
      approved: false,
      amountMinor: amountMinor,
      reference: intentId,
      sessionId: sessionId,
      acquirerStatus: last?.status,
      outcome: CardOutcome.unknown,
      uncertainty: PaymentUncertainty.checkTerminal,
      message: message,
    );

    while (DateTime.now().isBefore(deadline)) {
      if (_abandoned) {
        return unconfirmed(
          'The till stopped waiting for the card machine. Check the payment '
          'status before charging the card again.',
        );
      }

      // The clerk's cancel goes on the next poll, once.
      if (_cancelRequested && !cancelSent) {
        cancelSent = true;
        final answer = await cancelSessionWithReason(sessionId);
        onCancelAnswered?.call(answer.accepted, answer.message);
      }

      DojoSession session;
      try {
        session = await fetchSession(sessionId);
        lastHeard = DateTime.now();
        last = session;
      } catch (_) {
        if (DateTime.now().difference(lastHeard!) > _maxSilence) {
          return unconfirmed(
            'Lost contact with the card machine. Check the payment status '
            'before charging the card again — it may have gone through.',
          );
        }
        await Future<void>.delayed(pollInterval);
        continue;
      }
      onTerminalUpdate?.call(session);

      if (session.captured) {
        return PaymentResult(
          approved: true,
          amountMinor: amountMinor,
          reference: intentId,
          sessionId: sessionId,
          acquirerStatus: session.status,
          outcome: CardOutcome.approved,
          message: 'Approved',
          receiptLines: session.receiptLines,
          authCode: session.authCode,
          cardLast4: session.cardLast4,
          cardType: session.cardType,
        );
      }
      if (session.failed) {
        // `Expired` is not a decline and must never be shown as one.
        //
        // Declined and Canceled are verdicts: the money did not move and the
        // reader knows it. Expired means the reader stopped answering — the
        // card may have been approved and the result lost on the way back. The
        // accreditation checklist is explicit that the till has to say the
        // result cannot be confirmed and offer to check it and record it
        // manually, or retry, which is a different screen from "declined".
        final status = session.status.toLowerCase();
        final expired = status == 'expired';
        final cancelled = status == 'canceled' || status == 'cancelled';
        return PaymentResult(
          approved: false,
          amountMinor: amountMinor,
          reference: intentId,
          sessionId: sessionId,
          acquirerStatus: session.status,
          receiptLines: session.receiptLines,
          outcome: expired
              ? CardOutcome.expired
              : cancelled
              ? CardOutcome.cancelled
              : CardOutcome.declined,
          uncertainty: expired
              ? PaymentUncertainty.checkTerminal
              : PaymentUncertainty.none,
          message: expired
              ? 'The card machine did not confirm the result in time. Check '
                    'the payment status: if the machine shows it approved, it '
                    'can be recorded as paid.'
              : cancelled
              ? (cancelSent
                    ? 'Cancelled from the till. No money was taken.'
                    : 'Cancelled on the card machine. No money was taken.')
              : 'The card was declined. No money was taken. Ask for another '
                    'card or another way to pay.',
        );
      }
      if (session.needsSignature && !signatureAnswered) {
        signatureAnswered = true;
        final accepted = await (onSignatureRequested?.call() ?? Future.value(true));
        try {
          await answerSignature(sessionId, accepted: accepted);
        } on DojoException {
          // The machine moved on (it can time the signature out itself). The
          // next read says what it decided.
        }
        if (!accepted) {
          // Not returned yet: the machine reverses the sale and reports
          // Declined/Canceled, and that verdict is what goes in the log. The
          // outcome is renamed below so the clerk reads why.
          final verdict = await _settleAfterRejection(sessionId);
          return PaymentResult(
            approved: false,
            amountMinor: amountMinor,
            reference: intentId,
            sessionId: sessionId,
            acquirerStatus: verdict?.status ?? 'SignatureRejected',
            receiptLines: verdict?.receiptLines ?? const [],
            outcome: CardOutcome.signatureRejected,
            message: 'The signature did not match, so the payment was '
                'reversed. No money was taken.',
          );
        }
      }

      await Future<void>.delayed(pollInterval);
    }

    // Out of time with the session unresolved. The card may still be mid-flight
    // on the reader, so this is "unknown", never a decline — and it has to be
    // flagged as such, or the message says one thing while the till books the
    // other.
    return unconfirmed(
      'Timed out at the card machine. Check the payment status before '
      'charging the card again — it may still have gone through.',
    );
  }

  /// How long the machine may stay silent before the wait ends unconfirmed.
  static const _maxSilence = Duration(seconds: 45);

  /// After a rejected signature, follow the session briefly to its verdict so
  /// the log carries Dojo's own word for what happened.
  Future<DojoSession?> _settleAfterRejection(String sessionId) async {
    for (var i = 0; i < 15; i++) {
      try {
        final s = await fetchSession(sessionId);
        onTerminalUpdate?.call(s);
        if (s.failed || s.captured) return s;
      } catch (_) {}
      await Future<void>.delayed(pollInterval);
    }
    return null;
  }

  /// Cancel a session and say why Dojo did or did not.
  Future<({bool accepted, String message})> cancelSessionWithReason(
    String sessionId,
  ) async {
    try {
      final res = await _client
          .put(
            Uri.parse('$baseUrl/terminal-sessions/$sessionId/cancel'),
            headers: _terminalHeaders,
          )
          .timeout(const Duration(seconds: 20));
      if (res.statusCode >= 200 && res.statusCode < 300) {
        return (accepted: true, message: 'Cancelling on the card machine…');
      }
      final e = _exception(res, 'The card machine would not cancel');
      return (
        accepted: false,
        message: res.statusCode == 422
            ? 'Too late to cancel: the card is already in. Waiting for the '
                  'result.'
            : e.clerkMessage,
      );
    } catch (e) {
      return (
        accepted: false,
        message: 'Could not reach Dojo to cancel. Waiting for the result.',
      );
    }
  }

  /// Whether this till has everything it needs to send a payment to a reader.
  bool get canUseTerminal =>
      (terminalId?.isNotEmpty ?? false) &&
      (softwareHouseId?.isNotEmpty ?? false) &&
      (resellerId?.isNotEmpty ?? false);

  // ---- Checking a payment by hand -----------------------------------------

  /// Ask Dojo what became of a payment, for the "Check payment status" key.
  ///
  /// This is the manual reconciliation Dojo's sheet asks for after an expired
  /// session: the intent is the source of truth, whatever the till missed.
  Future<DojoPaymentStatus> paymentStatus(String intentId) async =>
      DojoPaymentStatus.fromJson(await fetchIntent(intentId));

  // ---- Checking the settings before they are saved ------------------------

  /// Prove the key and the partner ids work, and that [terminalId] (when one
  /// is chosen) is on this account and switched on.
  ///
  /// Dojo's "Incorrect authorization credentials" scenario: pressing Save
  /// must make an API call, and a 401 must read "API key is incorrect" there
  /// and then — not at the first sale.
  Future<DojoSettingsCheck> verifySettings() async {
    List<DojoTerminal> all;
    try {
      all = await listTerminals(status: null);
    } on DojoException catch (e) {
      return DojoSettingsCheck(
        ok: false,
        message: e.statusCode == 401
            ? 'API key is incorrect. Please check the API key.'
            : e.statusCode == 403
            ? 'Dojo refused the software house or reseller id (HTTP 403).'
            : 'Dojo did not accept these settings: ${e.message}',
      );
    } catch (e) {
      return DojoSettingsCheck(
        ok: false,
        message: 'Could not reach Dojo to check the settings. Check this '
            'till is online, then try again.',
      );
    }
    final tid = terminalId?.trim() ?? '';
    if (tid.isEmpty) {
      return DojoSettingsCheck(
        ok: true,
        terminals: all,
        message: 'API key accepted. No card machine chosen, so cards will be '
            'keyed on screen.',
      );
    }
    final match = all.where((t) => t.id == tid || t.tid == tid).firstOrNull;
    if (match == null) {
      return DojoSettingsCheck(
        ok: false,
        terminals: all,
        message: 'API key accepted, but card machine $tid is not on this '
            'Dojo account. Choose one from the list.',
      );
    }
    final status = match.status.toLowerCase();
    if (status != 'available' && status != 'busy') {
      return DojoSettingsCheck(
        ok: false,
        terminals: all,
        terminal: match,
        message: 'Card machine ${match.label} is ${match.status}. Switch it on '
            'and connect it, then save again.',
      );
    }
    return DojoSettingsCheck(
      ok: true,
      terminals: all,
      terminal: match,
      message: 'Connected: API key accepted and card machine ${match.label} '
          'is ${match.status.toLowerCase()}.',
    );
  }

  @override
  Future<PaymentResult> take(
    int amountMinor, {
    String? orderId,
    bool manual = false,
  }) async {
    _cancelRequested = false;
    _abandoned = false;
    String? intentId;
    try {
      final intent = await createIntent(amountMinor, orderId: orderId);
      intentId = intent.id;

      // With a reader configured the payment is driven through a terminal
      // session; polling the intent alone would wait forever, because nothing
      // would ever present the card.
      //
      // A keyed card deliberately skips the reader even on a till that has
      // one: a card machine can only take a card that is physically there, and
      // "manual" exists precisely for a chip that will not read or a customer
      // on the telephone.
      if (canUseTerminal && !manual) {
        if (_cancelRequested) {
          await cancelIntent(intent.id);
          return PaymentResult(
            approved: false,
            amountMinor: amountMinor,
            reference: intent.id,
            outcome: CardOutcome.cancelled,
            message: 'Cancelled from the till before it reached the card '
                'machine. No money was taken.',
          );
        }
        final sessionId = await startTerminalSession(intent.id);
        return await awaitTerminal(sessionId, intent.id, amountMinor);
      }

      return await confirm(intent.id, amountMinor);
    } on DojoException catch (e) {
      // Dojo's "Failure with busy terminal": a 409 on starting the session.
      // Nothing was sent to the machine, so nothing was taken; the clerk is
      // told to finish what is on its screen and try again.
      if (intentId != null) unawaited(cancelIntent(intentId));
      return PaymentResult(
        approved: false,
        amountMinor: amountMinor,
        reference: intentId,
        outcome: e.statusCode == 409 ? CardOutcome.busy : CardOutcome.failed,
        acquirerStatus: e.statusCode == null ? null : 'HTTP ${e.statusCode}',
        message: e.clerkMessage,
      );
    } catch (e) {
      // An errored card payment is NOT a payment. Never fall back to assuming
      // it worked — the till would record money it never took.
      return PaymentResult(
        approved: false,
        amountMinor: amountMinor,
        reference: intentId,
        outcome: CardOutcome.failed,
        message: 'Could not reach Dojo: $e',
      );
    }
  }
}

/// The result of checking card settings before they are saved.
class DojoSettingsCheck {
  const DojoSettingsCheck({
    required this.ok,
    required this.message,
    this.terminals = const [],
    this.terminal,
  });

  final bool ok;
  final String message;
  final List<DojoTerminal> terminals;
  final DojoTerminal? terminal;
}

/// What Dojo says about one payment, for the status check and refunds.
class DojoPaymentStatus {
  const DojoPaymentStatus({
    required this.id,
    required this.status,
    required this.amountMinor,
    required this.refundedMinor,
    this.authCode,
    this.cardLast4,
    this.cardType,
    this.createdAt,
  });

  final String id;

  /// Created, Authorized, Captured, Refunded, Reversed, Canceled…
  final String status;
  final int amountMinor;
  final int refundedMinor;
  final String? authCode;
  final String? cardLast4;
  final String? cardType;
  final DateTime? createdAt;

  bool get paid => DojoProvider.paidStatuses.contains(status.toLowerCase()) ||
      status.toLowerCase() == 'refunded';

  /// What can still be given back.
  int get refundableMinor =>
      paid ? (amountMinor - refundedMinor).clamp(0, amountMinor) : 0;

  /// One line for the clerk: "Captured · £12.34 · £2.00 refunded".
  String get summary {
    String gbp(int m) => '£${(m / 100).toStringAsFixed(2)}';
    return [
      status,
      gbp(amountMinor),
      if (refundedMinor > 0) '${gbp(refundedMinor)} refunded',
      if (cardType != null && cardLast4 != null) '$cardType ••$cardLast4',
      if (authCode != null && authCode!.isNotEmpty) 'Auth $authCode',
    ].join(' · ');
  }

  static int _minor(Object? v) => switch (v) {
    num n => n.toInt(),
    Map m => (m['value'] as num?)?.toInt() ?? 0,
    _ => 0,
  };

  factory DojoPaymentStatus.fromJson(Map<String, dynamic> j) {
    final details = j['paymentDetails'] as Map<String, dynamic>?;
    final card = details?['card'] as Map<String, dynamic>?;
    final pan = '${card?['last4PAN'] ?? card?['cardNumber'] ?? ''}';
    return DojoPaymentStatus(
      id: '${j['id'] ?? ''}',
      status: '${j['status'] ?? 'Unknown'}',
      amountMinor: _minor(j['totalAmount'] ?? j['amount']),
      refundedMinor: _minor(j['refundedAmount']),
      authCode: details?['authCode'] as String?,
      cardLast4: pan.length >= 4 ? pan.substring(pan.length - 4) : null,
      cardType: card?['cardType'] as String?,
      createdAt: DateTime.tryParse('${j['createdAt'] ?? ''}'),
    );
  }
}

/// A Dojo call that failed, with enough detail for the till to say something
/// useful and for support to trace it afterwards.
///
/// [statusCode] is carried because the accreditation checklist tests the four
/// HTTP codes separately, and because they mean genuinely different things to
/// the person standing at the till:
///
///   * 400 — we sent something wrong. Not the clerk's fault and not fixable at
///           the counter; it is a bug to report.
///   * 401 — the API key is wrong. Fixable, in Settings, by whoever installed
///           the till. This is the one that must never read "payment failed".
///   * 404 — the card machine (or the intent) is not there. Check the PDQ.
///   * 409 — the card machine is busy with something else.
///   * 422 — the request made sense but not right now, e.g. cancelling after
///           the card has already been presented. The original flow continues.
///
/// [traceId] is Dojo's own correlation id. It costs nothing to keep and it is
/// the first thing their support asks for.
class DojoException implements Exception {
  DojoException(this.message, {this.statusCode, this.traceId});

  final String message;
  final int? statusCode;
  final String? traceId;

  /// Whether retrying the identical request could plausibly work. A 409 means
  /// the terminal is busy now and might not be in a moment; a 400 will fail
  /// identically for ever.
  bool get retryable => statusCode == 409 || (statusCode ?? 0) >= 500;

  /// What the clerk should be told. Dojo returns at least three different
  /// error shapes depending on the endpoint, so the message is chosen by what
  /// the situation *is* rather than by parsing all of them perfectly.
  String get clerkMessage => switch (statusCode) {
    401 => 'API key is incorrect. Please check the API key in Settings › '
        'Card payments.',
    404 => 'The card machine could not be found. Check it is switched on and '
        'connected.',
    409 => 'The card machine is busy. Finish or cancel what is on its screen, '
        'then try again.',
    422 => message,
    _ => message,
  };

  @override
  String toString() =>
      statusCode == null ? message : '$message (HTTP $statusCode)';
}
