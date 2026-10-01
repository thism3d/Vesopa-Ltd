import 'package:flutter/material.dart' show Color;

import '../ui/theme.dart';
import 'screens.dart';

/// How a venue's page key looks while its page is open (2026-10-01).
///
/// Nicki's words: "If I'm on the DRAUGHT page the DRAUGHT navigation
/// highlights a different colour to show the user where they are". On
/// Newbridge a venue colours each page's own key by hand; here the key for the
/// open page lights up by itself, in a style the venue picks once in screen
/// programming.
///
/// Read off the till-settings row (`nav_here_style`, `nav_here_fill`,
/// `nav_here_bar`) and resolved per key by [lookFor], which mirrors
/// `spHereLook` in vesopa_server/public/screens.js: the back office draws its
/// preview with that one, and the two must agree or the preview lies.
enum PageHighlightStyle {
  /// The key turns the highlight colour (white by default) with an underbar.
  fill,

  /// The key keeps its own colour and gains an underbar.
  bar,

  /// A ring inside the key's edge: what 1.10 drew, kept for venues who liked it.
  outline,

  /// Nothing. Every page key looks the same on every page.
  off;

  static PageHighlightStyle parse(Object? raw) => switch (raw) {
    'bar' => bar,
    'outline' => outline,
    'off' => off,
    // Null, absent (a server without the migration) or anything new: the
    // Vesopa default.
    _ => fill,
  };
}

/// What [PageHighlight.lookFor] decided for one key. A null colour means
/// "leave that part of the key as it is".
class HereLook {
  const HereLook({this.fill, this.ink, this.bar, this.outline});

  final Color? fill;
  final Color? ink;
  final Color? bar;
  final Color? outline;
}

class PageHighlight {
  const PageHighlight({
    this.style = PageHighlightStyle.fill,
    this.fill = white,
    this.bar = brandBar,
  });

  static const white = Color(0xFFFFFFFF);

  /// The underbar's two named colours. Stored as words on the server ('brand',
  /// 'key'), held here as sentinels so a venue's own hex can never collide
  /// with them.
  static const brandBar = 'brand';
  static const keyBar = 'key';

  /// The default every venue starts on: a white key with a lime underbar.
  static const vesopa = PageHighlight();

  final PageHighlightStyle style;

  /// The key's colour while its page is open, under [PageHighlightStyle.fill].
  final Color fill;

  /// [brandBar], [keyBar], or a `#rrggbb` the venue chose.
  final String bar;

  factory PageHighlight.fromSettings(Map<String, dynamic> j) => PageHighlight(
    style: PageHighlightStyle.parse(j['nav_here_style']),
    fill: parseHex(j['nav_here_fill']) ?? white,
    bar: _cleanBar(j['nav_here_bar']) ?? brandBar,
  );

  static String? _cleanBar(Object? raw) {
    final v = '${raw ?? ''}'.trim().toLowerCase();
    if (v == brandBar || v == keyBar) return v;
    return parseHex(v) == null ? null : v;
  }

  static Color? parseHex(Object? raw) {
    final v = '${raw ?? ''}'.trim().replaceFirst('#', '');
    if (!RegExp(r'^[0-9a-fA-F]{6}$').hasMatch(v)) return null;
    return Color(0xFF000000 | int.parse(v, radix: 16));
  }

  /// How [button] looks while its page is open, given the colour it wears the
  /// rest of the time ([own]). Null when the venue has the highlight off.
  ///
  /// A page key may carry its own colours (`hereFill`, `hereBar`) over the
  /// venue's. An underbar that would vanish into the key under it — a white
  /// bar on a white key, or "match each key" with the underbar-only style —
  /// falls back to the lime, then to near-black: a highlight nobody can see is
  /// the fault this exists to fix.
  HereLook? lookFor(ScreenButton button, Color own) {
    if (style == PageHighlightStyle.off) return null;
    final mode = _cleanBar(button.hereBar) ?? bar;
    var line = switch (mode) {
      brandBar => Pos.brand,
      keyBar => own,
      _ => parseHex(mode) ?? Pos.brand,
    };
    if (style == PageHighlightStyle.outline) return HereLook(outline: line);

    final key = style == PageHighlightStyle.fill
        ? (parseHex(button.hereFill) ?? fill)
        : null;
    final under = key ?? own;
    if (Pos.contrast(line, under) < 1.35) {
      line = Pos.contrast(Pos.brand, under) >= 1.35 ? Pos.brand : Pos.onBrand;
    }
    return HereLook(
      fill: key,
      ink: key == null ? null : Pos.inkOn(key),
      bar: line,
    );
  }

  @override
  bool operator ==(Object other) =>
      other is PageHighlight &&
      other.style == style &&
      other.fill == fill &&
      other.bar == bar;

  @override
  int get hashCode => Object.hash(style, fill, bar);
}

/// The underbar's thickness on a key of [height]: a strip you can see across a
/// bar on a 15-inch panel, and not a stripe that eats a handheld's key.
double hereBarThickness(double height) => (height * 0.09).clamp(4.0, 8.0);
