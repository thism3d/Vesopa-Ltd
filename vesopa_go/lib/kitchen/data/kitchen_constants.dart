/// What the kitchen board's copied code (tool/sync_go_modes.py) reads from
/// the Windows app's config/constants.dart, with Go's own server.
library;

import '../../config/constants.dart' as go;

class Api {
  const Api._();

  static String get resolvedBase => go.apiBase;

  /// The back office's socket, for the board's live pushes.
  static String get resolvedWs {
    final b = Uri.parse(go.apiBase);
    return b.replace(scheme: b.scheme == 'http' ? 'ws' : 'wss', path: '/ws').toString();
  }
}

/// The board's timings, as the Windows kitchen screen's.
class BoardDefaults {
  const BoardDefaults._();

  /// A ticket turns amber, then red.
  static const warn = Duration(minutes: 8);
  static const late = Duration(minutes: 15);

  /// How long a finished ticket can be recalled.
  static const recallWindow = Duration(minutes: 60);

  /// The backstop fetch, whatever the socket is doing.
  static const poll = Duration(seconds: 30);

  /// The elapsed clocks.
  static const clock = Duration(seconds: 1);
}
