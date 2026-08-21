import 'dart:async';
import 'dart:convert';

import 'package:web_socket_channel/web_socket_channel.dart';

/// The push half of the link to the back office.
///
/// **The socket is the fast path; the poll is the truth.** This class only does
/// the fast path — it says "something happened, go and look" and nothing more.
/// Whoever owns the board re-fetches over HTTP, on this signal and on a timer
/// regardless, so a screen that misses a push because a proxy culled an idle
/// connection ends up a few seconds behind rather than blind.
///
/// That division is deliberate and is why nothing here carries a ticket. A
/// socket frame is not authenticated — the subscribe below is a routing hint,
/// not a credential — so the most it is trusted to say is that the board may
/// have moved. The board itself always comes back over a call carrying the
/// kitchen token.
class LiveLink {
  LiveLink({required this.wsUrl, required this.office});

  final String wsUrl;

  /// Which venue's pushes this screen wants. Sent as a `subscribe` frame on
  /// every connect, because the server keeps one socket set for every terminal
  /// in every venue and would otherwise have to send a Cardiff kitchen's
  /// orders to a Swansea one to be filtered by the client.
  final String office;

  WebSocketChannel? _channel;
  Timer? _reconnectTimer;
  int _attempts = 0;
  bool _disposed = false;

  final _events = StreamController<LiveEvent>.broadcast();

  /// Nudges. Never the data itself — see the note above.
  Stream<LiveEvent> get events => _events.stream;

  final _connected = StreamController<bool>.broadcast();
  Stream<bool> get connected => _connected.stream;

  bool _live = false;
  bool get isConnected => _live;

  void start() {
    _disposed = false;
    _connect();
  }

  void _connect() {
    if (_disposed || _channel != null) return;

    try {
      final channel = WebSocketChannel.connect(Uri.parse(wsUrl));
      _channel = channel;

      channel.stream.listen(
        _onMessage,
        onDone: _reset,
        onError: (Object _) => _reset(),
        // Without this a socket error becomes an unhandled zone error and, on
        // some platforms, takes the isolate down with it.
        cancelOnError: false,
      );

      // `connect` is lazy — it returns a channel immediately and reports
      // failure later on the stream — so this is the only place the handshake
      // is known to have succeeded. Treating a non-null channel as proof of
      // life is what lets a screen show "connected" against a server it has
      // never reached.
      channel.ready
          .then((_) {
            if (_disposed || _channel != channel) return;
            _attempts = 0;
            _setConnected(true);
            _subscribe(channel);
          })
          .catchError((Object _) {
            if (_channel == channel) _reset();
          });
    } catch (_) {
      _reset();
    }
  }

  void _subscribe(WebSocketChannel channel) {
    try {
      channel.sink.add(jsonEncode({'type': 'subscribe', 'office': office}));
    } catch (_) {
      // The socket went between `ready` and here. The reconnect will send it.
    }
  }

  void _onMessage(dynamic raw) {
    try {
      final msg = jsonDecode(raw as String) as Map<String, dynamic>;
      final type = msg['type'] as String?;
      if (type == null) return;

      final event = switch (type) {
        'kitchen.ticket' => LiveEvent.board,
        'kitchen.screens' => LiveEvent.profile,
        // The till-settings row carries the station *names*, which are drawn on
        // every card's station chips. A venue renaming KP 3 to "Fryer" should
        // see it change on the wall, not at the next restart.
        'till-settings' => LiveEvent.profile,
        _ => null,
      };
      if (event != null && !_events.isClosed) _events.add(event);
    } catch (_) {
      // Not JSON, or a message from a later release. Ignored rather than
      // treated as an error: a frame we do not understand must never cost us
      // the connection.
    }
  }

  void _reset() {
    _channel = null;
    _setConnected(false);
    _scheduleReconnect();
  }

  void _setConnected(bool value) {
    if (_live == value) return;
    _live = value;
    if (!_connected.isClosed) _connected.add(value);
  }

  /// 2s, 4s, 8s, 16s, then every 30s.
  ///
  /// Backed off so a server that is down is not hammered by every screen in
  /// every venue at once — and capped at thirty seconds so a kitchen that comes
  /// back after an outage is live again within half a minute rather than
  /// waiting out an exponential curve nobody is watching.
  void _scheduleReconnect() {
    if (_disposed) return;
    _reconnectTimer?.cancel();

    final seconds = _attempts >= 4 ? 30 : 2 << _attempts.clamp(0, 3);
    _attempts++;

    _reconnectTimer = Timer(Duration(seconds: seconds), () {
      if (_disposed || _channel != null) return;
      _connect();
      // A reconnect is also a moment the board may have moved without us — so
      // ask for a re-fetch as well as re-opening the socket.
      if (!_events.isClosed) _events.add(LiveEvent.board);
    });
  }

  void dispose() {
    _disposed = true;
    _reconnectTimer?.cancel();
    _channel?.sink.close();
    _channel = null;
    _events.close();
    _connected.close();
  }
}

/// What a push is asking the screen to go and re-read.
enum LiveEvent {
  /// The tickets moved: something fired, was bumped, or was recalled.
  board,

  /// The venue's screens or station names changed in the back office.
  profile,
}
