/// Vesopa Local Link: the venue's devices talking on its own network
/// (2026-10-27).
///
/// Nicki, Pontardawe RFC: "Any luck with getting 2 or more terminals to talk to
/// each other through local IP? … needs to be locally just in case they lose
/// internet. Newbridge does it by windows file sharing but I find it poor. ICR
/// uses each till's IP … and needs to be kind of instant."
///
/// The owner's decisions (docs/LOCAL_LINK_PLAN.md): one main till hosts, the
/// others connect to it, another till takes over if it goes; only devices of
/// the same venue may join and the traffic is encrypted; the cloud stays in
/// step for the back office.
///
/// THE SAME FILE IN THREE APPS
///
/// This library is copied, unchanged, into the till (vesopa_epos), the kitchen
/// screen and the customer display, under lib/data/lan/. It needs nothing but
/// dart:io and package:crypto, so it compiles in all three. Change it in the
/// till and copy it across (tool/sync_lan_link.py).
///
/// HOW IT FITS TOGETHER
///
///   * **Finding each other.** Tills listen on UDP [LanNode.discoveryPort] and
///     announce themselves every second and a half to the network's broadcast
///     addresses and to any address the back office has heard of. A kitchen or
///     display screen asks ("who") and the tills answer it directly. Every
///     packet carries the venue's tag and a signature, so another venue's
///     tills on the same network, or anybody else, are ignored.
///   * **The main till.** A till that has heard nobody claim the job for a few
///     seconds takes it if it is the best placed: the one pinned in the back
///     office, else the one that has been running longest. A main till keeps
///     the job while it is alive (no flapping when a till restarts), and steps
///     down only for a better-placed one that also claims it.
///   * **The link.** Every till listens on TCP [LanNode.linkPort]; the others
///     connect to the main till's. The two sides prove they hold the venue key
///     without sending it, then every frame is encrypted and authenticated
///     with keys made for that one connection (see [_Sealer]).
///   * **What travels.** Channels. A message on a channel goes to every device
///     subscribed to it. A *keyed* message is the latest state of something (a
///     bill, a basket) and the main till keeps it, so a device that joins late
///     is given the current picture. A *log* message (a kitchen ticket, a
///     ledger entry) is kept in order, for a while, for the same reason.
///     Requests go to the main till and come back with an answer.
///   * **One clock.** The main till's. Every device keeps its offset from it
///     ([LanNode.now]), which is what "newest change wins" is measured by.
///
/// Nothing here throws into a sale. A network that will not carry any of this
/// leaves every app exactly as it was: on the cloud.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';

/// Who this device is on the venue's network.
class LanIdentity {
  LanIdentity({
    required List<int> venueKey,
    required this.id,
    required this.name,
    required this.role,
    this.version = '',
    this.preferredHub,
  })  : venueKey = Uint8List.fromList(venueKey),
        venueTag = _hex(Hmac(sha256, venueKey).convert(utf8.encode('vesopa-lan-tag')).bytes).substring(0, 16);

  /// The venue's secret, from the back office (`/api/lan/key`). Never sent.
  final Uint8List venueKey;

  /// A short public name for the venue key: which packets are ours.
  final String venueTag;

  /// Stable per device: the till's terminal device id, the screen's own.
  final String id;
  final String name;

  /// 'till', 'kitchen' or 'display'. Only a till can be the main one.
  final String role;
  final String version;

  /// The till the back office has pinned as the main one, if any.
  String? preferredHub;

  bool get canHost => role == 'till';
}

/// Another device on the venue's network, as last heard.
class LanPeer {
  LanPeer({
    required this.id,
    required this.name,
    required this.role,
    required this.address,
    required this.port,
    required this.upMs,
    required this.claimsHub,
    required this.preferred,
    required this.version,
    required this.seen,
  });

  final String id;
  String name;
  String role;
  InternetAddress address;
  int port;

  /// How long it had been running when it last announced.
  int upMs;
  bool claimsHub;
  bool preferred;
  String version;
  DateTime seen;

  Map<String, Object?> toJson(DateTime now) => {
        'id': id,
        'name': name,
        'role': role,
        'address': address.address,
        'port': port,
        'up_s': upMs ~/ 1000,
        'hub': claimsHub,
        'version': version,
        'seen_s': now.difference(seen).inSeconds,
      };
}

/// One message on a channel.
class LanMessage {
  const LanMessage({
    required this.channel,
    required this.data,
    required this.from,
    required this.at,
    this.key,
    this.log = false,
  });

  final String channel;

  /// Set: the latest state of [key] on [channel]; null [data] retracts it.
  final String? key;
  final bool log;
  final Object? data;

  /// The device that sent it.
  final String from;

  /// The main till's clock, in milliseconds since the epoch.
  final int at;

  Map<String, Object?> toJson() => {
        'ch': channel,
        if (key != null) 'key': key,
        if (log) 'log': true,
        'data': data,
        'from': from,
        'at': at,
      };

