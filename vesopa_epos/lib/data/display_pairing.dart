/// Connecting a customer display to this till.
///
/// WHY THE TILL DOES THIS AND NOT THE DISPLAY
///
/// The display used to find the till on its own: it read a note, computed two
/// likely folders, swept two directory trees for anything shaped like a basket,
/// and picked whichever had been written to most recently. On a machine that
/// has had more than one till installed — a side-loaded one and then a Store
/// one, or a reinstall under a different name — more than one of those is real,
/// and the newest file is not reliably today's. The display would attach to a
/// folder nobody was writing to and show adverts for ever, and the only way out
/// was somebody typing a path into a screen with no keyboard in front of it.
///
/// Every tier of that was the display asserting something about how this
/// application happens to be installed. None of it is anything a screen facing
/// the public should be deciding.
///
/// So the till decides, because the till is the only thing that *knows* — it
/// does not have to work out where it writes, it writes there. A person presses
/// Connect once and the path is handed over.
///
/// THE HANDSHAKE
///
///     %PROGRAMDATA%\Vesopa\pairing\request-<device>.json   the display writes
///     %PROGRAMDATA%\Vesopa\pairing\grant-<device>.json     this writes
///
/// A display with nowhere to point leaves a request there every few seconds,
/// naming itself and showing a four-digit code on its own screen. This till
/// lists the fresh ones, the manager checks the code against the screen in front
/// of them, and Connect writes the grant.
///
/// ProgramData because it is the one place the two applications can both reach:
/// each is a separate Store package with its own virtualised AppData and no
/// shared identity, and ProgramData is not redirected. It is already where this
/// file's neighbour leaves its note, so it breaks no new ground.
///
/// THE GRANT IS REWRITTEN, NOT WRITTEN ONCE
///
/// [refreshGrants] runs on every start and rewrites the grant for every display
/// this till is paired with, with wherever it writes *today*. That is what makes
/// the pairing survive an upgrade, a reinstall, or a move between packagings:
/// the relationship is remembered, the path is not. A venue that has paired its
/// display once never has to do it again.
///
/// SIGNED IN, OR NOTHING
///
/// [connect] refuses on a till with no venue. A display is registered against
/// the office it belongs to and shown in that venue's back office, and a till
/// that has not been signed in has no office to register it against. Pairing
/// first and sorting the account out later would mean a device row that belongs
/// to nobody.
///
/// NOTHING HERE MAY THROW INTO A SALE. Every failure is swallowed, exactly as in
/// `customer_display.dart`: a display that could not be connected is a screen
/// showing adverts, and that is not a reason to stop taking money.
library;

import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'customer_display.dart';

/// The shape of both files, matching the display's constant of the same name.
const pairingFormat = 1;

const pairingRootFolder = 'Vesopa';
const pairingSubFolder = 'pairing';

/// How old a request may be and still be worth offering.
///
/// The display rewrites its request every few seconds while it is unpaired, so
/// anything older than this is a screen that has been switched off or has since
/// been connected. Offering those would be asking the manager to connect a
/// display that is not there — which is the same class of fault as the guessing
/// this replaced, arriving from the other direction.
const pairingRequestTtl = Duration(seconds: 45);

/// How often the till says it is still here.
///
/// The display waits for this file before it offers a code, so the interval is
/// what decides how long somebody stands in front of a blank screen after
/// starting the till. Five seconds is short enough not to be noticed and long
/// enough that it is one small write every five seconds for the life of a
/// service.
const tillPresenceInterval = Duration(seconds: 5);

/// How old the till's presence may be before the display calls it "not
/// running".
///
/// Three intervals. A till mid-garbage-collection, or one whose disk hiccuped,
/// must not read as switched off — but a till that was closed last night has to.
const tillPresenceTtl = Duration(seconds: 20);

/// Proof that a till is installed on this machine, and whether it is running.
///
/// WHY THE TILL SAYS SO RATHER THAN THE DISPLAY LOOKING
///
/// The display used to work out things about the till by inspecting the disk,
/// and that is what this whole change exists to stop. Asking "is a process
/// running" from a sandboxed Store application is worse still: there is no
/// supported way to do it, and every unsupported way is a guess that breaks on
/// the next Windows release.
///
/// So the till writes a small file every few seconds while it is running. Its
/// presence means installed; its freshness means running; the flag inside it
/// means somebody is signed in. Three questions, one file, no guessing.
@immutable
class TillPresence {
  const TillPresence({
    required this.deviceId,
    required this.terminalName,
    required this.venueName,
    required this.appVersion,
    required this.signedIn,
    required this.at,
  });

