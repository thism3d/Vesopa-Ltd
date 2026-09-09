import 'dart:convert';

import 'package:http/http.dart' as http;

import 'dinein_orders.dart';
import 'kitchen_branding.dart';
import 'screen_profile.dart';
import 'ticket.dart';

/// Something the server said no to, in words worth showing a chef.
///
/// A typed error rather than a status code because the two cases that matter
/// have to be told apart by the caller: a token that has expired means "sign in
/// again", and everything else means "try again in a minute". Showing the wrong
/// one of those to somebody in the middle of a service wastes their time in the
/// one place there is none to waste.
class KitchenApiError implements Exception {
  KitchenApiError(this.message, {this.status, this.signedOut = false});

  final String message;
  final int? status;

  /// The credential is no longer good. The only fix is a sign-in.
  final bool signedOut;

  @override
  String toString() => message;
}

/// Everything a screen needs to draw itself, fetched in one call.
class KitchenProfile {
  const KitchenProfile({
    required this.office,
    required this.screens,
    this.officeName,
    this.userName,
    this.stationNames = const {},
    this.branding = KitchenBranding.standard,
  });

  final String office;

  /// The venue's trading name. Shown on the info panel; never on the board,
  /// which has no room for anything that is not an order.
  final String? officeName;

  final String? userName;

  /// What the venue calls each station, from the same row the till reads. A
  /// station with no name here falls back to "KP 3".
  final Map<String, String> stationNames;

  final List<ScreenProfile> screens;

  /// What this venue's screens call themselves. Venue-wide, like the station
  /// names, and cached by the screen so the start screen is branded on a cold
  /// boot with no network.
  final KitchenBranding branding;

  /// The profiles a screen may be, always including the built-in one.
  ///
  /// [ScreenProfile.allStations] is offered even when the venue has defined its
  /// own, because a chef whose named screen has been deleted in the back office
  /// still needs a board, and "all of it" is the answer that cannot be wrong.
  List<ScreenProfile> get choices => [
    for (final s in screens) s.normalised(),
    ScreenProfile.allStations,
  ];

  /// What to call [station] on this board.
  String labelFor(String station) {
    final named = stationNames[station]?.trim();
    if (named != null && named.isNotEmpty) return named;
    return station.toUpperCase().replaceFirst('KP', 'KP ');
  }

  factory KitchenProfile.fromJson(Map<String, dynamic> j) => KitchenProfile(
    office: j['office'] as String? ?? '',
    officeName: j['officeName'] as String?,
    userName: (j['user'] as Map<String, dynamic>?)?['name'] as String?,
    stationNames: {
      for (final e in ((j['stationNames'] as Map?) ?? const {}).entries)
        '${e.key}': '${e.value}',
    },
    branding: KitchenBranding.fromJson(j['branding'] as Map<String, dynamic>?),
    screens: ((j['screens'] as List?) ?? const [])
        .cast<Map<String, dynamic>>()
        .map(ScreenProfile.fromJson)
        .toList(),
  );

  Map<String, dynamic> toJson() => {
    'office': office,
    if (officeName != null) 'officeName': officeName,
    if (userName != null) 'user': {'name': userName},
    'stationNames': stationNames,
    'branding': branding.toJson(),
    'screens': [for (final s in screens) s.toJson()],
  };
}

/// One fetch of the board.
class BoardSnapshot {
  const BoardSnapshot({
    required this.tickets,
    required this.serverTime,
    this.stationNames = const {},
  });

  final List<Ticket> tickets;

  /// The server's clock at the moment it answered.
  ///
  /// Kept because a wall-mounted screen's own clock is not to be trusted — a
  /// machine that has been unplugged for a fortnight comes back at some
  /// arbitrary time, and every elapsed figure on the board would be wrong in a
  /// way that looks authoritative. See `TicketBoard.now`.
  final DateTime serverTime;

  final Map<String, String> stationNames;

  factory BoardSnapshot.fromJson(Map<String, dynamic> j) => BoardSnapshot(
    serverTime:
        DateTime.tryParse('${j['serverTime']}')?.toLocal() ?? DateTime.now(),
    stationNames: {
      for (final e in ((j['stationNames'] as Map?) ?? const {}).entries)
        '${e.key}': '${e.value}',
    },
    tickets: ((j['tickets'] as List?) ?? const [])
        .cast<Map<String, dynamic>>()
        .map(Ticket.fromJson)
        .toList(),
  );
}

/// The kitchen screen's half of the API.
///
/// Six calls, and nothing else exists to this app: sign in, read the venue's
/// screens, read the board, bump, recall, rush. That is deliberate — the token
/// this client carries is a shared credential on a wall in a room full of
/// people, and the smaller the surface it opens the less it matters when it
/// walks out of the building on a photograph.
class KitchenApi {
  KitchenApi({required this.apiBase, http.Client? client})
    : _client = client ?? http.Client();

  final String apiBase;
  final http.Client _client;

  /// Set once the screen signs in. Null while it has not.
  String? token;

