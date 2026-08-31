/// Reading what the till is ringing up.
///
/// The till publishes the current basket as a small JSON file and stops caring
/// what happens next — see `vesopa_epos/lib/data/customer_display.dart` for why
/// it is a file and not a socket. This is the other end of it.
///
/// WATCHING, WITH A POLL UNDERNEATH
///
/// Windows raises a change event for the rename the till does, and that is the
/// fast path. It is not the only path: a file watcher on Windows misses
/// renames under some conditions, dies silently if the folder is recreated, and
/// does not exist at all if the folder is on a network share. So there is also
/// a poll on the modification time, at a second. A display that misses a push
/// is then a second behind rather than frozen with somebody's previous round on
/// it, and a frozen customer display is the fault this whole feature exists to
/// avoid.
///
/// EVERY READ IS DEFENSIVE
///
/// The writer is a different process on a different release cadence. A file
/// that is missing, truncated, half-renamed, or written by a newer till than
/// this build understands must all end the same way: the last good basket stays
/// on screen and the display carries on. Nothing here throws.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

/// The newest file format this build knows how to read.
///
/// A file claiming a higher one is ignored rather than guessed at: a display
/// showing a bill it has half-understood is worse than one showing adverts.
const supportedFormat = 1;

/// One line on the customer's bill.
class BasketLine {
  const BasketLine({
    required this.name,
    required this.quantity,
    required this.totalMinor,
    this.isModifier = false,
  });

  final String name;
  final double quantity;
  final int totalMinor;

  /// A choice made under the item above it — "Dash Lime" under a gin. Drawn
  /// indented and without a price, the way the till's own check draws it.
  final bool isModifier;

  static BasketLine? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final name = raw['name'];
    if (name is! String || name.isEmpty) return null;
    return BasketLine(
      name: name,
      quantity: (raw['quantity'] as num?)?.toDouble() ?? 1,
      totalMinor: (raw['total_minor'] as num?)?.toInt() ?? 0,
      isModifier: raw['modifier'] == true,
    );
  }
}

/// What the till says the customer should be looking at.
class Basket {
  const Basket({
    required this.state,
    required this.updatedAt,
    this.lines = const [],
    this.subtotalMinor = 0,
    this.discountMinor = 0,
    this.taxMinor = 0,
    this.totalMinor = 0,
    this.paidMinor = 0,
    this.changeMinor = 0,
    this.message,
    this.terminal,
  });

  /// The state before the till has ever written a file: a display switched on
  /// first thing in the morning, before anybody has signed on.
  static final unknown = Basket(state: 'idle', updatedAt: DateTime(1970));

  /// 'idle' | 'sale' | 'paid'
  final String state;

  /// When the till wrote it, by the till's clock. Used only to notice that the
  /// till has stopped writing — see [BasketFeed.staleAfter].
  final DateTime updatedAt;

  final List<BasketLine> lines;
  final int subtotalMinor;
  final int discountMinor;
  final int taxMinor;
  final int totalMinor;
  final int paidMinor;
  final int changeMinor;
  final String? message;
  final String? terminal;

  /// Whether there is a bill worth showing a customer.
  ///
  /// An empty basket is not a sale in progress. It is a till somebody has just
  /// walked up to, and the right thing on the screen is the venue's advert.
  bool get hasSale => state != 'idle' && lines.isNotEmpty;

  static Basket? fromJson(Map<String, Object?> raw) {
    final format = (raw['format'] as num?)?.toInt() ?? 0;
    if (format > supportedFormat) return null;

    final stamp = DateTime.tryParse(raw['updated_at'] as String? ?? '');
    return Basket(
      state: raw['state'] as String? ?? 'idle',
      // A file with no usable timestamp is treated as having just arrived
      // rather than as ancient: the alternative is a display that declares the
      // till dead because one field was missing.
      updatedAt: stamp ?? DateTime.now(),
      lines: [
        for (final line in (raw['lines'] as List?) ?? const [])
          ?BasketLine.fromJson(line),
      ],
      subtotalMinor: (raw['subtotal_minor'] as num?)?.toInt() ?? 0,
      discountMinor: (raw['discount_minor'] as num?)?.toInt() ?? 0,
      taxMinor: (raw['tax_minor'] as num?)?.toInt() ?? 0,
      totalMinor: (raw['total_minor'] as num?)?.toInt() ?? 0,
      paidMinor: (raw['paid_minor'] as num?)?.toInt() ?? 0,
      changeMinor: (raw['change_minor'] as num?)?.toInt() ?? 0,
      message: raw['message'] as String?,
      terminal: raw['terminal'] as String?,
    );
  }
}