  final String deviceId;
  final String terminalName;
  final String venueName;
  final String appVersion;

  /// Whether the till has a venue. A till nobody has signed in cannot connect a
  /// screen — see [DisplayPairing.connect] — and the display says so rather
  /// than showing a code nothing will ever answer.
  final bool signedIn;

  final DateTime at;

  /// Whether the till is running *now*, as opposed to merely installed.
  bool get isRunning => DateTime.now().difference(at) <= tillPresenceTtl;

  Map<String, Object?> toJson() => {
    'format': pairingFormat,
    'device_id': deviceId,
    'terminal': terminalName,
    'venue': venueName,
    'app_version': appVersion,
    'signed_in': signedIn,
    'at': at.toIso8601String(),
  };

  static TillPresence? fromJson(Object? raw) {
    if (raw is! Map) return null;
    if (((raw['format'] as num?)?.toInt() ?? 0) > pairingFormat) return null;

    final at = DateTime.tryParse((raw['at'] as String?) ?? '');
    if (at == null) return null;

    final terminal = (raw['terminal'] as String?)?.trim() ?? '';
    return TillPresence(
      deviceId: (raw['device_id'] as String?)?.trim() ?? '',
      terminalName: terminal.isEmpty ? 'the till' : terminal,
      venueName: (raw['venue'] as String?)?.trim() ?? '',
      appVersion: (raw['app_version'] as String?)?.trim() ?? '',
      signedIn: raw['signed_in'] == true,
      at: at,
    );
  }
}

/// A customer display asking to be connected.
@immutable
class DisplayPairRequest {
  const DisplayPairRequest({
    required this.deviceId,
    required this.code,
    required this.name,
    required this.appVersion,
    required this.at,
  });

  /// The display's own permanent id. What the pairing is keyed on, so renaming
  /// the screen does not produce a second device.
  final String deviceId;

  /// The four digits on the display's own screen right now. The manager checks
  /// these against the glass in front of them — it is how a venue with two
  /// displays connects the right one.
  final String code;

  final String name;
  final String appVersion;
  final DateTime at;

  bool get isFresh => DateTime.now().difference(at) <= pairingRequestTtl;

  static DisplayPairRequest? fromJson(Object? raw) {
    if (raw is! Map) return null;
    if (((raw['format'] as num?)?.toInt() ?? 0) > pairingFormat) return null;
    if (raw['kind'] != 'display') return null;

    final id = raw['device_id'];
    if (id is! String || id.trim().length < 8) return null;

    final name = (raw['name'] as String?)?.trim() ?? '';
    return DisplayPairRequest(
      deviceId: id.trim(),
      code: (raw['code'] as String?)?.trim() ?? '----',
      name: name.isEmpty ? 'Customer display' : name,
      appVersion: (raw['app_version'] as String?)?.trim() ?? '',
      at: DateTime.tryParse((raw['at'] as String?) ?? '') ?? DateTime(1970),
    );
  }
}

/// A display this till has connected.
@immutable
class PairedDisplay {
  const PairedDisplay({
    required this.deviceId,
    required this.name,
    required this.pairedAt,
  });

  final String deviceId;
  final String name;
  final DateTime pairedAt;

  Map<String, Object?> toJson() => {
    'device_id': deviceId,
    'name': name,
    'paired_at': pairedAt.toIso8601String(),
  };

  static PairedDisplay? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final id = raw['device_id'];
    if (id is! String || id.trim().isEmpty) return null;
    return PairedDisplay(
      deviceId: id.trim(),
      name: (raw['name'] as String?)?.trim() ?? 'Customer display',
      pairedAt:
          DateTime.tryParse((raw['paired_at'] as String?) ?? '') ??
          DateTime.now(),
    );
  }
}

/// Why a display could not be connected, in words a manager can act on.
///
/// Only one of these is a real refusal; the rest are the machine being unable
/// rather than unwilling, and they are worded to say which.
enum PairFailure {
  /// The till has no venue, so there is nothing to register the screen against.
  notSignedIn,

