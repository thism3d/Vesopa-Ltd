import 'dart:convert';

import 'package:http/http.dart' as http;

/// Running the kitchen screen from the till (2026-10-17).
///
/// Meirion, about the kitchen screen on a TV: "The problem mate not touch
/// screen". So the till does what a chef's finger would: the screen's size and
/// whether it is touched at all, and bump, recall and rush on the orders.
///
/// Authorised with the terminal token, like [KitchenDeliveryClient]: the
/// server lets a commissioned till reach its own venue's kitchen and nothing
/// else.
class KitchenRemote {
  KitchenRemote({
    required this.apiBase,
    required this.terminalToken,
    http.Client? client,
  }) : _client = client ?? http.Client();

  final String apiBase;
  final String? terminalToken;
  final http.Client _client;

  bool get canUse => terminalToken != null;

  Map<String, String> get _headers => {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer $terminalToken',
  };

  Future<dynamic> _send(String method, String path, [Object? body]) async {
    if (terminalToken == null) {
      throw StateError(
        'This till needs to be signed in again before it can run the kitchen screen.',
      );
    }
    final uri = Uri.parse('$apiBase$path');
    final req = http.Request(method, uri)..headers.addAll(_headers);
    if (body != null) req.body = jsonEncode(body);
    final streamed = await _client.send(req).timeout(const Duration(seconds: 10));
    final res = await http.Response.fromStream(streamed);
    if (res.statusCode < 200 || res.statusCode >= 300) {
      String message = 'The back office refused that (HTTP ${res.statusCode}).';
      try {
        final m = (jsonDecode(res.body) as Map<String, dynamic>)['error'];
        if (m is String && m.isNotEmpty) message = m;
      } catch (_) {}
      throw StateError(message);
    }
    return res.body.isEmpty ? null : jsonDecode(res.body);
  }

  Future<KitchenDisplaySettings> display() async =>
      KitchenDisplaySettings.fromJson(
        await _send('GET', '/till/kitchen/display') as Map<String, dynamic>,
      );

  /// The venue's default, for every screen without its own.
  Future<void> setVenue({String? tvSize, int? zoom, bool? touch}) => _send(
    'PUT',
    '/till/kitchen/display',
    {'tvSize': ?tvSize, 'zoom': ?zoom, 'touch': ?touch},
  );

  /// One named screen. [useVenue] hands every setting back to the venue's.
  Future<void> setScreen(
    int id, {
    String? tvSize,
    int? zoom,
    bool? touch,
    bool useVenue = false,
  }) => _send(
    'PUT',
    '/till/kitchen/display/$id',
    useVenue
        ? {'tvSize': null, 'zoom': null, 'touch': null}
        : {'tvSize': ?tvSize, 'zoom': ?zoom, 'touch': ?touch},
  );

  Future<List<RemoteTicket>> board() async {
    final body = await _send('GET', '/till/kitchen/board?minutes=60')
        as Map<String, dynamic>;
    return [
      for (final t in (body['tickets'] as List? ?? const []))
        RemoteTicket.fromJson(t as Map<String, dynamic>),
    ];
  }

  Future<void> bump(String id, {String? by}) =>
      _send('POST', '/till/kitchen/tickets/$id/bump', {'by': ?by});

  Future<void> recall(String id, {String? by}) =>
      _send('POST', '/till/kitchen/tickets/$id/recall', {'by': ?by});

  Future<void> rush(String id, bool rushed) =>
      _send('POST', '/till/kitchen/tickets/$id/rush', {'rushed': rushed});
}

/// The sizes the server knows, in order, with what a person calls them.
const kitchenTvSizes = <String, String>{
  'auto': 'Auto',
  'monitor': 'Monitor',
  'tv32': '32"',
  'tv43': '43"',
  'tv55': '50-55"',
  'tv65': '65"',
  'tv75': '75"',
  'tv100': '85-100"',
};

class KitchenDisplay {
  const KitchenDisplay({this.tvSize, this.zoom, this.touch});

  final String? tvSize;
  final int? zoom;
  final bool? touch;

  bool get usesVenue => tvSize == null && zoom == null && touch == null;
}

class KitchenScreenEntry {
  const KitchenScreenEntry({
    required this.id,
    required this.name,
    required this.display,
  });

  final int id;
  final String name;
  final KitchenDisplay display;
}

class KitchenDisplaySettings {
  const KitchenDisplaySettings({required this.venue, required this.screens});

  /// Never null fields: the venue always has a size, zoom and touch.
  final KitchenDisplay venue;
  final List<KitchenScreenEntry> screens;

  factory KitchenDisplaySettings.fromJson(Map<String, dynamic> j) {
    final v = (j['venue'] as Map?)?.cast<String, dynamic>() ?? const {};
    return KitchenDisplaySettings(
      venue: KitchenDisplay(
        tvSize: '${v['tvSize'] ?? 'auto'}',
        zoom: (v['zoom'] as num?)?.round() ?? 100,
        touch: v['touch'] != false,
      ),
      screens: [
        for (final s in (j['screens'] as List? ?? const []))
          KitchenScreenEntry(
            id: (s['id'] as num).toInt(),
            name: '${s['name'] ?? 'Screen'}',
            display: KitchenDisplay(
              tvSize: s['tvSize'] as String?,
              zoom: (s['zoom'] as num?)?.round(),
              touch: s['touch'] as bool?,
            ),
          ),
      ],
    );
  }
}

class RemoteLine {
  const RemoteLine({
    required this.quantity,
    required this.name,
    this.note,
    this.isModifier = false,
    this.made = false,
  });

  final num quantity;
  final String name;
  final String? note;
  final bool isModifier;
  final bool made;
}

class RemoteTicket {
  const RemoteTicket({
    required this.id,
    required this.lines,
    required this.open,
    this.ticketNo,
    this.tableNumber,
    this.kind,
    this.staffName,
    this.rushed = false,
    this.placedAt,
  });

  final String id;
  final String? ticketNo;
  final String? tableNumber;
  final String? kind;
  final String? staffName;
  final bool rushed;
  final DateTime? placedAt;
  final List<RemoteLine> lines;

  /// Whether any station is still cooking it.
  final bool open;

  String get title {
    if (tableNumber != null && tableNumber!.isNotEmpty) return 'Table $tableNumber';
    final k = (kind ?? '').trim();
    if (k.isEmpty) return 'Order';
    return k[0].toUpperCase() + k.substring(1);
  }

  factory RemoteTicket.fromJson(Map<String, dynamic> j) {
    final stations = (j['stations'] as List? ?? const []);
    return RemoteTicket(
      id: '${j['id']}',
      ticketNo: j['ticketNo']?.toString(),
      tableNumber: j['tableNumber']?.toString(),
      kind: j['kind'] as String?,
      staffName: j['staffName'] as String?,
      rushed: j['rushed'] == true,
      placedAt: DateTime.tryParse('${j['placedAt'] ?? ''}')?.toLocal(),
      open: stations.any((s) => (s as Map)['status'] != 'done'),
      lines: [
        for (final l in (j['lines'] as List? ?? const []))
          RemoteLine(
            quantity: (l['quantity'] as num?) ?? 1,
            name: '${l['name'] ?? ''}',
            note: l['note'] as String?,
            isModifier: l['isModifier'] == true,
            made: l['madeAt'] != null,
          ),
      ],
    );
  }
}
