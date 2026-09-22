import '../config/constants.dart';

/// A named board, as the back office defines it.
///
/// Which stations it watches, and how it behaves. The venue owns this for the
/// same reason it owns station *names*: so "the grill screen" means one thing
/// in the building, and a manager can widen it or slow its clock down without
/// climbing onto a stool with a keyboard.
///
/// Which profile a given machine *is* stays on that machine — see
/// [KitchenSession]. That is the same split the till already draws between
/// printer names (the venue's) and printer hardware (the terminal's).
class ScreenProfile {
  const ScreenProfile({
    required this.id,
    required this.name,
    this.stations = const {},
    this.columns = 0,
    this.warn = BoardDefaults.warn,
    this.late = BoardDefaults.late,
    this.recallWindow = BoardDefaults.recallWindow,
    this.sound = true,
  });

  /// Negative for the built-in profile, which has no row in the database. Real
  /// screens have the auto-increment id, so the two can never collide.
  final int id;

  final String name;

  /// The stations this board draws. **Empty means every station**, which is
  /// what a one-screen kitchen wants and saves it ticking six boxes to say so.
  final Set<String> stations;

  /// How many cards across. 0 means "work it out from the width", which is
  /// right for almost every panel.
  final int columns;

  final Duration warn;
  final Duration late;
  final Duration recallWindow;

  /// Whether a new ticket makes a noise. Off for a screen at the pass, where
  /// somebody is already looking at it; on for one in a corner.
  final bool sound;

  /// The board every venue has before anybody configures one.
  ///
  /// Not a stopgap — for a kitchen with a single screen it is the right answer
  /// permanently, and a venue that never opens the back office's kitchen page
  /// gets a working board on the first launch.
  static const allStations = ScreenProfile(
    id: -1,
    name: 'All stations',
  );

  bool get isBuiltIn => id < 0;

  /// Whether [station] belongs on this board.
  bool watches(String station) =>
      stations.isEmpty || stations.contains(station);

  factory ScreenProfile.fromJson(Map<String, dynamic> j) => ScreenProfile(
    id: (j['id'] as num).toInt(),
    name: j['name'] as String? ?? 'Screen',
    stations: {
      for (final s in (j['stations'] as List?) ?? const [])
        if ('$s'.trim().isNotEmpty) '$s'.trim().toLowerCase(),
    },
    columns: (j['columns_count'] as num?)?.toInt() ?? 0,
    // Clamped here as well as on the server. A board whose amber arrives after
    // its red, or whose thresholds are two seconds apart, is a board that is
    // entirely one colour — which is a board with no information on it, and a
    // bad row reaching the database by some other route must not produce one.
    warn: _seconds(j['warn_seconds'], BoardDefaults.warn, 60, 3600),
    late: _seconds(j['late_seconds'], BoardDefaults.late, 120, 7200),
    recallWindow: Duration(
      minutes: ((j['recall_minutes'] as num?)?.toInt() ?? 60).clamp(5, 1440),
    ),
    sound: j['sound'] != 0 && j['sound'] != false,
  );

  Map<String, dynamic> toJson() => {
    'id': id,
    'name': name,
    'stations': stations.toList(),
    'columns_count': columns,
    'warn_seconds': warn.inSeconds,
    'late_seconds': late.inSeconds,
    'recall_minutes': recallWindow.inMinutes,
    'sound': sound,
  };

  /// [late] is never allowed to arrive before [warn], whatever was stored.
  ScreenProfile normalised() => late > warn
      ? this
      : ScreenProfile(
          id: id,
          name: name,
          stations: stations,
          columns: columns,
          warn: warn,
          late: warn + const Duration(minutes: 1),
          recallWindow: recallWindow,
          sound: sound,
        );

  static Duration _seconds(Object? raw, Duration fallback, int min, int max) {
    final n = (raw as num?)?.toInt();
    if (n == null) return fallback;
    return Duration(seconds: n.clamp(min, max));
  }
}

/// How a ticket's age reads on the board.
enum TicketAge {
  /// Quiet, so the board is calm when the kitchen is calm — or the colours
  /// stop meaning anything when it is not.
  fresh,
  warn,

  /// And pulsing. See `ui/widgets/ticket_card.dart`.
  late;

  static TicketAge of(Duration age, ScreenProfile profile) {
    if (age >= profile.late) return TicketAge.late;
    if (age >= profile.warn) return TicketAge.warn;
    return TicketAge.fresh;
  }
}
