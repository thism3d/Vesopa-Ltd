/// What a table is called, on the till, on receipts and on the open-bills strip.
///
/// Nicky, Pontardawe RFC, 2026-11-24: "Table Plan, Allow Table 1, table 2 etc
/// to be created in different locations e.g. Bar 1, Bar 2, Lounge 1, Lounge 2."
/// Table numbers already start again in each room, but every screen called them
/// all "Table 1", so two parties on two Table 1s could not be told apart.
///
///   * A table given its own name in the designer ("Window") is called that.
///   * In a venue with more than one room: the room and the number, "Bar 1".
///   * Otherwise, as always: "Table 1".
library;

import 'floor_repository.dart';

String tableName(List<FloorRoom> rooms, int? number, {int? roomId}) {
  if (number == null) return '';
  FloorRoom? room;
  if (roomId != null) {
    for (final r in rooms) {
      if (r.id == roomId) room = r;
    }
  }
  // A bill saved before rooms were recorded: the room is the only one that
  // has a table with that number, when exactly one does.
  if (room == null) {
    final having = [for (final r in rooms) if (r.tables.any((t) => t.number == number)) r];
    if (having.length == 1) room = having.single;
  }
  if (room != null) {
    for (final t in room.tables) {
      final label = t.label?.trim() ?? '';
      if (t.number == number && label.isNotEmpty) return label;
    }
    final name = room.name.trim();
    if (rooms.length > 1 && name.isNotEmpty) return '$name $number';
  }
  return 'Table $number';
}
