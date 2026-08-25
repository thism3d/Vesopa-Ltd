import 'dart:convert';

import 'package:flutter/material.dart' show Color;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import '../main.dart';

/// The venue's own sale-screen layouts, as the till reads them.
///
/// See `docs/screen-programming.md` for the model. The short version: a screen
/// is a grid of buttons, and every button is one of four things — a product, a
/// jump to another screen, a till function, or nothing.
///
/// **A venue that has programmed nothing has none of these**, and that is the
/// normal case rather than an error. The sale page then draws what it has
/// always drawn: departments down the rail, products in the grid, straight off
/// the catalogue. See [SalePage] and the `homeScreenId` note on `TillSettings`.

/// What a button does when a clerk presses it.
enum ScreenButtonKind {
  product,
  page,
  function,

  /// Anything this build does not recognise.
  ///
  /// Not an error: the server stores `kind` as a string precisely so a till
  /// running an older release meets a newer button and ignores it, rather than
  /// failing to parse the screen and showing a clerk nothing at all.
  unknown;

  static ScreenButtonKind fromKey(String? key) => switch (key) {
    'product' => product,
    'page' => page,
    'function' => function,
    _ => unknown,
  };
}

class ScreenButton {
  const ScreenButton({
    required this.row,
    required this.col,
    this.rowSpan = 1,
    this.colSpan = 1,
    this.kind = ScreenButtonKind.unknown,
    this.pluId,
    this.targetScreenId,
    this.functionKey,
    this.label,
    this.fill,
    this.ink,
  });

  final int row;
  final int col;
  final int rowSpan;
  final int colSpan;

  final ScreenButtonKind kind;

  /// Set when [kind] is `product`. The catalogue's PLU.
  final int? pluId;

  /// Set when [kind] is `page`.
  final int? targetScreenId;

  /// Set when [kind] is `function`.
  final String? functionKey;

  /// The venue's own wording. Null means "use the product's or screen's name",
  /// which is what makes renaming a product in the back office rename its key.
  final String? label;

  final Color? fill;
  final Color? ink;

  factory ScreenButton.fromJson(Map<String, dynamic> j) => ScreenButton(
    row: (j['row'] as num?)?.toInt() ?? 0,
    col: (j['col'] as num?)?.toInt() ?? 0,
    rowSpan: ((j['rowSpan'] as num?)?.toInt() ?? 1).clamp(1, 10),
    colSpan: ((j['colSpan'] as num?)?.toInt() ?? 1).clamp(1, 12),
    kind: ScreenButtonKind.fromKey(j['kind'] as String?),
    pluId: (j['pluId'] as num?)?.toInt(),
    targetScreenId: (j['targetScreenId'] as num?)?.toInt(),
    functionKey: (j['functionKey'] as String?)?.trim(),
    label: (j['label'] as String?)?.trim(),
    fill: _colour(j['fill']),
    ink: _colour(j['ink']),
  );

  Map<String, dynamic> toJson() => {
    'row': row,
    'col': col,
    'rowSpan': rowSpan,
    'colSpan': colSpan,
    'kind': kind.name,
    if (pluId != null) 'pluId': pluId,
    if (targetScreenId != null) 'targetScreenId': targetScreenId,
    if (functionKey != null) 'functionKey': functionKey,
    if (label != null) 'label': label,
    if (fill != null) 'fill': _hex(fill!),
    if (ink != null) 'ink': _hex(ink!),
  };

  /// `#RRGGBB` to a colour, and null for anything else.
  ///
  /// Null rather than a throw, because this string was typed into a form in an
  /// office and this code runs on a counter. A colour nobody can parse has to
  /// come out as "the till picks", not as a screen that will not draw.
  static Color? _colour(Object? raw) {
    final text = '${raw ?? ''}'.trim().replaceFirst('#', '');
    if (text.length != 6) return null;
    final value = int.tryParse(text, radix: 16);
    return value == null ? null : Color(0xFF000000 | value);
  }

  static String _hex(Color c) {
    int ch(double v) => (v * 255).round().clamp(0, 255);
    return '#'
        '${ch(c.r).toRadixString(16).padLeft(2, '0')}'
        '${ch(c.g).toRadixString(16).padLeft(2, '0')}'
        '${ch(c.b).toRadixString(16).padLeft(2, '0')}';
  }
}

/// One page of buttons.
class TillScreen {
  const TillScreen({
    required this.id,
    required this.name,
    this.rows = 5,
    this.cols = 6,
    this.buttons = const [],
  });

  final int id;
  final String name;
  final int rows;
  final int cols;
  final List<ScreenButton> buttons;

  /// The button drawn at a cell, if any.
  ScreenButton? at(int row, int col) {
    for (final b in buttons) {
      if (b.row == row && b.col == col) return b;
    }
    return null;
  }

