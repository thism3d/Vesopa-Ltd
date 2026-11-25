// Tables by room (Nicky, Pontardawe RFC, 2026-11-24): "Allow Table 1, table 2
// etc to be created in different locations e.g. Bar 1, Bar 2, Lounge 1,
// Lounge 2."
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/floor_repository.dart';
import 'package:vesopa_epos/data/table_names.dart';

FloorTable _t(int n, {String? label}) => FloorTable(
      number: n, label: label, x: 0, y: 0, width: 2, height: 2, shape: 'rect', seats: 4);

void main() {
  final bar = FloorRoom(id: 1, name: 'Bar', tables: [_t(1), _t(2, label: 'Window')]);
  final lounge = FloorRoom(id: 2, name: 'Lounge', tables: [_t(1), _t(5)]);

  test('in a venue with rooms, a table is its room and number', () {
    expect(tableName([bar, lounge], 1, roomId: 1), 'Bar 1');
    expect(tableName([bar, lounge], 1, roomId: 2), 'Lounge 1');
  });

  test('a table with its own name keeps it', () {
    expect(tableName([bar, lounge], 2, roomId: 1), 'Window');
  });

  test('an old bill with no room finds the one room that has the number', () {
    expect(tableName([bar, lounge], 5), 'Lounge 5');
    expect(tableName([bar, lounge], 1), 'Table 1', reason: 'two rooms have a 1: no guess');
  });

  test('one room, or no plan: Table N as always', () {
    expect(tableName([bar], 1, roomId: 1), 'Table 1');
    expect(tableName(const [], 7), 'Table 7');
  });
}
