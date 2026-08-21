/// What the kitchen is looking at.
///
/// One ticket per *fire*, not per station — see `docs/architecture.md`. Every
/// line carries the stations it was routed to, and a board draws only the lines
/// for the stations it watches. That is what makes one order one card on a
/// small kitchen's single screen, and the same order appear on the grill and
/// the fryer screens carrying only their own lines in a large one.
library;

/// One item on a ticket.
class TicketLine {
  const TicketLine({
    required this.id,
    required this.seq,
    required this.quantity,
    required this.name,
    required this.stations,
    this.note,
  });

  final String id;

  /// The order the clerk rang them in. A kitchen reads a ticket top to bottom,
  /// and a re-sorted ticket is a re-plated dish.
  final int seq;

  final double quantity;
  final String name;

  /// The modifier, drawn in red under the line: "no tomato", "extra sausage".
  /// The one thing on the card that is not the recipe.
  final String? note;

  /// The stations this line was routed to.
  final Set<String> stations;

  /// Whether this line belongs on a board watching [watched].
  ///
  /// An empty [watched] means "every station", which is what a single-screen
  /// kitchen has and what saves it ticking six boxes to say so.
  bool isFor(Set<String> watched) =>
      watched.isEmpty || stations.any(watched.contains);

  /// "2" rather than "2.0", but "0.5" when somebody really did sell half of
  /// something. A kitchen ticket reading `1.0x Chips` looks like a fault.
  String get quantityLabel => quantity == quantity.roundToDouble()
      ? quantity.toStringAsFixed(0)
      : quantity.toString();

  factory TicketLine.fromJson(Map<String, dynamic> j) => TicketLine(
    id: j['id'] as String,
    seq: (j['seq'] as num?)?.toInt() ?? 0,
    quantity: (j['quantity'] as num?)?.toDouble() ?? 1,
    name: j['name'] as String? ?? '',
    note: (j['note'] as String?)?.trim().isEmpty ?? true
        ? null
        : (j['note'] as String).trim(),
    stations: _stations(j['stations']),
  );

  Map<String, dynamic> toJson() => {
    'id': id,
    'seq': seq,
    'quantity': quantity,
    'name': name,
    if (note != null) 'note': note,
    'stations': stations.toList(),
  };
}

/// How far along one station is on one ticket.
class TicketStation {
  const TicketStation({
    required this.station,
    required this.done,
    this.doneAt,
    this.doneBy,
  });

  final String station;
  final bool done;
  final DateTime? doneAt;
  final String? doneBy;

  factory TicketStation.fromJson(Map<String, dynamic> j) => TicketStation(
    station: j['station'] as String,
    done: j['status'] == 'done',
    doneAt: _time(j['doneAt']),
    doneBy: j['doneBy'] as String?,
  );

  Map<String, dynamic> toJson() => {
    'station': station,
    'status': done ? 'done' : 'open',
    if (doneAt != null) 'doneAt': doneAt!.toUtc().toIso8601String(),
    if (doneBy != null) 'doneBy': doneBy,
  };
}

/// Why the ticket fired. The kitchen genuinely works these differently: a
/// saved table is food to start against a bill that stays open, a sale is food
/// already paid for, a reprint is neither.
enum TicketKind {
  sale('Sale'),
  table('Table'),
  reprint('Reprint');

  const TicketKind(this.label);
  final String label;

  static TicketKind fromKey(String? key) => switch (key) {
    'table' => table,
    'reprint' => reprint,
    _ => sale,
  };
}

/// A bill, as the kitchen sees it.
class Ticket {
  const Ticket({
    required this.id,
    required this.orderId,
    required this.kind,
    required this.placedAt,
    required this.lines,
    required this.stations,
    this.ticketNo,
    this.tableNumber,
    this.roomName,
    this.staffName,
    this.covers,
    this.note,
    this.rushed = false,
  });

  final String id;
  final String orderId;
  final String? ticketNo;
  final TicketKind kind;

