import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'layout.dart';

/// How the till shows its side menu.
///
/// The nav used to be a fixed rail, then became a drawer on every screen size
/// to buy back the ~208px it took off the width permanently. Both are the right
/// answer for somebody: a 24" counter terminal has the room and the operator
/// would rather see the sections than press a key for them; a 10" tablet does
/// not. Rather than pick one and be wrong half the time, it is a setting.
enum NavPanelMode {
  /// Fixed on a wide screen, tucked away below it. The default, and the only
  /// option that is right without knowing the hardware.
  auto,

  /// Always fixed — as far as the screen allows. See [isPinnedOn]: a phone
  /// cannot give 208px to navigation and still show a bill, so this degrades
  /// there rather than producing an unusable screen.
  fixed,

  /// Always tucked away behind the Settings key, whatever the screen size.
  hidden;

  String get label => switch (this) {
    NavPanelMode.auto => 'Automatic',
    NavPanelMode.fixed => 'Always show',
    NavPanelMode.hidden => 'Keep hidden',
  };

  String get blurb => switch (this) {
    NavPanelMode.auto =>
      'Fixed on a wide screen, behind the menu key on a small one',
    NavPanelMode.fixed => 'Menu stays on screen (needs a tablet or wider)',
    NavPanelMode.hidden => 'Opens from the menu key — most room for the bill',
  };

  /// Whether the rail should be fixed on screen at this width.
  ///
  /// [PosLayout.phone] never pins, in any mode. 208px of navigation on a 5"
  /// screen leaves nothing to sell from, and a setting that can put the till in
  /// a state where it cannot take a sale is not a setting worth having — so
  /// `fixed` means "wherever it fits", not "always".
  bool isPinnedOn(PosLayout layout) {
    if (layout == PosLayout.phone) return false;
    return switch (this) {
      NavPanelMode.auto => layout == PosLayout.desktop,
      NavPanelMode.fixed => true,
      NavPanelMode.hidden => false,
    };
  }
}

/// Remembers the choice between sessions, the same way the theme does — a till
/// is set up once and then used, so being handed a different layout each
/// morning would be worse than having no choice at all.
class NavPanelController extends AsyncNotifier<NavPanelMode> {
  static const _key = 'nav_panel_mode';

  @override
  Future<NavPanelMode> build() async {
    final prefs = await SharedPreferences.getInstance();
    final stored = prefs.getString(_key);
    return NavPanelMode.values.firstWhere(
      (m) => m.name == stored,
      orElse: () => NavPanelMode.auto,
    );
  }

  Future<void> set(NavPanelMode mode) async {
    state = AsyncData(mode);
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_key, mode.name);
  }
}

final navPanelControllerProvider =
    AsyncNotifierProvider<NavPanelController, NavPanelMode>(
      NavPanelController.new,
    );
