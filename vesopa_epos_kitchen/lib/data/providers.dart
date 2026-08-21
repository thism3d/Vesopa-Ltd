import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config/constants.dart';
import 'kitchen_api.dart';
import 'kitchen_session.dart';
import 'ticket_board.dart';

/// Every provider this app has, in one file.
///
/// Deliberately not in `main.dart` — where the till keeps its equivalents —
/// because the session controller and the board each need to read the other,
/// and hanging both off the entry point makes `data/` import `main.dart`. One
/// small file at the bottom of the graph is cheaper than that cycle.

/// Where the server is. See `config/constants.dart` for the switch.
final apiBaseProvider = Provider<String>((_) => Api.resolvedBase);
final wsUrlProvider = Provider<String>((_) => Api.resolvedWs);

/// The one API client.
///
/// One, and not one per call site, because the sign-in token lives on it: a
/// second client would be a second, tokenless client, and whichever call
/// happened to use it would fail with "not signed in" on a screen that plainly
/// is.
final kitchenApiProvider = Provider<KitchenApi>(
  (ref) => KitchenApi(apiBase: ref.watch(apiBaseProvider)),
);

/// Who this screen is signed in as, and which board it is.
final kitchenSessionProvider =
    AsyncNotifierProvider<KitchenSessionController, KitchenSession>(
      KitchenSessionController.new,
    );

/// The tickets.
final ticketBoardProvider = NotifierProvider<TicketBoard, BoardState>(
  TicketBoard.new,
);
