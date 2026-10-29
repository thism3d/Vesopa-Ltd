/// Vesopa Go's calls to the back office.
///
/// A Tap phone is a terminal. It is commissioned like a till and reads the
/// till's own endpoints, mostly at the server's root (`/till/...`): staff,
/// products, the floor and the shared open bills. Screens and modifiers are
/// the exception, mounted under `/api/till/...` (vesopa_server/src/server.js,
/// tillScreenRoutes and tillModifierRoutes), as the till itself reads them. So a table opened on a phone is on
/// every till at once and the other way round. Card payments go through
/// /api/tap/* (vesopa_server/src/tap.js): the venue's Dojo key never comes
/// to the phone.
library;

import 'dart:convert';

import 'package:http/http.dart' as http;

import '../config/constants.dart';
import 'models.dart';

class TapApiError implements Exception {
  const TapApiError(this.status, this.message, [this.body = const {}]);
  final int status;
  final String message;
  final Map<String, dynamic> body;
  @override
  String toString() => message;
}

class TapApi {
  TapApi({this.base = apiBase, http.Client? client}) : _client = client ?? http.Client();

  final String base;
  final http.Client _client;

  /// The terminal token, once commissioned. Only this one is kept: the
  /// back-office session the commission also returns is thrown away, because
  /// a phone leaves the building and must not open the back office.
  String? token;

  /// The venue's contact email: what the till endpoints are scoped by.
  String? office;

  Future<Map<String, dynamic>> _send(String method, String path, [Object? body]) async {
    final req = http.Request(method, Uri.parse('$base$path'))
      ..headers.addAll({
        'Accept': 'application/json',
        if (body != null) 'Content-Type': 'application/json',
        if (token != null) 'Authorization': 'Bearer $token',
      });
    if (body != null) req.body = jsonEncode(body);
    final http.Response res;
    try {
      res = await http.Response.fromStream(await _client.send(req).timeout(const Duration(seconds: 20)));
    } catch (_) {
      throw const TapApiError(0, 'No connection to Vesopa. Check the wifi or mobile data.');
    }
    Map<String, dynamic> j;
    try {
      final d = res.body.isEmpty ? <String, dynamic>{} : jsonDecode(res.body);
      j = d is Map<String, dynamic> ? d : {'items': d};
    } catch (_) {
      j = {};
    }
    if (res.statusCode >= 400) {
      throw TapApiError(res.statusCode, (j['error'] as String?) ?? 'Vesopa answered ${res.statusCode}.', j);
    }
    return j;
  }

  /// Any POST, for the outbox.
  Future<Map<String, dynamic>> post(String path, Map<String, Object?> body) => _send('POST', path, body);

  String get _o => Uri.encodeQueryComponent(office ?? '');

  // ---- Setting the phone up --------------------------------------------------

  /// Continue with Vesopa: an ID token in, a terminal token out (or a site to
  /// choose). The phone takes a till seat: it counts as one of the tills.
  /// Which Vesopa Auth client and issuer this app signs in with: Vesopa Go's
  /// own when the back office has it, else the till's. Vesopa Auth knows apps
  /// by their client id, so this is asked rather than built in.
  Future<({String issuer, String clientId})> signInClient() async {
    for (final path in const ['/api/go/vesopa/enabled', '/api/terminal/vesopa/enabled']) {
      try {
        final j = await _send('GET', path);
        final id = j['clientId'] as String?;
        if (j['enabled'] == true && id != null && id.isNotEmpty) {
          return (issuer: (j['issuer'] as String?) ?? authIssuer, clientId: id);
        }
      } on TapApiError catch (e) {
        if (e.status == 0) rethrow;
      }
    }
    throw const TapApiError(503, 'Continue with Vesopa is not switched on for this back office yet.');
  }

  Future<Map<String, dynamic>> commission(String idToken, {required String device, required String deviceId}) =>
      _send('POST', '/api/terminal/vesopa/commission', {
        'id_token': idToken,
        // Vesopa Go is its own licence (licences.js: none unless the venue is offered it).
        'device_kind': 'go',
        'device_name': device,
        'device_id': deviceId,
        'site_choice': true,
      });

  /// A login that runs several sites picks one with the five-minute pass.
  Future<Map<String, dynamic>> commissionSite(String pickToken, Object officeId, {required String device, required String deviceId}) =>
      _send('POST', '/api/terminal/vesopa/commission/site', {
        'pick_token': pickToken,
        'office_id': officeId,
        // Vesopa Go is its own licence (licences.js: none unless the venue is offered it).
        'device_kind': 'go',
        'device_name': device,
        'device_id': deviceId,
      });

