/// How this screen finds the till it belongs to.
///
/// WHAT THIS REPLACED, AND WHY
///
/// Until now the display worked the till's data folder out for itself. It read
/// a note the till left, then guessed at `%APPDATA%\<company>\<product>\...`,
/// then guessed again at the Store's redirected copy of that, then swept two
/// folder trees looking for anything shaped like a basket — and where more than
/// one of those turned something up, it sorted them by modification time and
/// took the winner. Failing all that, somebody typed a path in by hand.
///
/// It found the wrong till. A machine that has run a side-loaded till and then
/// a Store one has two of those folders, both real, and the newest file is not
/// reliably today's; a machine where a till was uninstalled keeps the folder it
/// wrote. The display would attach to a folder nobody was writing to any more
/// and sit there showing adverts — with no way for the person standing in front
/// of it to tell a screen that had found nothing from one that had found the
/// wrong thing. Typing the path in was the escape hatch, and working out which
/// path to type was the hard part.
///
/// Guessing is the whole fault. Every tier of it was this application asserting
/// something about how the till happens to be installed, and none of that is
/// anything a screen facing the public should be deciding on its own.
///
/// So it does not decide. **The till hands the folder over, once, and a person
/// confirms it.**
///
/// THE HANDSHAKE
///
/// One folder, machine-wide, and two files in it:
///
///     %PROGRAMDATA%\Vesopa\pairing\request-<device>.json   this writes
///     %PROGRAMDATA%\Vesopa\pairing\grant-<device>.json     the till writes
///
/// While this screen is unpaired it leaves a request there saying what it is
/// and showing a four-digit code. A till that is **signed in** notices, shows
/// the manager "a customer display on this PC wants to connect — code 4821",
/// and on Connect writes the grant, which names the exact basket file by the
/// till's own reckoning. Nothing is computed at this end.
///
/// %PROGRAMDATA% because it is the one place the two applications can both
/// reach. Each is a separate Store package with its own virtualised AppData and
/// no shared identity between them; ProgramData is not redirected and is
/// readable by every account on the machine. It is already where the till
/// leaves its note, so this breaks no new ground.
///
/// WHY THE GRANT IS RE-READ RATHER THAN KEPT
///
/// A path stored at pairing time is a path that is right until the till is
/// upgraded, reinstalled, or moved between packagings — and then silently wrong
/// on a screen nobody is watching for faults. So the pairing is a *relationship*
/// rather than a path: the till remembers which displays it is paired with and
/// rewrites their grants on every start with wherever it writes today, and this
/// end re-reads the grant on a slow timer. A till that moves takes its displays
/// with it, and neither end has to be set up again.
///
/// NOTHING HERE THROWS. A pairing folder that cannot be read is a display that
/// has not been paired, which is a state this already draws.
library;

import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// The shape of both files. A reader seeing a higher number leaves the file
/// alone rather than half-understanding it — the same rule the basket and the
/// control files already follow.
const pairingFormat = 1;

const pairingRootFolder = 'Vesopa';
const pairingSubFolder = 'pairing';

/// How long a request stands before the till should stop offering it.
///
/// This screen rewrites its request every few seconds while it is unpaired, so
/// a live request is never more than a moment old. Anything older is a display
/// that has been switched off, or one that has since been paired — and a till
/// that kept offering those would be asking the manager to connect a screen
/// that is not there.
const pairingRequestTtl = Duration(seconds: 45);

/// Where the two applications meet, or null on a machine with no ProgramData.
///
/// Not created here. This end only needs the folder in order to write a request
/// into it, and [PairingChannel.writeRequest] creates it at that point: a
/// display nobody has tried to pair should leave nothing behind.
String? pairingDirectory() {
  if (!Platform.isWindows) return null;
  final root = Platform.environment['PROGRAMDATA'];
  if (root == null || root.isEmpty) return null;
  return '$root\\$pairingRootFolder\\$pairingSubFolder';
}

/// How old the till's presence may be before this screen calls it "not
/// running".
///
/// Matches the till's own constant. It writes one every five seconds while it
/// is running, so three intervals is generous enough that a till mid-hiccup is
/// not reported as switched off, and short enough that one closed at the end of
/// the night is.
const tillPresenceTtl = Duration(seconds: 20);

