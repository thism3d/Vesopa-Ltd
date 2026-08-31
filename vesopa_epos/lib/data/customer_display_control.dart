/// Setting the customer display up, from the till.
///
/// The display is a separate application with its own window and its own
/// settings screen, and for a while that was the only place to configure it.
/// That is wrong for the venue: the manager is standing at the till, the
/// display is a screen facing the other way with no keyboard in front of it,
/// and "go round the counter and press the small cog" is not a setup procedure.
///
/// So the till owns the settings, and this is the channel.
///
/// TWO FILES, THE SAME WAY THE BASKET TRAVELS
///
/// Both live in the folder the two applications already share — see
/// [customerDisplayDirectory]. No socket, no port, no shared process, for
/// exactly the reasons given at the top of `customer_display.dart`.
///
///   * `settings.json` — written here, read by the display. The till is the
///     authority: whatever is in this file is what the display does.
///   * `status.json`   — written by the display, read here. What it is actually
///     doing, and which monitors it can see, so the till can offer them by name
///     instead of asking somebody to guess.
///
/// The status file is why the till's screen picker can work at all. The till
/// cannot enumerate the display's monitors — on a two-machine setup they are
/// not even its own — so it asks the display to say, and offers back what it
/// was told.
library;

import 'dart:convert';
import 'dart:io';

import 'customer_display.dart';

/// The shape of both files. A reader seeing a higher one leaves the file alone
/// rather than half-applying it.
const displayControlFormat = 1;

const displayControlFile = 'settings.json';
const displayStatusFile = 'status.json';

/// Field readers that never throw.
///
/// A cast would: `raw['idle_seconds'] as num?` on a string throws, and the
/// whole file goes with it. These fall back one field at a time, so a settings
/// file with one bad number in it still sets the other six things — which is
/// the documented promise of [DisplayControl.fromJson].
String _str(Object? value, String fallback) =>
    value is String ? value : fallback;

int _int(Object? value, int fallback) =>
    value is num ? value.toInt() : fallback;

bool _bool(Object? value, {required bool fallback}) =>
    value is bool ? value : fallback;

/// How the customer display should behave. The till's copy is the real one.
class DisplayControl {
  const DisplayControl({
    this.advertFolder = '',
    this.idleSeconds = 45,
    this.dwellSeconds = 12,
    this.showPrices = true,
    this.thankYou = 'Thank you',
    this.screenKey = '',
    this.fullScreen = true,
    this.advertVolume = 0,
    this.billOnRight = false,
    this.billShare = 50,
    this.fillScreen = false,
    this.standingMessage = '',
  });

  /// A folder of pictures and clips on the display's machine.
  final String advertFolder;

  /// With a bill on screen and nothing rung up for this long, the adverts take
  /// the whole screen. Zero means never.
  final int idleSeconds;

  /// How long each still advert stays up.
  final int dwellSeconds;

  /// Whether a price is shown against each line. The total always is.
  final bool showPrices;

  /// What the screen says once a sale has been paid for.
  final String thankYou;

  /// Which monitor, by the key the display reported in its status. Empty means
  /// "wherever the window opens" — see the display's `data/screens.dart`.
  final String screenKey;

  /// Fill that screen, with no title bar and nothing to drag.
  final bool fullScreen;

  /// How loud video adverts play, 0 to 100.
  ///
  /// **Silent by default, and that is the right default.** A screen on a bar
  /// counter playing a soundtrack at the person waiting to be served is a
  /// complaint, not a feature — so sound is something a venue turns on for a
  /// room where it makes sense, not something they discover and have to
  /// switch off.
  final int advertVolume;

  /// Which side of the screen the bill is on.
  ///
  /// Which side is right depends on where the customer stands relative to the
  /// till, and that is a property of the counter, not of the software.
  final bool billOnRight;

  /// How much of the screen's width the bill takes, as a percentage.
  ///
  /// A venue whose adverts are portrait posters wants a narrow bill; one
  /// ringing up long rounds wants a wide one. Clamped when it is applied
  /// rather than here, so a hand-edited file cannot produce a bill with no
  /// width at all.
  final int billShare;

