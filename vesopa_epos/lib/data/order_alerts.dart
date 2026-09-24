/// Where this terminal announces an order that came in from a phone.
///
/// A TERMINAL SETTING, NOT A VENUE ONE
///
/// It is stored on the machine rather than in the back office, and that is the
/// right side of the line. A venue with a bar till and a kitchen till wants
/// different answers on each: the bar is facing customers and cannot have
/// notifications sliding over the sale screen all night, while the till by the
/// pass exists to be told. Made venue-wide, one of the two would always be
/// wrong, and the manager would be changing it for both.
///
/// It is also the kind of thing somebody changes standing at the counter,
/// having been annoyed by it once — so it lives where they are, not behind a
/// browser on an office PC.
library;

import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// How an order announces itself here.
enum OrderAlerts {
  /// Sliding notifications, stacked at the side. The default, because an order
  /// from a table is a thing that has just happened with somebody waiting on
  /// it, and a number in a corner is not how you tell somebody that.
  toasts,

  /// A count on the bar, and nothing over the screen. For a till facing
  /// customers all evening.
  topBar,

  /// Both.
  both,

  /// Neither. For a terminal that has no business in the kitchen's work —
  /// a stockroom till, or a second counter that never takes food.
  off;

  bool get showsToasts => this == toasts || this == both;
  bool get showsBadge => this == topBar || this == both;

  String get label => switch (this) {
    OrderAlerts.toasts => 'Notifications',
    OrderAlerts.topBar => 'A count on the bar',
    OrderAlerts.both => 'Both',
    OrderAlerts.off => 'Nothing',
  };

  String get blurb => switch (this) {
    OrderAlerts.toasts =>
      'Slides in from the side with Accept and Cancel on it, and stays until '
          'one of them is pressed.',
    OrderAlerts.topBar =>
      'A quiet count on the top bar. Nothing ever covers the sale screen.',
    OrderAlerts.both => 'The notification and the count.',
    OrderAlerts.off =>
      'This till is not told at all. Orders still arrive and are still under '
          'Functions — nobody here is shown them.',
  };

  static OrderAlerts fromName(String? name) => OrderAlerts.values.firstWhere(
    (v) => v.name == name,
    orElse: () => OrderAlerts.toasts,
  );
}

const _key = 'till.order_alerts';
const _keyChime = 'till.order_chime';

/// Whether an arriving order makes a noise.
///
/// Separate from *where* it appears, because they answer different questions. A
/// till that shows notifications may still want to be silent — a quiet dining
/// room, a counter with a queue at it — and a till set to show nothing at all
/// may still want the chime, because somebody in the kitchen is listening for
/// it rather than watching.
///
/// The system alert rather than a sound of our own: it is the noise this
/// machine already makes for everything else, it is the one the venue has
/// already set the volume of in Windows, and it needs no audio package and no
/// asset to ship.
class OrderChimeController extends Notifier<bool> {
  SharedPreferences? _prefs;

  @override
  bool build() {
    unawaited(_load());
    return true;
  }

  Future<void> _load() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      _prefs = prefs;
      state = prefs.getBool(_keyChime) ?? true;
    } catch (_) {
      // Default on. A till that cannot read its preferences still tells
      // somebody an order has arrived.
    }
  }

  Future<void> set({required bool on}) async {
    state = on;
    try {
      final prefs = _prefs ?? await SharedPreferences.getInstance();
      _prefs = prefs;
      await prefs.setBool(_keyChime, on);
    } catch (_) {
      // Applied for this session, which is what the person who pressed it sees.
    }
  }
}

final orderChimeProvider = NotifierProvider<OrderChimeController, bool>(
  OrderChimeController.new,
);

/// Reads once at start, writes on change. Small enough that there is no reason
/// for it to be asynchronous at every call site.
class OrderAlertsController extends Notifier<OrderAlerts> {
  SharedPreferences? _prefs;

  @override
  OrderAlerts build() {
    unawaited(_load());
    return OrderAlerts.toasts;
  }

  Future<void> _load() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      _prefs = prefs;
      state = OrderAlerts.fromName(prefs.getString(_key));
    } catch (_) {
      // A terminal whose preferences will not open still sells. It gets the
      // default, which is the one a till wants.
    }
  }

  Future<void> set(OrderAlerts value) async {
    state = value;
    try {
      final prefs = _prefs ?? await SharedPreferences.getInstance();
      _prefs = prefs;
      await prefs.setString(_key, value.name);
    } catch (_) {
      // Applied for this session either way, which is what the person who just
      // pressed it is looking at.
    }
  }
}

final orderAlertsProvider = NotifierProvider<OrderAlertsController, OrderAlerts>(
  OrderAlertsController.new,
);
