/// The accent this device wears (Settings, Appearance): Vesopa lime unless a
/// clerk picks another. Kept with the device's other settings, so it comes
/// back after a reinstall (terminal_sync.dart).
library;

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'theme.dart';

class Accent extends Notifier<GoPalette> {
  static const _key = 'go_accent';

  @override
  GoPalette build() {
    SharedPreferences.getInstance().then((p) {
      final saved = GoPalette.byId(p.getString(_key));
      if (saved != state) _apply(saved);
    }).catchError((Object _) {});
    return GoPalette.lime;
  }

  Future<void> set(GoPalette palette) async {
    _apply(palette);
    try {
      await (await SharedPreferences.getInstance()).setString(_key, palette.id);
    } catch (_) {}
  }

  void _apply(GoPalette palette) {
    Tp.palette = palette;
    state = palette;
    // Most screens read Tp.lime directly rather than through the theme, so
    // after the frame that swaps the theme, rebuild every widget once.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final root = WidgetsBinding.instance.rootElement;
      if (root == null) return;
      void mark(Element e) {
        e.markNeedsBuild();
        e.visitChildren(mark);
      }
      mark(root);
    });
  }
}

final accentProvider = NotifierProvider<Accent, GoPalette>(Accent.new);
