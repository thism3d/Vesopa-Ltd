import 'package:flutter/foundation.dart';

/// What the venue allows, and what this device can actually do about it.
///
/// TWO DIFFERENT QUESTIONS, and the app gets them wrong if it mixes them.
///
///   * The VENUE decides which ways in it offers. That arrives from the server.
///   * The DEVICE decides which of those it can perform. A passkey needs a
///     browser that has WebAuthn; the Windows build has none.
///
/// [offered] is the venue's answer and [usable] is the two together. The sign-in
/// page only ever draws [usable], because a button that cannot work is worse
/// than one that is not there — somebody taps it, nothing happens, and they
/// conclude the app is broken rather than that this device cannot do it.
@immutable
class SignInConfig {
  const SignInConfig({
    this.offered = const {'code_email'},
    this.policy = 'code_first',
    this.selfService = true,
  });

  /// `code_email`, `password`, `passkey`, `code_sms`, `vesopa`.
  final Set<String> offered;

  /// Which one leads: `code_first`, `password_first`, `vesopa_first`.
  final String policy;

  /// Whether a member may change their own name, phone and password.
  final bool selfService;

  /// An emailed code is always there. The server guarantees it — it is what it
  /// falls back to when a venue switches everything else off — so the app can
  /// rely on it and never has to draw a page with no way forward.
  static const fallback = SignInConfig();

  factory SignInConfig.fromJson(Map<String, dynamic>? json) {
    if (json == null) return fallback;
    final list = (json['methods'] as List?)?.whereType<String>().toSet() ?? const {'code_email'};
    return SignInConfig(
      offered: list.isEmpty ? const {'code_email'} : list,
      policy: (json['policy'] as String?) ?? 'code_first',
      selfService: json['self_service'] != false,
    );
  }

  /// Whether this device can perform a method at all.
  ///
  /// Passkeys are the only one that differs by platform. WebAuthn is a browser
  /// API: there is no Dart or Win32 equivalent to fall back to, so the Windows,
  /// Android and iOS builds simply do not offer it and use the other methods.
  /// That is a real limit, not a gap left to fill in later.
  static bool deviceCan(String method) {
    if (method == 'passkey') return kIsWeb;
    return true;
  }

  Set<String> get usable => offered.where(deviceCan).toSet();

  bool has(String method) => usable.contains(method);

  /// Which way in to open on, after anything this device cannot do is dropped.
  String get leads {
    if (policy == 'password_first' && has('password')) return 'password';
    if (policy == 'vesopa_first' && has('vesopa')) return 'vesopa';
    return 'code_email';
  }

  /// The others, in the order they are offered underneath the one that leads.
  List<String> get alternatives =>
      ['vesopa', 'passkey', 'password', 'code_sms', 'code_email']
          .where((m) => m != leads && has(m))
          .toList();

  @override
  bool operator ==(Object other) =>
      other is SignInConfig &&
      other.policy == policy &&
      other.selfService == selfService &&
      setEquals(other.offered, offered);

  @override
  int get hashCode => Object.hash(policy, selfService, Object.hashAllUnordered(offered));
}

/// What each way in is called, where a member reads it.
String signInLabel(String method) => switch (method) {
  'password' => 'Use a password',
  'passkey' => 'Use a passkey',
  'code_sms' => 'Text me a code',
  'vesopa' => 'Continue with Vesopa',
  _ => 'Email me a code',
};