  /// When the till fired it, not when it reached the server. The board's
  /// elapsed clock counts from this — a ticket held up by the network is
  /// *late*, and hiding that is the one thing a kitchen board must not do.
  final DateTime placedAt;

  final int? tableNumber;
  final String? roomName;
  final String? staffName;
  final int? covers;
  final String? note;
  final bool rushed;

  final List<TicketLine> lines;
  final List<TicketStation> stations;

  /// How long this has been waiting.
  Duration age([DateTime? now]) => (now ?? DateTime.now()).difference(placedAt);

  /// The lines a board watching [watched] should draw.
  List<TicketLine> linesFor(Set<String> watched) =>
      lines.where((l) => l.isFor(watched)).toList();

  /// The stations a board watching [watched] is responsible for.
  ///
  /// The intersection, not [watched] itself: bumping must close the stations
  /// this ticket actually has, or a screen watching all six would close five
  /// rows that do not exist and the request would be a no-op.
  Set<String> stationsFor(Set<String> watched) => {
    for (final s in stations)
      if (watched.isEmpty || watched.contains(s.station)) s.station,
  };

  /// Whether a board watching [watched] still has work on this ticket.
  ///
  /// Per station, so the pass can see that the fryer is still going while the
  /// grill has finished — and so a kitchen with one screen never meets the
  /// distinction at all, because for them every station is theirs.
  bool isOpenFor(Set<String> watched) => stations.any(
    (s) => !s.done && (watched.isEmpty || watched.contains(s.station)),
  );

  /// Every station done, everywhere. What moves a card to the Completed tab.
  bool get isComplete => stations.every((s) => s.done);

  /// When the last station finished, for ordering the Completed tab and for
  /// deciding what has aged out of the recall window.
  DateTime? get completedAt => completedAtFor(const {});

  /// The same, for one board's share of the ticket.
  ///
  /// This distinction is not decoration, and getting it wrong loses orders. On
  /// a kitchen with two screens the grill can finish while the fryer is still
  /// going: the ticket is not *complete*, so a whole-ticket reading returns
  /// null — and the grill's card would then be in neither tab, because it is no
  /// longer open for them and has no completion time to sort by. It would
  /// simply vanish off their screen, un-recallable, while the fryer worked.
  ///
  /// So the Completed tab asks when the stations *this board* is responsible
  /// for finished. An empty [watched] means every station, which is the
  /// single-screen case and collapses back to [completedAt].
  DateTime? completedAtFor(Set<String> watched) {
    DateTime? latest;
    for (final s in stations) {
      if (watched.isNotEmpty && !watched.contains(s.station)) continue;
      final at = s.doneAt;
      // Still working. No completion time, which is what keeps an unfinished
      // ticket out of the Completed tab.
      if (at == null) return null;
      if (latest == null || at.isAfter(latest)) latest = at;
    }
    return latest;
  }

  /// Whether some stations are done and others are not — a ticket the kitchen
  /// is halfway through. Worth showing on a multi-screen board and invisible on
  /// a single-screen one, which is exactly the behaviour wanted.
  bool get isPartlyDone =>
      stations.any((s) => s.done) && stations.any((s) => !s.done);

  /// The stations still outstanding, whoever is responsible for them.
  Set<String> get outstanding => {
    for (final s in stations)
      if (!s.done) s.station,
  };

  /// What to put at the top left of the card.
  ///
  /// The table wins, because that is where the food is going and it is the only
  /// thing on the card a chef acts on. A counter sale has no table and says so.
  String get destination {
    if (tableNumber != null) return 'Table #$tableNumber';
    return switch (kind) {
      TicketKind.table => 'Table',
      TicketKind.reprint => 'Reprint',
      TicketKind.sale => 'Counter',
    };
  }