  /// A new venue on Vesopa Go alone (vesopa_server/src/tap.js).
  Future<Map<String, dynamic>> registerVenue({
    required String idToken,
    required String venueName,
    required String businessType,
    required String postcode,
    required String device,
    required String deviceId,
  }) =>
      _send('POST', '/api/tap/register', {
        'id_token': idToken,
        'venue_name': venueName,
        'business_type': businessType,
        'postcode': postcode,
        'name': device,
        'device_id': deviceId,
      });

  // ---- The venue -----------------------------------------------------------------

  Future<List<Clerk>> staff() async {
    final j = await _send('GET', '/till/staff');
    final list = (j['staff'] ?? j['items'] ?? const []) as List;
    return [for (final s in list) Clerk.fromJson(s as Map<String, dynamic>)];
  }

  Future<List<dynamic>> products() async => (await _send('GET', '/till/products?office=$_o'))['items'] as List? ?? const [];
  Future<Map<String, dynamic>> modifiers() => _send('GET', '/api/till/modifiers?office=$_o');
  Future<List<dynamic>> screens() async => (await _send('GET', '/api/till/screens?office=$_o'))['screens'] as List? ?? const [];
  Future<List<dynamic>> floor() async => (await _send('GET', '/till/floor?office=$_o'))['items'] as List? ?? const [];

  // ---- Shared open bills (vesopa_server/src/terminals.js) --------------------------

  Future<Map<String, dynamic>> openBills({int since = 0}) => _send('GET', '/till/open-bills?since=$since');
  Future<Map<String, dynamic>> saveBill(Map<String, Object?> bill) => _send('POST', '/till/open-bills', bill);
  Future<Map<String, dynamic>> claimBill(String id, String terminal) => _send('POST', '/till/open-bills/$id/claim', {'terminal': terminal});
  Future<void> retireBill(String id, {String reason = 'settled'}) => _send('DELETE', '/till/open-bills/$id?reason=$reason');

  // ---- Members and vouchers (vesopa_server/src/commerce.js, as the till) ----------

  /// A Vesopa Loyalty member by their card or member number (the code the
  /// Loyalty app shows, scanned or typed).
  Future<Member> member(String number) async =>
      Member.fromJson(await _send('GET', '/api/loyalty/card?office=$_o&number=${Uri.encodeQueryComponent(number)}'));

  /// What [code] takes off a bill of [subtotalMinor]; `valid` false says why not.
  Future<Map<String, dynamic>> checkVoucher(String code, int subtotalMinor) =>
      _send('GET', '/api/vouchers/validate?office=$_o&code=${Uri.encodeQueryComponent(code)}&subtotal_minor=$subtotalMinor');

  // ---- Kitchen ------------------------------------------------------------------

  Future<Map<String, dynamic>> kitchenBoard() => _send('GET', '/till/kitchen/board?minutes=90');

  // ---- Card payments on this phone (vesopa_server/src/tap.js) ----------------------

  Future<Map<String, dynamic>> tapConfig() => _send('GET', '/api/tap/config');

  /// The till's settings Go follows: consolidate lines, the idle screen.
  Future<Map<String, dynamic>> tillSettings() => _send('GET', '/api/till-settings/public?office=$_o');

  /// Clocks [staffId] in unless their shift is already open (`/till/clock`
  /// toggles, so it is asked first). Answers whether a shift was started.
  Future<bool> clockIn(int staffId) async {
    final open = (await _send('GET', '/till/clock'))['open'] as List? ?? const [];
    if (open.any((o) => (o as Map)['staff_id'] == staffId)) return false;
    await _send('POST', '/till/clock', {'staff_id': staffId, 'terminal': 'Vesopa Go'});
    return true;
  }

  /// Customers by name, phone, email or card, as the till's Customer key.
  Future<List<dynamic>> customers(String q) async {
    // A list, which _send hands back under `items`.
    final r = await _send('GET', '/till/customers?office=$_o${q.trim().isEmpty ? '' : '&q=${Uri.encodeQueryComponent(q.trim())}'}');
    return r['items'] as List? ?? const [];
  }

  /// A new customer, joined to the venue's loyalty scheme as the till does.
  Future<Map<String, dynamic>> createCustomer({required String name, String phone = '', String email = '', bool marketing = false}) =>
      _send('POST', '/till/customers', {
        'office': office,
        'name': name,
        if (phone.isNotEmpty) 'phone': phone,
        if (email.isNotEmpty) 'email': email,
        'marketing_opt_in': marketing,
      });

