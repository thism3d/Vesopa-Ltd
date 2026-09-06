import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

/// A table as laid out in the back office designer.
class FloorTable {
  const FloorTable({
    required this.number,
    required this.label,
    required this.x,
    required this.y,
    required this.width,
    required this.height,
    required this.shape,
    required this.seats,
    this.colour,
  });

  final int number;
  final String? label;
  final int x;
  final int y;
  final int width;
  final int height;
  final String shape;
  final int seats;

  /// What the venue painted this one, as "#RRGGBB", or null for the default.
  ///
  /// Set in the designer for the tables worth picking out — the window seats,
  /// the booths. Null is not a missing value: it means this table takes the
  /// till's own colours, which is what every table did before there was a
  /// picker at all.
  final String? colour;

  bool get isCircle => shape == 'circle';

  factory FloorTable.fromJson(Map<String, dynamic> json) => FloorTable(
        number: json['table_number'] as int,
        label: json['label'] as String?,
        x: json['pos_x'] as int? ?? 0,
        y: json['pos_y'] as int? ?? 0,
        width: json['width'] as int? ?? 2,
        height: json['height'] as int? ?? 2,
        shape: json['shape'] as String? ?? 'rect',
        seats: json['seats'] as int? ?? 4,
        colour: json['colour'] as String?,
      );

  Map<String, dynamic> toJson() => {
        'table_number': number,
        'label': label,
        'pos_x': x,
        'pos_y': y,
        'width': width,
        'height': height,
        'shape': shape,
        'seats': seats,
        if (colour != null) 'colour': colour,
      };
}

class FloorRoom {
  const FloorRoom({
    required this.name,
    required this.tables,
    this.id,
    this.outline,
    this.floorColour,
    this.wallColour,
  });

  /// The back office's id for this room.
  ///
  /// Kept because a table number is only unique within a room, so a bill has to
  /// record which room it is sitting in — the name would do it too, until
  /// somebody renames "Terrace" to "Garden" mid-service and every parked bill
  /// on it stops resolving.
  ///
  /// Nullable for a plan cached by an older release, which stored no ids.
  final int? id;

  final String name;
  final List<FloorTable> tables;

  /// The corners of the room, walked round, in grid squares — or null for a
  /// plain rectangle.
  ///
  /// Real rooms are not boxes. An L wrapping a corner is the commonest floor in
  /// the trade, and a member of staff carrying two plates is navigating by the
  /// shape of the room rather than by a grid of numbered squares. The back
  /// office draws this by walking the actual corners; this is the till reading
  /// the same thing.
  final List<List<int>>? outline;

  /// The carpet and the walls, as "#RRGGBB", or null for the till's own.
  final String? floorColour;
  final String? wallColour;

  /// The outline, however it arrives.
  ///
  /// The back office stores it as JSON text in a column and hands the column
  /// back untouched, so over the wire it is a String; out of this app's own
  /// cache it has already been decoded and is a List. Both are read, and
  /// anything unreadable becomes null rather than throwing — a room whose
  /// shape cannot be parsed is a rectangle, which is what every room was
  /// before shapes existed, and is a great deal better than a till that will
  /// not open its floor screen.
  static List<List<int>>? _outlineFrom(dynamic raw) {
    if (raw == null) return null;
    try {
      final decoded = raw is String ? jsonDecode(raw) : raw;
      if (decoded is! List || decoded.length < 3) return null;
      final points = <List<int>>[];
      for (final point in decoded) {
        if (point is! List || point.length < 2) return null;
        final x = (point[0] as num?)?.round();
        final y = (point[1] as num?)?.round();
        if (x == null || y == null) return null;
        points.add([x, y]);
      }
      return points;
    } catch (_) {
      return null;
    }
  }

  factory FloorRoom.fromJson(Map<String, dynamic> json) => FloorRoom(
        id: (json['id'] as num?)?.toInt(),
        name: json['name'] as String? ?? 'Room',
        tables: (json['tables'] as List<dynamic>? ?? [])
            .cast<Map<String, dynamic>>()
            .map(FloorTable.fromJson)
            .toList(),
        outline: _outlineFrom(json['outline']),
        floorColour: json['floor_colour'] as String?,
        wallColour: json['wall_colour'] as String?,
      );

  Map<String, dynamic> toJson() => {
        if (id != null) 'id': id,
        'name': name,
        'tables': [for (final t in tables) t.toJson()],
        // Cached as a list rather than re-encoded to text: this map is about to
        // be JSON-encoded whole, and a string of JSON inside JSON would come
        // back double-escaped.
        if (outline != null) 'outline': outline,
        if (floorColour != null) 'floor_colour': floorColour,
        if (wallColour != null) 'wall_colour': wallColour,
      };
}

/// The floor plan drawn in the back office.
///
/// Cached to the local database on every successful fetch, so the till still
/// shows the right room after the network goes down — the plan is exactly the
/// thing a waiter needs when the wifi drops mid-service.
class FloorRepository {
  FloorRepository({
    required this.apiBase,
    required this.cache,
    required this.office,
  });

  final String apiBase;
  final FloorCache cache;

  /// Which venue's plan to fetch — a till must not show another venue's rooms.
  final String office;

  Future<List<FloorRoom>> load() async {
    try {
      final res = await http
          .get(
            Uri.parse(
              '$apiBase/till/floor?office=${Uri.encodeComponent(office)}',
            ),
          )
          .timeout(const Duration(seconds: 8));

      if (res.statusCode == 200) {
        final rooms = (jsonDecode(res.body) as List<dynamic>)
            .cast<Map<String, dynamic>>()
            .map(FloorRoom.fromJson)
            .toList();
        await cache.save(rooms);
        return rooms;
      }
    } catch (_) {
      // Offline: fall through to whatever plan we last saw.
    }
    return cache.load();
  }
}

/// Where the plan is kept between sessions.
abstract class FloorCache {
  Future<void> save(List<FloorRoom> rooms);
  Future<List<FloorRoom>> load();
}

class PrefsFloorCache implements FloorCache {
  PrefsFloorCache(this._prefs, {this.office = ''});

  final SharedPreferences _prefs;

  /// Keyed per venue, so a terminal that is re-commissioned to another office
  /// cannot render the previous office's floor plan from cache.
  final String office;

  String get _key => 'floor_plan:$office';

  @override
  Future<void> save(List<FloorRoom> rooms) async {
    await _prefs.setString(
      _key,
      jsonEncode([for (final r in rooms) r.toJson()]),
    );
  }

  @override
  Future<List<FloorRoom>> load() async {
    final raw = _prefs.getString(_key);
    if (raw == null) return const [];
    try {
      return (jsonDecode(raw) as List<dynamic>)
          .cast<Map<String, dynamic>>()
          .map(FloorRoom.fromJson)
          .toList();
    } catch (_) {
      // A corrupt cache must not stop the till opening.
      return const [];
    }
  }
}
