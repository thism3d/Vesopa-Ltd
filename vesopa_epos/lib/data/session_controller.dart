import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import 'vesopa_sso.dart';
import '../main.dart' show apiBaseProvider;

/// Who is signed into this terminal.
class Session {
  const Session({
    this.email,
    this.name,
    this.office,
    this.officeName,
    this.token,
    this.terminalToken,
  });

  final String? email;
  final String? name;

  /// The venue whose catalogue and sales this terminal belongs to, as its
  /// **contact email** — the tenancy key every catalogue read and write is
  /// scoped by. It is an identifier, not a name: never show it to a customer.
  final String? office;

  /// The venue's trading name, for anything a customer sees.
  ///
  /// Separate from [office] because that one is an email address, and printing
  /// it at the top of a receipt put a staff address in the customer's hand.
  final String? officeName;

  final String? token;

  /// The terminal's own long-lived credential, issued once at commissioning.
  ///
  /// Separate from [token], which is a *person's* twelve-hour session and is
  /// useless a day later. This one is what lets the till read its venue's staff
  /// list so a PIN can be checked with no network — see StaffRepository.
  ///
  /// Null on a terminal commissioned before v1.3.1.0. Staff sign-on asks such a
  /// till to be signed in again rather than pretending to work.
  final String? terminalToken;

  bool get signedIn => token != null && office != null;

  /// Whether this terminal can pull its staff list. False on a till whose
  /// session predates the terminal token.
  bool get commissioned => terminalToken != null;

  /// What to print above a receipt. Falls back to the product name rather than
  /// to [office]: a till that has not been told its trading name should say
  /// nothing about the venue rather than leak an email address.
  String get venueName =>
      officeName?.trim().isNotEmpty ?? false ? officeName!.trim() : 'Vesopa';

  static const empty = Session();

  Map<String, dynamic> toJson() => {
        'email': email,
        'name': name,
        'office': office,
        'officeName': officeName,
        'token': token,
        'terminalToken': terminalToken,
      };

  factory Session.fromJson(Map<String, dynamic> json) => Session(
        email: json['email'] as String?,
        name: json['name'] as String?,
        office: json['office'] as String?,
        officeName: json['officeName'] as String?,
        token: json['token'] as String?,
        terminalToken: json['terminalToken'] as String?,
      );
}

class SignInFailed implements Exception {
  SignInFailed(this.message);
  final String message;

  @override
  String toString() => message;
}

/// The terminal's sign-in.
///
/// The till is commissioned by signing in once with a back-office account. That
/// tells it which venue it belongs to — so the office is no longer a build-time
/// flag baked into the APK, and the same binary can be installed in any venue.
///
/// The session is persisted, so the terminal does not demand a password every
/// morning; it is cleared only on an explicit, verified sign-out.
class SessionController extends AsyncNotifier<Session> {
  static const _key = 'session';