  /// A customer's name, phone and email (vesopa_server tap.js).
  Future<void> updateCustomer(String id, {required String name, String phone = '', String email = ''}) =>
      _send('PUT', '/api/tap/customers/${Uri.encodeComponent(id)}', {'name': name, 'phone': phone, 'email': email});

  /// Go's own layouts for a kind of device (`tablet` or `phone`).
  Future<Map<String, dynamic>> layouts(String form) => _send('GET', '/api/tap/layouts?form=$form');

  /// A screen as a manager arranged it here; null buttons = back to the till's.
  Future<void> saveLayout(String form, int screenId, List<Map<String, dynamic>>? buttons, {required int clerkId, required String pin}) =>
      _send('PUT', '/api/tap/layouts/$form/$screenId', {'buttons': buttons, 'clerk_id': clerkId, 'pin': pin});

  /// The venue's mix & match deals, as the till reads them.
  Future<List<dynamic>> deals() async => (await _send('GET', '/till/deals?office=$_o'))['items'] as List? ?? const [];

  /// The floor plan as moved on this device (the venue's one floor, as the
  /// till's floor editor saves it).
  Future<void> saveFloor(List<TableInfo> tables) => _send('PUT', '/till/floor/tables', {
        'tables': [
          for (final t in tables)
            if (t.rowId != null)
              {'id': t.rowId, 'pos_x': t.x, 'pos_y': t.y, 'width': t.width, 'height': t.height, 'shape': t.round ? 'circle' : 'rect', 'seats': t.seats, 'colour': t.colour},
        ],
      });

  // ---- Memberships and Events & tickets (the till's own routes) ---------------

  Future<List<dynamic>> membershipPlans() async => (await _send('GET', '/till/memberships/plans'))['items'] as List? ?? const [];

  Future<List<dynamic>> memberships(String q) async =>
      (await _send('GET', '/till/memberships/members${q.trim().isEmpty ? '' : '?q=${Uri.encodeQueryComponent(q.trim())}'}'))['items'] as List? ?? const [];

  Future<Map<String, dynamic>> joinMembership({required int planId, String? customerId, Map<String, String>? newCustomer, int? amountMinor, String? staff}) =>
      _send('POST', '/till/memberships/members', {
        'scheme_id': planId,
        'customer_id': ?customerId,
        'customer': ?newCustomer,
        'amount_minor': ?amountMinor,
        'staff': ?staff,
      });

  /// renew, freeze, unfreeze, cancel or reinstate.
  Future<Map<String, dynamic>> membershipAction(String id, String action, [Map<String, Object?> body = const {}]) =>
      _send('POST', '/till/memberships/members/${Uri.encodeComponent(id)}/$action', body);

  Future<List<dynamic>> events() async => (await _send('GET', '/till/events'))['events'] as List? ?? const [];

  Future<Map<String, dynamic>> sellTickets(int eventId, {required List<Map<String, int>> items, required String name, String? email, String? phone, required int amountMinor, String? staff}) =>
      _send('POST', '/till/events/$eventId/sell', {
        'items': items,
        'name': name,
        if (email != null && email.isNotEmpty) 'email': email,
        if (phone != null && phone.isNotEmpty) 'phone': phone,
        'amount_minor': amountMinor,
        'staff': ?staff,
      });

  Future<Map<String, dynamic>> checkInTicket(String code, {String? staff}) =>
      _send('POST', '/till/events/checkin', {'code': code, 'staff': ?staff});

  /// The venue's photos: `{products: {plu: url}, sections: {name: url}}`.
  Future<Map<String, dynamic>> photos() => _send('GET', '/api/tap/photos');

  /// The venue's modules that are on (memberships, events...), as the till asks.
  Future<Map<String, dynamic>> modules() => _send('GET', '/till/modules');

  /// Today across the venue: every till and device (vesopa_server tap.js).
  Future<Map<String, dynamic>> today() => _send('GET', '/api/tap/today');

  /// The venue's banknote keys and their pictures (back office, as the till's).
  Future<List<dynamic>> cashNotes() async => (await _send('GET', '/till/denominations?office=$_o'))['items'] as List? ?? const [];

  /// A photo taken or chosen on the device, as a data URI; answers its address.
  Future<String> uploadPhoto(String dataUri) async => (await _send('POST', '/api/tap/uploads', {'data': dataUri}))['url'] as String;