  /// No ProgramData, which in practice means this is not the Windows build.
  noSharedFolder,

  /// The till's own data folder could not be opened, so there is no basket file
  /// to point anything at.
  noBasketFolder,

  /// The grant could not be written — a folder this account cannot write to.
  couldNotWrite,
}

const _keyPaired = 'display.paired';

/// Screens the manager has said no to.
///
/// Kept, because the display goes on asking every few seconds — it has no way
/// to know it was refused — and a full-screen prompt that came back three
/// seconds after being dismissed would be unusable.
///
/// It suppresses the *interruption*, not the pairing: a declined screen is
/// still listed on the customer display settings page, where somebody who has
/// gone looking for it can connect it deliberately. "Stop asking me" and "never
/// connect this" are different instructions and only the first one was given.
const _keyDeclined = 'display.declined';

/// The till's end of the handshake.
class DisplayPairing {
  DisplayPairing({this.folderOverride, this.basketOverride});

  /// Somewhere else to meet, and a basket path to hand out instead of the real
  /// one. Both only for tests: the real locations are fixed, because a location
  /// either side would have to be *told* about would defeat the point.
  final String? folderOverride;
  final String? basketOverride;

  /// Where the two applications meet, or null on a machine with no ProgramData.
  String? get folder {
    if (folderOverride != null) return folderOverride;
    if (!Platform.isWindows) return null;
    final root = Platform.environment['PROGRAMDATA'];
    if (root == null || root.isEmpty) return null;
    return '$root${Platform.pathSeparator}$pairingRootFolder'
        '${Platform.pathSeparator}$pairingSubFolder';
  }

  /// The file this till publishes the basket to.
  ///
  /// Resolved from the same folder [CustomerDisplayFeed] writes into rather than
  /// asked of the feed, so a display can be connected before the first bill of
  /// the day is opened — which is when somebody is actually standing there with
  /// a bracket and a screwdriver.
  Future<String?> basketPath() async {
    if (basketOverride != null) return basketOverride;
    final dir = await customerDisplayDirectory();
    if (dir == null) return null;
    return '${dir.path}${Platform.pathSeparator}$customerDisplayFile';
  }

  // ---------------------------------------------------------------------------
  // Who is asking
  // ---------------------------------------------------------------------------

  /// Displays asking to be connected, newest first.
  ///
  /// Already-paired screens are left out: they are not asking, and a list that
  /// offered to connect something already connected would send a manager round
  /// the counter to check a screen that is working.
  Future<List<DisplayPairRequest>> pending({bool includeDeclined = false}) async {
    final root = folder;
    if (root == null) return const [];

    final known = {for (final d in await paired()) d.deviceId};
    if (!includeDeclined) known.addAll(await declined());
    final found = <DisplayPairRequest>[];

    try {
      final dir = Directory(root);
      if (!dir.existsSync()) return const [];

      for (final entry in dir.listSync().whereType<File>()) {
        final name = entry.path.split(RegExp(r'[\\/]')).last;
        if (!name.startsWith('request-') || !name.endsWith('.json')) continue;

        try {
          // A request is a couple of hundred bytes. Anything larger is not one,
          // and this reads a machine-wide folder rather than a chosen file.
          if (entry.lengthSync() > 64 * 1024) continue;

          final request = DisplayPairRequest.fromJson(
            jsonDecode(entry.readAsStringSync()),
          );
          if (request == null || !request.isFresh) continue;
          if (known.contains(request.deviceId)) continue;
          found.add(request);
        } catch (_) {
          // One unreadable request must not hide the others.
        }
      }
    } catch (_) {
      // A folder this account cannot list is a machine with no display asking.
    }

    found.sort((a, b) => b.at.compareTo(a.at));
    return found;
  }

  // ---------------------------------------------------------------------------
  // Connecting
  // ---------------------------------------------------------------------------

