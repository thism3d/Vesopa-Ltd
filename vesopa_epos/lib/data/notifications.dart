/// Windows toasts on the till, and who is allowed to set one off.
///
/// WHY A TILL WANTS ONE AT ALL
///
/// It already has notifications of its own — the cards that slide in from the
/// side, in `ui/dinein_toasts.dart` — and those are better than a Windows toast
/// for the case they were built for: they carry Accept and Cancel, and they do
/// not disappear. But they are only ever seen by somebody looking at the till.
/// A clerk who has minimised it to do a stock count, or who is on the second
/// monitor with the back office open, sees nothing at all, and the venue asked
/// for "Microsoft native notifications should be added to every apps". A
/// Windows toast is the one thing that reaches somebody who is not looking at
/// this window.
///
/// So they are complementary, not alternatives: the in-app card is the one you
/// act on, and the toast is the one that makes you look.
///
/// THE RULE
///
///     effective = notify_master AND <the event's column> AND <local toggle>
///
/// Every AND, no OR. The back office can silence a class of notification for
/// every machine in the building; a machine can opt out of what it is allowed;
/// neither can switch on what the other has switched off. Stated identically
/// in the kitchen app and in schema_till_notifications.sql, because three
/// copies of a rule that drift are worse than no rule.
library;

import 'package:flutter/foundation.dart';
import 'package:local_notifier/local_notifier.dart';

/// What the back office says this venue's tills may do.
///
/// Field names are the columns on `epos_till_settings`, so the mapping is one
/// line each and there is nothing to get wrong in the middle.
@immutable
class NotifyPolicy {
  const NotifyPolicy({
    this.master = true,
    this.tillDineInNew = true,
    this.tillSound = true,
  });

  /// One tick that silences every terminal in the building.
  final bool master;

  /// A customer has ordered from a QR code.
  final bool tillDineInNew;

  /// Whether a toast may make a noise, decided separately from whether it may
  /// appear: a bar with music on wants the light and not the chime.
  final bool tillSound;

  static const standard = NotifyPolicy();

  factory NotifyPolicy.fromSettings(Map<String, Object?> row) {
    bool on(String key) {
      final v = row[key];
      if (v == null) return true;
      if (v is bool) return v;
      if (v is num) return v != 0;
      return '$v' == '1' || '$v'.toLowerCase() == 'true';
    }

    return NotifyPolicy(
      master: on('notify_master'),
      tillDineInNew: on('notify_till_dinein_new'),
      tillSound: on('notify_till_sound'),
    );
  }
}

/// What this terminal decides for itself.
@immutable
class NotifyLocal {
  const NotifyLocal({this.enabled = true, this.sound = true});

  final bool enabled;
  final bool sound;

  NotifyLocal copyWith({bool? enabled, bool? sound}) =>
      NotifyLocal(enabled: enabled ?? this.enabled, sound: sound ?? this.sound);
}

/// What a toast is about.
enum NotifyKind { dineInOrder }

/// Shows toasts, or does not. Never throws.
///
/// A toast is the least important thing this application does — it sells food
/// and takes money — so a notification API that is unavailable, unregistered
/// or refused by Focus Assist costs a clerk nothing at all.
class AppNotifications {
  AppNotifications({this.appName = 'Vesopa EPOS'});

  final String appName;

  bool _ready = false;

  NotifyPolicy policy = NotifyPolicy.standard;
  NotifyLocal local = const NotifyLocal();

  Future<void> init() async {
    if (_ready) return;
    try {
      await localNotifier.setup(appName: appName);
      _ready = true;
    } catch (e) {
      debugPrint('Notifications unavailable: $e');
    }
  }

  bool allows(NotifyKind kind) {
    if (!policy.master || !local.enabled) return false;
    return switch (kind) {
      NotifyKind.dineInOrder => policy.tillDineInNew,
    };
  }

  bool get audible => policy.tillSound && local.sound;

  Future<void> show(
    NotifyKind kind, {
    required String title,
    required String body,
  }) async {
    if (!allows(kind)) return;
    if (!_ready) await init();
    if (!_ready) return;

    try {
      await LocalNotification(
        title: title,
        body: body,
        silent: !audible,
      ).show();
    } catch (e) {
      debugPrint('Notification failed: $e');
    }
  }
}
