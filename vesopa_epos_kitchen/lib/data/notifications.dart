/// Windows toasts, and who is allowed to set one off.
///
/// WHY THERE IS A RULE RATHER THAN A SWITCH
///
/// The venue asked for two things that pull against each other: notifications
/// on every app, and "a centralized option in the back office" deciding which
/// notification goes where. A single toggle on this screen cannot do the
/// second, and a single toggle in the back office cannot do what a manager
/// standing at a quiet screen at eight in the morning needs, which is to turn
/// the noise off without opening a browser.
///
/// So both exist, and they combine one way only:
///
///     effective = notify_master AND <the event's column> AND <local toggle>
///
/// Every AND, no OR. The back office can silence a whole class of notification
/// for every machine in the building, and a machine can opt out of what it is
/// allowed; neither can switch on what the other has switched off. That is
/// what makes "centralized" mean anything, and it is stated once here and once
/// in schema_till_notifications.sql rather than reinvented in three apps.
///
/// FAILURE IS SILENCE, NEVER A CRASH
///
/// Every call is wrapped. A toast is the least important thing this app does —
/// the board is the truth and it is on the wall — and a notification API that
/// is unavailable, unregistered, or refused by Focus Assist must cost a chef
/// nothing at all.
library;

import 'package:flutter/foundation.dart';
import 'package:local_notifier/local_notifier.dart';

/// What the back office says this venue's machines may do.
///
/// The field names are the columns on `epos_till_settings`, so the mapping
/// between this and the back office is one line each and there is nothing to
/// get wrong in the middle.
@immutable
class NotifyPolicy {
  const NotifyPolicy({
    this.master = true,
    this.kitchenDineInNew = true,
    this.kitchenTicketNew = true,
    this.kitchenSound = true,
  });

  /// One tick that silences every terminal in the building.
  final bool master;

  /// A customer has ordered from a QR code.
  final bool kitchenDineInNew;

  /// A till has sent food to the pass.
  final bool kitchenTicketNew;

  /// Whether a toast may make a noise. Separate from whether it may appear: a
  /// bar with music on wants the light and not the chime, and a kitchen that
  /// cannot hear over an extractor wants exactly the opposite.
  final bool kitchenSound;

  /// The defaults, which are what a venue that has never opened the settings
  /// page gets. On, because a kitchen screen that says nothing when an order
  /// arrives is the fault this feature exists to fix.
  static const standard = NotifyPolicy();

  factory NotifyPolicy.fromSettings(Map<String, dynamic> row) {
    bool on(String key, {bool fallback = true}) {
      final v = row[key];
      if (v == null) return fallback;
      if (v is bool) return v;
      if (v is num) return v != 0;
      return '$v' == '1' || '$v'.toLowerCase() == 'true';
    }

    return NotifyPolicy(
      master: on('notify_master'),
      kitchenDineInNew: on('notify_kitchen_dinein_new'),
      kitchenTicketNew: on('notify_kitchen_ticket_new'),
      kitchenSound: on('notify_kitchen_sound'),
    );
  }
}

/// The two things this screen decides for itself.
@immutable
class NotifyLocal {
  const NotifyLocal({this.enabled = true, this.sound = true});

  final bool enabled;
  final bool sound;

  NotifyLocal copyWith({bool? enabled, bool? sound}) =>
      NotifyLocal(enabled: enabled ?? this.enabled, sound: sound ?? this.sound);
}

/// What a toast is about. Each maps to its own back-office column, because
/// which of them a venue wants differs — a bar runs the till, a kitchen runs
/// the board — and one "new order" switch would be wrong for half of them.
enum NotifyKind { dineInOrder, kitchenTicket }

/// Shows toasts, or does not, according to the rule at the top of this file.
class AppNotifications {
  AppNotifications({this.appName = 'Vesopa Kitchen'});

  final String appName;

  bool _ready = false;

  NotifyPolicy policy = NotifyPolicy.standard;
  NotifyLocal local = const NotifyLocal();

  /// Register with Windows. Safe to call twice; safe to fail.
  Future<void> init() async {
    if (_ready) return;
    try {
      await localNotifier.setup(appName: appName);
      _ready = true;
    } catch (e) {
      // An unregistered app identity, a Windows build without the notification
      // service, a sandbox. All of them mean the same thing here: no toasts.
      debugPrint('Notifications unavailable: $e');
    }
  }

  /// Whether a toast of [kind] is allowed at all, before it is composed.
  bool allows(NotifyKind kind) {
    if (!policy.master || !local.enabled) return false;
    return switch (kind) {
      NotifyKind.dineInOrder => policy.kitchenDineInNew,
      NotifyKind.kitchenTicket => policy.kitchenTicketNew,
    };
  }

  /// Whether it may make a noise. Both layers again, and never louder than
  /// either allows.
  bool get audible => policy.kitchenSound && local.sound;

  /// Show one. Never throws.
  Future<void> show(
    NotifyKind kind, {
    required String title,
    required String body,
  }) async {
    if (!allows(kind)) return;
    if (!_ready) await init();
    if (!_ready) return;

    try {
      final toast = LocalNotification(
        title: title,
        body: body,
        silent: !audible,
      );
      await toast.show();
    } catch (e) {
      debugPrint('Notification failed: $e');
    }
  }
}