  /// Connect [request], and remember it.
  ///
  /// Returns null on success, or the reason it could not be done. The reason is
  /// returned rather than thrown because every one of them is something the
  /// screen should say plainly, and none of them is exceptional.
  Future<PairFailure?> connect(
    DisplayPairRequest request, {
    required String office,
    required String terminalName,
    required String venueName,
  }) async {
    // A display belongs to a venue, and a till with no venue has none to give
    // it. See the note at the top of this file.
    if (!_looksLikeAnOffice(office)) return PairFailure.notSignedIn;
    if (folder == null) return PairFailure.noSharedFolder;

    final basket = await basketPath();
    if (basket == null || basket.isEmpty) return PairFailure.noBasketFolder;

    // One instant, used for both. Read twice, the grant on disk and the entry
    // in preferences disagree by a few milliseconds — and [refreshGrants] then
    // rewrites the grant's date on every start, so "connected on" quietly moves
    // every time the till is switched on.
    final now = DateTime.now();

    final written = await _writeGrant(
      deviceId: request.deviceId,
      basket: basket,
      terminalName: terminalName,
      venueName: venueName,
      pairedAt: now,
    );
    if (!written) return PairFailure.couldNotWrite;

    await _remember(
      PairedDisplay(
        deviceId: request.deviceId,
        name: request.name,
        pairedAt: now,
      ),
    );
    // A screen that has just been connected is plainly not one the manager is
    // refusing, so an old decline is cleared rather than left to surprise
    // somebody who later disconnects it and wonders why it never asks again.
    await allow(request.deviceId);
    return null;
  }

  /// Rewrite the grant for every display this till is paired with.
  ///
  /// Called on every start. This is what makes a pairing survive the till being
  /// upgraded, reinstalled or moved between packagings — see the note at the top
  /// of this file. Cheap enough to do unconditionally: it is one small write per
  /// paired screen, and a venue has one or two.
  ///
  /// Skipped on a till that is not signed in, for the same reason [connect]
  /// refuses. A till that has been signed out should stop feeding screens that
  /// were attached to the account it no longer has.
  Future<void> refreshGrants({
    required String office,
    required String terminalName,
    required String venueName,
  }) async {
    if (!_looksLikeAnOffice(office)) return;

    final displays = await paired();
    if (displays.isEmpty) return;

    final basket = await basketPath();
    if (basket == null || basket.isEmpty) return;

    for (final display in displays) {
      await _writeGrant(
        deviceId: display.deviceId,
        basket: basket,
        terminalName: terminalName,
        venueName: venueName,
        pairedAt: display.pairedAt,
      );
    }
  }

  /// Disconnect a display and stop rewriting its grant.
  ///
  /// The grant file is removed as well as the entry, so the screen goes back to
  /// asking rather than carrying on with a path this till has stopped
  /// maintaining. A screen that keeps working after it has been disconnected is
  /// the worst of both.
  Future<void> forget(String deviceId) async {
    final displays = await paired();
    displays.removeWhere((d) => d.deviceId == deviceId);
    await _store(displays);

    try {
      final root = folder;
      if (root == null) return;
      final grant = File(
        '$root${Platform.pathSeparator}grant-$deviceId.json',
      );
      if (grant.existsSync()) await grant.delete();
    } catch (_) {
      // Left behind. The display keeps working until it is next restarted,
      // which is not worth a message to the person who just pressed Forget.
    }
  }

  /// The displays this till has connected.
  Future<List<PairedDisplay>> paired() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(_keyPaired);
      if (raw == null || raw.isEmpty) return [];

