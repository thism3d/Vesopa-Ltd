/// Being set up from the till.
///
/// The manager is standing at the till. This screen is facing the other way,
/// on a bracket, with no keyboard in front of it — so the till owns every
/// setting on it, and this file is the other end of that.
///
/// See `vesopa_epos/lib/data/customer_display_control.dart` for the protocol.
/// Two files, in the folder this application already finds:
///
///   * `settings.json` — the till writes, this reads. What to do.
///   * `status.json`   — this writes, the till reads. What is actually being
///     done, and which monitors are attached, so the till can offer them by
///     name rather than asking somebody to guess.
///
/// WHO WINS
///
/// The till does, whenever it has said anything at all. This screen keeps its
/// own settings page for the case the till cannot reach — a display on a
/// different machine, or one being set up before the till has ever been
/// started — and hands authority over the moment a settings file appears.
/// Anything else means two places to change one thing, and a manager who
/// changes it in the wrong one.
///
/// Nothing here throws. A control channel that fell over would take a working
/// customer display down with it, and the display's job does not depend on
/// being configurable.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

/// This application's version, as reported to the till.
///
/// Written out rather than read from the package, because reading it means a
/// plugin and a platform channel for one string on one line of one settings
/// screen. Kept in step with `version:` in pubspec.yaml by hand — the release
/// checklist there mentions it.
const appVersion = '1.6.1';

/// The shape of both files, matching the till's constant of the same name.
const displayControlFormat = 1;

const displayControlFile = 'settings.json';
const displayStatusFile = 'status.json';

/// Whether a till is setting this screen up.
///
/// A synchronous look for the settings file beside [basketPath], for the
/// display's own settings page: when the till owns these settings, that page
/// steps aside and says where they are, rather than offering a second set of
/// controls that quietly lose to the till two seconds later.
bool isControlledByTill(String basketPath) {
  try {
    if (basketPath.trim().isEmpty) return false;
    final folder = File(basketPath).parent;
    return File('${folder.path}/$displayControlFile').existsSync();
  } catch (_) {
    return false;
  }
}

/// Field readers that never throw.
///
/// A cast would: `raw['idle_seconds'] as num?` on a string throws, and the whole
/// settings file goes with it. These fall back one field at a time, so a till
/// that sent one bad number still sets the other six things.
String _str(Object? value, String fallback) =>
    value is String ? value : fallback;

int _int(Object? value, int fallback) =>
    value is num ? value.toInt() : fallback;

bool _bool(Object? value, {required bool fallback}) =>
    value is bool ? value : fallback;

/// What the till has said this screen should do.
class TillControl {
  const TillControl({
    required this.advertFolder,
    required this.idleSeconds,
    required this.dwellSeconds,
    required this.showPrices,
    required this.thankYou,
    required this.screenKey,
    required this.fullScreen,
    required this.advertVolume,
    required this.billOnRight,
    required this.billShare,
    required this.fillScreen,
    required this.standingMessage,
    required this.customerQr,
    required this.customerQrCaption,
  });

  final String advertFolder;
  final int idleSeconds;
  final int dwellSeconds;
  final bool showPrices;
  final String thankYou;
  final String screenKey;
  final bool fullScreen;
  final int advertVolume;
  final bool billOnRight;
  final int billShare;
  final bool fillScreen;
  final String standingMessage;

  /// A code for the customer to point their phone at, or empty for none. What
  /// it means is the venue's business — this end draws the square.
  final String customerQr;

  /// The line under it.
  final String customerQrCaption;

  /// Null when the file is missing, unreadable, or written by a newer till than
  /// this build understands. All three mean the same thing to the caller: carry
  /// on with what this screen already had.
  static TillControl? fromJson(Object? raw) {
    if (raw is! Map) return null;
    if (_int(raw['format'], 0) > displayControlFormat) return null;

    return TillControl(
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
      customerQr: _str(raw['customer_qr'], ''),
      customerQrCaption: _str(raw['customer_qr_caption'], 'Scan to join'),
    );
  }
}

/// Follows the till's settings file, and reports back into the same folder.
///
/// The folder is derived from the basket path rather than resolved separately.
/// Finding the till is already a solved problem with three tiers of discovery
/// behind it (see `settings.dart`), and solving it twice is how the two answers
/// come to disagree.
class TillControlChannel {
  TillControlChannel({
    required this.basketPath,
    this.pollEvery = const Duration(seconds: 2),
  });

