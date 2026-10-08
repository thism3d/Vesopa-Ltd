/// How a printer finishes a document and how its bytes are sent (2026-10-08).
///
/// "The paper is not cutting and no Z report, it's just blank." (Pontardawe
/// RFC, an Xprinter 80mm.) The slip on the counter showed the heading of each
/// job and nothing after it: the printer had been handed the first few lines
/// and lost the rest, cut command included. The transports are fixed for that
/// (printer_transport.dart). This file is the other half of the ask -- "more
/// printing options, but a default mode for easy operating":
///
///   * STANDARD, which every printer starts on and most never leave. It
///     follows the venue's own choices in the back office (Receipt Designer,
///     Paper and cutting), so one setting there reaches every till.
///   * CUSTOM, behind "Advanced" on one printer, for the printer that needs
///     something different: no cutter, a cutter that wants the feed-and-cut
///     command, a printer that drops data unless it is sent slowly.
library;

/// What the cutter does at the end of a document.
enum CutStyle {
  full('Full cut', 'Cuts the paper right through.'),
  partial('Partial cut', 'Leaves a small tab so the slip hangs until torn.'),
  none('No cut', 'For a printer with no cutter: tear it off by hand.');

  const CutStyle(this.label, this.blurb);
  final String label;
  final String blurb;

  static CutStyle parse(Object? v) =>
      values.where((c) => c.name == v).firstOrNull ?? CutStyle.full;
}

/// Which cut command is sent.
///
/// Both are standard ESC/POS. Most printers take either; a few clones only
/// cut on one of them, which is the whole reason this is a choice.
enum CutCommand {
  standard('Standard (GS V 0)'),
  feedAndCut('Feed and cut (GS V 65)');

  const CutCommand(this.label);
  final String label;

  static CutCommand parse(Object? v) =>
      values.where((c) => c.name == v).firstOrNull ?? CutCommand.standard;
}

/// What the venue chose in the back office, for every printer on Standard.
class VenuePrintDefaults {
  const VenuePrintDefaults({
    this.cut = CutStyle.full,
    this.feedLines = defaultFeedLines,
    this.kitchenBeep = false,
  });

  final CutStyle cut;
  final int feedLines;
  final bool kitchenBeep;

  /// Lines fed before the cut. Enough to carry the last printed line past the
  /// cutter blade on an 80mm or 58mm head.
  static const defaultFeedLines = 5;

  /// What the till uses until the back office has answered -- and when it
  /// never does. Exactly the standard a new printer gets.
  static VenuePrintDefaults current = const VenuePrintDefaults();

  factory VenuePrintDefaults.fromJson(Map<String, dynamic> j) =>
      VenuePrintDefaults(
        cut: CutStyle.parse(j['print_cut']),
        feedLines: clampFeed((j['print_feed_lines'] as num?)?.toInt()),
        kitchenBeep: j['kitchen_beep'] == 1 || j['kitchen_beep'] == true || j['kitchen_beep'] == '1',
      );
}

int clampFeed(int? n) =>
    (n ?? VenuePrintDefaults.defaultFeedLines).clamp(0, 12);

/// One printer's own settings. Null-free: [custom] decides whether they apply.
class PrintOptions {
  const PrintOptions({
    this.custom = false,
    this.cut = CutStyle.full,
    this.feedLines = VenuePrintDefaults.defaultFeedLines,
    this.cutCommand = CutCommand.standard,
    this.gentle = false,
    this.kitchenBeep = false,
    this.openDrawerPin = 0,
  });

  static const standard = PrintOptions();

  /// False is Standard: follow the venue. True is this printer's own choices.
  final bool custom;
  final CutStyle cut;
  final int feedLines;
  final CutCommand cutCommand;

  /// Send in small pieces with a short pause between them, for a printer that
  /// loses data when it is handed a whole document at once.
  final bool gentle;

  /// Beep when a kitchen ticket prints, on a printer with a buzzer.
  final bool kitchenBeep;

