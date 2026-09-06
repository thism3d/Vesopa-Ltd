import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

/// A table as laid out in the back office designer.
class FloorTable {
  const FloorTable({
    this.id,
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

  /// The back office's own id for this table.
  ///
  /// The number is what staff call it and the id is what addresses it. They are
  /// not interchangeable: a number is unique only within a room, and moving a
  /// table between rooms or renumbering it changes the number while the row
  /// stays the same. Saving a rearrangement has to name the row.
  ///
  /// Nullable for a plan cached by an older release, which stored no ids —
  /// such a table simply cannot be saved until the plan is fetched again.
  final int? id;

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
        id: (json['id'] as num?)?.toInt(),
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
        if (id != null) 'id': id,
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
/// Something the back office refused, with the reason it gave.
///
/// Thrown rather than returned false, because every one of these has something
/// specific to say — "there is already a table called Window", "that room is
/// not yours" — and a screen that says "could not save" instead is a screen
/// somebody presses again.
class FloorSaveFailed implements Exception {
  const FloorSaveFailed(this.message);
  final String message;
  @override
  String toString() => message;
}

class FloorRepository {
  FloorRepository({
    required this.apiBase,
    required this.cache,
    required this.office,
    this.terminalToken,
  });

  final String apiBase;
  final FloorCache cache;

  /// Which venue's plan to fetch — a till must not show another venue's rooms.
  final String office;

  /// What this terminal was commissioned with.
  ///
  /// Reading the plan needs nothing; changing it needs this. The server takes
  /// the venue from inside the token rather than from anything sent with the
  /// request, so a till can only ever rewrite its own floor — which is the
  /// whole reason editing can be offered on a device that sits on a counter.
  ///
  /// Null on a till that has not been commissioned. The editor is not offered
  /// there rather than offered and then failing.
  final String? terminalToken;

  bool get canEdit => (terminalToken ?? '').isNotEmpty;

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

  // -------------------------------------------------------------------------
  // Changing the plan
  // -------------------------------------------------------------------------
  //
  // None of these touches the cache. The server broadcasts floor.updated on
  // every one of them and the provider reloads from that, so the plan on screen
  // comes back the way the server actually stored it — including anything it
  // clamped or refused. Writing the optimistic version into the cache as well
  // would leave a till showing a layout no other screen agrees with.

  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ${terminalToken ?? ''}',
      };

  Never _refuse(http.Response res) {
    String message;
    try {
      message = (jsonDecode(res.body) as Map<String, dynamic>)['error']
              as String? ??
          'The back office would not save that.';
    } catch (_) {
      message = res.statusCode == 401
          ? 'This till needs to be signed in again before it can change the plan.'
          : 'The back office would not save that.';
    }
    throw FloorSaveFailed(message);
  }

  /// Where the tables are, after a rearrangement.
  ///
  /// Sent as one request rather than one per table: a manager moving a dozen
  /// tables would otherwise fire a dozen writes, and half of them landing is a
  /// plan that matches neither the screen nor what was there before. The server
  /// puts them in a transaction for the same reason.
  Future<void> saveTables(List<FloorTable> tables) async {
    if (tables.isEmpty) return;
    final res = await http
        .put(
          Uri.parse('$apiBase/till/floor/tables'),
          headers: _headers,
          body: jsonEncode({
            'tables': [
              // A table with no id came out of a cache written by an older
              // release and cannot be addressed. Skipped rather than sent with
              // a null id, which the server would read as table 0.
              for (final t in tables.where((t) => t.id != null))
                {
                  'id': t.id,
                  'pos_x': t.x,
                  'pos_y': t.y,
                  'width': t.width,
                  'height': t.height,
                  'shape': t.shape,
                  'seats': t.seats,
                  'colour': t.colour,
                },
            ],
          }),
        )
        .timeout(const Duration(seconds: 10));
    if (res.statusCode != 200) _refuse(res);
  }

  /// A new table, put down where somebody is standing.
  Future<int> addTable({
    required int roomId,
    required int tableNumber,
    required int x,
    required int y,
    required int width,
    required int height,
    required String shape,
    required int seats,
    String? name,
  }) async {
    final res = await http
        .post(
          Uri.parse('$apiBase/till/floor/tables'),
          headers: _headers,
          body: jsonEncode({
            'room_id': roomId,
            'table_number': tableNumber,
            'pos_x': x,
            'pos_y': y,
            'width': width,
            'height': height,
            'shape': shape,
            'seats': seats,
            if (name != null && name.trim().isNotEmpty) 'name': name.trim(),
          }),
        )
        .timeout(const Duration(seconds: 10));
    if (res.statusCode != 201) _refuse(res);
    return (jsonDecode(res.body) as Map<String, dynamic>)['id'] as int;
  }

  /// The shape of the room, walked out on the floor it describes.
  ///
  /// A null outline is a real answer and not a missing one: it means "no shape
  /// of its own", which is the plain rectangle every room was before any of
  /// this existed. So it is sent explicitly rather than omitted.
  Future<void> saveRoomShape(int roomId, List<List<int>>? outline) async {
    final res = await http
        .put(
          Uri.parse('$apiBase/till/floor/rooms/$roomId'),
          headers: _headers,
          body: jsonEncode({'outline': outline}),
        )
        .timeout(const Duration(seconds: 10));
    if (res.statusCode != 200) _refuse(res);
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
