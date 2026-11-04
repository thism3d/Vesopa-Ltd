/// The kitchen board's providers, as the copied code (tool/sync_go_modes.py)
/// expects them, over Go's server and Go's kitchen session.
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'dinein_inbox.dart';
import 'kitchen_api.dart';
import 'kitchen_constants.dart';
import 'kitchen_session.dart';
import 'ticket_board.dart';

final apiBaseProvider = Provider<String>((_) => Api.resolvedBase);
final wsUrlProvider = Provider<String>((_) => Api.resolvedWs);

final kitchenApiProvider = Provider<KitchenApi>((ref) => KitchenApi(apiBase: ref.watch(apiBaseProvider)));

final kitchenSessionProvider = AsyncNotifierProvider<KitchenSessionController, KitchenSession>(KitchenSessionController.new);

final ticketBoardProvider = NotifierProvider<TicketBoard, BoardState>(TicketBoard.new);

final dineInInboxProvider = NotifierProvider<DineInInbox, DineInInboxState>(DineInInbox.new);

final allergenLabelsProvider = FutureProvider<Map<String, String>>((ref) async {
  try {
    return await ref.watch(kitchenApiProvider).allergenLabels();
  } catch (_) {
    return const {};
  }
});