  static LanMessage? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final ch = raw['ch'];
    if (ch is! String) return null;
    return LanMessage(
      channel: ch,
      key: raw['key'] as String?,
      log: raw['log'] == true,
      data: raw['data'],
      from: '${raw['from'] ?? ''}',
      at: (raw['at'] as num?)?.toInt() ?? 0,
    );
  }
}

/// Raised by [LanNode.request] when there is nobody to answer.
class LanUnavailable implements Exception {
  const LanUnavailable(this.message);
  final String message;
  @override
  String toString() => message;
}

typedef LanHandler = FutureOr<Object?> Function(Object? data, String from);

/// The device's end of the venue's local link.
class LanNode {
  LanNode(
    this.identity, {
    this.discoveryPort = defaultDiscoveryPort,
    this.linkPort = defaultLinkPort,
    this.broadcast = true,
    List<({String host, int port})> targets = const [],
    this.claimAfter = const Duration(seconds: 3),
    this.announceEvery = const Duration(milliseconds: 1500),
  }) : _targets = [...targets];

  static const defaultDiscoveryPort = 47820;
  static const defaultLinkPort = 47821;

  final LanIdentity identity;
  final int discoveryPort;
  final int linkPort;

  /// Send announces and questions to the broadcast addresses. Off in tests.
  final bool broadcast;

  /// How long a till listens before it may take the main role.
  final Duration claimAfter;
  final Duration announceEvery;

  /// Addresses to announce to directly as well: devices the back office has
  /// heard of, for a network that drops broadcasts but carries the rest.
  List<({String host, int port})> _targets;
  set targets(List<({String host, int port})> value) => _targets = [...value];

  final _started = DateTime.now();
  int get upMs => DateTime.now().difference(_started).inMilliseconds;

  final Map<String, LanPeer> peers = {};

  RawDatagramSocket? _udp;
  ServerSocket? _server;
  int _boundLinkPort = 0;
  Timer? _tick;
  bool _running = false;

  // ---- what the apps see ---------------------------------------------------

  final _changes = StreamController<void>.broadcast();

  /// Fires when the main till, the connection or the list of devices changes.
  Stream<void> get changes => _changes.stream;
  void _changed() {
    if (!_changes.isClosed) _changes.add(null);
  }

  final _ready = StreamController<void>.broadcast();

  /// Fires each time this device has a working link to a main till -- having
  /// become it, or having connected to it. The moment to send the current
  /// state again, because a new main till starts with nothing.
  Stream<void> get onReady => _ready.stream;

  bool _isHub = false;
  bool get isHub => _isHub;

  /// The main till as far as this device knows, or null.
  String? hubId;

  /// Linked: this device is the main till, or is connected to it.
  bool get linked => _isHub || _client?.authed == true;

  int get clientCount => _clients.length;
  List<Map<String, Object?>> get clients => [
        for (final c in _clients)
          if (c.authed) {'id': c.peerId, 'name': c.peerName, 'role': c.peerRole, 'address': c.address},
      ];

  // ---- the clock -----------------------------------------------------------

  int _offset = 0;

  /// Milliseconds since the epoch on the main till's clock.
  int now() => DateTime.now().millisecondsSinceEpoch + (_isHub ? 0 : _offset);

  // ---- start / stop --------------------------------------------------------

  Future<void> start() async {
    if (_running) return;
    _running = true;
    await _bindUdp();
    if (identity.canHost) {
      try {
        _server = await ServerSocket.bind(InternetAddress.anyIPv4, linkPort);
      } catch (_) {
        try {
          _server = await ServerSocket.bind(InternetAddress.anyIPv4, 0);
        } catch (_) {}
      }
      _boundLinkPort = _server?.port ?? 0;
      _server?.listen(_onSocket, onError: (Object _) {});
    }
    _tick = Timer.periodic(announceEvery, (_) => _onTick());
    _onTick();
  }

  /// The discovery socket. Rebound if Windows closes it: a datagram sent to a
  /// device that has just been switched off comes back as "connection reset"
  /// on the next read, and an unhandled one ends the socket's stream.
  Future<void> _bindUdp() async {
    if (!_running) return;
    RawDatagramSocket? socket;
    for (final port in [if (identity.canHost) discoveryPort, 0]) {
      try {
        socket = await RawDatagramSocket.bind(InternetAddress.anyIPv4, port, reuseAddress: true);
        break;
      } catch (_) {}
    }
    if (socket == null) return;
    socket.broadcastEnabled = true;
    _udp = socket;
    socket.listen(
      (event) {
        if (event != RawSocketEvent.read) return;
        try {
          final dg = socket!.receive();
          if (dg != null) _onDatagram(dg);
        } catch (_) {}
      },
      onError: (Object _) {},
      onDone: () {
        if (_udp == socket) _udp = null;
        if (_running) Timer(const Duration(milliseconds: 100), _bindUdp);
      },
      cancelOnError: false,
    );
  }

  Future<void> stop() async {
    _running = false;
    _tick?.cancel();
    _tick = null;
    try {
      _udp?.close();
    } catch (_) {}
    _udp = null;
    for (final c in _clients.toList()) {
      c.close();
    }
    _clients.clear();
    await _server?.close();
    _server = null;
    _client?.close();
    _client = null;
    _isHub = false;
    hubId = null;
    _changed();
  }

