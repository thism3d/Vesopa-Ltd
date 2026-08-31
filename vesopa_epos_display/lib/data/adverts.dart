/// The venue's adverts, and when to show them.
///
/// A folder on this machine, not a download. Two reasons, and the second is the
/// one that decided it:
///
///   * an advert is a still or a thirty-second clip, and a venue that has had
///     one cut for its screens has a file measured in tens of megabytes — which
///     is not something to push through a back office designed for product
///     pictures;
///   * a display whose adverts live locally keeps working when the broadband
///     does not, and a blank screen facing the customer is exactly the failure
///     nobody is standing next to the machine to notice.
///
/// So: point it at a folder, drop files in, and they appear. The folder is
/// re-read on a timer, so a manager who adds a Christmas poster at four o'clock
/// does not have to restart anything.
library;

import 'dart:async';
import 'dart:io';

/// What kind of thing an advert is, which decides how it is drawn.
enum AdvertKind { image, video }

/// One advert.
class Advert {
  const Advert({required this.file, required this.kind});

  final File file;
  final AdvertKind kind;

  String get path => file.path;
}

/// Extensions taken from the folder, and what each is.
///
/// A deliberately short list. Anything else in the folder — a PSD, a thumbs.db,
/// the notes.txt somebody left — is ignored rather than attempted, because a
/// decoder failing on a full screen in front of customers is the one place an
/// error must not reach.
const _kinds = <String, AdvertKind>{
  '.png': AdvertKind.image,
  '.jpg': AdvertKind.image,
  '.jpeg': AdvertKind.image,
  '.gif': AdvertKind.image,
  '.webp': AdvertKind.image,
  '.bmp': AdvertKind.image,
  '.mp4': AdvertKind.video,
  '.m4v': AdvertKind.video,
  '.mov': AdvertKind.video,
};

/// Read a folder's adverts, in the order they should play.
///
/// Sorted by file name, which is the only ordering a venue can control without
/// a screen to control it in: prefix the files `01-`, `02-` and they play in
/// that order. Sorting by modification time instead would reshuffle the loop
/// every time somebody touched a file.
List<Advert> advertsIn(Directory folder) {
  if (!folder.existsSync()) return const [];

  final found = <Advert>[];
  try {
    for (final entry in folder.listSync(followLinks: false)) {
      if (entry is! File) continue;
      final name = entry.uri.pathSegments.last;
      final dot = name.lastIndexOf('.');
      if (dot < 0) continue;
      final kind = _kinds[name.substring(dot).toLowerCase()];
      if (kind == null) continue;
      found.add(Advert(file: entry, kind: kind));
    }
  } catch (_) {
    // A folder that vanished mid-listing, or one on a share that went away.
    // An empty list is the right answer; the caller draws its fallback.
    return const [];
  }

  found.sort((a, b) => a.path.toLowerCase().compareTo(b.path.toLowerCase()));
  return found;
}

/// Watches an advert folder and hands out what is in it.
class AdvertLibrary {
  AdvertLibrary({
    required this.folder,
    this.rescanEvery = const Duration(minutes: 2),
  });

  /// Null until the venue has chosen one. The display draws its own fallback
  /// card in that case rather than a black rectangle, so a screen that has been
  /// switched on but never set up says what it needs.
  final Directory? folder;

  final Duration rescanEvery;

  final _changes = StreamController<List<Advert>>.broadcast();
  Stream<List<Advert>> get changes => _changes.stream;

  List<Advert> _adverts = const [];
  List<Advert> get adverts => _adverts;

  Timer? _timer;

  void start() {
    _rescan();
    _timer = Timer.periodic(rescanEvery, (_) => _rescan());
  }

  void _rescan() {
    final directory = folder;
    final next = directory == null ? const <Advert>[] : advertsIn(directory);

    // Compared by path so a rescan that finds the same files does not restart
    // the loop — which, on a two-minute timer and a thirty-second advert, would
    // mean the third one in the folder was never reached.
    final same =
        next.length == _adverts.length &&
        List.generate(next.length, (i) => next[i].path == _adverts[i].path)
            .every((x) => x);
    if (same) return;

    _adverts = next;
    if (!_changes.isClosed) _changes.add(next);
  }

  Future<void> dispose() async {
    _timer?.cancel();
    await _changes.close();
  }
}

/// Which advert is showing, and moving on to the next.
///
/// Held apart from the widget that draws it so the rotation survives the screen
/// changing shape — going full screen when the till goes idle must not restart
/// the loop at the first poster.
class AdvertRotation {
  AdvertRotation({this.dwell = const Duration(seconds: 12)});

  /// How long a still stays up. A video plays to its end and then advances
  /// regardless of this.
  final Duration dwell;

  int _index = 0;

  /// The advert to draw now, or null when the folder is empty.
  Advert? current(List<Advert> adverts) {
    if (adverts.isEmpty) return null;
    // Clamped rather than reset: a folder that shrank while the loop was on its
    // last poster should show the new last one, not jump back to the first.
    if (_index >= adverts.length) _index = adverts.length - 1;
    return adverts[_index];
  }

  /// Move on. Wraps.
  void advance(List<Advert> adverts) {
    if (adverts.isEmpty) {
      _index = 0;
      return;
    }
    _index = (_index + 1) % adverts.length;
  }

  /// Back to the beginning of the loop. Used when the folder's contents change,
  /// where keeping the position would land on a different advert than the one
  /// that was showing.
  void reset() => _index = 0;
}