  factory Ticket.fromJson(Map<String, dynamic> j) => Ticket(
    id: j['id'] as String,
    orderId: j['orderId'] as String? ?? j['id'] as String,
    ticketNo: j['ticketNo'] as String?,
    kind: TicketKind.fromKey(j['kind'] as String?),
    placedAt: _time(j['placedAt']) ?? DateTime.now(),
    tableNumber: (j['tableNumber'] as num?)?.toInt(),
    roomName: j['roomName'] as String?,
    staffName: j['staffName'] as String?,
    covers: (j['covers'] as num?)?.toInt(),
    note: (j['note'] as String?)?.trim().isEmpty ?? true
        ? null
        : (j['note'] as String).trim(),
    rushed: j['rushed'] == true,
    lines:
        ((j['lines'] as List?) ?? const [])
            .cast<Map<String, dynamic>>()
            .map(TicketLine.fromJson)
            .toList()
          ..sort((a, b) => a.seq.compareTo(b.seq)),
    stations: ((j['stations'] as List?) ?? const [])
        .cast<Map<String, dynamic>>()
        .map(TicketStation.fromJson)
        .toList(),
  );

  Map<String, dynamic> toJson() => {
    'id': id,
    'orderId': orderId,
    if (ticketNo != null) 'ticketNo': ticketNo,
    'kind': kind.name,
    'placedAt': placedAt.toUtc().toIso8601String(),
    if (tableNumber != null) 'tableNumber': tableNumber,
    if (roomName != null) 'roomName': roomName,
    if (staffName != null) 'staffName': staffName,
    if (covers != null) 'covers': covers,
    if (note != null) 'note': note,
    'rushed': rushed,
    'lines': [for (final l in lines) l.toJson()],
    'stations': [for (final s in stations) s.toJson()],
  };

  /// The same ticket with some stations marked done.
  ///
  /// Applied locally the moment the tick is pressed, before the server has
  /// answered. A kitchen screen that waits for a round trip before the card
  /// moves is a screen somebody presses twice.
  Ticket bumped(Set<String> which, {String? by, DateTime? at}) {
    final when = at ?? DateTime.now();
    return _copy(
      stations: [
        for (final s in stations)
          if (s.done || !(which.isEmpty || which.contains(s.station)))
            s
          else
            TicketStation(
              station: s.station,
              done: true,
              doneAt: when,
              doneBy: by,
            ),
      ],
    );
  }

  /// The same ticket, everything re-opened. Recall is all-or-nothing because
  /// "that went out wrong" has no partial reading.
  Ticket recalled() => _copy(
    stations: [
      for (final s in stations) TicketStation(station: s.station, done: false),
    ],
  );

  Ticket rushedTo(bool value) => _copy(rushed: value);

  Ticket _copy({List<TicketStation>? stations, bool? rushed}) => Ticket(
    id: id,
    orderId: orderId,
    ticketNo: ticketNo,
    kind: kind,
    placedAt: placedAt,
    tableNumber: tableNumber,
    roomName: roomName,
    staffName: staffName,
    covers: covers,
    note: note,
    rushed: rushed ?? this.rushed,
    lines: lines,
    stations: stations ?? this.stations,
  );
}

/// A time from the server, which sends MySQL DATETIMEs as ISO strings.
///
/// Returns local time. Everything on this screen is a wall clock a chef reads
/// against the one above the pass, so UTC anywhere in the UI is a bug.
DateTime? _time(Object? raw) {
  if (raw == null) return null;
  final parsed = DateTime.tryParse('$raw');
  return parsed?.toLocal();
}

/// Station keys from either a list or a comma-separated string, since the
/// server sends a list and the local cache round-trips one.
Set<String> _stations(Object? raw) {
  if (raw is List) {
    return {
      for (final s in raw)
        if ('$s'.trim().isNotEmpty) '$s'.trim().toLowerCase(),
    };
  }
  return {
    for (final s in '${raw ?? ''}'.split(','))
      if (s.trim().isNotEmpty) s.trim().toLowerCase(),
  };
}