  Future<void> dispose() async {
    await stop();
    await _changes.close();
    await _ready.close();
  }

  // ---- discovery -----------------------------------------------------------

  Map<String, Object?> _announce() => {
        'v': 1,
        't': 'ann',
        'venue': identity.venueTag,
        'id': identity.id,
        'name': identity.name,
        'role': identity.role,
        'port': _boundLinkPort,
        'up': upMs,
        'hub': _isHub,
        'pref': identity.preferredHub == identity.id,
        'ver': identity.version,
      };

  Map<String, Object?> _who() => {
        'v': 1,
        't': 'who',
        'venue': identity.venueTag,
        'id': identity.id,
        'name': identity.name,
        'role': identity.role,
        'ver': identity.version,
      };

  List<int> _signed(Map<String, Object?> body) {
    final text = jsonEncode(body);
    final sig = _hex(Hmac(sha256, identity.venueKey).convert(utf8.encode(text)).bytes).substring(0, 32);
    return utf8.encode(jsonEncode({'b': text, 's': sig}));
  }

  Map<String, dynamic>? _verify(List<int> bytes) {
    try {
      final outer = jsonDecode(utf8.decode(bytes));
      if (outer is! Map) return null;
      final text = outer['b'];
      final sig = outer['s'];
      if (text is! String || sig is! String) return null;
      final want = _hex(Hmac(sha256, identity.venueKey).convert(utf8.encode(text)).bytes).substring(0, 32);
      if (!_same(want, sig)) return null;
      final body = jsonDecode(text);
      if (body is! Map<String, dynamic> || body['venue'] != identity.venueTag) return null;
      return body;
    } catch (_) {
      return null;
    }
  }

  void _send(Map<String, Object?> body, InternetAddress to, int port) {
    try {
      _udp?.send(_signed(body), to, port);
    } catch (_) {}
  }

  /// Where to shout: the limited broadcast, each interface's /24, and the
  /// devices the back office knows of.
  Future<List<({InternetAddress address, int port})>> _destinations() async {
    final out = <({InternetAddress address, int port})>[];
    if (broadcast) {
      out.add((address: InternetAddress('255.255.255.255'), port: discoveryPort));
      for (final ip in await localAddresses()) {
        final parts = ip.split('.');
        if (parts.length == 4) {
          out.add((address: InternetAddress('${parts[0]}.${parts[1]}.${parts[2]}.255'), port: discoveryPort));
        }
      }
    }
    for (final t in _targets) {
      final a = InternetAddress.tryParse(t.host);
      if (a != null && a.type == InternetAddressType.IPv4) out.add((address: a, port: t.port));
    }
    return out;
  }

  Future<void> _onTick() async {
    if (!_running) return;
    final body = identity.canHost ? _announce() : _who();
    for (final d in await _destinations()) {
      _send(body, d.address, d.port);
    }
    // Answer-by-hand for a till that cannot broadcast: announce straight to
    // every till heard of.
    if (identity.canHost) {
      for (final p in peers.values) {
        if (p.role == 'till') _send(body, p.address, discoveryPortOf(p));
      }
    }
    _expire();
    _elect();
    _keepClient();
    _pingClients();
  }

  /// The discovery port of another device: the one it sent from.
  final Map<String, int> _udpPorts = {};
  int discoveryPortOf(LanPeer p) => _udpPorts[p.id] ?? discoveryPort;

  void _onDatagram(Datagram dg) {
    final body = _verify(dg.data);
    if (body == null) return;
    final id = '${body['id'] ?? ''}';
    if (id.isEmpty || id == identity.id) return;
    final role = '${body['role'] ?? ''}';
    _udpPorts[id] = dg.port;
    if (body['t'] == 'who') {
      // A screen asking: tell it about this till, straight back.
      if (identity.canHost) _send(_announce(), dg.address, dg.port);
      _notePeer(id, body, dg.address, role, claimsHub: false, port: 0, up: 0);
      return;
    }
    if (body['t'] != 'ann') return;
    _notePeer(
      id,
      body,
      dg.address,
      role,
      claimsHub: body['hub'] == true,
      port: (body['port'] as num?)?.toInt() ?? 0,
      up: (body['up'] as num?)?.toInt() ?? 0,
    );
    _elect();
    _keepClient();
  }

