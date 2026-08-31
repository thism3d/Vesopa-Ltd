/// What this screen has been set up to do.
///
/// All of it is local to this device. There is nothing here another machine
/// needs to know, and putting it in the back office would mean a display that
/// cannot be set up until the broadband is working — on the day of the install,
/// which is exactly when it is not.
library;

import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Where the till writes its basket.
///
/// Computed rather than asked for, so a display installed beside a till on the
/// same machine works with nothing typed in — which is every installation this
/// application was written for.
///
/// THE PATH IS NOT ONE PATH
///
/// The till resolves its data folder through path_provider, which on Windows
/// builds it out of the *executable's* CompanyName and ProductName version
/// resources:
///
///     %APPDATA%\Vesopa EPOS Limited\Vesopa EPOS\display\basket.json
///
/// That is where a till installed from the .exe writes. A till installed from
/// the Microsoft Store asks for the same path and Windows quietly redirects it,
/// because a packaged application's AppData is virtualised into its own package
/// folder:
///
///     %LOCALAPPDATA%\Packages\MeirionDavies.Vesopa_<id>\LocalCache\Roaming\...
///
/// The `<id>` is a hash of the publisher, so the folder is matched rather than
/// computed. Both are looked for, and the one written to most recently wins: a
/// machine that ran a side-loaded till before it had a Store one has both
/// folders, and only one of them is today's.
const _tillCompany = 'Vesopa EPOS Limited';
const _tillProduct = 'Vesopa EPOS';

/// The till's Store identity, up to the publisher hash. See above.
const _tillPackagePrefix = 'MeirionDavies.Vesopa_';

/// Where the till leaves a note saying where it writes.
///
/// The till writes this on every start — see
/// `vesopa_epos/lib/data/customer_display.dart` for what it is and why it is in
/// ProgramData rather than anywhere else. Reading it is how this application
/// stops depending on facts about how the till happens to be built: what its
/// version resources say, and whether the Store has redirected its AppData.
///
/// Returns null when there is no note, when it is unreadable, or when it was
/// written by a newer till in a shape this build does not know. All three mean
/// the same thing here — fall back to working the path out — which is what
/// [candidateBasketPaths] does next.
String? announcedBasketPath() {
  if (!Platform.isWindows) return null;
  final root = Platform.environment['PROGRAMDATA'];
  if (root == null || root.isEmpty) return null;

  try {
    final file = File('$root\\Vesopa\\customer-display.json');
    if (!file.existsSync()) return null;

    final raw = jsonDecode(file.readAsStringSync());
    if (raw is! Map) return null;
    if (((raw['format'] as num?)?.toInt() ?? 0) > 1) return null;

    final basket = raw['basket'];
    return basket is String && basket.trim().isNotEmpty ? basket.trim() : null;
  } catch (_) {
    return null;
  }
}

/// Every basket file the till might be writing, most recently written first.
///
/// The list is what the settings screen shows when it has to explain itself.
/// [defaultBasketPath] is what the rest of the application uses.
List<String> candidateBasketPaths() {
  if (!Platform.isWindows) return const [];

  final paths = <String>[];

  // What the till itself said, ahead of anything worked out. A note that names
  // a file which is not there yet is still the right answer: it is the till
  // saying where it will write when somebody opens a bill.
  final announced = announcedBasketPath();
  if (announced != null) paths.add(announced);

  void addUnder(String? root) {
    if (root == null || root.isEmpty) return;
    paths.add(
      '$root\\$_tillCompany\\$_tillProduct\\display\\basket.json',
    );
  }

  addUnder(Platform.environment['APPDATA']);

  // The Store till's redirected AppData. Enumerated rather than computed
  // because the publisher hash on the end of the package name is not something
  // this application can work out, and not something anybody should type.
  final local = Platform.environment['LOCALAPPDATA'];
  if (local != null && local.isNotEmpty) {
    try {
      final packages = Directory('$local\\Packages');
      if (packages.existsSync()) {
        for (final entry in packages.listSync().whereType<Directory>()) {
          final name = entry.path.split(RegExp(r'[\\/]')).last;
          if (name.startsWith(_tillPackagePrefix)) {
            addUnder('${entry.path}\\LocalCache\\Roaming');
          }
        }
      }
    } catch (_) {
      // An unreadable Packages folder simply means no Store till was found.
    }
  }

  // Anything the sweep turns up that is not already listed. Last, because it is
  // the tier that guesses least specifically.
  for (final swept in _sweepForBaskets()) {
    if (!paths.contains(swept)) paths.add(swept);
  }

  // Newest first, among the ones this application worked out for itself. A
  // till that is running is a till that is writing, and its file is the one
  // with today's date on it.
  //
  // The announcement is deliberately left out of that sort and kept at the
  // front. It is not a guess competing with other guesses; it is the till's own
  // answer, and it stays in front even on a machine with an older, stale basket
  // file sitting somewhere with a newer timestamp.
  final guessed = paths.sublist(announced == null ? 0 : 1)
    ..sort((a, b) => _writtenAt(b).compareTo(_writtenAt(a)));

  return [?announced, ...guessed];
}

