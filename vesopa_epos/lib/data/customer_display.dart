/// What the customer sees, published for something else to draw.
///
/// The customer display is a **separate application** — see the
/// `vesopa_epos_display` project — and that is a deliberate decision rather than
/// an architectural preference. A second screen showing adverts is doing video
/// work on a machine whose actual job is taking money, and it must not be able
/// to slow the till down or take it with it when it falls over. So the till's
/// entire involvement is this file: it writes a small JSON file whenever the
/// basket changes, and stops caring what happens next.
///
/// WHY A FILE AND NOT A SOCKET
///
/// A socket would mean the till listening on a port: a firewall prompt on every
/// new machine, a port to document, and an inbound surface on the one device in
/// the building that handles cards. A customer display is a second monitor on
/// the same PC in almost every venue that has one, so a file in the till's own
/// data folder reaches it with none of that.
///
/// The write is atomic — temp file, then rename — because the reader is a
/// different process and a half-written basket is a display showing a bill with
/// three of its five lines on it.
///
/// NOTHING HERE MAY THROW INTO A SALE
///
/// Every failure is swallowed. A full disk, a locked file, a folder somebody
/// removed: none of them are reasons to stop selling, and none of them are
/// worth a message on the clerk's screen either. The display simply stops
/// updating, which is the failure the customer can already see.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:path_provider/path_provider.dart';

import 'local/database.dart';
import 'terminal_identity.dart';

/// The file's own version, so a newer till and an older display can recognise
/// each other rather than mis-reading a shape that has changed.
const customerDisplayFormat = 1;

/// The folder the till and the display meet in, under %PROGRAMDATA%\Vesopa.
///
/// Named `display` because it is the one part of the till's data another
/// program is meant to open, and a folder makes that obvious to whoever is
/// looking at it during a support call.
const customerDisplayFolder = 'display';
const customerDisplayFile = 'basket.json';

/// The root both applications can reach. Shared with the pairing handshake,
/// which already meets here — see `display_pairing.dart`.
const customerDisplayRootFolder = 'Vesopa';

/// One line as the customer should read it.
///
/// Deliberately not [OrderLine]: this crosses a process boundary into an
/// application that must keep working when the till is upgraded, so it carries
/// only what a customer needs to see and nothing that would tie the two builds
/// together.
class DisplayLine {
  const DisplayLine({
    required this.name,
    required this.quantity,
    required this.totalMinor,
    this.isModifier = false,
  });

  final String name;
  final double quantity;
  final int totalMinor;

  /// Drawn indented and without a price, the way it is on the till's own
  /// receipt panel.
  final bool isModifier;

  Map<String, Object?> toJson() => {
    'name': name,
    'quantity': quantity,
    'total_minor': totalMinor,
    if (isModifier) 'modifier': true,
  };
}

/// What the customer's screen should be showing right now.
class DisplaySnapshot {
  const DisplaySnapshot({
    required this.state,
    this.lines = const [],
    this.subtotalMinor = 0,
    this.discountMinor = 0,
    this.taxMinor = 0,
    this.totalMinor = 0,
    this.paidMinor = 0,
    this.changeMinor = 0,
    this.message,
    this.terminalName,
  });

  /// A till with nothing rung up. The display shows adverts full screen for
  /// this, without waiting for its own idle timer — an empty basket is not
  /// something a customer needs to look at.
  const DisplaySnapshot.idle({String? terminalName})
    : this(state: 'idle', terminalName: terminalName);

  /// 'idle' | 'sale' | 'paid'
  final String state;

  final List<DisplayLine> lines;
  final int subtotalMinor;
  final int discountMinor;
  final int taxMinor;
  final int totalMinor;

  /// Only meaningful in 'paid': what was tendered and what is owed back. A
  /// customer checking their change against the screen is the one moment this
  /// display earns its keep.
  final int paidMinor;
  final int changeMinor;

  /// A line for the customer — "Thank you", or what the venue set.
  final String? message;

  final String? terminalName;

  Map<String, Object?> toJson() => {
    'format': customerDisplayFormat,
    'updated_at': DateTime.now().toIso8601String(),
    'state': state,
    'terminal': terminalName,
    'lines': [for (final line in lines) line.toJson()],
    'subtotal_minor': subtotalMinor,
    'discount_minor': discountMinor,
    'tax_minor': taxMinor,
    'total_minor': totalMinor,
    'paid_minor': paidMinor,
    'change_minor': changeMinor,
    'message': message,
  };

