/// What this machine calls itself.
///
/// A venue with two tills has to be able to tell them apart — on a receipt, in
/// the clerk session that says where somebody is standing, and on the bill a
/// terminal is holding. Until shared tables there was nothing to tell apart, so
/// the till never had a name.
///
/// The default is the computer's own host name, because that is the one string
/// that is already different on the two machines and already means something to
/// whoever set them up. A manager can change it in Settings, and it is kept on
/// the terminal rather than in the back office: it describes this machine, and
/// a name held centrally would need the machine to be identified before it
/// could be looked up, which is the problem it is here to solve.
library;

import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _key = 'terminal_name';

/// Longest name worth carrying. The column behind it is VARCHAR(120), and a
/// name that does not fit on a bar key is not a name anybody reads.
const _maxLength = 40;

class TerminalIdentity extends AsyncNotifier<String> {
  @override
  Future<String> build() async {
    final prefs = await SharedPreferences.getInstance();
    final stored = prefs.getString(_key)?.trim();
    if (stored != null && stored.isNotEmpty) return stored;
    return _defaultName();
  }

  Future<void> set(String name) async {
    final clean = name.trim().isEmpty
        ? _defaultName()
        : name.trim().substring(0, name.trim().length.clamp(0, _maxLength));
    state = AsyncData(clean);
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_key, clean);
  }

  /// The host name, or "Till" where the platform will not say.
  ///
  /// Wrapped because `Platform.localHostname` throws on some sandboxed
  /// platforms rather than returning empty, and a till that will not start
  /// because it could not learn its own name would be an absurd way to lose a
  /// service.
  static String _defaultName() {
    try {
      final host = Platform.localHostname.trim();
      if (host.isNotEmpty) {
        return host.substring(0, host.length.clamp(0, _maxLength));
      }
    } catch (_) {
      // Fall through.
    }
    return 'Till';
  }
}

final terminalIdentityProvider =
    AsyncNotifierProvider<TerminalIdentity, String>(TerminalIdentity.new);

/// The name as a plain string, for the many places that cannot wait for it.
///
/// Printing a receipt and pushing a bill both need this and neither may block
/// on a preference read. "Till" is what a terminal is called for the fraction
/// of a second before the real name arrives, and it is a great deal better
/// than either waiting or a null.
final terminalNameProvider = Provider<String>(
  (ref) => ref.watch(terminalIdentityProvider).value ?? 'Till',
);
