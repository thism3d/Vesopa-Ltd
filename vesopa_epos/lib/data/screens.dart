import 'dart:convert';

import 'package:flutter/material.dart' show Color;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import '../config/constants.dart';
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
    this.emoji,
    this.imageUrl,
    this.fontFamily,
    this.fontSize,
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

  /// The key's own picture, set in the back office.
  ///
  /// Null is the common case and has to cost nothing: most keys on most screens
  /// are a word on a colour, and that is the layout the venue arranged.
  ///
  /// When both are null a *product* key still falls back to the product's own
  /// emoji and picture, which the catalogue grid has always shown. That
  /// fallback is what stops this feature quietly un-decorating every screen a
  /// venue had already programmed before it existed.
  final String? emoji;

  /// A path on the venue's own server — `/uploads/…` or `/assets/…`. The back
  /// office refuses anything off-site, because a till on a venue network with
  /// no route to the open internet must not be able to draw a broken frame
  /// across its sale screen.
  final String? imageUrl;

  /// The slug of the font this key is lettered in — `inter`, `bebas-neue`, or
  /// one the venue uploaded. Null means the venue's font, and if the venue has
  /// not chosen one either, the app's own.
  ///
  /// Not resolved to a family here. A font the till has not finished
  /// downloading, or one the venue deleted after this layout was cached, has to
  /// come out as plain lettering on a key that still works — see
  /// [FontLibrary.familyFor], which is the one place that decides.
  final String? fontFamily;

  /// Points, or null for the key's own default.
  ///
  /// A wish rather than a promise. The same layout is drawn on a 10-inch
  /// terminal and a 24-inch one, so the key caps this against its own height
  /// before using it — see `programmed_grid.dart`, where that is settled.
  final int? fontSize;

  factory ScreenButton.fromJson(Map<String, dynamic> j) => ScreenButton(
    row: (j['row'] as num?)?.toInt() ?? 0,
    col: (j['col'] as num?)?.toInt() ?? 0,
    rowSpan: ((j['rowSpan'] as num?)?.toInt() ?? 1).clamp(1, 10),
    // Sixteen to match a bar's width. A key on a sale grid cannot be wider
    // than its screen anyway — the renderer positions it inside one.
    colSpan: ((j['colSpan'] as num?)?.toInt() ?? 1).clamp(1, 16),
    kind: ScreenButtonKind.fromKey(j['kind'] as String?),
    pluId: (j['pluId'] as num?)?.toInt(),
    targetScreenId: (j['targetScreenId'] as num?)?.toInt(),
    functionKey: (j['functionKey'] as String?)?.trim(),
    label: (j['label'] as String?)?.trim(),
    fill: _colour(j['fill']),
    ink: _colour(j['ink']),
    emoji: (j['emoji'] as String?)?.trim(),
    imageUrl: _absoluteImage((j['imageUrl'] as String?)?.trim()),
    fontFamily: _slug(j['fontFamily']),
    fontSize: (j['fontSize'] as num?)?.toInt().clamp(8, 72),
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
    if (emoji != null) 'emoji': emoji,
    if (imageUrl != null) 'imageUrl': imageUrl,
    if (fontFamily != null) 'fontFamily': fontFamily,
    if (fontSize != null) 'fontSize': fontSize,
  };

  /// A key's picture, as something the till can actually load.
  ///
  /// The back office stores these as on-site paths — `/uploads/...` — and
  /// refuses anything off-site, so what arrives here is never a URL. Handing
  /// that straight to `Image.network` fails, and it fails *quietly*: the key's
  /// error builder draws nothing rather than a broken frame, which is right for
  /// a sale screen and is why "adding an image does nothing on the till" looked
  /// like the picture had never been saved.
  ///
  /// Resolved here, at the edge, so every place that draws a key — the sale
  /// grid, the bars, a modifier prompt — gets a loadable address without each
  /// having to know where the server is.
  static String? _absoluteImage(String? path) {
    if (path == null || path.isEmpty) return null;
    if (path.startsWith('http')) return path;
    return '${Api.resolvedBase}$path';
  }

  /// A font slug, or null.
  ///
  /// Sanitised here rather than trusted, for the same reason the colour below
  /// is: this string ends up naming a font family, and the till should meet a
  /// value it does not like by lettering the key plainly rather than by
  /// refusing to draw the screen.
  static String? _slug(Object? raw) {
    final text = '${raw ?? ''}'.trim().toLowerCase().replaceAll(
      RegExp(r'[^a-z0-9-]'),
      '',
    );
    return text.isEmpty ? null : text;
  }

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