/// The till, as it describes itself in the shared folder.
///
/// WHY THIS EXISTS RATHER THAN LOOKING FOR A PROCESS
///
/// This screen needs to know three things before it is worth showing anybody a
/// code: is the till installed, is it running, and is it signed in. None of
/// those can be answered honestly by a sandboxed application poking at the
/// machine — there is no supported way to enumerate processes from one, and
/// every unsupported way is a guess that breaks on the next Windows release.
///
/// So the till says. It writes this file every few seconds while it runs. Its
/// existence answers "installed", its timestamp answers "running", and the flag
/// inside it answers "signed in".
@immutable
class TillPresence {
  const TillPresence({
    required this.terminalName,
    required this.venueName,
    required this.appVersion,
    required this.signedIn,
    required this.at,
  });

  final String terminalName;
  final String venueName;
  final String appVersion;

  /// Whether the till has a venue. A till nobody has signed in cannot connect a
  /// screen, so this screen says so rather than showing a code that nothing
  /// will ever answer.
  final bool signedIn;

  final DateTime at;

  bool get isRunning => DateTime.now().difference(at) <= tillPresenceTtl;

  static TillPresence? fromJson(Object? raw) {
    if (raw is! Map) return null;
    if (((raw['format'] as num?)?.toInt() ?? 0) > pairingFormat) return null;

    final at = DateTime.tryParse((raw['at'] as String?) ?? '');
    if (at == null) return null;

    final terminal = (raw['terminal'] as String?)?.trim() ?? '';
    return TillPresence(
      terminalName: terminal.isEmpty ? 'the till' : terminal,
      venueName: (raw['venue'] as String?)?.trim() ?? '',
      appVersion: (raw['app_version'] as String?)?.trim() ?? '',
      signedIn: raw['signed_in'] == true,
      at: at,
    );
  }
}

/// Whether Vesopa EPOS appears to be installed on this machine.
///
/// ONLY ASKED WHEN THE TILL HAS SAID NOTHING
///
/// A till that has ever run leaves a presence file, and that is a far better
/// answer than this. This is for the one case it cannot cover: a machine where
/// the till has been installed and never started. The difference matters to the
/// person standing in front of the screen — "start Vesopa EPOS" and "Vesopa
/// EPOS is not on this PC" are two completely different jobs.
///
/// **This is not the folder-guessing that was removed, and the distinction is
/// the point.** That guessing produced a *path to follow*, and being wrong
/// meant a screen quietly showing a dead till's data. This produces a yes or a
/// no, and being wrong costs one sentence of wording: a false no is corrected
/// the moment somebody starts the till, and a false yes says "start the till"
/// to somebody who cannot, which is where they were anyway.
bool tillLooksInstalled() {
  if (!Platform.isWindows) return false;

  bool exists(String? path) {
    if (path == null || path.isEmpty) return false;
    try {
      return Directory(path).existsSync() || File(path).existsSync();
    } catch (_) {
      return false;
    }
  }

  final env = Platform.environment;

  // A till that has run leaves its data folder behind, and a note in
  // ProgramData. Either is proof.
  if (exists('${env['APPDATA']}\\Vesopa EPOS Limited\\Vesopa EPOS')) return true;
  if (exists('${env['PROGRAMDATA']}\\Vesopa\\customer-display.json')) return true;

  // Installed from the .exe.
  for (final root in ['PROGRAMFILES', 'PROGRAMFILES(X86)']) {
    if (exists('${env[root]}\\Vesopa EPOS')) return true;
  }

  // Installed from the Store. The package name carries a hash of the publisher
  // on the end, so the folder is matched by prefix rather than computed.
  try {
    final packages = Directory('${env['LOCALAPPDATA']}\\Packages');
    if (packages.existsSync()) {
      for (final entry in packages.listSync().whereType<Directory>()) {
        final name = entry.path.split(RegExp(r'[\\/]')).last;
        if (name.startsWith('MeirionDavies.Vesopa_')) return true;
      }
    }
  } catch (_) {
    // An unreadable Packages folder is not evidence either way, and the tiers
    // above have already had their say.
  }

  return false;
}