/// Look for a till by the shape of what it leaves behind, not by its name.
///
/// The last resort, and the only tier that survives the till being renamed. The
/// two tiers above it both depend on a name: the announcement on the till being
/// new enough to write one, and the computed candidates on its CompanyName and
/// ProductName resources still reading "Vesopa EPOS Limited" and "Vesopa EPOS".
/// Neither is a promise, and a customer display that goes blank because a build
/// setting changed is a bad way to find out.
///
/// So this sweeps the two roots a Flutter application's support folder can be
/// under, two levels down, looking for the `displayasket.json` shape:
///
///     %APPDATA%\<company>\<product>\display\basket.json
///     %LOCALAPPDATA%\Packages\<package>\LocalCache\Roaming\<company>\...
///
/// **Every hit is opened and checked before it is offered.** A path found by
/// sweeping is a path nobody chose, and pointing a screen the public can read
/// at an unknown file because it sat in the right place would be a far worse
/// failure than not finding the till at all. [_looksLikeABasket] is what makes
/// this tier safe enough to have.
List<String> _sweepForBaskets() {
  final found = <String>[];

  void look(Directory root, int depth) {
    if (found.length >= 8) return;
    try {
      if (!root.existsSync()) return;
      for (final entry in root.listSync().whereType<Directory>()) {
        if (depth > 1) {
          look(entry, depth - 1);
          continue;
        }
        final candidate = File(
          '${entry.path}\\display\\basket.json',
        );
        if (candidate.existsSync() && _looksLikeABasket(candidate)) {
          found.add(candidate.path);
        }
      }
    } catch (_) {
      // A folder this account cannot read is a folder with no till in it.
    }
  }

  final roaming = Platform.environment['APPDATA'];
  if (roaming != null && roaming.isNotEmpty) {
    look(Directory(roaming), 2);
  }

  final local = Platform.environment['LOCALAPPDATA'];
  if (local != null && local.isNotEmpty) {
    try {
      final packages = Directory('$local\\Packages');
      if (packages.existsSync()) {
        for (final pkg in packages.listSync().whereType<Directory>()) {
          look(Directory('${pkg.path}\\LocalCache\\Roaming'), 2);
        }
      }
    } catch (_) {
      // As above.
    }
  }

  return found;
}

/// Whether [file] is a basket a Vesopa till wrote.
///
/// Checked by content, because the sweep above found it by position and
/// position is not evidence. It has to parse, carry a format this build
/// understands, and name a state the till actually publishes.
bool _looksLikeABasket(File file) {
  try {
    // A basket is a few hundred bytes. Anything large enough to be worth
    // reading carefully is not one, and this runs against files chosen by a
    // directory listing rather than by a person.
    if (file.lengthSync() > 512 * 1024) return false;

    final raw = jsonDecode(file.readAsStringSync());
    if (raw is! Map) return false;
    if (((raw['format'] as num?)?.toInt() ?? 0) > 1) return false;
    return const {'idle', 'sale', 'paid'}.contains(raw['state']);
  } catch (_) {
    return false;
  }
}

/// When [path] was last written, or the epoch if it is not there at all.
DateTime _writtenAt(String path) {
  try {
    final file = File(path);
    return file.existsSync() ? file.lastModifiedSync() : DateTime(1970);
  } catch (_) {
    return DateTime(1970);
  }
}