  /// A product's price (pounds) and photo, as the till's own product edit.
  Future<void> updateProduct(int plu, {double? price, String? imageUrl}) =>
      _send('PATCH', '/till/products/$plu', {'price': ?price, 'image_url': ?imageUrl});

  /// The online menu shows the product's new photo too.
  Future<void> menuPhoto(int plu, String imageUrl) => _send('PUT', '/api/tap/menu-photo/$plu', {'image_url': imageUrl});

  /// Staff photos, `{photos: {id: url}}`.
  Future<Map<String, dynamic>> staffPhotos() => _send('GET', '/api/tap/staff-photos');

  /// The venue's receipt branding, as the tills print it.
  Future<Map<String, dynamic>> branding() => _send('GET', '/api/branding/public?office=$_o');

  /// A Tap to Pay terminal secret for Dojo's SDK (six hours).
  Future<String> tapSecret(String platform) async =>
      (await _send('POST', '/api/tap/secret', {'platform': platform}))['secret'] as String;

  /// [via] `tap` (this phone) or `machine` (the venue's Dojo card machine).
  Future<Map<String, dynamic>> createPayment({
    required String id,
    required int amountMinor,
    int tipMinor = 0,
    String? billRef,
    String? clerk,
    String via = 'tap',
    String? terminalId,
  }) =>
      _send('POST', '/api/tap/payments', {
        'id': id,
        'amount_minor': amountMinor,
        'tip_minor': tipMinor,
        'bill_ref': billRef,
        'clerk': clerk,
        'via': via,
        // This device's own card machine (Card machine page); else the venue's.
        'terminal_id': ?terminalId,
      });

  /// The venue's free Dojo card machines, and its default.
  Future<Map<String, dynamic>> terminals() => _send('GET', '/api/tap/terminals');

  Future<Map<String, dynamic>> payment(String id) => _send('GET', '/api/tap/payments/$id');
  Future<Map<String, dynamic>> cancelPayment(String id) => _send('POST', '/api/tap/payments/$id/cancel');
  Future<Map<String, dynamic>> refund(String id, {int? amountMinor, required String approvedBy, required String reason}) async {
    // A Teya payment goes back to its card through Teya, as on the till.
    if (id.startsWith('teya:')) {
      final r = await _send('POST', '/api/till/teya/refunds', {
        'gateway_payment_id': id.substring(5),
        'amount_minor': ?amountMinor,
        'reference': 'vesopa-refund-${DateTime.now().millisecondsSinceEpoch.toRadixString(36)}',
      });
      if (r['ok'] != true) throw TapApiError(409, '${r['message'] ?? 'Teya refused the refund.'}', r);
      return r;
    }
    return _send('POST', '/api/tap/payments/$id/refund', {
      'amount_minor': ?amountMinor,
      'approved_by': approvedBy,
      'reason': reason,
    });
  }

  // ---- Teya card machines (the till's own routes, vesopa_server src/teya.js) ----

  /// Whether the venue takes cards with Teya, and its machines. A server
  /// without Teya answers 404: Teya is off.
  Future<Map<String, dynamic>> teyaConfig() async {
    try {
      return await _send('GET', '/api/till/teya/config');
    } on TapApiError catch (e) {
      if (e.status == 404) return const {'enabled': false};
      rethrow;
    }
  }

  /// Send a payment to a Teya machine; answers Teya's payment request id.
  Future<String> teyaPay({required String terminalId, required int amountMinor, required String reference, String? orderId, required String tillName}) async {
    final r = await _send('POST', '/api/till/teya/payments', {
      'terminal_id': terminalId,
      'amount_minor': amountMinor,
      'type': 'SALE',
      'reference': reference,
      'idempotency_key': reference,
      'order_id': ?orderId,
      'till_name': tillName,
    });
    final id = '${r['id'] ?? ''}';
    if (id.isEmpty) throw const TapApiError(502, 'Teya did not accept the payment.');
    return id;
  }

  /// Where a Teya payment is, waiting up to [wait] seconds for it to move.
  Future<Map<String, dynamic>> teyaStatus(String id, {int wait = 15}) =>
      _send('GET', '/api/till/teya/payments/${Uri.encodeComponent(id)}?wait=$wait');

  Future<void> teyaCancel(String id) => _send('POST', '/api/till/teya/payments/${Uri.encodeComponent(id)}/cancel');
  Future<void> emailReceipt(String orderId, String email) => _send('POST', '/api/tap/receipts', {'order_id': orderId, 'email': email});
}