  /// Whether adverts fill the panel, cropping to fit, instead of sitting inside
  /// it with bars around them.
  ///
  /// Off by default: cropping a poster that has a phone number along the bottom
  /// cuts the phone number off, and that is a worse first impression than a
  /// letterbox.
  final bool fillScreen;

  /// A line the venue sets, shown across the bottom of the adverts.
  ///
  /// For the thing the staff would otherwise have to say to everybody — "Ask
  /// about our loyalty card", "Kitchen closes at nine". Empty shows nothing at
  /// all rather than an empty strip.
  final String standingMessage;

  DisplayControl copyWith({
    String? advertFolder,
    int? idleSeconds,
    int? dwellSeconds,
    bool? showPrices,
    String? thankYou,
    String? screenKey,
    bool? fullScreen,
    int? advertVolume,
    bool? billOnRight,
    int? billShare,
    bool? fillScreen,
    String? standingMessage,
  }) => DisplayControl(
    advertFolder: advertFolder ?? this.advertFolder,
    idleSeconds: idleSeconds ?? this.idleSeconds,
    dwellSeconds: dwellSeconds ?? this.dwellSeconds,
    showPrices: showPrices ?? this.showPrices,
    thankYou: thankYou ?? this.thankYou,
    screenKey: screenKey ?? this.screenKey,
    fullScreen: fullScreen ?? this.fullScreen,
    advertVolume: advertVolume ?? this.advertVolume,
    billOnRight: billOnRight ?? this.billOnRight,
    billShare: billShare ?? this.billShare,
    fillScreen: fillScreen ?? this.fillScreen,
    standingMessage: standingMessage ?? this.standingMessage,
  );

  Map<String, Object?> toJson() => {
    'format': displayControlFormat,
    'updated_at': DateTime.now().toIso8601String(),
    'advert_folder': advertFolder,
    'idle_seconds': idleSeconds,
    'dwell_seconds': dwellSeconds,
    'show_prices': showPrices,
    'thank_you': thankYou,
    'screen_key': screenKey,
    'full_screen': fullScreen,
    'advert_volume': advertVolume,
    'bill_on_right': billOnRight,
    'bill_share': billShare,
    'fill_screen': fillScreen,
    'standing_message': standingMessage,
  };

  /// Null when the file is from a newer till than this build understands.
  ///
  /// Every other malformed field falls back to its default rather than
  /// rejecting the file. A settings file with one bad number in it should still
  /// set the other six things.
  static DisplayControl? fromJson(Object? raw) {
    if (raw is! Map) return null;
    if (_int(raw['format'], 0) > displayControlFormat) {
      return null;
    }
    return DisplayControl(
      advertFolder: _str(raw['advert_folder'], ''),
      idleSeconds: _int(raw['idle_seconds'], 45),
      dwellSeconds: _int(raw['dwell_seconds'], 12),
      showPrices: _bool(raw['show_prices'], fallback: true),
      thankYou: _str(raw['thank_you'], 'Thank you'),
      screenKey: _str(raw['screen_key'], ''),
      fullScreen: _bool(raw['full_screen'], fallback: true),
      advertVolume: _int(raw['advert_volume'], 0),
      billOnRight: _bool(raw['bill_on_right'], fallback: false),
      billShare: _int(raw['bill_share'], 50),
      fillScreen: _bool(raw['fill_screen'], fallback: false),
      standingMessage: _str(raw['standing_message'], ''),
    );
  }
}

/// A monitor the display can see, as it described it.
class DisplayScreenOption {
  const DisplayScreenOption({required this.key, required this.label});

  final String key;
  final String label;

  Map<String, Object?> toJson() => {'key': key, 'label': label};

  static DisplayScreenOption? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final key = raw['key'];
    final label = raw['label'];
    if (key is! String || key.isEmpty) return null;
    return DisplayScreenOption(
      key: key,
      label: label is String && label.isNotEmpty ? label : key,
    );
  }
}