  @override
  Future<Session> build() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(_key);
    if (raw == null) return Session.empty;
    try {
      return Session.fromJson(jsonDecode(raw) as Map<String, dynamic>);
    } catch (_) {
      return Session.empty;
    }
  }

  /// Sign in against the back office. Only a successful, live response
  /// commissions the terminal — there is no offline path in, because a terminal
  /// that has never spoken to the server has no catalogue to sell from anyway.
  Future<void> signIn({
    required String apiBase,
    required String email,
    required String password,
  }) async {
    final http.Response res;
    try {
      res = await http
          .post(
            Uri.parse('$apiBase/api/login'),
            headers: {'Content-Type': 'application/json'},
            body: jsonEncode({
              'email': email,
              'password': password,
              // Ask for the terminal's own credential as well as this person's
              // session. It is what staff PIN sign-on reads the staff list
              // with, long after the session token below has expired.
              'terminal': true,
            }),
          )
          .timeout(const Duration(seconds: 15));
    } catch (e) {
      throw SignInFailed(
        'Cannot reach the server at $apiBase.\n'
        'Check the address and the network, then try again.',
      );
    }

    final body = jsonDecode(res.body) as Map<String, dynamic>;

    if (res.statusCode == 401) {
      throw SignInFailed('That email or password is not correct.');
    }
    if (res.statusCode != 200) {
      throw SignInFailed((body['error'] as String?) ?? 'Sign-in failed.');
    }

    // The catalogue is keyed by the office's contact email, and the terminal
    // token is what staff PIN sign-on later reads the staff list with. Both are
    // handled in _adopt, which the Vesopa door uses as well.
    await _adopt(body);
  }

  /// Ask the back office whether a till may be commissioned with a Vesopa
  /// account here.
  ///
  /// Asked rather than compiled in. A till in a venue is updated through a
  /// store release that may be weeks behind the server, so a button baked into
  /// this build would keep offering an option the server had turned off — and
  /// the flag is the whole rollback plan.
  static Future<VesopaOption> option(String apiBase) async {
    try {
      final res = await http
          .get(Uri.parse('$apiBase/api/terminal/vesopa/enabled'))
          .timeout(const Duration(seconds: 8));
      if (res.statusCode != 200) return const VesopaOption.off();
      final body = jsonDecode(res.body) as Map<String, dynamic>;
      if (body['enabled'] != true) return const VesopaOption.off();
      return VesopaOption(
        enabled: true,
        // Absent means false, which is a back office that has not been updated
        // — and that venue keeps the email and password fields it has always
        // had rather than being left with a screen it cannot use.
        only: body['only'] == true,
        issuer: body['issuer'] as String,
        clientId: body['clientId'] as String,
      );
    } catch (_) {
      // A till with no signal cannot be commissioned by any route, so there is
      // nothing to say here beyond hiding a button that would not work.
      return const VesopaOption.off();
    }
  }

  /// Commission this terminal with a Vesopa account.
  ///
  /// The till proves who the person is to `auth.vesopa.com` itself, then hands
  /// the resulting identity token to the back office, which decides what that
  /// is worth and issues the SAME pair of tokens the password form issues. From
  /// [Session] downwards nothing can tell which door was used, which is what
  /// keeps this an addition rather than a second system.
  Future<void> signInWithVesopa({
    required String apiBase,
    required VesopaOption via,
    void Function(Uri url)? onUrl,
  }) async {
    final idToken = await VesopaSso(issuer: via.issuer, clientId: via.clientId)
        .authorize(onUrl: onUrl);

    final http.Response res;
    try {
      res = await http
          .post(
            Uri.parse('$apiBase/api/terminal/vesopa/commission'),
            headers: {'Content-Type': 'application/json'},
            body: jsonEncode({'id_token': idToken}),
          )
          .timeout(const Duration(seconds: 20));
    } catch (e) {
      throw SignInFailed(
        'Signed in with Vesopa, but the till could not reach $apiBase to finish.\n'
        'Check the network and try again.',
      );
    }

    final body = jsonDecode(res.body) as Map<String, dynamic>;
    if (res.statusCode != 200) {
      throw SignInFailed((body['error'] as String?) ?? 'The back office refused that sign-in.');
    }

    await _adopt(body);
  }

  /// Take a `/api/login`-shaped response and become that session.
  ///
  /// Shared by both doors on purpose: the office rule and the terminal token
  /// are read in ONE place, so the Vesopa route cannot quietly end up with a
  /// laxer version of either.
  Future<void> _adopt(Map<String, dynamic> body) async {
    final user = body['user'] as Map<String, dynamic>;

    final office = (user['officeEmail'] ?? user['email']) as String?;
    if (office == null) {
      throw SignInFailed('This account is not attached to an office.');
    }

    final session = Session(
      email: user['email'] as String?,
      name: user['name'] as String?,
      office: office,
      officeName: user['officeName'] as String?,
      token: body['token'] as String?,
      terminalToken: body['terminalToken'] as String?,
    );

    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_key, jsonEncode(session.toJson()));
    state = AsyncData(session);
  }

  /// Clear the session. The caller is responsible for having verified the
  /// password and flushed the outbox first — see AuthService.
  Future<void> signOut() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_key);
    state = const AsyncData(Session.empty);
  }
}

/// Whether the back office will accept a Vesopa account for commissioning, and
/// what to use if it will.
class VesopaOption {
  const VesopaOption({
    required this.enabled,
    required this.issuer,
    required this.clientId,
    this.only = false,
  });

  const VesopaOption.off()
      : enabled = false,
        only = false,
        issuer = '',
        clientId = '';

  final bool enabled;

  /// Whether this is the ONLY way to commission a terminal.
  ///
  /// The venue's own decision, answered by the back office rather than built
  /// in, so turning it off is a flag and a restart rather than a Store
  /// release — see /api/terminal/vesopa/enabled.
  ///
  /// There is no offline argument for keeping the password form here, and it
  /// is worth saying why: BOTH doors post to the back office. This screen is
  /// shown once, on first run, to commission a terminal against a venue, and a
  /// terminal with no network cannot be commissioned by any route. What a till
  /// does when the broadband drops mid-service is a different question, with a
  /// different answer — it carries on selling from its local database.
  final bool only;

  final String issuer;
  final String clientId;
}

/// What the back office says about signing in with a Vesopa account.
///
/// A provider rather than a call from the page's `initState`, so the two
/// shapes this screen takes — with the password fields and without — can each
/// be built in a test by overriding one thing. That was the practical
/// difference between "the sign-in page is covered" and "somebody will find
/// out at a venue".
///
/// Answers "off" when the back office cannot be reached, which leaves the page
/// exactly as it was before any of this existed.
final vesopaOptionProvider = FutureProvider<VesopaOption>(
  (ref) => SessionController.option(ref.watch(apiBaseProvider)),
);

final sessionControllerProvider =
    AsyncNotifierProvider<SessionController, Session>(SessionController.new);