  void _notePeer(
    String id,
    Map<String, dynamic> body,
    InternetAddress address,
    String role, {
    required bool claimsHub,
    required int port,
    required int up,
  }) {
    final known = peers[id];
    final isNew = known == null;
    // A device is known by its own id, never by its address: Windows, phones
    // and tablets now give each network a random hardware (MAC) address, and
    // DHCP may then hand out a new IP. When the main till turns up somewhere
    // new and our link to it has gone quiet, go to where it is now rather than
    // waiting for the old socket to time out.
    final moved = known != null &&
        (known.address.address != address.address || (body['t'] == 'ann' && port > 0 && known.port != port));
    if (moved && id == hubId) {
      final c = _client;
      if (c != null && DateTime.now().difference(c.lastHeard) > const Duration(seconds: 5)) {
        c.close();
        _client = null;
      }
    }
    final p = known ??
        LanPeer(
          id: id,
          name: '${body['name'] ?? id}',
          role: role,
          address: address,
          port: port,
          upMs: up,
          claimsHub: claimsHub,
          preferred: body['pref'] == true,
          version: '${body['ver'] ?? ''}',
          seen: DateTime.now(),
        );
    p
      ..name = '${body['name'] ?? p.name}'
      ..role = role
      ..address = address
      ..seen = DateTime.now()
      ..version = '${body['ver'] ?? p.version}';
    if (body['t'] == 'ann') {
      final hubChanged = p.claimsHub != claimsHub;
      p
        ..port = port
        ..upMs = up
        ..claimsHub = claimsHub
        ..preferred = body['pref'] == true;
      if (hubChanged) _changed();
    }
    peers[id] = p;
    if (isNew) _changed();
  }

  /// A device not heard from for this long has gone.
  static const _gone = Duration(seconds: 6);

  void _expire() {
    final now = DateTime.now();
    final before = peers.length;
    peers.removeWhere((_, p) => now.difference(p.seen) > _gone);
    if (peers.length != before) _changed();
  }

  // ---- who is the main till ------------------------------------------------

  /// Better placed first: pinned, then running longest, then by id.
  static int _rank(({bool pref, int up, String id}) a, ({bool pref, int up, String id}) b) {
    if (a.pref != b.pref) return a.pref ? -1 : 1;
    // Within two seconds counts as the same: announces are not simultaneous.
    if ((a.up - b.up).abs() > 2000) return b.up.compareTo(a.up);
    return a.id.compareTo(b.id);
  }

  ({bool pref, int up, String id}) get _me =>
      (pref: identity.preferredHub == identity.id, up: upMs, id: identity.id);

  ({bool pref, int up, String id}) _of(LanPeer p) =>
      (pref: p.preferred || identity.preferredHub == p.id, up: p.upMs, id: p.id);

  void _elect() {
    final tills = [for (final p in peers.values) if (p.role == 'till' && p.port > 0) p];
    final claimers = [for (final p in tills) if (p.claimsHub) p];

    if (identity.canHost) {
      final pinnedHere = identity.preferredHub == identity.id;
      if (_isHub) {
        // Step down only for a better-placed till that also claims the job.
        final better = claimers.where((p) => _rank(_of(p), _me) < 0).toList();
        if (better.isNotEmpty) {
          _becomeClient();
        }
      } else {
        final best = [...tills.map(_of), _me]..sort(_rank);
        final iAmBest = best.first.id == identity.id;
        final settled = upMs >= claimAfter.inMilliseconds;
        // Nobody has the job and this till is the best placed -- or this is
        // the pinned till, which takes it back once it has been up a while.
        if (settled && ((claimers.isEmpty && iAmBest) || (pinnedHere && upMs >= claimAfter.inMilliseconds * 3))) {
          _becomeHub();
          return;
        }
      }
    }
    if (_isHub) {
      if (hubId != identity.id) {
        hubId = identity.id;
        _changed();
      }
      return;
    }
    claimers.sort((a, b) => _rank(_of(a), _of(b)));
    final next = claimers.isEmpty ? null : claimers.first.id;
    if (next != hubId) {
      hubId = next;
      _client?.close();
      _client = null;
      _changed();
    }
  }

  void _becomeHub() {
    if (_isHub) return;
    _client?.close();
    _client = null;
    _isHub = true;
    hubId = identity.id;
    _offset = 0;
    _retained.clear();
    _logs.clear();
    _changed();
    // Say so at once rather than at the next tick, so the others follow now.
    unawaited(_onTick());
    if (!_ready.isClosed) _ready.add(null);
  }

  void _becomeClient() {
    if (!_isHub) return;
    _isHub = false;
    for (final c in _clients.toList()) {
      c.send({'op': 'nothub'});
      c.close();
    }
    _clients.clear();
    hubId = null;
    _changed();
  }

  // ---- the main till's side ---------------------------------------------------

  final List<_Conn> _clients = [];

  void _onSocket(Socket socket) {
    try {
      final ws = _Wire(socket);
      final conn = _Conn(ws, address: socket.remoteAddress.address);
      final nonce = _nonce();
      conn.serverNonce = nonce;
      ws.add(jsonEncode({'t': 'hello', 'nonce': nonce, 'hub': _isHub, 'id': identity.id}));
      // An unauthenticated socket has five seconds to prove itself.
      final timeout = Timer(const Duration(seconds: 5), () {
        if (!conn.authed) conn.close();
      });
      ws.listen(
        (data) => _onClientFrame(conn, data),
        onDone: () {
          timeout.cancel();
          if (_clients.remove(conn)) _changed();
        },
        onError: (Object _) {},
        cancelOnError: true,
      );
    } catch (_) {}
  }

