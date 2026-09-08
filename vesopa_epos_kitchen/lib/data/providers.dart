import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config/constants.dart';
import 'dinein_inbox.dart';
import 'kitchen_api.dart';
import 'kitchen_session.dart';
import 'notifications.dart';
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

/// The QR orders nobody has picked up yet.
final dineInInboxProvider = NotifierProvider<DineInInbox, DineInInboxState>(
  DineInInbox.new,
);

/// Windows toasts, and the two-layer rule about who may set one off.
///
/// One instance, like the API client, because the back office's policy is
/// fetched onto it and a second instance would be a second, permissive copy
/// that had never heard of the venue's settings.
final notificationsProvider = Provider<AppNotifications>(
  (_) => AppNotifications(appName: VesopaBrand.appName),
);

/// Allergen codes to the words a person reads.
///
/// Fetched once from the server rather than listed in this app, so the board,
/// the QR menu, the back office and the customer display cannot drift into
/// four spellings of the same allergen. An empty map — a screen that has not
/// reached the server yet — means the board shows the codes it has rather than
/// nothing at all.
final allergenLabelsProvider = FutureProvider<Map<String, String>>((ref) async {
  try {
    return await ref.watch(kitchenApiProvider).allergenLabels();
  } catch (_) {
    return const {};
  }
});