  /// Whether two snapshots would draw the same screen.
  ///
  /// Used to skip a write. The basket stream fires for changes the customer
  /// cannot see — a note edited, a line's kitchen route set — and rewriting the
  /// file for each of them means the display's own "has anything happened
  /// lately" timer never gets to run out.
  bool sameAs(DisplaySnapshot other) =>
      state == other.state &&
      totalMinor == other.totalMinor &&
      subtotalMinor == other.subtotalMinor &&
      discountMinor == other.discountMinor &&
      taxMinor == other.taxMinor &&
      paidMinor == other.paidMinor &&
      changeMinor == other.changeMinor &&
      message == other.message &&
      lines.length == other.lines.length &&
      () {
        for (var i = 0; i < lines.length; i++) {
          if (lines[i].name != other.lines[i].name ||
              lines[i].quantity != other.lines[i].quantity ||
              lines[i].totalMinor != other.lines[i].totalMinor) {
            return false;
          }
        }
        return true;
      }();
}

/// The folder the till and the customer display share.
///
/// One folder, three files, and they are the entire contract between the two
/// applications:
///
///   * `basket.json`   — the till writes, the display reads. What to show.
///   * `settings.json` — the till writes, the display reads. How to show it.
///   * `status.json`   — the display writes, the till reads. What it is doing.
///
/// WHY THIS MOVED OUT OF THE TILL'S OWN DATA FOLDER
///
/// It used to be `getApplicationSupportDirectory()/display`, and the display was
/// handed that path by the pairing grant. On a machine where both are installed
/// from the Store that path is a lie the moment it crosses the counter: an MSIX
/// package's AppData is virtualised into its own package container, so the till
/// writes to a folder only the till can see. The display would pair — the
/// handshake is in ProgramData and works — and then follow a basket file that
/// never changed, showing adverts with "Waiting for the till" in the corner. A
/// venue reported exactly that on three terminals.
///
/// Handing over the path could not fix it, because the problem was never that
/// the display did not know the path. It was that the file was somewhere the
/// display is not allowed to look.
///
/// So the data moves to where the handshake already is. ProgramData is not
/// redirected and is reachable by both packages with no shared identity and no
/// capability declared on either side — which the pairing folder has been
/// demonstrating for as long as pairing has worked.
///
/// PER TILL, NOT PER MACHINE
///
/// The path carries the terminal's device id. ProgramData is one folder for the
/// whole machine, and a venue that runs two tills on one PC would otherwise
/// have both writing one basket.json — two counters' baskets in one file, each
/// overwriting the other several times a second. The pairing grant names the
/// full path, so a display follows its own till and no other.
///
/// MOVING IS AUTOMATIC
///
/// A display already paired keeps the old path only until the till next starts:
/// `refreshGrants` rewrites every grant with wherever the till writes *today*,
/// which is what that function is for. Nobody re-pairs anything.
///
/// Created if it is not there, so the till's settings screen can configure a
/// display that has not been installed yet — which is the order these things
/// actually happen in on install day.
///
/// Returns null on a till whose data folder cannot be opened. Every caller
/// treats that as "no customer display", which is the truth.
Future<Directory?> customerDisplayDirectory({Directory? override}) async {
  try {
    if (override != null) {
      final folder = Directory('${override.path}/$customerDisplayFolder');
      await folder.create(recursive: true);
      return folder;
    }

    final shared = await _sharedDisplayDirectory();
    if (shared != null) return shared;

    // Not Windows, or a Windows with no ProgramData — neither of which is a
    // machine a customer display is plugged into. The till's own folder still
    // works for everything on this side of the boundary, and a display that
    // cannot reach it was never going to reach anything.
    final base = await getApplicationSupportDirectory().timeout(
      const Duration(seconds: 5),
    );
    final folder = Directory('${base.path}/$customerDisplayFolder');
    await folder.create(recursive: true);
    return folder;
  } catch (_) {
    return null;
  }
}