/// What this screen calls itself when it asks to be connected.
///
/// Neither field is a credential. This handshake runs between two applications
/// on one PC and is confirmed by a person standing at the till; all the code
/// has to do is tell two screens apart when a venue mounts two of them.
@immutable
class PairingIdentity {
  const PairingIdentity({required this.deviceId, required this.code});

  /// Generated once, on first run, and kept for the life of the installation.
  ///
  /// It is what the till's paired list is keyed on, so renaming this screen —
  /// or renaming the PC — neither produces a second device nor loses the
  /// pairing.
  final String deviceId;

  /// Four digits, shown on this screen and offered on the till.
  ///
  /// Derived from the device id rather than rolled fresh, so a display that
  /// restarts in the middle of being set up shows the manager the same number
  /// it showed a moment ago instead of quietly becoming a different screen.
  final String code;

  static PairingIdentity forDevice(String deviceId) =>
      PairingIdentity(deviceId: deviceId, code: codeFor(deviceId));

  /// A stable four-digit code for [deviceId].
  ///
  /// A plain rolling sum. It does not need to be hard to predict — see the note
  /// above — it needs to be the same every time and different between two
  /// screens on one counter.
  static String codeFor(String deviceId) {
    var hash = 7;
    for (final unit in deviceId.codeUnits) {
      hash = (hash * 31 + unit) & 0x7fffffff;
    }
    return (hash % 10000).toString().padLeft(4, '0');
  }
}

/// A till this screen has been connected to.
@immutable
class Pairing {
  const Pairing({
    required this.basketPath,
    required this.terminalName,
    required this.venueName,
    required this.pairedAt,
  });

  /// The basket file, exactly as the till named it. Never adjusted and never
  /// re-derived: the point of the handshake is that this end computes nothing
  /// about where the till lives.
  final String basketPath;

  /// What the till calls itself — the same string that prints on a receipt, so
  /// whoever is looking at this screen and at a receipt is reading one name.
  final String terminalName;

  /// The venue's trading name, for whoever is setting the screen up. Never the
  /// office email: that is an identifier, not something to put on a screen a
  /// customer can see.
  final String venueName;

  final DateTime pairedAt;

  /// The folder the basket sits in, where `settings.json` and `status.json`
  /// also live. See `data/control.dart`.
  String get folder => File(basketPath).parent.path;

  static Pairing? fromJson(Object? raw) {
    if (raw is! Map) return null;
    if (((raw['format'] as num?)?.toInt() ?? 0) > pairingFormat) return null;

    final basket = raw['basket'];
    if (basket is! String || basket.trim().isEmpty) return null;

    final terminal = (raw['terminal'] as String?)?.trim() ?? '';
    return Pairing(
      basketPath: basket.trim(),
      terminalName: terminal.isEmpty ? 'the till' : terminal,
      venueName: (raw['venue'] as String?)?.trim() ?? '',
      pairedAt:
          DateTime.tryParse((raw['paired_at'] as String?) ?? '') ??
          DateTime.now(),
    );
  }
}

/// Where this screen has got to.
///
/// The four states before [waiting] exist because "no code yet" has four
/// completely different causes and four completely different answers, and a
/// screen that showed one message for all of them would send whoever is
/// standing in front of it to do the wrong thing. In order, they are: install
/// the till, start the till, sign the till in, and then — finally — read the
/// code out.
enum PairingStage {
  /// Not a Windows machine, or one with no ProgramData to meet the till in.
  /// There is nothing to offer and nothing to explain away.
  unavailable,

  /// Vesopa EPOS does not appear to be on this PC at all.
  tillMissing,

  /// It is installed, and it is not running. Somebody has to start it.
  tillIdle,

  /// It is running, and nobody has signed it in. A till with no venue cannot
  /// connect a screen, so there is no point offering a code yet.
  tillSignedOut,

  /// Asking. The code is on screen and the request is on disk.
  waiting,

  /// Connected, and following the till's file.
  paired,
}

@immutable
class PairingState {
  const PairingState({
    required this.stage,
    required this.identity,
    this.pairing,
    this.till,
    this.justConnected = false,
  });