/// The best guess at the till's basket file.
///
/// Returns the candidate that has actually been written to, and otherwise the
/// first one — a path that does not exist yet is the right answer on a machine
/// where the till has been installed but has not yet opened a bill, which is
/// every machine on install day.
///
/// Returns null off Windows, and where the environment gives nothing to build a
/// path from. The settings screen then shows an empty box.
String? defaultBasketPath() {
  final candidates = candidateBasketPaths();
  return candidates.isEmpty ? null : candidates.first;
}

@immutable
class DisplaySettings {
  const DisplaySettings({
    this.basketPath = '',
    this.advertFolder = '',
    this.screenKey = '',
    this.fullScreen = true,
    this.idleSeconds = 45,
    this.dwellSeconds = 12,
    this.showPrices = true,
    this.thankYou = 'Thank you',
    this.advertVolume = 0,
    this.billOnRight = false,
    this.billShare = 50,
    this.fillScreen = false,
    this.standingMessage = '',
  });

  /// A basket file typed in by hand, overriding what the till announced.
  ///
  /// Empty is the normal case and the default: follow the till on this machine,
  /// wherever it turns out to be. It is only filled in for the setup this
  /// application does not otherwise support — a display on a *different* PC,
  /// reading the till's folder over a share — and it is deliberately a plain
  /// path rather than a second discovery mechanism.
  final String basketPath;

  /// The folder of images and clips to play. Empty means none chosen.
  final String advertFolder;

  /// Which monitor this window belongs on — see `data/screens.dart` for what
  /// the key is and why it is a hardware id rather than a number.
  ///
  /// Empty means nobody has chosen, which is a fresh install: the window is
  /// left where it opened, showing the setup card, rather than taking over the
  /// primary screen. On a two-screen till the primary screen is the till.
  final String screenKey;

  /// Whether to fill the chosen screen, with no title bar and nothing to drag.
  ///
  /// On by default, because that is what a customer display is. It only takes
  /// effect once a screen has been chosen, so it cannot swallow the till on a
  /// machine nobody has set up yet, and Escape always brings the window back.
  final bool fullScreen;

  /// How long with no change to the basket before the adverts take the whole
  /// screen.
  ///
  /// The adjustable one the venue asked for. Zero means never — a screen beside
  /// a busy bar may want the bill up permanently — and that is offered rather
  /// than treated as a mistake.
  final int idleSeconds;

  /// How long each still advert stays up.
  final int dwellSeconds;

  /// Whether line prices are shown. A venue that discounts on the fly may not
  /// want a customer reading each line's price off the screen.
  final bool showPrices;

  /// What the screen says when a sale has just been paid for.
  final String thankYou;

  /// How loud video adverts play, 0 to 100. Silent by default.
  final int advertVolume;

  /// Which side of the screen the bill is on. Which side is right depends on
  /// where the customer stands, which is a property of the counter.
  final bool billOnRight;

  /// How much of the screen the bill takes, as a percentage. Clamped where it
  /// is used, so a hand-edited file cannot produce a bill with no width.
  final int billShare;

  /// Whether adverts fill their panel, cropping to fit, instead of sitting
  /// inside it with bars around them.
  final bool fillScreen;

  /// A line the venue sets, shown across the bottom of the adverts.
  final String standingMessage;

  /// The bill's share of the screen, as a usable fraction.
  double get billFraction => (billShare.clamp(20, 80)) / 100;

  Duration get idleAfter => Duration(seconds: idleSeconds);
  Duration get dwell => Duration(seconds: dwellSeconds);

  /// The advert folder as a directory, or null when none has been chosen.
  ///
  /// Null rather than an empty [Directory]: an empty path resolves to the
  /// process's working directory, and a display that decided to play every
  /// image it found next to its own executable would be a memorable bug.
  Directory? get advertDirectory =>
      advertFolder.trim().isEmpty ? null : Directory(advertFolder.trim());

  /// The file to actually follow: what was typed in, or what was found.
  ///
  /// Resolved rather than stored. A path stored on the day the display was set
  /// up is a path that is right until the till is upgraded, reinstalled, or
  /// moved from the .exe to the Store — and then wrong, silently, on a screen
  /// nobody is looking at for faults.
  ///
  /// This does touch the disk, so it is not for calling on every frame. The
  /// display page holds the answer and re-asks only while it has not found the
  /// till — see `ui/display_page.dart`.
  String resolveBasketPath() {
    final typed = basketPath.trim();
    return typed.isNotEmpty ? typed : (defaultBasketPath() ?? '');
  }

