/// Which price level this terminal is charging, and how it is changed.
///
/// Remembered across restarts, because a venue that switched to Happy Hour at
/// five does not want the till back on Price 1 because somebody rebooted it at
/// half past. Stored on the terminal rather than centrally, deliberately: the
/// lounge can be on a function tariff while the public bar is not, and one
/// setting for the whole venue could not express that.
///
/// A CHANGE NEVER TOUCHES A BILL ALREADY OPEN
///
/// Prices are snapshotted onto the line when it is rung up — see
/// `OrderRepository.addLine`. So switching level changes what the *next* item
/// costs and leaves every check on the floor exactly as the customer was told
/// it would be, which is the only behaviour that can be explained at a counter.
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'price_levels.dart';
import '../main.dart';

const _key = 'till.price_level';

/// The level this till charges at, 1 to 6.
class PriceLevelController extends AsyncNotifier<int> {
  @override
  Future<int> build() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      return clampPriceLevel(prefs.getInt(_key));
    } catch (_) {
      // A preferences read that failed is a till that charges Price 1, which is
      // the price every product certainly has. Not a till that will not sell.
      return minPriceLevel;
    }
  }

  /// Charge at [level] from the next item onwards.
  Future<void> set(int level) async {
    final wanted = clampPriceLevel(level);
    state = AsyncData(wanted);
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setInt(_key, wanted);
    } catch (_) {
      // The till is already on the new level; it simply will not remember it
      // through a restart. Better than refusing the change.
    }
  }
}

final priceLevelProvider = AsyncNotifierProvider<PriceLevelController, int>(
  PriceLevelController.new,
);

/// The level as a plain int, for the many places that cannot wait for it.
///
/// Ringing up an item cannot block on a preference read, so this answers
/// Price 1 for the fraction of a second before the stored value arrives — the
/// same trade `terminalNameProvider` makes, and for the same reason.
final currentPriceLevelProvider = Provider<int>(
  (ref) => ref.watch(priceLevelProvider).value ?? minPriceLevel,
);

/// What this venue calls each level.
///
/// Read from the till's own settings, which is where the back office puts them
/// — so a venue names Price 2 "Happy Hour" once and every terminal's key says
/// so. Empty until it does, which reads as "Price 2".
final priceLevelNamesProvider = Provider<PriceLevelNames>(
  (ref) => ref.watch(tillSettingsProvider).priceLevelNames,
);
