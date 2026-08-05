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
  });

  final int number;
  final String? label;
  final int x;
  final int y;
  final int width;
  final int height;
  final String shape;
  final int seats;

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
      };
}

class FloorRoom {
  const FloorRoom({required this.name, required this.tables});

  final String name;
  final List<FloorTable> tables;

  factory FloorRoom.fromJson(Map<String, dynamic> json) => FloorRoom(
        name: json['name'] as String? ?? 'Room',
        tables: (json['tables'] as List<dynamic>? ?? [])
            .cast<Map<String, dynamic>>()
            .map(FloorTable.fromJson)
            .toList(),
      );

  Map<String, dynamic> toJson() => {
        'name': name,
        'tables': [for (final t in tables) t.toJson()],
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