      final decoded = jsonDecode(raw);
      if (decoded is! List) return [];
      return [
        for (final entry in decoded) ?PairedDisplay.fromJson(entry),
      ];
    } catch (_) {
      return [];
    }
  }

  /// Rename a paired display, as it appears here and in the back office.
  Future<void> rename(String deviceId, String name) async {
    final clean = name.trim();
    if (clean.isEmpty) return;

    final displays = await paired();
    final next = [
      for (final display in displays)
        if (display.deviceId == deviceId)
          PairedDisplay(
            deviceId: display.deviceId,
            name: clean.substring(0, clean.length.clamp(0, 40)),
            pairedAt: display.pairedAt,
          )
        else
          display,
    ];
    await _store(next);
  }

  // ---------------------------------------------------------------------------
  // Saying the till is here
  // ---------------------------------------------------------------------------

  /// Write the presence file. Called on start and on a heartbeat.
  ///
  /// Best effort and silent, like everything else in this file. A till that
  /// cannot write it sells exactly as it did; the only thing lost is that a
  /// display on the same machine says "not running" and offers no code, which
  /// is a visible fault somebody can act on rather than a silent one.
  Future<void> announcePresence({
    required String deviceId,
    required String terminalName,
    required String venueName,
    required String appVersion,
    required bool signedIn,
  }) async {
    try {
      final root = folder;
      if (root == null) return;

      final file = File(
        '$root${Platform.pathSeparator}till-$deviceId.json',
      );
      await file.parent.create(recursive: true);
      await file.writeAsString(
        jsonEncode(
          TillPresence(
            deviceId: deviceId,
            terminalName: terminalName,
            venueName: venueName,
            appVersion: appVersion,
            signedIn: signedIn,
            at: DateTime.now(),
          ).toJson(),
        ),
        flush: true,
      );
    } catch (_) {
      // See above.
    }
  }

  /// Stop claiming to be here.
  ///
  /// Called when the till closes. Not relied upon — a till that loses power
  /// says nothing — which is exactly why the display judges by the timestamp
  /// rather than by the file's existence. This only makes a clean shutdown
  /// read as one immediately instead of twenty seconds later.
  Future<void> withdrawPresence(String deviceId) async {
    try {
      final root = folder;
      if (root == null) return;
      final file = File('$root${Platform.pathSeparator}till-$deviceId.json');
      if (file.existsSync()) await file.delete();
    } catch (_) {
      // The timestamp will go stale on its own.
    }
  }

  // ---------------------------------------------------------------------------
  // Saying no
  // ---------------------------------------------------------------------------

  /// Stop the full-screen prompt for this screen.
  ///
  /// See [_keyDeclined]: this suppresses the interruption and not the pairing.
  Future<void> decline(String deviceId) async {
    final ids = await declined()..add(deviceId);
    await _storeDeclined(ids);
  }

  /// Offer this screen again.
  Future<void> allow(String deviceId) async {
    final ids = await declined()..remove(deviceId);
    await _storeDeclined(ids);
  }

  Future<Set<String>> declined() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      return (prefs.getStringList(_keyDeclined) ?? const <String>[]).toSet();
    } catch (_) {
      return <String>{};
    }
  }

  Future<void> _storeDeclined(Set<String> ids) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setStringList(_keyDeclined, ids.toList());
    } catch (_) {
      // A preferences write that failed. The prompt comes back, which is
      // irritating and not harmful.
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /// Whether [office] is a venue this till can attach a screen to.
  ///
  /// A shape check and nothing more. The office has already been verified by
  /// the server at sign-in — this is here to distinguish "signed in" from "not"
  /// without a round trip, on a till that may have no network at all.
  static bool _looksLikeAnOffice(String office) {
    final trimmed = office.trim();
    if (trimmed.length < 5) return false;
    final at = trimmed.indexOf('@');
    return at > 0 && trimmed.indexOf('.', at) > at + 1;
  }

  Future<bool> _writeGrant({
    required String deviceId,
    required String basket,
    required String terminalName,
    required String venueName,
    required DateTime pairedAt,
  }) async {
    try {
      final root = folder;
      if (root == null) return false;

      final file = File('$root${Platform.pathSeparator}grant-$deviceId.json');
      await file.parent.create(recursive: true);
      await file.writeAsString(
        jsonEncode({
          'format': pairingFormat,
          'device_id': deviceId,
          'basket': basket,
          'terminal': terminalName,
          // The trading name, never the office email. That is an identifier,
          // and the display puts this on a screen a customer can see.
          'venue': venueName,
          'paired_at': pairedAt.toIso8601String(),
          'updated_at': DateTime.now().toIso8601String(),
        }),
        flush: true,
      );
      return true;
    } catch (_) {
      return false;
    }
  }

  Future<void> _remember(PairedDisplay display) async {
    final displays = await paired();
    displays.removeWhere((d) => d.deviceId == display.deviceId);
    await _store([...displays, display]);
  }

  Future<void> _store(List<PairedDisplay> displays) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(
        _keyPaired,
        jsonEncode([for (final d in displays) d.toJson()]),
      );
    } catch (_) {
      // A preferences write that failed. The grant is already on disk, so the
      // screen keeps working; it will simply not be re-granted on the next
      // start, and the manager can connect it again.
    }
  }
}