  /// Whether this screen has anywhere to look.
  ///
  /// True on any Windows machine, because there is always a path worth
  /// watching even before the till has written to it. The screen that says
  /// "not set up" is therefore only ever seen where no path could be built at
  /// all, which is not a machine a till runs on.
  bool get isConfigured => resolveBasketPath().isNotEmpty;

  DisplaySettings copyWith({
    String? basketPath,
    String? advertFolder,
    String? screenKey,
    bool? fullScreen,
    int? idleSeconds,
    int? dwellSeconds,
    bool? showPrices,
    String? thankYou,
    int? advertVolume,
    bool? billOnRight,
    int? billShare,
    bool? fillScreen,
    String? standingMessage,
  }) => DisplaySettings(
    basketPath: basketPath ?? this.basketPath,
    advertFolder: advertFolder ?? this.advertFolder,
    screenKey: screenKey ?? this.screenKey,
    fullScreen: fullScreen ?? this.fullScreen,
    idleSeconds: idleSeconds ?? this.idleSeconds,
    dwellSeconds: dwellSeconds ?? this.dwellSeconds,
    showPrices: showPrices ?? this.showPrices,
    thankYou: thankYou ?? this.thankYou,
    advertVolume: advertVolume ?? this.advertVolume,
    billOnRight: billOnRight ?? this.billOnRight,
    billShare: billShare ?? this.billShare,
    fillScreen: fillScreen ?? this.fillScreen,
    standingMessage: standingMessage ?? this.standingMessage,
  );
}

const _keyBasket = 'display.basket_path';
const _keyAdverts = 'display.advert_folder';

/// The two keys `main()` reads directly, before there is a widget tree to hold
/// a provider. Public so that the window is positioned from the same strings
/// this file stores, rather than from a copy of them that can drift.
const keyScreen = 'display.screen_key';
const keyFullScreen = 'display.full_screen';

const _keyIdle = 'display.idle_seconds';
const _keyDwell = 'display.dwell_seconds';
const _keyPrices = 'display.show_prices';
const _keyThanks = 'display.thank_you';

class DisplaySettingsController extends AsyncNotifier<DisplaySettings> {
  @override
  Future<DisplaySettings> build() async {
    final prefs = await SharedPreferences.getInstance();
    return DisplaySettings(
      // Only what somebody typed. Storing the detected path here is what
      // would freeze a guess made on install day into a setting nothing ever
      // revisits.
      basketPath: prefs.getString(_keyBasket) ?? '',
      advertFolder: prefs.getString(_keyAdverts) ?? '',
      screenKey: prefs.getString(keyScreen) ?? '',
      fullScreen: prefs.getBool(keyFullScreen) ?? true,
      idleSeconds: prefs.getInt(_keyIdle) ?? 45,
      dwellSeconds: prefs.getInt(_keyDwell) ?? 12,
      showPrices: prefs.getBool(_keyPrices) ?? true,
      thankYou: prefs.getString(_keyThanks) ?? 'Thank you',
    );
  }

  Future<void> save(DisplaySettings next) async {
    // On screen first, stored second. A display whose disk is full should still
    // be showing what the manager just set for the rest of the day, rather than
    // silently reverting under them.
    state = AsyncData(next);
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_keyBasket, next.basketPath);
      await prefs.setString(_keyAdverts, next.advertFolder);
      await prefs.setString(keyScreen, next.screenKey);
      await prefs.setBool(keyFullScreen, next.fullScreen);
      await prefs.setInt(_keyIdle, next.idleSeconds);
      await prefs.setInt(_keyDwell, next.dwellSeconds);
      await prefs.setBool(_keyPrices, next.showPrices);
      await prefs.setString(_keyThanks, next.thankYou);
    } catch (_) {
      // Nothing to tell the customer standing in front of this.
    }
  }
}

final displaySettingsProvider =
    AsyncNotifierProvider<DisplaySettingsController, DisplaySettings>(
      DisplaySettingsController.new,
    );