/// Follows the till's basket file.
class BasketFeed {
  BasketFeed({
    required this.path,
    this.pollEvery = const Duration(seconds: 1),
    this.staleAfter = const Duration(minutes: 10),
  });

  /// The file the till writes.
  ///
  /// Passed in rather than worked out here. Finding the till is its own problem
  /// with three tiers and a lot of judgement in it — see `data/settings.dart` —
  /// and this class does one thing: follow a path, and never fall over doing it.
  final String path;

  /// The backstop under the file watcher. See the note at the top.
  final Duration pollEvery;

  /// How long without a write before the till is assumed to be off.
  ///
  /// Long, deliberately. A quiet Tuesday afternoon is not a fault, and a
  /// display that puts "no connection" over the adverts because nobody has
  /// bought anything for five minutes is worse than one that says nothing.
  final Duration staleAfter;

  final _baskets = StreamController<Basket>.broadcast();
  Stream<Basket> get baskets => _baskets.stream;

  StreamSubscription<FileSystemEvent>? _watch;
  Timer? _timer;
  DateTime? _lastModified;
  bool _disposed = false;

  Basket _current = Basket.unknown;
  Basket get current => _current;

  /// Whether a basket has ever been read from [path].
  ///
  /// What the display page uses to decide whether to keep looking for the till.
  /// False means the path has never produced anything — a till that has not
  /// started, or a path that is simply wrong — and those are worth re-checking.
  /// True means this is the file, and it should be left alone.
  bool get hasRead => _hasRead;
  bool _hasRead = false;

  /// Whether the till has stopped writing.
  bool get isStale =>
      DateTime.now().difference(_current.updatedAt) > staleAfter;

  void start() {
    _disposed = false;
    unawaited(_read());
    _timer = Timer.periodic(pollEvery, (_) => unawaited(_read()));
    _startWatching();
  }

  /// The fast path. Best effort: if it cannot be established, or dies later,
  /// the poll above is still running and the display stays correct.
  void _startWatching() {
    try {
      final folder = File(path).parent;
      if (!folder.existsSync()) return;
      _watch = folder.watch(events: FileSystemEvent.all).listen(
        (_) => unawaited(_read()),
        onError: (Object _) {},
        cancelOnError: false,
      );
    } catch (_) {
      // No watcher. The poll carries it.
    }
  }

  Future<void> _read() async {
    if (_disposed) return;
    try {
      final file = File(path);
      final stat = await file.stat();
      if (stat.type == FileSystemEntityType.notFound) return;

      // Nothing has changed since the last read. Skipping the parse here is
      // what keeps this at effectively no cost once a second.
      if (_lastModified != null && !stat.modified.isAfter(_lastModified!)) {
        return;
      }

      final text = await file.readAsString();
      final raw = jsonDecode(text);
      if (raw is! Map<String, Object?>) return;

      final basket = Basket.fromJson(raw);
      if (basket == null) return;

      _lastModified = stat.modified;
      _hasRead = true;
      _current = basket;
      if (!_baskets.isClosed) _baskets.add(basket);
    } catch (_) {
      // A read that lands mid-rename, a file being written, a folder that has
      // gone: all of them mean "try again in a second", and none of them mean
      // anything the customer should be told about.
    }
  }

  Future<void> dispose() async {
    _disposed = true;
    _timer?.cancel();
    await _watch?.cancel();
    await _baskets.close();
  }
}