  /// Cells swallowed by a spanning button, so a 2x2 leaves one key rather than
  /// one key and three holes.
  Set<String> get covered {
    final covered = <String>{};
    for (final b in buttons) {
      for (var r = b.row; r < b.row + b.rowSpan; r++) {
        for (var c = b.col; c < b.col + b.colSpan; c++) {
          if (r != b.row || c != b.col) covered.add('$r:$c');
        }
      }
    }
    return covered;
  }

  factory TillScreen.fromJson(Map<String, dynamic> j) => TillScreen(
    id: (j['id'] as num?)?.toInt() ?? 0,
    name: (j['name'] as String?)?.trim() ?? '',
    rows: ((j['rows'] as num?)?.toInt() ?? 5).clamp(1, 10),
    cols: ((j['cols'] as num?)?.toInt() ?? 6).clamp(1, 12),
    buttons: ((j['buttons'] as List?) ?? const [])
        .cast<Map<String, dynamic>>()
        .map(ScreenButton.fromJson)
        .toList(),
  );

  Map<String, dynamic> toJson() => {
    'id': id,
    'name': name,
    'rows': rows,
    'cols': cols,
    'buttons': [for (final b in buttons) b.toJson()],
  };
}

/// Every screen this venue has.
///
/// All of them, not just the home one, because a page button jumps to another
/// screen and a till that fetched it at the moment of the tap would show a
/// clerk a blank grid while it did.
class ScreenSet {
  const ScreenSet(this.screens);

  final List<TillScreen> screens;

  static const empty = ScreenSet([]);

  bool get isEmpty => screens.isEmpty;

  TillScreen? byId(int? id) {
    if (id == null) return null;
    for (final s in screens) {
      if (s.id == id) return s;
    }
    return null;
  }

  factory ScreenSet.fromJson(Map<String, dynamic> j) => ScreenSet(
    ((j['screens'] as List?) ?? const [])
        .cast<Map<String, dynamic>>()
        .map(TillScreen.fromJson)
        .toList(),
  );

  Map<String, dynamic> toJson() => {
    'screens': [for (final s in screens) s.toJson()],
  };
}

/// Fetches the venue's screens, and remembers the last set that arrived.
///
/// Cached for the same reason the catalogue is: a till that has just been
/// switched on, on a venue's wifi, must be able to ring up a sale before the
/// network has settled. A layout that needs the server to be up is a layout
/// nobody sees on the one morning the line is down.
class ScreensRepository {
  ScreensRepository({required this.apiBase, http.Client? client})
    : _client = client ?? http.Client();

  final String apiBase;
  final http.Client _client;

  static const _key = 'vesopa_till_screens';

  Future<ScreenSet> load(String office) async {
    try {
      final res = await _client
          .get(Uri.parse('$apiBase/api/till/screens?office=$office'))
          .timeout(const Duration(seconds: 8));
      if (res.statusCode != 200) return _cached();

      final set = ScreenSet.fromJson(
        jsonDecode(res.body) as Map<String, dynamic>,
      );
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_key, jsonEncode(set.toJson()));
      return set;
    } catch (_) {
      // Offline, or a server mid-deploy. The cached layout carries on working;
      // there is nothing here worth failing a sale over.
      return _cached();
    }
  }

  Future<ScreenSet> _cached() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(_key);
      if (raw == null || raw.isEmpty) return ScreenSet.empty;
      return ScreenSet.fromJson(jsonDecode(raw) as Map<String, dynamic>);
    } catch (_) {
      // A cache written by a different release, or half-written. Falls back to
      // the built-in Default rather than taking the till down.
      return ScreenSet.empty;
    }
  }
}

final screensRepositoryProvider = Provider<ScreensRepository>(
  (ref) => ScreensRepository(apiBase: ref.watch(apiBaseProvider)),
);

/// The venue's screens, refreshed when the office changes — and when the back
/// office says a layout has.
///
/// The push half is not an optimisation. Without it these were fetched once, at
/// sign-on, and never again: a manager could lay out a page, watch the back
/// office confirm the save, and find every till in the building still showing
/// the old one until somebody restarted the app. That is the whole point of
/// programming a screen from an office, and it did not work.
///
/// `screens` is the layout itself. `till-settings` is which screen a till opens
/// on, and it is listened for here too — changing the home screen changes what
/// this venue's tills draw just as much as moving a key does, and the settings
/// row is fetched by a different provider that cannot invalidate this one.
final screensProvider = FutureProvider<ScreenSet>((ref) async {
  ref.listen(syncEventsProvider, (_, next) {
    final type = next.value?.type;
    if (type == 'screens' || type == 'till-settings') ref.invalidateSelf();
  });

  final office = ref.watch(officeProvider);
  if (office.isEmpty) return ScreenSet.empty;
  return ref.watch(screensRepositoryProvider).load(office);
});
