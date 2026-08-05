import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../main.dart';
import 'local/database.dart';

/// Who is working the till right now, and whether the idle screen is up.
///
/// Deliberately *not* the same thing as [Session], which is the terminal's
/// commissioning — that says which venue's catalogue this machine sells from and
/// survives for months. This says which member of staff is standing at it, and
/// changes every few minutes.
class StaffSession {
  const StaffSession({this.staff, this.idle = false, this.promptPin = false});

  /// The signed-on member of staff, or null if nobody is.
  final StaffData? staff;

  /// Whether the idle screen is covering the till.
  ///
  /// Separate from [staff] because the two are not the same question: after a
  /// sale the screen goes up while the same person is still signed on, and they
  /// come straight back to their own shift.
  final bool idle;

  /// Open straight onto the PIN pad rather than the picture.
  ///
  /// Set when somebody asked to sign on deliberately — they have already said
  /// what they want, so making them touch the screensaver first to be offered it
  /// would be a step that answers a question nobody asked.
  final bool promptPin;

  bool get signedOn => staff != null;

  /// What prints as "Served by", and what goes above a run of items on the
  /// check. Null when nobody is signed on, so the caller can fall back to the
  /// terminal's own account rather than printing a blank.
  String? get name => staff?.name;

  static const empty = StaffSession();

  StaffSession copyWith({
    StaffData? staff,
    bool clearStaff = false,
    bool? idle,
    bool? promptPin,
  }) =>
      StaffSession(
        staff: clearStaff ? null : (staff ?? this.staff),
        idle: idle ?? this.idle,
        promptPin: promptPin ?? this.promptPin,
      );
}

/// Sign-on, sign-off, and the inactivity timer that does the latter for you.
///
/// The timer is kept off the published state on purpose. Every touch anywhere in
/// the app pokes this controller, and if "last activity" were part of the state
/// the whole tree would rebuild on every tap — which on a product grid mid-
/// service is exactly the wrong place to spend frames. So the timestamp is a
/// plain field, and the notifier only announces something when the *answer*
/// changes: signed on, signed off, idle, or back.
class StaffSessionController extends Notifier<StaffSession> {
  Timer? _ticker;
  DateTime _lastActivity = DateTime.now();

  /// Seconds of inactivity before an automatic sign-off. 0 disables it. Set
  /// from the venue's till settings once they have loaded.
  int _signoffSeconds = 0;

  /// Whether the idle screen should ask for a PIN. When false, sign-off does not
  /// blank the till — the venue has said it does not want a lock, and putting
  /// one up anyway would leave the counter facing a PIN pad it cannot answer.
  bool _requirePin = true;

  @override
  StaffSession build() {
    ref.onDispose(() => _ticker?.cancel());
    return StaffSession.empty;
  }

  /// Apply the venue's settings. Called whenever they load or change.
  void configure({required int signoffSeconds, required bool requirePin}) {
    _signoffSeconds = signoffSeconds;
    _requirePin = requirePin;
    _restartTicker();
  }

  /// Note that somebody touched the till.
  ///
  /// Cheap by design: this is called from a pointer listener wrapping the whole
  /// app, so it does no more than move a timestamp.
  void touch() => _lastActivity = DateTime.now();

  void signOn(StaffData who) {
    _lastActivity = DateTime.now();
    state = StaffSession(staff: who, idle: false);
    _restartTicker();
  }

  /// Ask for a PIN now — the Sign On key.
  ///
  /// Raises the lock already open on the pad, so signing on is one press rather
  /// than "press Sign On, then touch the picture it puts in front of you".
  ///
  /// A no-op where a PIN cannot be checked, for the same reason [signOff] is: a
  /// pad nobody can satisfy is a till nobody can use.
  void promptSignOn() {
    if (!_requirePin || !_canVerify) return;
    state = state.copyWith(idle: true, promptPin: true);
  }

  /// Sign off, by choice or by the timer.
  ///
  /// Raises the idle screen only when the venue wants a PIN *and* this terminal
  /// can actually check one. Otherwise there is nothing to unlock it with and the
  /// till would be stuck behind a pad nobody can satisfy — which is exactly what
  /// happened on a till commissioned before the terminal token existed.
  void signOff() {
    state = StaffSession(staff: null, idle: _requirePin && _canVerify);
    _ticker?.cancel();
  }

  /// Whether a PIN typed on this terminal can be checked against anybody.
  ///
  /// Read at the moment it is needed rather than pushed in by [configure], so
  /// this can never be acting on a stale answer from before the staff list
  /// finished loading.
  bool get _canVerify => ref.read(canSignOnProvider);

  /// Raise the idle screen without signing anybody off. This is the after-a-sale
  /// path: the same person is still on shift.
  void showIdle() {
    if (state.idle) return;
    state = state.copyWith(idle: true);
  }

  /// Clear the idle screen, leaving whoever was signed on still signed on. Used
  /// when the venue has switched the PIN prompt off.
  void dismissIdle() {
    _lastActivity = DateTime.now();
    if (!state.idle) return;
    state = state.copyWith(idle: false, promptPin: false);
    _restartTicker();
  }

  /// The one-second heartbeat that watches for inactivity.
  ///
  /// A ticker rather than a single scheduled timer, because every touch would
  /// otherwise have to tear down and rebuild a timer — thousands of allocations
  /// across a shift for something one comparison per second answers.
  void _restartTicker() {
    _ticker?.cancel();
    if (_signoffSeconds <= 0) return;

    _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
      // Nobody on shift, or already behind the idle screen: nothing to do.
      if (!state.signedOn) {
        _ticker?.cancel();
        return;
      }
      if (DateTime.now().difference(_lastActivity).inSeconds >=
          _signoffSeconds) {
        // The bill on screen is deliberately left alone — not parked, not
        // cleared. Whoever signs back on picks it up exactly as it was. Losing
        // a half-rung order to a timeout would be a far worse fault than the
        // one the lock is there to prevent.
        signOff();
      }
    });
  }
}

final staffSessionProvider =
    NotifierProvider<StaffSessionController, StaffSession>(
  StaffSessionController.new,
);