  final PairingStage stage;
  final PairingIdentity identity;

  /// Set only in [PairingStage.paired].
  final Pairing? pairing;

  /// What the till last said about itself, or null where it has said nothing.
  ///
  /// Carried even in [PairingStage.waiting] so the screen can name the till it
  /// is waiting on — "Bar is running, connect this screen there" is a better
  /// instruction than "a till somewhere is running".
  final TillPresence? till;

  /// True for the few seconds after a pairing lands, so the screen can say so
  /// before it starts showing bills.
  ///
  /// Somebody has just pressed a button on a machine facing the other way. This
  /// is the only confirmation they get on *this* side of the counter, and a
  /// display that went straight to adverts would leave them wondering whether
  /// it worked.
  final bool justConnected;

  /// The file to follow, or empty while there is nothing to follow.
  String get basketPath => pairing?.basketPath ?? '';

  bool get isPaired => stage == PairingStage.paired && basketPath.isNotEmpty;

  PairingState copyWith({bool? justConnected}) => PairingState(
    stage: stage,
    identity: identity,
    pairing: pairing,
    till: till,
    justConnected: justConnected ?? this.justConnected,
  );
}

/// Reads and writes the two files.
///
/// Separated from the controller so a test can drive the whole handshake
/// against a folder in a temp directory, with the till's end of it written by
/// hand.
class PairingChannel {
  PairingChannel({this.folderOverride});

  /// Somewhere else to meet. Only for tests — the real location is fixed,
  /// because a location either side would have to be *told* about would defeat
  /// the entire point of having one.
  final String? folderOverride;

  String? get folder => folderOverride ?? pairingDirectory();

  /// Say that this screen is here and would like to be connected.
  ///
  /// Rewritten on every call rather than written once, so the timestamp stays
  /// fresh and the till can tell a display that is asking now from one that was
  /// switched off two days ago.
  Future<void> writeRequest({
    required PairingIdentity identity,
    required String name,
    required String appVersion,
  }) async {
    try {
      final root = folder;
      if (root == null) return;

      final file = File('$root\\request-${identity.deviceId}.json');
      await file.parent.create(recursive: true);
      await file.writeAsString(
        jsonEncode({
          'format': pairingFormat,
          'kind': 'display',
          'device_id': identity.deviceId,
          'code': identity.code,
          'name': name,
          'app_version': appVersion,
          'at': DateTime.now().toIso8601String(),
        }),
        flush: true,
      );
    } catch (_) {
      // A folder this account cannot write to. The screen says it is waiting,
      // which is true, and the settings page explains the rest.
    }
  }

  /// Take the request back down.
  ///
  /// Called once a grant has been read: a request left lying about is a till
  /// offering to connect a screen it is already connected to.
  Future<void> clearRequest(String deviceId) async {
    try {
      final root = folder;
      if (root == null) return;
      final file = File('$root\\request-$deviceId.json');
      if (file.existsSync()) await file.delete();
    } catch (_) {
      // Left behind. The till ignores a request older than its TTL.
    }
  }

  /// What the till on this machine last said about itself, or null if none has
  /// said anything.
  ///
  /// Where a machine has more than one till — unusual, but a back office and a
  /// counter on one PC is a real setup — the freshest wins, and a signed-in one
  /// beats a signed-out one at the same freshness. That is the till most likely
  /// to be able to answer, which is all this is used to decide.
  TillPresence? readTillPresence() {
    try {
      final root = folder;
      if (root == null) return null;

      final dir = Directory(root);
      if (!dir.existsSync()) return null;

      TillPresence? best;
      for (final entry in dir.listSync().whereType<File>()) {
        final name = entry.path.split(RegExp(r'[\\/]')).last;
        if (!name.startsWith('till-') || !name.endsWith('.json')) continue;

        try {
          if (entry.lengthSync() > 64 * 1024) continue;
          final presence = TillPresence.fromJson(
            jsonDecode(entry.readAsStringSync()),
          );
          if (presence == null) continue;

          if (best == null ||
              presence.at.isAfter(best.at) ||
              (presence.signedIn && !best.signedIn)) {
            best = presence;
          }
        } catch (_) {
          // One unreadable file must not hide the others.
        }
      }
      return best;
    } catch (_) {
      return null;
    }
  }