/// Where this till publishes, as a path: no disk touched and nothing created.
///
/// Separate from the directory below so that it can be asserted on. A test that
/// had to call the real thing would create `C:\ProgramData\Vesopa\display\...`
/// on whatever machine ran it, and a suite that leaves folders behind on the
/// build agent is one nobody runs twice.
///
/// [programData] is the machine's ProgramData root and [deviceId] the
/// terminal's permanent id. Null off Windows and null where ProgramData is
/// unknown — both of which fall back to the till's own folder rather than
/// failing.
String? sharedDisplayPath({
  required String? programData,
  required String deviceId,
  bool windows = true,
}) {
  if (!windows) return null;
  if (programData == null || programData.isEmpty) return null;
  if (deviceId.trim().isEmpty) return null;

  const sep = r'\';
  return '$programData$sep$customerDisplayRootFolder$sep'
      '$customerDisplayFolder$sep${deviceId.trim()}';
}

/// `%PROGRAMDATA%\Vesopa\display\<terminal device id>`, created.
Future<Directory?> _sharedDisplayDirectory() async {
  // The id is a preferences read that has already happened by the time any
  // basket is published — the shell resolves it on start — so this is a cache
  // hit in practice rather than a disk seek per bill.
  final path = sharedDisplayPath(
    programData: Platform.environment['PROGRAMDATA'],
    deviceId: await terminalDeviceId(),
    windows: Platform.isWindows,
  );
  if (path == null) return null;

  final folder = Directory(path);
  await folder.create(recursive: true);
  return folder;
}

/// Where the till leaves a note saying where it writes.
///
/// WHY THIS EXISTS
///
/// The display application has to open a file this one writes, and until now it
/// worked that path out for itself. Working it out means knowing that
/// path_provider builds the folder from the executable's CompanyName and
/// ProductName resources, and that the Microsoft Store then redirects the whole
/// thing into a package folder whose name ends in a hash of the publisher. Both
/// of those are facts about how this till happens to be built today. Neither is
/// something the screen facing the customer should depend on.
///
/// So the till says it instead. It writes one small file to a fixed place, and
/// the display reads that first and computes nothing.
///
/// WHY %PROGRAMDATA%
///
/// It is the one location that survives the difference. A packaged application
/// has its AppData and its registry writes virtualised into its own package
/// container — which is exactly what made the path hard to guess — but
/// ProgramData is not redirected, and it is readable by every account on the
/// machine. A till installed from the Store and a display installed from the
/// Store therefore meet in the same folder, with no shared identity between
/// them and no capability declared on either side.
///
/// It is best effort. A machine whose ProgramData cannot be written to loses
/// nothing it had before: the display falls back to working the path out, which
/// is what it did already.
const displayAnnouncementFolder = 'Vesopa';
const displayAnnouncementFile = 'customer-display.json';

/// The announcement's own version, read by the display before anything else in
/// it is trusted.
const displayAnnouncementFormat = 1;

/// The full path, or null on a machine that does not have a ProgramData.
String? displayAnnouncementPath() {
  if (!Platform.isWindows) return null;
  final root = Platform.environment['PROGRAMDATA'];
  if (root == null || root.isEmpty) return null;
  return '$root\\$displayAnnouncementFolder\\$displayAnnouncementFile';
}

/// Tell any customer display on this machine where the basket file is.
///
/// Called once, when the till resolves its own data folder. Rewritten on every
/// start rather than written once, so a till that has been upgraded, moved
/// between packagings, or reinstalled under a different name corrects the note
/// rather than leaving the display following a path that no longer exists.
///
/// Never throws. See the note at the top of this file.
Future<void> announceDisplayFile(
  File basket, {
  String? terminalName,
  /// Somewhere else to write it. Only for tests — the real location is fixed,
  /// because a location the display would have to be told about would defeat
  /// the entire point of the note.
  String? pathOverride,
}) async {
  try {
    final path = pathOverride ?? displayAnnouncementPath();
    if (path == null) return;

    final file = File(path);
    await file.parent.create(recursive: true);
    await file.writeAsString(
      jsonEncode({
        'format': displayAnnouncementFormat,
        'updated_at': DateTime.now().toIso8601String(),
        'basket': basket.path,
        'terminal': terminalName,
      }),
      flush: true,
    );
  } catch (_) {
    // A till that could not leave a note. The display works the path out, the
    // way it did before there was a note to leave.
  }
}

