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

/// The file's own version, so a newer till and an older display can recognise
/// each other rather than mis-reading a shape that has changed.
const customerDisplayFormat = 1;

/// Where the file lives, under the till's own application support folder.
///
/// Named `display` rather than dropped beside the database on purpose: it is
/// the one thing in that folder another program is meant to open, and a folder
/// makes that obvious to whoever is looking at it during a support call.
const customerDisplayFolder = 'display';
const customerDisplayFile = 'basket.json';

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
      final base =
          directoryOverride ??
          await getApplicationSupportDirectory().timeout(
            const Duration(seconds: 5),
          );
      final folder = Directory('${base.path}/$customerDisplayFolder');
      await folder.create(recursive: true);
      _file = File('${folder.path}/$customerDisplayFile');
      // Beside the real file rather than in the system temp folder, so the
      // rename below is within one filesystem — a cross-device rename is a
      // copy, and a copy is not atomic.
      _temp = File('${folder.path}/$customerDisplayFile.tmp');
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