  /// What the till has granted this screen, or null while it has granted
  /// nothing.
  Pairing? readGrant(String deviceId) {
    try {
      final root = folder;
      if (root == null) return null;

      final file = File('$root\\grant-$deviceId.json');
      if (!file.existsSync()) return null;

      // A grant is a few hundred bytes. Anything bigger is not one, and this
      // reads a machine-wide folder rather than a file somebody chose.
      if (file.lengthSync() > 64 * 1024) return null;

      return Pairing.fromJson(jsonDecode(file.readAsStringSync()));
    } catch (_) {
      return null;
    }
  }

  /// Disconnect from the till.
  ///
  /// Removes both files, so the till stops rewriting a grant for a screen that
  /// has walked away and this screen starts asking again from scratch.
  Future<void> forget(String deviceId) async {
    try {
      final root = folder;
      if (root == null) return;
      for (final name in ['request-$deviceId.json', 'grant-$deviceId.json']) {
        final file = File('$root\\$name');
        if (file.existsSync()) await file.delete();
      }
    } catch (_) {
      // Nothing to say to the customer standing in front of this.
    }
  }
}

const _keyDeviceId = 'display.device_id';
const _keyDeviceName = 'display.device_name';

/// This build's version, as it appears in the till's device list.
///
/// Kept in step with `version:` in pubspec.yaml by hand, the same way
/// `data/control.dart` keeps its own copy.
const pairingAppVersion = '1.6.3';

/// This screen's identity and its pairing, kept current.
///
/// Polled rather than watched. Both files are written by another process at
/// human speed — a grant appears when somebody presses a button on the till —
/// and a directory watcher on a ProgramData folder is one more thing that can
/// die silently on a machine this application never sees.
class PairingController extends AsyncNotifier<PairingState> {
  PairingChannel _channel = PairingChannel();

  /// What this screen calls itself in the till's list.
  ///
  /// The computer's own host name to begin with, because that is the one string
  /// already on the machine that means something to whoever installed it. A
  /// venue with two displays renames them from the till.
  static String defaultName() {
    try {
      final host = Platform.localHostname.trim();
      if (host.isNotEmpty) {
        return 'Display on ${host.substring(0, host.length.clamp(0, 28))}';
      }
    } catch (_) {
      // Fall through.
    }
    return 'Customer display';
  }

  @override
  Future<PairingState> build() async {
    final prefs = await SharedPreferences.getInstance();
    final identity = PairingIdentity.forDevice(await _deviceId(prefs));
    return _look(identity);
  }

  /// Read the grant and work out which of the three states this screen is in.
  ///
  /// Synchronous disk work, deliberately: it is one `existsSync` on the common
  /// path, and the alternative — an async read on a timer — races itself when
  /// the timer fires again before the previous read has landed.
  PairingState _look(PairingIdentity identity) {
    if (_channel.folder == null) {
      return PairingState(stage: PairingStage.unavailable, identity: identity);
    }

    // Paired is checked first and unconditionally. A connected screen must keep
    // showing bills through a till restart, an upgrade, or the till simply
    // being closed for the night — none of which are reasons to throw a working
    // display back to a setup card in front of customers.
    final grant = _channel.readGrant(identity.deviceId);
    final till = _channel.readTillPresence();

    if (grant != null) {
      return PairingState(
        stage: PairingStage.paired,
        identity: identity,
        pairing: grant,
        till: till,
      );
    }

    // Not paired. Now the ladder: installed, running, signed in, asking.
    if (till == null) {
      // The till has never run on this machine — or has never run since this
      // build of it started leaving a presence file. Fall back to looking for
      // an installation, which is the only way to tell "not installed" from
      // "installed and never opened". See [tillLooksInstalled].
      return PairingState(
        stage: tillLooksInstalled()
            ? PairingStage.tillIdle
            : PairingStage.tillMissing,
        identity: identity,
      );
    }

    if (!till.isRunning) {
      return PairingState(
        stage: PairingStage.tillIdle,
        identity: identity,
        till: till,
      );
    }

    if (!till.signedIn) {
      return PairingState(
        stage: PairingStage.tillSignedOut,
        identity: identity,
        till: till,
      );
    }

    return PairingState(
      stage: PairingStage.waiting,
      identity: identity,
      till: till,
    );
  }