/// What the display says it is doing.
class DisplayStatus {
  const DisplayStatus({
    required this.updatedAt,
    this.appVersion = '',
    this.following = '',
    this.screens = const [],
    this.screenKey = '',
    this.fullScreen = false,
    this.advertCount = 0,
  });

  /// By the display's clock. Used only to decide whether it is still running.
  final DateTime updatedAt;

  final String appVersion;

  /// The basket file the display resolved. Shown on the till so a display
  /// following the wrong till is visible rather than merely wrong.
  final String following;

  final List<DisplayScreenOption> screens;
  final String screenKey;
  final bool fullScreen;
  final int advertCount;

  /// Whether the display is running.
  ///
  /// It writes its status every few seconds, so a minute of silence is a
  /// display that has been closed or has fallen over. Short, unlike the
  /// basket's staleness window, because this one is read by a manager who is
  /// standing there setting the thing up and wants to know now.
  bool get isLive => DateTime.now().difference(updatedAt).inMinutes < 1;

  Map<String, Object?> toJson() => {
    'format': displayControlFormat,
    'updated_at': updatedAt.toIso8601String(),
    'app_version': appVersion,
    'following': following,
    'screens': [for (final screen in screens) screen.toJson()],
    'screen_key': screenKey,
    'full_screen': fullScreen,
    'advert_count': advertCount,
  };

  static DisplayStatus? fromJson(Object? raw) {
    if (raw is! Map) return null;
    if (_int(raw['format'], 0) > displayControlFormat) {
      return null;
    }
    return DisplayStatus(
      // A status with no usable timestamp is treated as ancient, not as new:
      // the till would otherwise report a display that is not there as live.
      updatedAt: DateTime.tryParse(_str(raw['updated_at'], '')) ??
          DateTime(1970),
      appVersion: _str(raw['app_version'], ''),
      following: _str(raw['following'], ''),
      screens: [
        for (final screen in (raw['screens'] as List?) ?? const [])
          ?DisplayScreenOption.fromJson(screen),
      ],
      screenKey: _str(raw['screen_key'], ''),
      fullScreen: _bool(raw['full_screen'], fallback: false),
      advertCount: _int(raw['advert_count'], 0),
    );
  }
}

/// Read what the till has set, or the defaults if it has never set anything.
///
/// Defaults rather than null, so the settings screen opens on a sensible form
/// on a till that has never had a display attached.
Future<DisplayControl> readDisplayControl({Directory? override}) async {
  try {
    final folder = await customerDisplayDirectory(override: override);
    if (folder == null) return const DisplayControl();

    final file = File('${folder.path}/$displayControlFile');
    if (!await file.exists()) return const DisplayControl();

    return DisplayControl.fromJson(jsonDecode(await file.readAsString())) ??
        const DisplayControl();
  } catch (_) {
    return const DisplayControl();
  }
}

/// Write what the display should do.
///
/// Atomic, for the same reason the basket is: the reader is a different process
/// and a half-written settings file is a display that has applied three of its
/// seven settings.
///
/// Returns whether it was written, so the till's settings screen can say
/// plainly that it could not be saved rather than appearing to have saved it.
Future<bool> writeDisplayControl(
  DisplayControl control, {
  Directory? override,
}) async {
  try {
    final folder = await customerDisplayDirectory(override: override);
    if (folder == null) return false;

    final file = File('${folder.path}/$displayControlFile');
    final temp = File('${file.path}.tmp');
    await temp.writeAsString(jsonEncode(control.toJson()), flush: true);
    await temp.rename(file.path);
    return true;
  } catch (_) {
    return false;
  }
}

/// Read what the display last said about itself, or null if it has never said
/// anything — a display that has not been installed, or has never been run.
Future<DisplayStatus?> readDisplayStatus({Directory? override}) async {
  try {
    final folder = await customerDisplayDirectory(override: override);
    if (folder == null) return null;

    final file = File('${folder.path}/$displayStatusFile');
    if (!await file.exists()) return null;

    return DisplayStatus.fromJson(jsonDecode(await file.readAsString()));
  } catch (_) {
    return null;
  }
}