  /// The basket file this display is following. Its folder is the shared one.
  final String basketPath;

  /// How often the settings file is re-read and the status re-written.
  ///
  /// Two seconds. A manager at the till moves a slider and looks up at this
  /// screen, and anything slower reads as nothing having happened.
  final Duration pollEvery;

  final _controls = StreamController<TillControl>.broadcast();

  /// Fires only when the till's settings have actually changed.
  Stream<TillControl> get controls => _controls.stream;

  Timer? _timer;
  DateTime? _lastModified;
  bool _disposed = false;

  /// Whether the till has ever said anything.
  ///
  /// What the settings page uses to decide between showing its own controls and
  /// saying that the till owns them.
  bool get isControlled => _isControlled;
  bool _isControlled = false;

  /// The status this display should be reporting. Set by the display page,
  /// which is the only thing that knows all of it.
  DisplayStatusReport report = const DisplayStatusReport();

  Directory? get _folder {
    try {
      final folder = File(basketPath).parent;
      return folder.existsSync() ? folder : null;
    } catch (_) {
      return null;
    }
  }

  /// The tick currently running, so [dispose] can wait for it.
  ///
  /// Without this, disposing cancels the timer and returns while a status write
  /// is still in flight — and the write lands in a folder the caller has
  /// already moved on from. Harmless in the application, where the folder
  /// outlives everything; not harmless in a test, which is where it showed up.
  Future<void>? _inFlight;

  void start() {
    _disposed = false;
    _inFlight = _tick();
    _timer = Timer.periodic(pollEvery, (_) {
      _inFlight = _tick();
    });
  }

  Future<void> _tick() async {
    if (_disposed) return;
    await _readControl();
    if (_disposed) return;
    await _writeStatus();
  }

  Future<void> _readControl() async {
    try {
      final folder = _folder;
      if (folder == null) return;

      final file = File('${folder.path}/$displayControlFile');
      final stat = await file.stat();
      if (stat.type == FileSystemEntityType.notFound) return;

      _isControlled = true;

      // Unchanged since the last read. Skipping the parse is what keeps this
      // at effectively no cost every two seconds, and — more importantly —
      // stops the display re-applying settings it is already running, which
      // would restart a playing advert every two seconds.
      if (_lastModified != null && !stat.modified.isAfter(_lastModified!)) {
        return;
      }

      final control = TillControl.fromJson(
        jsonDecode(await file.readAsString()),
      );
      if (control == null) return;

      _lastModified = stat.modified;
      if (!_controls.isClosed) _controls.add(control);
    } catch (_) {
      // A read that landed mid-rename, or a folder that has gone. Try again in
      // two seconds; say nothing to the customer.
    }
  }

  Future<void> _writeStatus() async {
    try {
      final folder = _folder;
      if (folder == null) return;

      final file = File('${folder.path}/$displayStatusFile');
      final temp = File('${file.path}.tmp');
      await temp.writeAsString(
        jsonEncode(report.toJson()),
        flush: true,
      );
      await temp.rename(file.path);
    } catch (_) {
      // The till simply shows "no customer display running", which is wrong but
      // harmless. The screen the customer is looking at is unaffected.
    }
  }

  Future<void> dispose() async {
    _disposed = true;
    _timer?.cancel();
    // Let the tick that is already running finish before saying this is closed.
    try {
      await _inFlight;
    } catch (_) {
      // A tick that failed on the way out is a tick nobody is waiting on.
    }
    await _controls.close();
  }
}

/// What this display tells the till about itself.
class DisplayStatusReport {
  const DisplayStatusReport({
    this.appVersion = '',
    this.following = '',
    this.screens = const [],
    this.screenKey = '',
    this.fullScreen = false,
    this.advertCount = 0,
  });

  final String appVersion;
  final String following;

  /// Every monitor attached here, as `(key, label)`. The till cannot enumerate
  /// these — they are not its monitors, and on a two-machine setup not even its
  /// desktop — so this is the only way its screen picker can offer real names.
  final List<({String key, String label})> screens;

  final String screenKey;
  final bool fullScreen;
  final int advertCount;

  Map<String, Object?> toJson() => {
    'format': displayControlFormat,
    'updated_at': DateTime.now().toIso8601String(),
    'app_version': appVersion,
    'following': following,
    'screens': [
      for (final screen in screens)
        {'key': screen.key, 'label': screen.label},
    ],
    'screen_key': screenKey,
    'full_screen': fullScreen,
    'advert_count': advertCount,
  };
}
