import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'kitchen_api.dart';
import 'providers.dart';
import 'screen_profile.dart';

/// Who this screen is signed in as, and which board it is.
///
/// Two halves that come from two places on purpose:
///
///  * The **venue's** half — the screens it has defined, what it calls each
///    station — is read from the back office on every sign-in and every
///    reconnect, so a manager's change reaches the wall without anybody
///    touching the machine.
///  * The **machine's** half — which of those screens *this* one is — never
///    leaves this device. It is a physical fact about a panel bolted to a wall,
///    the same way a printer's USB port is a physical fact about a counter.
class KitchenSession {
  const KitchenSession({
    this.token,
    this.office,
    this.officeName,
    this.userName,
    this.stationNames = const {},
    this.screens = const [],
    this.screenId,
    this.soundOverride,
  });

  final String? token;

  /// The venue, as its contact email. The tenancy key every read is scoped by,
  /// and an identifier rather than a name — it is shown on sign-in, where
  /// somebody has to type it, and nowhere else.
  final String? office;

  final String? officeName;
  final String? userName;

  final Map<String, String> stationNames;
  final List<ScreenProfile> screens;

  /// Which profile this machine is. Null means the built-in all-stations board.
  final int? screenId;

  /// This machine's answer to the profile's sound setting, when it disagrees.
  ///
  /// A local override rather than a second venue-wide setting, because the
  /// reason to turn the noise off is almost always where the screen is standing
  /// — somebody is working next to it — and that is not a fact the office can
  /// know.
  final bool? soundOverride;

  bool get signedIn => token != null && office != null;

  /// Every profile this screen could be, the built-in one included.
  List<ScreenProfile> get choices => [
    for (final s in screens) s.normalised(),
    ScreenProfile.allStations,
  ];

  /// The board this machine is currently drawing.
  ///
  /// Falls back to all stations when the chosen profile has been deleted in the
  /// back office. That is the important case: a screen whose profile vanishes
  /// must keep showing food, not show an error, and "everything" is the fallback
  /// that cannot be wrong.
  ScreenProfile get screen {
    for (final s in choices) {
      if (s.id == screenId) return s;
    }
    return ScreenProfile.allStations;
  }

  /// Whether this screen should make a noise for a new ticket.
  bool get sound => soundOverride ?? screen.sound;

  String labelFor(String station) {
    final named = stationNames[station]?.trim();
    if (named != null && named.isNotEmpty) return named;
    return station.toUpperCase().replaceFirst('KP', 'KP ');
  }

  KitchenSession copyWith({
    String? token,
    String? office,
    String? officeName,
    String? userName,
    Map<String, String>? stationNames,
    List<ScreenProfile>? screens,
    int? screenId,
    bool clearScreenId = false,
    bool? soundOverride,
    bool clearSoundOverride = false,
  }) => KitchenSession(
    token: token ?? this.token,
    office: office ?? this.office,
    officeName: officeName ?? this.officeName,
    userName: userName ?? this.userName,
    stationNames: stationNames ?? this.stationNames,
    screens: screens ?? this.screens,
    screenId: clearScreenId ? null : (screenId ?? this.screenId),
    soundOverride: clearSoundOverride
        ? null
        : (soundOverride ?? this.soundOverride),
  );

  Map<String, dynamic> toJson() => {
    'token': token,
    'office': office,
    'officeName': officeName,
    'userName': userName,
    'stationNames': stationNames,
    'screens': [for (final s in screens) s.toJson()],
    'screenId': screenId,
    'soundOverride': soundOverride,
  };

  factory KitchenSession.fromJson(Map<String, dynamic> j) => KitchenSession(
    token: j['token'] as String?,
    office: j['office'] as String?,
    officeName: j['officeName'] as String?,
    userName: j['userName'] as String?,
    stationNames: {
      for (final e in ((j['stationNames'] as Map?) ?? const {}).entries)
        '${e.key}': '${e.value}',
    },
    screens: ((j['screens'] as List?) ?? const [])
        .cast<Map<String, dynamic>>()
        .map(ScreenProfile.fromJson)
        .toList(),
    screenId: (j['screenId'] as num?)?.toInt(),
    soundOverride: j['soundOverride'] as bool?,
  );

