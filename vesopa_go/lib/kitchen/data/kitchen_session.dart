/// Vesopa Go running as a kitchen screen: which venue, which board, and the
/// kitchen credential (vesopa_server go_modes.js /api/go/mode-token).
///
/// The Windows kitchen screen's session (vesopa_epos_kitchen
/// kitchen_session.dart) with its two sign-in doors taken out: a Go device is
/// already signed in to its venue, so it is handed the kitchen token for it.
/// The board, the stations and the sound are the Windows screen's own.
library;

import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'kitchen_api.dart';
import 'kitchen_branding.dart';
import 'providers.dart';
import 'screen_profile.dart';

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
    this.branding = KitchenBranding.standard,
  });

  final String? token;
  final String? office;
  final String? officeName;
  final String? userName;
  final Map<String, String> stationNames;
  final List<ScreenProfile> screens;

  /// The board this device shows; null until it is chosen.
  final int? screenId;
  final bool? soundOverride;
  final KitchenBranding branding;

  bool get signedIn => token != null && office != null;

  List<ScreenProfile> get choices => [
        for (final s in screens) s.normalised(),
        ScreenProfile.allStations,
      ];

  ScreenProfile get screen {
    for (final s in choices) {
      if (s.id == screenId) return s;
    }
    return ScreenProfile.allStations;
  }

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
    KitchenBranding? branding,
  }) =>
      KitchenSession(
        token: token ?? this.token,
        office: office ?? this.office,
        officeName: officeName ?? this.officeName,
        userName: userName ?? this.userName,
        stationNames: stationNames ?? this.stationNames,
        screens: screens ?? this.screens,
        screenId: clearScreenId ? null : (screenId ?? this.screenId),
        soundOverride: clearSoundOverride ? null : (soundOverride ?? this.soundOverride),
        branding: branding ?? this.branding,
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
        'branding': branding.toJson(),
      };

  factory KitchenSession.fromJson(Map<String, dynamic> j) => KitchenSession(
        token: j['token'] as String?,
        office: j['office'] as String?,
        officeName: j['officeName'] as String?,
        userName: j['userName'] as String?,
        stationNames: {for (final e in ((j['stationNames'] as Map?) ?? const {}).entries) '${e.key}': '${e.value}'},
        screens: ((j['screens'] as List?) ?? const []).cast<Map<String, dynamic>>().map(ScreenProfile.fromJson).toList(),
        screenId: (j['screenId'] as num?)?.toInt(),
        soundOverride: j['soundOverride'] as bool?,
        branding: KitchenBranding.fromJson(j['branding'] as Map<String, dynamic>?),
      );

  static const empty = KitchenSession();
}

class KitchenSessionController extends AsyncNotifier<KitchenSession> {
  KitchenApi get _api => ref.read(kitchenApiProvider);
  static const _key = 'go_kitchen_session';

  @override
  Future<KitchenSession> build() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(_key);
      if (raw == null || raw.isEmpty) return KitchenSession.empty;
      final session = KitchenSession.fromJson(jsonDecode(raw) as Map<String, dynamic>);
      _api.token = session.token;
      return session;
    } catch (_) {
      return KitchenSession.empty;
    }
  }

  /// The kitchen credential Go was just handed for its venue.
  Future<void> startWith({required String token, required String office, String? venue}) async {
    _api.token = token;
    final had = state.value ?? KitchenSession.empty;
    var session = had.copyWith(token: token, office: office, officeName: venue);
    try {
      final p = await _api.profile();
      session = session.copyWith(
        office: p.office.isEmpty ? office : p.office,
        officeName: p.officeName ?? venue,
        userName: p.userName,
        stationNames: p.stationNames,
        screens: p.screens,
        branding: p.branding,
      );
    } catch (_) {
      // Offline: the board starts on what was cached and the profile follows.
    }
    // Another venue's board is not this one's.
    if (had.office != null && had.office != office) session = session.copyWith(clearScreenId: true);
    await _persist(session);
  }

  Future<void> refreshProfile() async {
    final current = state.value;
    if (current == null || !current.signedIn) return;
    try {
      final p = await _api.profile();
      await _persist(current.copyWith(
        officeName: p.officeName,
        userName: p.userName,
        stationNames: p.stationNames,
        screens: p.screens,
        branding: p.branding,
      ));
    } on KitchenApiError catch (e) {
      if (e.signedOut) await signOut();
    } catch (_) {}
  }

  Future<void> chooseScreen(int? id) async {
    final current = state.value;
    if (current == null) return;
    await _persist(id == null ? current.copyWith(clearScreenId: true) : current.copyWith(screenId: id));
  }

  Future<void> setSound(bool? on) async {
    final current = state.value;
    if (current == null) return;
    await _persist(on == null ? current.copyWith(clearSoundOverride: true) : current.copyWith(soundOverride: on));
  }

  /// The kitchen credential is no good: dropped, and the mode screen asks
  /// for a new one with the device's own sign-in.
  Future<void> signOut() async {
    _api.token = null;
    final current = state.value ?? KitchenSession.empty;
    final next = KitchenSession(screenId: current.screenId, soundOverride: current.soundOverride, branding: current.branding);
    await _persist(next);
  }

  Future<void> _persist(KitchenSession session) async {
    _api.token = session.token;
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_key, jsonEncode(session.toJson()));
    } catch (_) {}
    state = AsyncData(session);
  }
}