  /// A short timeout everywhere.
  ///
  /// Nothing here is worth waiting on: a board that cannot be fetched is
  /// re-fetched thirty seconds later, and a bump that times out is applied
  /// locally and re-sent. The cost of a long timeout is a screen that appears
  /// frozen to somebody holding a pan.
  static const _timeout = Duration(seconds: 8);

  Map<String, String> get _headers => {
    'Content-Type': 'application/json',
    if (token != null) 'Authorization': 'Bearer $token',
  };

  /// Sign a screen in. Returns the token *and* the venue's profile, because a
  /// wall-mounted machine on a venue's wifi is exactly where four sequential
  /// round trips become a visible pause.
  Future<({String token, KitchenProfile profile})> signIn({
    required String office,
    required String username,
    required String password,
  }) async {
    final body = await _send(
      'POST',
      '/api/kitchen/login',
      body: {'office': office, 'username': username, 'password': password},
      authorised: false,
    );

    final issued = body['token'] as String?;
    if (issued == null) {
      throw KitchenApiError('The back office did not issue a sign-in.');
    }
    token = issued;
    return (token: issued, profile: KitchenProfile.fromJson(body));
  }

  /// What the back office says about signing in with a Vesopa account.
  ///
  /// The till's own endpoint, shared: the issuer and the public client id are
  /// the same for both applications -- see `data/vesopa_sso.dart` for why --
  /// and a second route answering the same two strings would be a second thing
  /// to keep in step.
  Future<({bool enabled, bool only, String issuer, String clientId})?>
      vesopaOption() async {
    try {
      final body = await _send(
        'GET',
        '/api/terminal/vesopa/enabled',
        authorised: false,
      );
      if (body['enabled'] != true) return null;
      return (
        enabled: true,
        only: body['only'] == true,
        issuer: body['issuer'] as String,
        clientId: body['clientId'] as String,
      );
    } catch (_) {
      // A screen that cannot ask keeps the typed form it has always had.
      return null;
    }
  }

  /// Set this screen up from a person's Vesopa account.
  ///
  /// The back office decides what that account may commission -- the same
  /// matching and access rules the browser and the till go through -- and
  /// issues the screen's own token. The token is the screen's from then on;
  /// nobody stays signed in as a person.
  Future<({String token, String office})> commissionWithVesopa(
    String idToken,
  ) async {
    final body = await _send(
      'POST',
      '/api/kitchen/vesopa/commission',
      body: {'id_token': idToken},
      authorised: false,
    );
    final issued = body['token'] as String?;
    if (issued == null) {
      throw KitchenApiError('The back office did not set this screen up.');
    }
    token = issued;
    return (token: issued, office: body['office'] as String? ?? '');
  }

  /// Re-read the venue's screens and station names without signing in again.
  Future<KitchenProfile> profile() async =>
      KitchenProfile.fromJson(await _send('GET', '/api/kitchen/profile'));

  Future<BoardSnapshot> board({required Duration recallWindow}) async =>
      BoardSnapshot.fromJson(
        await _send(
          'GET',
          '/api/kitchen/board?minutes=${recallWindow.inMinutes}',
        ),
      );

  /// Mark [stations] done. Empty closes every station on the ticket, which is
  /// what a single-screen kitchen means by the tick.
  Future<void> bump(String ticketId, Set<String> stations) => _send(
    'POST',
    '/api/kitchen/tickets/$ticketId/bump',
    body: {'stations': stations.toList()},
  );

  /// Cross one item off a ticket, or put it back.
  Future<void> markLine(String ticketId, String lineId, bool made) => _send(
    'POST',
    '/api/kitchen/tickets/$ticketId/lines/$lineId',
    body: {'made': made},
  );

  Future<void> recall(String ticketId) =>
      _send('POST', '/api/kitchen/tickets/$ticketId/recall');

  Future<void> rush(String ticketId, bool rushed) => _send(
    'POST',
    '/api/kitchen/tickets/$ticketId/rush',
    body: {'rushed': rushed},
  );

  /// The QR orders a customer has sent and nobody has picked up yet.
  ///
  /// The same handler the till calls, reached at a kitchen-scoped path — see
  /// the note on `appAuth` in vesopa_server/src/dinein.js. A venue with no QR
  /// menu simply gets an empty list, which is why nothing here has to ask
  /// whether the feature is switched on.
  Future<List<DineInOrder>> dineInOrders({String status = 'placed'}) async {
    final rows = await _sendList(
      'GET',
      '/api/kitchen/dinein/orders?status=$status&limit=30',
    );
    return [
      for (final row in rows) ?DineInOrder.fromJson(row),
    ];
  }

  /// Accept or reject one. [action] is `accepted` or `rejected`.
  ///
  /// A 409 means somebody else got there first — the till, or the screen on the
  /// other wall — and it is a normal outcome rather than a fault, so it comes
  /// back as a typed error the board can turn into a sentence instead of a
  /// red banner.
  Future<void> moveDineInOrder(int id, String action) =>
      _send('POST', '/api/kitchen/dinein/orders/$id/$action');

