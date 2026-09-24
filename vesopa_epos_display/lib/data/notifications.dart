/// Windows toasts on the customer display, and why there are almost none.
///
/// WHY THIS SCREEN IS THE EXCEPTION
///
/// The venue asked for "Microsoft native notifications should be added to
/// every apps", and this is one of the apps. But it is a screen facing a
/// queue: a toast sliding over somebody's bill while they are reading it is a
/// notification aimed at nobody, because the person who needs to know is
/// behind the counter looking at the till. So the capability is here, and it
/// is OFF unless a manager turns it on — for the venue that mounts a display
/// in a back office or a service corridor, where there IS somebody to tell.
///
/// WHAT IT SAYS WHEN IT IS ON
///
/// One thing, and deliberately not "a sale happened": that is what the screen
/// itself is for. It says the TILL HAS STOPPED TALKING TO IT. That is the one
/// event this application knows about that nobody else does — the till is
/// running happily, the display looks like it is working because the adverts
/// are still playing, and a customer at the counter is looking at a screen
/// that is no longer their bill. Nothing else in the building notices.
///
/// TWO LAYERS, AS EVERYWHERE ELSE
///
///     effective = notify_display_enabled (back office) AND <local toggle>
///
/// The back-office half arrives in the snapshot file the till writes, because
/// this application has no network of its own — see `data/basket_feed.dart`.
library;

import 'package:flutter/foundation.dart';
import 'package:local_notifier/local_notifier.dart';

/// Raises toasts, or does not. Never throws: a display that cannot register
/// with Windows must still show a bill.
class DisplayNotifications {
  DisplayNotifications({this.appName = 'Vesopa Customer Display'});

  final String appName;

  bool _ready = false;

  /// What the back office allows, as the till last reported it.
  bool allowedByVenue = false;

  /// What this machine allows. Off by default, like the venue half.
  bool allowedHere = false;

  /// So a till that is down for an hour produces one toast, not sixty.
  bool _saidSoAlready = false;

  bool get allows => allowedByVenue && allowedHere;

  Future<void> init() async {
    if (_ready) return;
    try {
      await localNotifier.setup(appName: appName);
      _ready = true;
    } catch (e) {
      debugPrint('Notifications unavailable: $e');
    }
  }

  /// The till has stopped writing. Said once per outage.
  Future<void> tillWentQuiet({String? terminal}) async {
    if (!allows || _saidSoAlready) return;
    _saidSoAlready = true;
    await _show(
      'The till has stopped sending',
      terminal == null
          ? 'This screen is showing adverts because nothing has arrived from '
                'the till for a while.'
          : 'Nothing has arrived from $terminal for a while. This screen is '
                'showing adverts.',
    );
  }

  /// It came back. Re-arms the warning; says nothing itself, because a screen
  /// that is working again is not news to anybody.
  void tillCameBack() => _saidSoAlready = false;

  Future<void> _show(String title, String body) async {
    if (!_ready) await init();
    if (!_ready) return;
    try {
      await LocalNotification(title: title, body: body).show();
    } catch (e) {
      debugPrint('Notification failed: $e');
    }
  }
}