  void _onClientFrame(_Conn conn, Object? data) {
    if (!conn.authed) {
      if (data is! String) return conn.close();
      try {
        final m = jsonDecode(data);
        if (m is! Map || m['t'] != 'auth') return conn.close();
        final id = '${m['id'] ?? ''}';
        final cn = '${m['nonce'] ?? ''}';
        final want = _proof('c', conn.serverNonce, cn, id);
        if (id.isEmpty || cn.length < 16 || !_same(want, '${m['proof'] ?? ''}')) return conn.close();
        if (!_isHub) {
          conn.ws.add(jsonEncode({'t': 'nothub'}));
          return conn.close();
        }
        conn
          ..peerId = id
          ..peerName = '${m['name'] ?? id}'
          ..peerRole = '${m['role'] ?? ''}'
          ..sealer = _Sealer(identity.venueKey, conn.serverNonce, cn, server: true)
          ..authed = true;
        conn.ws.add(jsonEncode({
          't': 'ok',
          'proof': _proof('s', cn, conn.serverNonce, identity.id),
          'now': DateTime.now().millisecondsSinceEpoch,
        }));
        // One connection per device: a device that reconnects replaces itself.
        for (final old in _clients.where((c) => c.peerId == id).toList()) {
          _clients.remove(old);
          old.close();
        }
        _clients.add(conn);
        _changed();
      } catch (_) {
        conn.close();
      }
      return;
    }
    final m = conn.open(data);
    if (m == null) return;
    conn.lastHeard = DateTime.now();
    switch (m['op']) {
      case 'sub':
        final channels = [for (final c in (m['ch'] as List? ?? const [])) '$c'];
        conn.channels.addAll(channels);
        // What a device joining late needs: the current state and the recent log.
        for (final ch in channels) {
          for (final msg in _retained[ch]?.values ?? const <LanMessage>[]) {
            conn.send({'op': 'msg', ...msg.toJson()});
          }
          for (final msg in _logs[ch] ?? const <LanMessage>[]) {
            conn.send({'op': 'msg', ...msg.toJson()});
          }
        }
      case 'unsub':
        conn.channels.removeAll([for (final c in (m['ch'] as List? ?? const [])) '$c']);
      case 'pub':
        final msg = LanMessage.fromJson({...m, 'from': conn.peerId, 'at': now()});
        if (msg != null) _route(msg, except: conn);
      case 'req':
        unawaited(_answer(conn, m));
      case 'ping':
        conn.send({'op': 'pong', 't': m['t'], 'now': DateTime.now().millisecondsSinceEpoch});
    }
  }

  Future<void> _answer(_Conn conn, Map m) async {
    final rid = m['rid'];
    final ch = '${m['ch'] ?? ''}';
    final handler = _handlers[ch];
    if (handler == null) {
      conn.send({'op': 'rep', 'rid': rid, 'error': 'Nothing on the main till answers $ch'});
      return;
    }
    try {
      final out = await handler(m['data'], conn.peerId);
      conn.send({'op': 'rep', 'rid': rid, 'data': out});
    } catch (e) {
      conn.send({'op': 'rep', 'rid': rid, 'error': '$e'});
    }
  }

  /// Keep, deliver here, and deliver to every subscribed device but the sender.
  void _route(LanMessage msg, {_Conn? except}) {
    _retain(msg);
    _deliver(msg);
    final frame = {'op': 'msg', ...msg.toJson()};
    for (final c in _clients) {
      if (c == except || !c.channels.contains(msg.channel)) continue;
      c.send(frame);
    }
  }

  final Map<String, Map<String, LanMessage>> _retained = {};
  final Map<String, List<LanMessage>> _logs = {};
  static const _logCap = 400;
  static const _logAge = Duration(hours: 12);

  void _retain(LanMessage msg) {
    final key = msg.key;
    if (key != null) {
      final map = _retained.putIfAbsent(msg.channel, () => {});
      if (msg.data == null) {
        map.remove(key);
      } else {
        map[key] = msg;
      }
    } else if (msg.log) {
      final list = _logs.putIfAbsent(msg.channel, () => []);
      list.add(msg);
      final oldest = now() - _logAge.inMilliseconds;
      list.removeWhere((m) => m.at < oldest);
      while (list.length > _logCap) {
        list.removeAt(0);
      }
    }
  }

  void _pingClients() {
    final now = DateTime.now();
    for (final c in _clients.toList()) {
      if (now.difference(c.lastHeard) > const Duration(seconds: 15)) {
        _clients.remove(c);
        c.close();
        _changed();
      }
    }
    final client = _client;
    if (client != null && client.authed) {
      if (now.difference(client.lastHeard) > const Duration(seconds: 15)) {
        client.close();
        _client = null;
        _changed();
        return;
      }
      client.send({'op': 'ping', 't': DateTime.now().millisecondsSinceEpoch});
    }
  }

  // ---- a device's side ---------------------------------------------------

  _Conn? _client;
  bool _connecting = false;

  void _keepClient() {
    if (_isHub || _connecting || !_running) return;
    final id = hubId;
    if (id == null) return;
    if (_client != null) return;
    final hub = peers[id];
    if (hub == null || hub.port <= 0) return;
    unawaited(_connect(hub));
  }