/// Publishes [DisplaySnapshot]s for the customer display application.
class CustomerDisplayFeed {
  CustomerDisplayFeed({this.directoryOverride});

  /// A folder to write into instead of the platform one. Only for tests: the
  /// real path comes from path_provider, which has no plugin in a unit test.
  final Directory? directoryOverride;

  File? _file;
  File? _temp;
  DisplaySnapshot? _last;

  /// Set once the folder has been resolved, successfully or not. A till whose
  /// data folder cannot be written to must not retry on every keystroke.
  bool _resolved = false;

  /// Resolve the target file. Safe to call repeatedly.
  Future<void> _resolve() async {
    if (_resolved) return;
    _resolved = true;
    try {
      final folder = await customerDisplayDirectory(
        override: directoryOverride,
      );
      if (folder == null) {
        _file = null;
        return;
      }
      _file = File('${folder.path}/$customerDisplayFile');
      // Beside the real file rather than in the system temp folder, so the
      // rename below is within one filesystem — a cross-device rename is a
      // copy, and a copy is not atomic.
      _temp = File('${folder.path}/$customerDisplayFile.tmp');

      // Say where it is, now that it is known. Not awaited into the caller's
      // critical path any more than the write itself is: a sale must not wait
      // on a note left for another application.
      //
      // Skipped when the folder was overridden, which only a test does. The
      // announcement is at a fixed machine-wide path, and a test run that left
      // a real customer display pointed at a deleted temp folder would be a
      // memorable way to find that out.
      if (directoryOverride == null) unawaited(announceDisplayFile(_file!));
    } catch (_) {
      _file = null;
    }
  }

  /// The file this feed writes, once resolved. Null before the first publish,
  /// and on a till whose data folder could not be opened.
  File? get file => _file;

  /// Write [snapshot], unless it would draw the same screen as the last one.
  Future<void> publish(DisplaySnapshot snapshot) async {
    final previous = _last;
    if (previous != null && snapshot.sameAs(previous)) return;

    await _resolve();
    final file = _file;
    final temp = _temp;
    if (file == null || temp == null) return;

    try {
      await temp.writeAsString(jsonEncode(snapshot.toJson()), flush: true);
      await temp.rename(file.path);
      _last = snapshot;
    } catch (_) {
      // Swallowed on purpose. See the note at the top of this file: a display
      // that stops updating is a visible fault the customer can see, and it is
      // a far smaller one than a till that cannot take money.
    }
  }

  /// Put the display back to adverts. Called when a sale is finished with, and
  /// when the till shuts down.
  Future<void> clear({String? terminalName}) =>
      publish(DisplaySnapshot.idle(terminalName: terminalName));
}

/// Build a snapshot from what the sale screen is holding.
///
/// Takes the four figures rather than the whole [Order] on purpose. The order
/// row carries forty columns this screen has no business knowing about — a
/// clerk's PIN among them — and naming the four it does need is what keeps a
/// change to the schema from quietly altering what a customer is shown.
DisplaySnapshot snapshotFor({
  required List<OrderLine> lines,
  int subtotalMinor = 0,
  int discountMinor = 0,
  int taxMinor = 0,
  int totalMinor = 0,
  String? terminalName,
  String? message,
}) {
  if (lines.isEmpty) return DisplaySnapshot.idle(terminalName: terminalName);

  return DisplaySnapshot(
    state: 'sale',
    terminalName: terminalName,
    message: message,
    lines: [
      for (final line in lines)
        DisplayLine(
          name: line.name,
          quantity: line.quantity,
          // Computed here rather than read off the row: the schema stores a
          // unit price and a per-line discount, and the customer is owed the
          // figure that will actually appear on their bill.
          totalMinor:
              (line.unitPriceMinor * line.quantity).round() -
              line.lineDiscountMinor,
          // A modifier is a line with a parent — "Dash Coke" under a double
          // gin. The display indents those under the item they belong to, the
          // same way the till's own check does.
          isModifier: line.parentLineId != null,
        ),
    ],
    subtotalMinor: subtotalMinor,
    discountMinor: discountMinor,
    taxMinor: taxMinor,
    totalMinor: totalMinor,
  );
}