  /// Which drawer socket pin the cash drawer is on: 0 is pin 2 (almost every
  /// drawer), 1 is pin 5.
  final int openDrawerPin;

  /// What this printer actually does, with Standard resolved against the
  /// venue's choices.
  ResolvedPrint resolve([VenuePrintDefaults? venue]) {
    final v = venue ?? VenuePrintDefaults.current;
    return custom
        ? ResolvedPrint(
            cut: cut,
            feedLines: clampFeed(feedLines),
            cutCommand: cutCommand,
            gentle: gentle,
            kitchenBeep: kitchenBeep,
            openDrawerPin: openDrawerPin,
          )
        : ResolvedPrint(
            cut: v.cut,
            feedLines: v.feedLines,
            cutCommand: CutCommand.standard,
            gentle: false,
            kitchenBeep: v.kitchenBeep,
            openDrawerPin: 0,
          );
  }

  PrintOptions copyWith({
    bool? custom,
    CutStyle? cut,
    int? feedLines,
    CutCommand? cutCommand,
    bool? gentle,
    bool? kitchenBeep,
    int? openDrawerPin,
  }) => PrintOptions(
    custom: custom ?? this.custom,
    cut: cut ?? this.cut,
    feedLines: feedLines ?? this.feedLines,
    cutCommand: cutCommand ?? this.cutCommand,
    gentle: gentle ?? this.gentle,
    kitchenBeep: kitchenBeep ?? this.kitchenBeep,
    openDrawerPin: openDrawerPin ?? this.openDrawerPin,
  );

  Map<String, dynamic> toJson() => {
    'custom': custom,
    'cut': cut.name,
    'feed_lines': feedLines,
    'cut_command': cutCommand.name,
    'gentle': gentle,
    'kitchen_beep': kitchenBeep,
    'drawer_pin': openDrawerPin,
  };

  static PrintOptions fromJson(Object? raw) {
    if (raw is! Map) return standard;
    return PrintOptions(
      custom: raw['custom'] == true,
      cut: CutStyle.parse(raw['cut']),
      feedLines: clampFeed((raw['feed_lines'] as num?)?.toInt()),
      cutCommand: CutCommand.parse(raw['cut_command']),
      gentle: raw['gentle'] == true,
      kitchenBeep: raw['kitchen_beep'] == true,
      openDrawerPin: (raw['drawer_pin'] as num?)?.toInt() == 1 ? 1 : 0,
    );
  }
}

/// The settings a document is built and sent with.
class ResolvedPrint {
  const ResolvedPrint({
    required this.cut,
    required this.feedLines,
    required this.cutCommand,
    required this.gentle,
    required this.kitchenBeep,
    required this.openDrawerPin,
  });

  final CutStyle cut;
  final int feedLines;
  final CutCommand cutCommand;
  final bool gentle;
  final bool kitchenBeep;
  final int openDrawerPin;

  /// The end of every document: print what is buffered, feed it past the
  /// blade, cut.
  ///
  /// `ESC d n` rather than n line feeds: one command, and it prints anything
  /// still sitting in the line buffer first.
  List<int> finish() {
    final bytes = <int>[0x1B, 0x64, feedLines];
    switch (cut) {
      case CutStyle.none:
        break;
      case CutStyle.full:
        bytes.addAll(cutCommand == CutCommand.feedAndCut
            ? const [0x1D, 0x56, 65, 0]
            : const [0x1D, 0x56, 0]);
      case CutStyle.partial:
        bytes.addAll(cutCommand == CutCommand.feedAndCut
            ? const [0x1D, 0x56, 66, 0]
            : const [0x1D, 0x56, 1]);
    }
    return bytes;
  }

  /// Two short beeps, `ESC B n t`, on a printer with a buzzer. A printer
  /// without one ignores it.
  List<int> beep() => const [0x1B, 0x42, 2, 2];
}