  Future<void> _connect(LanPeer hub) async {
    _connecting = true;
    try {
      final ws = _Wire(await Socket.connect(hub.address, hub.port, timeout: const Duration(seconds: 4)));
      final conn = _Conn(ws, address: hub.address.address)..peerId = hub.id;
      _client = conn;
      final done = Completer<void>();
      ws.listen(
        (data) => _onHubFrame(conn, data, done),
        onDone: () {
          if (_client == conn) {
            _client = null;
            _changed();
          }
          if (!done.isCompleted) done.complete();
        },
        onError: (Object _) {},
        cancelOnError: true,
      );
      await done.future.timeout(const Duration(seconds: 5), onTimeout: () {
        if (!conn.authed) conn.close();
      });
    } catch (_) {
      _client = null;
    } finally {
      _connecting = false;
    }
  }

  void _onHubFrame(_Conn conn, Object? data, Completer<void> authed) {
    if (!conn.authed) {
      if (data is! String) return conn.close();
      try {
        final m = jsonDecode(data);
        if (m is! Map) return conn.close();
        if (m['t'] == 'hello') {
          conn.serverNonce = '${m['nonce'] ?? ''}';
          conn.clientNonce = _nonce();
          conn.ws.add(jsonEncode({
            't': 'auth',
            'id': identity.id,
            'name': identity.name,
            'role': identity.role,
            'ver': identity.version,
            'nonce': conn.clientNonce,
            'proof': _proof('c', conn.serverNonce, conn.clientNonce, identity.id),
          }));
          return;
        }
        if (m['t'] == 'ok') {
          // The main till proves it holds the key too: a stranger answering on
          // the port learns nothing and is told nothing.
          if (!_same(_proof('s', conn.clientNonce, conn.serverNonce, conn.peerId), '${m['proof'] ?? ''}')) {
            return conn.close();
          }
          final sent = DateTime.now().millisecondsSinceEpoch;
          _offset = ((m['now'] as num?)?.toInt() ?? sent) - sent;
          conn
            ..sealer = _Sealer(identity.venueKey, conn.serverNonce, conn.clientNonce, server: false)
            ..authed = true
            ..lastHeard = DateTime.now();
          if (!authed.isCompleted) authed.complete();
          if (_subs.isNotEmpty) conn.send({'op': 'sub', 'ch': _subs.keys.toList()});
          _changed();
          if (!_ready.isClosed) _ready.add(null);
          return;
        }
        // 'nothub' or anything else: not the one to talk to.
        conn.close();
      } catch (_) {
        conn.close();
      }
      return;
    }
    final m = conn.open(data);
    if (m == null) return;
    conn.lastHeard = DateTime.now();
    switch (m['op']) {
      case 'msg':
        final msg = LanMessage.fromJson(m);
        if (msg != null) _deliver(msg);
      case 'rep':
        final waiting = _waiting.remove(m['rid']);
        if (waiting == null) return;
        if (m['error'] != null) {
          waiting.completeError(LanUnavailable('${m['error']}'));
        } else {
          waiting.complete(m['data']);
        }
      case 'pong':
        final t = (m['t'] as num?)?.toInt();
        final hubNow = (m['now'] as num?)?.toInt();
        if (t != null && hubNow != null) {
          final back = DateTime.now().millisecondsSinceEpoch;
          _offset = hubNow - (t + back) ~/ 2;
        }
      case 'nothub':
        conn.close();
    }
  }

  // ---- channels -------------------------------------------------------------

  final Map<String, List<void Function(LanMessage)>> _subs = {};

  /// Hear every message on [channel], including what the main till keeps.
  void subscribe(String channel, void Function(LanMessage) onMessage) {
    final list = _subs.putIfAbsent(channel, () => []);
    final first = list.isEmpty;
    list.add(onMessage);
    if (first && _client?.authed == true) _client!.send({'op': 'sub', 'ch': [channel]});
    if (_isHub) {
      for (final m in _retained[channel]?.values ?? const <LanMessage>[]) {
        onMessage(m);
      }
    }
  }

  void unsubscribe(String channel) {
    _subs.remove(channel);
    if (_client?.authed == true) _client!.send({'op': 'unsub', 'ch': [channel]});
  }

  void _deliver(LanMessage msg) {
    if (msg.from == identity.id) return;
    for (final f in List.of(_subs[msg.channel] ?? const <void Function(LanMessage)>[])) {
      try {
        f(msg);
      } catch (_) {}
    }
  }

  /// Send [data] on [channel]. Keyed: the latest state of [key] (null data
  /// retracts it). [log]: kept in order for devices that join late. Returns
  /// whether it went anywhere.
  bool publish(String channel, Object? data, {String? key, bool log = false}) {
    final msg = LanMessage(channel: channel, key: key, log: log, data: data, from: identity.id, at: now());
    if (_isHub) {
      _route(msg);
      return true;
    }
    final c = _client;
    if (c == null || !c.authed) return false;
    c.send({'op': 'pub', 'ch': channel, 'key': ?key, if (log) 'log': true, 'data': data});
    return true;
  }

