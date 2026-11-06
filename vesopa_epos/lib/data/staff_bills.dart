import 'order_repository.dart';
import 'table_repository.dart';

/// Who holds which bill on this till, as the person at it changes.
///
/// Nicki, Pontardawe RFC: each order is per member of staff. Whoever signs on
/// sees the bill they left, or a blank one, and never anyone else's. The bill
/// on screen is held for the person leaving, in their name, and comes back the
/// moment they use their PIN again.
///
/// [held] is staff id to bill id, and is updated in place. Returns the bill to
/// switch to, and whether the bill on screen has to go when there is none.
Future<({String? target, bool leave})> handOverBill({
  required OrderRepository orders,
  required TableRepository tables,
  required Map<String, String> held,
  required String? onScreen,
  required int? previous,
  required int? next,
}) async {
  if (previous != null && onScreen != null) {
    final order = await orders.orderOnce(onScreen);
    final lines = await orders.linesOnce(onScreen);
    if (order != null && order.status == 'open' && lines.isNotEmpty) {
      held['$previous'] = onScreen;
      // A table's bill also goes back on the plan, where anyone can still open
      // it on purpose.
      final table = order.tableNumber;
      if (table != null) await tables.park(onScreen, table, roomId: order.roomId);
    }
  }

  String? target;
  if (next != null) {
    final mine = held.remove('$next');
    if (mine != null && mine == onScreen) {
      target = mine;
    } else if (mine != null) {
      final order = await orders.orderOnce(mine);
      final lines = await orders.linesOnce(mine);
      if (order != null && const ['open', 'parked'].contains(order.status) && lines.isNotEmpty) {
        target = mine;
      }
    }
  }

  final leave = onScreen != null && held.values.contains(onScreen);
  return (target: target, leave: leave);
}
