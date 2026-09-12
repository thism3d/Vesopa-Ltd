import 'dart:async';
import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;

import '../main.dart' show apiBaseProvider;
import 'session_controller.dart';
import 'staff_session.dart';

/// The practice venue this till is talking to while a trainee is signed on.
///
/// WHY A SECOND TOKEN AND NOT A FLAG ON EACH REQUEST
///
/// A header saying "this one is practice" is one forgotten check away from a
/// rehearsal landing in the real ledger. A token is not: this one *names the
/// practice venue*, so every repository that sends it is incapable of reaching
/// the live one. Nothing else on the till has to learn that demo venues exist —
/// `sessionProvider` swaps this in and the rest of the app carries on.
///
/// It is short-lived (twelve hours) where the terminal's own credential lasts
/// ten years, because a practice session is an afternoon and a long credential
/// for a venue nobody watches is one worth stealing.
class DemoVenue {
  const DemoVenue({
    required this.token,
    required this.office,
    required this.officeName,
  });

  /// A terminal token scoped to the practice venue. Holds no licence seat.
  final String token;

  /// The practice venue's tenancy key. An address that cannot be delivered to.
  final String office;

  /// What it is called on screen — the live venue's name with "Demo" on it.
  final String officeName;
}

/// Fetches the practice venue's token when a training account signs on, and
/// lets go of it when they sign off.
///
/// Answers null for everybody else, which is every real sale: a till only ever
/// leaves the live venue for as long as a trainee is standing at it.
class DemoSessionController extends AsyncNotifier<DemoVenue?> {
  @override
  Future<DemoVenue?> build() async {
    final staff = ref.watch(staffSessionProvider).staff;
    if (staff == null || !staff.training) return null;

    // The LIVE session on purpose, not `sessionProvider` — that one is about to
    // be this, and watching it here would be a cycle.
    final live = ref.watch(sessionControllerProvider).value;
    final terminalToken = live?.terminalToken;
    if (terminalToken == null) return null;

    final base = ref.watch(apiBaseProvider);
    try {
      final res = await http
          .post(
            Uri.parse('$base/till/demo/token'),
            headers: {
              'Authorization': 'Bearer $terminalToken',
              'Content-Type': 'application/json',
            },
            body: jsonEncode({'staff_id': staff.id}),
          )
          .timeout(const Duration(seconds: 10));
      if (res.statusCode != 200) return null;
      final body = jsonDecode(res.body) as Map<String, dynamic>;
      final token = body['token'] as String?;
      final venue = body['venue'] as Map<String, dynamic>?;
      if (token == null || venue == null) return null;
      return DemoVenue(
        token: token,
        office: (venue['email'] as String?) ?? '',
        officeName: (venue['name'] as String?) ?? 'Demo',
      );
    } catch (_) {
      // Offline, or a server too old to have practice venues. The till stays on
      // the live venue's key — which is safe, because a practice bill is marked
      // as one and is never queued from here, and the server throws away any
      // that reaches it anyway (src/training.js). Practice still works with the
      // broadband down; it simply has nowhere to be reported until it is back.
      return null;
    }
  }
}

final demoSessionProvider =
    AsyncNotifierProvider<DemoSessionController, DemoVenue?>(
  DemoSessionController.new,
);

/// Whether this till is currently working in a practice venue.
///
/// Not the same question as [trainingModeProvider]: a trainee is signed on the
/// moment they touch their PIN, but the till is only *in* the practice venue
/// once its token has arrived. Anything that must not reach the live venue asks
/// the first; anything that reports where practice went asks this.
final inDemoVenueProvider = Provider<bool>(
  (ref) => ref.watch(demoSessionProvider).value != null,
);
