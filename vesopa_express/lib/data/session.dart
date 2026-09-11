/// Who this kiosk is, whether its venue wants it, and what it is selling.
///
/// The kiosk's life has six phases, and every screen the app can show is one of
/// them:
///
///   booting         reading its token off the disk
///   setup           no token: a manager has to press Continue with Vesopa
///   choosePasscode  just set up, in a venue with no exit passcode yet
///   off             the venue has switched Vesopa Express off
///   offline         never reached the server since starting
///   ready           selling
///
/// The config is re-read every minute, so switching the venue off in the back
/// office reaches a kiosk mid-afternoon without anybody touching it -- and the
/// menu with it, but only while nobody is half way through an order, because a
/// dish vanishing from under somebody's finger is worse than a menu a minute
/// out of date.
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../config/constants.dart';
import 'api.dart';
import 'models.dart';
import 'vesopa_sso.dart';

final apiProvider = Provider<ExpressApi>((ref) => ExpressApi());

enum Phase { booting, setup, choosePasscode, off, offline, ready }

@immutable
class KioskState {
  const KioskState({
    required this.phase,
    this.config,
    this.menu = KioskMenu.empty,
    this.message,
    this.connected = true,
  });

  final Phase phase;
  final KioskConfig? config;
  final KioskMenu menu;

  /// A sentence for the setup screen: why this kiosk is being asked to sign in
  /// again ("removed in the back office").
  final String? message;

  /// False while the last attempt to reach the server failed. A kiosk that is
  /// selling keeps selling from what it has and says so in a banner; placing
  /// the order is what will actually need the network.
  final bool connected;

  KioskState copyWith({
    Phase? phase,
    KioskConfig? config,
    KioskMenu? menu,
    String? message,
    bool clearMessage = false,
    bool? connected,
  }) => KioskState(
    phase: phase ?? this.phase,
    config: config ?? this.config,
    menu: menu ?? this.menu,
    message: clearMessage ? null : (message ?? this.message),
    connected: connected ?? this.connected,
  );
}

class KioskSession extends Notifier<KioskState> {
  static const _tokenKey = 'express_token';
  static const _configKey = 'express_config';

  Timer? _tick;
  int _ticks = 0;

  /// Set by the order flow: whether somebody is mid-order right now.
  bool Function() isIdle = () => true;

  ExpressApi get _api => ref.read(apiProvider);

  @override
  KioskState build() {
    ref.onDispose(() => _tick?.cancel());
    Future.microtask(boot);
    return const KioskState(phase: Phase.booting);
  }

  Future<void> boot() async {
    final prefs = await SharedPreferences.getInstance();
    if (!ref.mounted) return;
    final token = ExpressConfig.seedToken.isNotEmpty
        ? ExpressConfig.seedToken
        : prefs.getString(_tokenKey);
    if (token == null || token.isEmpty) {
      state = const KioskState(phase: Phase.setup);
      return;
    }
    _api.token = token;
    await refresh();
    _tick ??= Timer.periodic(const Duration(minutes: 1), (_) {
      _ticks++;
      // The menu every five minutes, and only between customers.
      unawaited(refresh(withMenu: _ticks % 5 == 0 && isIdle()));
    });
  }

  /// Read the config, and the menu with it unless told not to.
  Future<void> refresh({bool withMenu = true}) async {
    if (_api.token == null) return;
    try {
      final (config, raw) = await _api.config();
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_configKey, raw);
      if (!ref.mounted) return;

      if (!config.enabled) {
        state = KioskState(phase: Phase.off, config: config, menu: state.menu);
        return;
      }
      var menu = state.menu;
      if (withMenu || menu.isEmpty || state.phase != Phase.ready) {
        menu = await _api.menu();
        if (!ref.mounted) return;
      }
      state = KioskState(phase: Phase.ready, config: config, menu: menu);
    } on ExpressApiError catch (e) {
      if (!ref.mounted) return;
      if (e.signedOut) {
        await _forget(message: e.message);
      } else if (e.expressOff) {
        state = state.copyWith(phase: Phase.off);
      } else if (state.phase == Phase.ready || state.phase == Phase.off) {
        state = state.copyWith(connected: false);
      } else {
        // Never reached the server since starting. The saved config is enough
        // to leave kiosk mode with the passcode; it is not enough to sell.
        state = KioskState(phase: Phase.offline, config: await _savedConfig(), connected: false);
        Future.delayed(const Duration(seconds: 10), () => refresh());
      }
    }
  }

  Future<KioskConfig?> _savedConfig() async {
    final raw = (await SharedPreferences.getInstance()).getString(_configKey);
    if (raw == null) return null;
    try {
      return KioskConfig.fromJson(jsonDecode(raw) as Map<String, dynamic>);
    } catch (_) {
      return null;
    }
  }

  /// Set this kiosk up: Continue with Vesopa, then the kiosk's own token.
  ///
  /// [beforeApply] PUTS THE KIOSK WINDOW BACK ON THE SCREEN, and it is called
  /// before the phase changes rather than after, which is the whole reason it
  /// exists. The kiosk is out of the way while the sign-in browser is in front,
  /// and Windows never presents a frame that was built while it was: the phase
  /// moved to the passcode screen, the tree rebuilt, and the glass went on
  /// showing "Set up this kiosk" because that was the last frame rasterised.
  /// The manager -- who had in fact just signed in perfectly well -- pressed
  /// Continue with Vesopa again and commissioned the venue a second time.
  ///
  /// So the order matters: window back first, phase second, and the frame that
  /// carries the new screen is built while there is something to present it to.
  Future<void> commission({
    void Function(Uri url)? onUrl,
    Future<void> Function()? beforeApply,
  }) async {
    final option = await _api.vesopaOption();
    if (!option.enabled) {
      throw VesopaSsoFailed('Vesopa sign-in is not switched on for this server.');
    }
    final idToken = await VesopaSso(issuer: option.issuer, clientId: option.clientId)
        .authorize(onUrl: onUrl);

    final view = WidgetsBinding.instance.platformDispatcher.views.first;
    final logical = view.physicalSize / view.devicePixelRatio;
    final done = await _api.commission(
      idToken,
      screen: '${logical.width.round()}x${logical.height.round()}',
    );

    _api.token = done.token;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_tokenKey, done.token);

    if (beforeApply != null) await beforeApply();

    if (!done.passcodeSet) {
      state = KioskState(phase: Phase.choosePasscode, message: done.venueName);
      return;
    }
    await boot();
  }

  /// The venue's first exit passcode, chosen by the manager who set this up.
  Future<void> setFirstPasscode(String passcode) async {
    await _api.setFirstPasscode(passcode);
    await boot();
  }

  /// Sign this kiosk out: the next person has to set it up again.
  Future<void> signOut() => _forget();

  Future<void> _forget({String? message}) async {
    _tick?.cancel();
    _tick = null;
    _api.token = null;
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_tokenKey);
    await prefs.remove(_configKey);
    if (!ref.mounted) return;
    state = KioskState(phase: Phase.setup, message: message);
  }
}

final kioskSessionProvider = NotifierProvider<KioskSession, KioskState>(KioskSession.new);