  /// The venue's notification settings, from the same row the back office
  /// edits. Unauthenticated and scoped by office, exactly as the till reads it.
  Future<Map<String, dynamic>> tillSettings(String office) => _send(
    'GET',
    '/api/till-settings/public?office=${Uri.encodeQueryComponent(office)}',
    authorised: false,
  );

  /// Allergen codes to the words a person reads. Fetched once at start-up.
  ///
  /// From the server rather than a list in this app, so the board, the menu,
  /// the back office and the customer display cannot drift into four spellings
  /// of the same allergen.
  Future<Map<String, String>> allergenLabels() async {
    final rows = await _sendList('GET', '/api/allergens', authorised: false);
    return {
      for (final row in rows) '${row['code']}': '${row['label']}',
    }..removeWhere((code, label) => code == 'null' || label == 'null');
  }

  /// Check the password of the login this screen is already signed in as.
  ///
  /// Not a second sign-in: it issues no token and cannot be used to become
  /// somebody else. It answers one question — is the person standing at this
  /// screen the person who set it up? — for the two places that have to ask it,
  /// signing out and restyling the venue.
  ///
  /// Returns false for a wrong password and *throws* for anything else, because
  /// the two must not be confused: a screen that cannot reach the server has
  /// not established that the password is wrong.
  ///
  /// The server answers 200 either way and puts the verdict in the body — a 401
  /// here means the *token* has expired, which is a different problem needing a
  /// different sentence in front of somebody holding a pan.
  Future<bool> verifyPassword(String password) async {
    final body = await _send(
      'POST',
      '/api/kitchen/verify',
      body: {'password': password},
    );
    return body['ok'] == true;
  }

  /// Restyle the venue's screens from this one. Costs the screen's password.
  ///
  /// `/kitchen/profile/branding`, not `/kitchen/branding`: the back office's
  /// router is mounted first and owns the shorter path behind a session token,
  /// which refuses this one. See the note on the route in src/kitchen.js.
  Future<KitchenBranding> saveBranding(
    KitchenBranding branding, {
    required String password,
  }) async {
    final body = await _send(
      'PUT',
      '/api/kitchen/profile/branding',
      body: {...branding.toJson(), 'password': password},
    );
    return KitchenBranding.fromJson(body);
  }

  /// The same call as [_send], for the routes that answer with a JSON array.
  ///
  /// Two methods rather than one returning `Object?`, so no caller has to cast
  /// and none can forget to.
  Future<List<Map<String, dynamic>>> _sendList(
    String method,
    String path, {
    bool authorised = true,
  }) async {
    final decoded = await _raw(method, path, authorised: authorised);
    if (decoded is! List) return const [];
    return [
      for (final row in decoded)
        if (row is Map<String, dynamic>) row,
    ];
  }

  Future<Map<String, dynamic>> _send(
    String method,
    String path, {
    Map<String, dynamic>? body,
    bool authorised = true,
  }) async {
    final decoded = await _raw(method, path, body: body, authorised: authorised);
    return decoded is Map<String, dynamic> ? decoded : const {};
  }

  /// One request, one set of error rules, whatever shape the answer is.
  ///
  /// Split out of [_send] when the dine-in orders route turned up: it answers
  /// with a JSON array, and the alternative was a second copy of the timeout
  /// handling, the 401-means-sign-out rule and the error-message extraction —
  /// three things that must not be allowed to differ between two calls made
  /// from the same screen.
  Future<Object?> _raw(
    String method,
    String path, {
    Map<String, dynamic>? body,
    bool authorised = true,
  }) async {
    if (authorised && token == null) {
      throw KitchenApiError('This screen is not signed in.', signedOut: true);
    }

    final uri = Uri.parse('$apiBase$path');
    late final http.Response res;
    try {
      res = await switch (method) {
        'POST' => _client.post(
          uri,
          headers: _headers,
          body: jsonEncode(body ?? const {}),
        ),
        _ => _client.get(uri, headers: _headers),
      }.timeout(_timeout);
    } catch (e) {
      // Network, DNS, TLS, timeout. All the same thing to a chef, and all
      // recovered the same way — by the poll, a moment later.
      throw KitchenApiError('The back office cannot be reached right now.');
    }

    if (res.statusCode >= 200 && res.statusCode < 300) {
      if (res.body.isEmpty) return null;
      return jsonDecode(res.body);
    }

    // 401 is the credential; 402 is a paused office, which is also a sign-out
    // as far as this screen is concerned — it cannot be recovered from here and
    // the message says who to ring.
    throw KitchenApiError(
      _messageFrom(res),
      status: res.statusCode,
      signedOut: res.statusCode == 401 || res.statusCode == 402,
    );
  }

  static String _messageFrom(http.Response res) {
    try {
      final message = (jsonDecode(res.body) as Map<String, dynamic>)['error'];
      if (message is String && message.isNotEmpty) return message;
    } catch (_) {
      // Not JSON — an nginx error page, most likely. Fall through.
    }
    return 'The back office refused that (HTTP ${res.statusCode}).';
  }
}