  /// Look again, and keep the request fresh while there is nothing to follow.
  ///
  /// This is the whole loop; the display page calls it on a timer.
  Future<void> refresh() async {
    final current = state.value;
    if (current == null) return;

    final next = _look(current.identity);

    if (next.stage == PairingStage.waiting) {
      final prefs = await SharedPreferences.getInstance();
      await _channel.writeRequest(
        identity: current.identity,
        name: prefs.getString(_keyDeviceName) ?? defaultName(),
        appVersion: pairingAppVersion,
      );
    }

    final connectedJustNow =
        next.stage == PairingStage.paired &&
        current.stage != PairingStage.paired;

    if (connectedJustNow) {
      // Take the request down so the till stops offering it, and start the
      // moment of confirmation on this side of the counter.
      await _channel.clearRequest(current.identity.deviceId);
      state = AsyncData(next.copyWith(justConnected: true));

      // Long enough to be read across a counter, short enough that a screen
      // switched on before opening is showing adverts by the time anybody
      // arrives. Not a Timer field: this notifier outlives no widget and there
      // is nothing to cancel it against — the guard below is the whole safety.
      Future.delayed(const Duration(seconds: 6), () {
        final now = state.value;
        if (now != null && now.justConnected) {
          state = AsyncData(now.copyWith(justConnected: false));
        }
      });
      return;
    }

    // Published only when something a screen would draw has changed. A grant
    // re-written by the till with the same path in it must not rebuild the feed
    // and restart a playing advert, and a presence file rewritten every five
    // seconds must not rebuild anything at all.
    if (next.stage != current.stage ||
        next.basketPath != current.basketPath ||
        next.pairing?.terminalName != current.pairing?.terminalName ||
        next.till?.terminalName != current.till?.terminalName ||
        next.till?.signedIn != current.till?.signedIn) {
      state = AsyncData(next.copyWith(justConnected: false));
    }
  }

  /// Look again now, because somebody pressed the button.
  ///
  /// The same work the timer does, exposed so the setup card can offer a
  /// "check again" that does something visible. A person who has just started
  /// the till should not have to wait out a poll interval wondering whether the
  /// screen noticed.
  Future<void> checkNow() => refresh();

  /// Disconnect, and start asking again.
  Future<void> forget() async {
    final current = state.value;
    if (current == null) return;

    await _channel.forget(current.identity.deviceId);
    state = AsyncData(
      PairingState(stage: PairingStage.waiting, identity: current.identity),
    );
    await refresh();
  }

  /// Rename this screen, as it appears on the till and in the back office.
  Future<void> rename(String name) async {
    final clean = name.trim();
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(
      _keyDeviceName,
      clean.isEmpty
          ? defaultName()
          : clean.substring(0, clean.length.clamp(0, 40)),
    );
    await refresh();
  }

  /// The name this screen goes by. Read straight from preferences, because the
  /// settings page is the only caller and it can wait.
  Future<String> name() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_keyDeviceName) ?? defaultName();
  }

  /// For tests: meet the till somewhere other than ProgramData.
  @visibleForTesting
  void useFolder(String folder) =>
      _channel = PairingChannel(folderOverride: folder);

  /// The permanent id, generated on first run.
  ///
  /// Thirty-two hex characters from the platform's secure source. Not a UUID,
  /// only because a UUID would mean a dependency for one string nothing ever
  /// parses — it is compared, and that is all.
  static Future<String> _deviceId(SharedPreferences prefs) async {
    final existing = prefs.getString(_keyDeviceId)?.trim();
    if (existing != null && existing.length >= 8) return existing;

    final random = Random.secure();
    final id = [
      for (var i = 0; i < 16; i++)
        random.nextInt(256).toRadixString(16).padLeft(2, '0'),
    ].join();

    await prefs.setString(_keyDeviceId, id);
    return id;
  }
}

final pairingProvider = AsyncNotifierProvider<PairingController, PairingState>(
  PairingController.new,
);