  final Map<String, LanHandler> _handlers = {};

  /// Answer requests on [channel]. Only called while this device is the main
  /// till: whichever till holds the job answers.
  void handle(String channel, LanHandler handler) => _handlers[channel] = handler;

  final Map<String, Completer<Object?>> _waiting = {};
  int _rid = 0;

  /// Ask the main till. Throws [LanUnavailable] when there is no link.
  Future<Object?> request(String channel, Object? data, {Duration timeout = const Duration(seconds: 4)}) async {
    if (_isHub) {
      final h = _handlers[channel];
      if (h == null) throw LanUnavailable('Nothing answers $channel');
      return h(data, identity.id);
    }
    final c = _client;
    if (c == null || !c.authed) throw const LanUnavailable('Not linked to the main till');
    final rid = '${identity.id}-${++_rid}';
    final done = Completer<Object?>();
    _waiting[rid] = done;
    c.send({'op': 'req', 'ch': channel, 'rid': rid, 'data': data});
    try {
      return await done.future.timeout(timeout);
    } on TimeoutException {
      throw const LanUnavailable('The main till did not answer');
    } finally {
      _waiting.remove(rid);
    }
  }

  // ---- the check (phase 1) -------------------------------------------------

  /// What this device can see, for the back office's Local network page.
  Future<Map<String, Object?>> report() async {
    final now = DateTime.now();
    final hub = hubId == null ? null : (hubId == identity.id ? null : peers[hubId]);
    return {
      'device': identity.id,
      'name': identity.name,
      'role': identity.role,
      'version': identity.version,
      'ips': await localAddresses(),
      'link_port': _boundLinkPort,
      'listening': _server != null,
      'is_hub': _isHub,
      'linked': linked,
      'hub': hubId == null
          ? null
          : {
              'id': hubId,
              'name': hubId == identity.id ? identity.name : hub?.name,
              'address': hub?.address.address,
            },
      'peers': [for (final p in peers.values) p.toJson(now)],
      'clients': clients,
      'up_s': upMs ~/ 1000,
    };
  }

  /// This machine's IPv4 addresses on the local network.
  static Future<List<String>> localAddresses() async {
    try {
      final list = await NetworkInterface.list(type: InternetAddressType.IPv4, includeLoopback: false);
      return [
        for (final i in list)
          for (final a in i.addresses)
            if (!a.isLoopback && !a.address.startsWith('169.254.')) a.address,
      ];
    } catch (_) {
      return const [];
    }
  }

  // ---- proofs --------------------------------------------------------------

  String _proof(String side, String a, String b, String id) =>
      _hex(Hmac(sha256, identity.venueKey).convert(utf8.encode('vesopa-lan-$side|$a|$b|$id')).bytes);
}

/// The link's own framing over plain TCP (2026-10-27).
///
/// Not a WebSocket, because a WebSocket in Dart cannot switch off Nagle's
/// algorithm, and on Windows that can hold a small frame back for up to a
/// couple of hundred milliseconds waiting for an acknowledgement -- the one
/// delay a table plan shared "instantly" cannot have. Here the socket is told
/// to send at once (TCP_NODELAY), and each frame is a type byte (0 text, 1
/// sealed), a four-byte length and the bytes.
class _Wire {
  _Wire(this.socket) {
    try {
      socket.setOption(SocketOption.tcpNoDelay, true);
    } catch (_) {}
  }

  final Socket socket;
  static const _max = 16 * 1024 * 1024;
  final BytesBuilder _buffer = BytesBuilder(copy: false);

  void add(Object data) {
    final bytes = data is String ? utf8.encode(data) : data as List<int>;
    final head = ByteData(5)
      ..setUint8(0, data is String ? 0 : 1)
      ..setUint32(1, bytes.length);
    final frame = BytesBuilder(copy: false)
      ..add(head.buffer.asUint8List())
      ..add(bytes);
    socket.add(frame.takeBytes());
  }

  void listen(
    void Function(Object data) onData, {
    required void Function() onDone,
    void Function(Object)? onError,
    bool cancelOnError = true,
  }) {
    socket.listen(
      (chunk) {
        _buffer.add(chunk);
        var bytes = _buffer.takeBytes();
        var at = 0;
        while (bytes.length - at >= 5) {
          final view = ByteData.sublistView(bytes, at);
          final type = view.getUint8(0);
          final length = view.getUint32(1);
          if (length > _max) {
            close();
            return;
          }
          if (bytes.length - at - 5 < length) break;
          final body = Uint8List.sublistView(bytes, at + 5, at + 5 + length);
          at += 5 + length;
          onData(type == 0 ? utf8.decode(body) : Uint8List.fromList(body));
        }
        if (at < bytes.length) _buffer.add(Uint8List.sublistView(bytes, at));
      },
      onDone: onDone,
      onError: (Object e) {
        onError?.call(e);
        if (cancelOnError) close();
      },
      cancelOnError: cancelOnError,
    );
  }