  static const empty = KitchenSession();
}

/// Reads, writes and refreshes the session.
///
/// An [AsyncNotifier] because the stored session has to be read off disk before
/// the app can decide whether to show the board or the sign-in page, and doing
/// that in a `FutureBuilder` above the router leads to the board mounting twice.
class KitchenSessionController extends AsyncNotifier<KitchenSession> {
  /// The one client this app has. Read through the provider rather than
  /// constructed here so the token this controller sets is the token every
  /// other call in the app carries — there is exactly one, and it lives on the
  /// client.
  KitchenApi get _api => ref.read(kitchenApiProvider);

  static const _key = 'vesopa_kitchen_session';

  @override
  Future<KitchenSession> build() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(_key);
    if (raw == null || raw.isEmpty) return KitchenSession.empty;

    try {
      final session = KitchenSession.fromJson(
        jsonDecode(raw) as Map<String, dynamic>,
      );
      // Hand the token to the client before anything can call it. Without this
      // the first board fetch after a restart races the sign-in check and fails
      // for no reason a chef could understand.
      _api.token = session.token;
      return session;
    } catch (_) {
      // A corrupt session must not stop the screen starting. Signing in again
      // is a ten-second job; a crash loop on a wall-mounted machine is not.
      return KitchenSession.empty;
    }
  }

  Future<void> signIn({
    required String office,
    required String username,
    required String password,
  }) async {
    final result = await _api.signIn(
      office: office.trim(),
      username: username.trim(),
      password: password,
    );

    final profile = result.profile;
    final session = KitchenSession(
      token: result.token,
      office: profile.office.isEmpty ? office.trim() : profile.office,
      officeName: profile.officeName,
      userName: profile.userName,
      stationNames: profile.stationNames,
      screens: profile.screens,
      // Left unset deliberately. The screen picker is shown straight after a
      // first sign-in, and guessing here would put a chef in front of a board
      // that is nearly right — which is harder to notice than one that is
      // obviously unset.
      screenId: null,
    );

    await _persist(session);
  }

  /// Re-read the venue's screens and station names.
  ///
  /// Called on every reconnect. Silent on failure: this is a refresh of
  /// something the screen already has a good copy of, and a chef has no use for
  /// being told it did not happen.
  Future<void> refreshProfile() async {
    final current = state.value;
    if (current == null || !current.signedIn) return;

    try {
      final profile = await _api.profile();
      await _persist(
        current.copyWith(
          officeName: profile.officeName,
          userName: profile.userName,
          stationNames: profile.stationNames,
          screens: profile.screens,
        ),
      );
    } on KitchenApiError catch (e) {
      // Except when the credential is the thing that failed, which is not a
      // refresh problem and cannot be recovered by waiting.
      if (e.signedOut) await signOut();
    } catch (_) {
      // Offline. The cached profile carries on working.
    }
  }

  Future<void> chooseScreen(int? id) async {
    final current = state.value;
    if (current == null) return;
    await _persist(
      id == null
          ? current.copyWith(clearScreenId: true)
          : current.copyWith(screenId: id),
    );
  }

  Future<void> setSound(bool? on) async {
    final current = state.value;
    if (current == null) return;
    await _persist(
      on == null
          ? current.copyWith(clearSoundOverride: true)
          : current.copyWith(soundOverride: on),
    );
  }

  Future<void> signOut() async {
    _api.token = null;
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_key);
    state = const AsyncData(KitchenSession.empty);
  }

  Future<void> _persist(KitchenSession session) async {
    _api.token = session.token;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_key, jsonEncode(session.toJson()));
    state = AsyncData(session);
  }
}