/// What a layout lays out.
///
/// A bar is a screen. The strip of open bills along the top of the till and the
/// strip of keys along the bottom are one or two rows of the same buttons the
/// sale grid is made of, so everything that reads a screen — the cache, the
/// push, the fallback chain — works on them without knowing they are bars.
///
/// [unknown] is not an error, for the same reason [ScreenButtonKind.unknown] is
/// not: the server stores this as a string precisely so a till running an older
/// release meets a surface it has never heard of and ignores it, rather than
/// failing to parse the venue's whole layout.
enum ScreenSurface {
  sale,
  topBar,
  bottomBar,

  /// The answers to one modifier question — which mixer, how the steak is
  /// cooked. Drawn over the sale screen when a product that asks is pressed,
  /// never opened on its own, and never offered as a home screen.
  ///
  /// A screen like any other otherwise, which is the point: it arrives in the
  /// same fetch, caches in the same blob and draws with the same button code.
  modifier,
  unknown;

  static ScreenSurface fromKey(String? key) => switch (key) {
    'sale' => sale,
    'topbar' => topBar,
    'bottombar' => bottomBar,
    'modifier' => modifier,
    _ => unknown,
  };

  bool get isBar => this == topBar || this == bottomBar;
}

/// One page of buttons — or one bar.
class TillScreen {
  const TillScreen({
    required this.id,
    required this.name,
    this.surface = ScreenSurface.sale,
    this.rows = 5,
    this.cols = 6,
    this.buttons = const [],
    this.topBarId,
    this.bottomBarId,
  });

  final int id;
  final String name;
  final ScreenSurface surface;
  final int rows;
  final int cols;
  final List<ScreenButton> buttons;

  /// The bars this one page wants, when it does not want the venue's.
  ///
  /// Null is the answer for nearly every screen and means "whatever the venue's
  /// default is". Set, it lets one page carry a different action bar from the
  /// rest — a Drinks page whose bottom bar offers a round and a tab, where the
  /// food page offers Covers and Save Table.
  final int? topBarId;
  final int? bottomBarId;

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
    surface: ScreenSurface.fromKey(j['surface'] as String?),
    rows: ((j['rows'] as num?)?.toInt() ?? 5).clamp(1, 10),
    // Sixteen, not twelve: a bar's cells are narrow by nature, and the built-in
    // bottom bar is already ten keys plus a wide Pay. See MAX_BAR_COLS.
    cols: ((j['cols'] as num?)?.toInt() ?? 6).clamp(1, 16),
    buttons: ((j['buttons'] as List?) ?? const [])
        .cast<Map<String, dynamic>>()
        .map(ScreenButton.fromJson)
        .toList(),
    topBarId: (j['topBarId'] as num?)?.toInt(),
    bottomBarId: (j['bottomBarId'] as num?)?.toInt(),
  );

  Map<String, dynamic> toJson() => {
    'id': id,
    'name': name,
    'surface': switch (surface) {
      ScreenSurface.sale => 'sale',
      ScreenSurface.topBar => 'topbar',
      ScreenSurface.bottomBar => 'bottombar',
      ScreenSurface.modifier => 'modifier',
      ScreenSurface.unknown => 'unknown',
    },
    'rows': rows,
    'cols': cols,
    'buttons': [for (final b in buttons) b.toJson()],
    if (topBarId != null) 'topBarId': topBarId,
    if (bottomBarId != null) 'bottomBarId': bottomBarId,
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

  /// A screen by id, but only if it is the kind asked for.
  ///
  /// The whole fallback chain rests on this returning null rather than the
  /// wrong thing. A sale page worn as a bottom bar would draw a page of lagers
  /// squashed into the bottom two inches of the till; a bar opened as a sale
  /// screen would leave a clerk with eleven keys and no products. The back
  /// office refuses to set either, but a till reads rows it did not write —
  /// from its own cache, written by an older release — so it checks here too.
  TillScreen? surfaceById(int? id, ScreenSurface surface) {
    final found = byId(id);
    return found != null && found.surface == surface ? found : null;
  }

  /// The bar a screen wears: its own if it asked for one, otherwise the
  /// venue's, otherwise none — which means the till's built-in bar.
  TillScreen? barFor(TillScreen? screen, ScreenSurface surface, int? venueDefault) {
    final own = surface == ScreenSurface.topBar
        ? screen?.topBarId
        : screen?.bottomBarId;
    return surfaceById(own, surface) ?? surfaceById(venueDefault, surface);
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