  void close() {
    try {
      socket.destroy();
    } catch (_) {}
  }
}

/// One authenticated connection, either side.
class _Conn {
  _Conn(this.ws, {required this.address});

  final _Wire ws;
  final String address;
  String serverNonce = '';
  String clientNonce = '';
  String peerId = '';
  String peerName = '';
  String peerRole = '';
  bool authed = false;
  _Sealer? sealer;
  DateTime lastHeard = DateTime.now();
  final Set<String> channels = {};

  void send(Map<String, Object?> msg) {
    final s = sealer;
    if (s == null) return;
    try {
      ws.add(s.seal(utf8.encode(jsonEncode(msg))));
    } catch (_) {}
  }

  Map<String, dynamic>? open(Object? data) {
    final s = sealer;
    if (s == null || data is! List<int>) return null;
    final plain = s.open(data);
    if (plain == null) {
      // A frame that does not authenticate is an attack or a fault; either
      // way this connection is finished.
      close();
      return null;
    }
    try {
      final m = jsonDecode(utf8.decode(plain));
      return m is Map<String, dynamic> ? m : null;
    } catch (_) {
      return null;
    }
  }

  void close() {
    try {
      ws.close();
    } catch (_) {}
  }
}

/// Encryption and authentication for one connection.
///
/// Built from HMAC-SHA256 alone (package:crypto is in every app already):
/// a keystream of HMAC(encKey, counter | block) blocks XORed with the frame,
/// then HMAC(macKey, counter | ciphertext) over the result -- encrypt then MAC.
/// Each direction has its own keys, derived from the venue key and both
/// sides' fresh nonces, and its own strictly rising counter, so a frame cannot
/// be replayed, reordered or moved to another connection.
class _Sealer {
  _Sealer(List<int> venueKey, String serverNonce, String clientNonce, {required bool server}) {
    List<int> k(String label) =>
        Hmac(sha256, venueKey).convert(utf8.encode('vesopa-lan-$label|$serverNonce|$clientNonce')).bytes;
    final c2sEnc = k('c2s-enc'), c2sMac = k('c2s-mac'), s2cEnc = k('s2c-enc'), s2cMac = k('s2c-mac');
    _outEnc = Hmac(sha256, server ? s2cEnc : c2sEnc);
    _outMac = Hmac(sha256, server ? s2cMac : c2sMac);
    _inEnc = Hmac(sha256, server ? c2sEnc : s2cEnc);
    _inMac = Hmac(sha256, server ? c2sMac : s2cMac);
  }

  late final Hmac _outEnc, _outMac, _inEnc, _inMac;
  int _sent = 0;
  int _heard = 0;

  static const _tag = 16;

  Uint8List seal(List<int> plain) {
    final counter = ++_sent;
    final head = _u64(counter);
    final body = _xor(_outEnc, head, plain);
    final mac = _outMac.convert([...head, ...body]).bytes.sublist(0, _tag);
    return Uint8List.fromList([...head, ...body, ...mac]);
  }

  List<int>? open(List<int> frame) {
    if (frame.length < 8 + _tag) return null;
    final head = frame.sublist(0, 8);
    final body = frame.sublist(8, frame.length - _tag);
    final mac = frame.sublist(frame.length - _tag);
    final want = _inMac.convert([...head, ...body]).bytes.sublist(0, _tag);
    if (!_sameBytes(want, mac)) return null;
    final counter = ByteData.sublistView(Uint8List.fromList(head)).getUint64(0);
    if (counter <= _heard) return null;
    _heard = counter;
    return _xor(_inEnc, head, body);
  }

  static List<int> _xor(Hmac enc, List<int> head, List<int> data) {
    final out = Uint8List(data.length);
    for (var block = 0; block * 32 < data.length; block++) {
      final ks = enc.convert([...head, block >> 24 & 255, block >> 16 & 255, block >> 8 & 255, block & 255]).bytes;
      for (var i = 0; i < 32 && block * 32 + i < data.length; i++) {
        out[block * 32 + i] = data[block * 32 + i] ^ ks[i];
      }
    }
    return out;
  }

  static List<int> _u64(int v) {
    final b = ByteData(8)..setUint64(0, v);
    return b.buffer.asUint8List();
  }
}

String _nonce() {
  final r = Random.secure();
  return _hex(List.generate(16, (_) => r.nextInt(256)));
}

String _hex(List<int> bytes) => bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();

bool _same(String a, String b) => _sameBytes(utf8.encode(a), utf8.encode(b));

bool _sameBytes(List<int> a, List<int> b) {
  if (a.length != b.length) return false;
  var d = 0;
  for (var i = 0; i < a.length; i++) {
    d |= a[i] ^ b[i];
  }
  return d == 0;
}

/// Parse the venue key the back office hands out (hex).
List<int>? lanKeyFromHex(String? hex) {
  if (hex == null || hex.length < 32 || hex.length.isOdd) return null;
  try {
    return [for (var i = 0; i < hex.length; i += 2) int.parse(hex.substring(i, i + 2), radix: 16)];
  } catch (_) {
    return null;
  }
}
