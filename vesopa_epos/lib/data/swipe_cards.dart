/// Cards at the counter: what one looks like, and how the till hears one.
///
/// THREE READERS, ONE KEYBOARD
///
/// A magnetic stripe reader, a barcode/QR scanner and a USB tag reader are all,
/// as far as Windows is concerned, keyboards. None of them is a device this
/// application opens, polls or configures. They are plugged into a USB port and
/// they *type* — which is why there is no driver in this file, and why one state
/// machine reads all three.
///
/// What differs is the framing:
///
///   * a **stripe** arrives wrapped in sentinels — `;999800001?` — which gives
///     it away on the very first character;
///   * a **scan** (a QR on a customer's phone, a printed barcode, an NFC tag
///     read by a wedge reader) arrives as a bare run of digits and a Return,
///     with nothing to announce it but its speed.
///
/// Both end in the same place: a number, classified by its prefix, routed to a
/// member of staff, a member, or a gift card. A wallet pass on a phone and a
/// piece of plastic are the same card as far as the till is concerned, which is
/// the whole point of the pass's barcode carrying the card number.
///
/// WHAT A READER ACTUALLY DOES
///
/// A magnetic stripe reader on a till counter is a **keyboard**. It is not a
/// device the application opens, polls or configures; it is plugged into a USB
/// port, Windows sees a keyboard, and when somebody swipes a card it *types*:
///
///     ;999800001?
///
/// A start sentinel, the digits off the stripe, an end sentinel — ISO 7811
/// track 2, typed in about eighty milliseconds. Some readers add a Return.
/// Track 1 readers lead with `%` and sometimes a format code, and a card
/// programmed for a bank carries a `=` with expiry data after it. None of that
/// is the card's number.
///
/// So there is no driver here and there is nothing to connect. There is a
/// listener on the keyboard and a small state machine that can tell a swipe from
/// somebody typing, which is the whole of the problem.
///
/// WHY THE KEYSTROKES MUST BE SWALLOWED
///
/// The reader types into whatever has focus. A card swiped while the discount
/// dialog is open would otherwise put `999800001` in the amount box and press
/// Return — which is a discount of nine hundred and ninety-nine thousand
/// pounds, entered by a customer holding out a loyalty card. So once a swipe is
/// under way every keystroke in it is consumed, and nothing downstream sees it.
///
/// THE COST OF THAT, SAID PLAINLY
///
/// A `;` typed by a person is swallowed too, along with whatever follows it for
/// the next fraction of a second. That is an acceptable trade at a till — `;`
/// is not a character anybody enters into a price, a quantity or a PIN — and it
/// is bounded: [SwipeBuffer] gives up on the first character that could not be
/// on a card, and gives up anyway after [_maxSwipe]. It is not open-ended.
library;

import 'package:flutter/foundation.dart';

/// The programmes a venue can run on one reader.
///
/// The prefix on the front of the number is what tells them apart, before
/// anything is looked up — see [CardSettings.classify].
///
/// These are the same four the wallet passes are cut for, so a customer with a
/// pass on their phone and a customer with a piece of plastic are the same
/// customer to this till. (The fifth pass, a promotional offer, has no prefix
/// here on purpose: an offer is not a card that identifies anybody, so there is
/// nothing for a swipe to look up.)
enum CardKind {
  /// Signs a member of staff on. Checked against the till's own cached staff
  /// list, so it works with the broadband down.
  clerk,

  /// Puts a member on the bill, or offers to enrol whoever is holding it.
  loyalty,

  /// A gift card: balance, and paying with it.
  gift,

  /// A membership, which is a different question from loyalty and always has
  /// been: loyalty is points earned, membership is a subscription with a date
  /// on it. A venue can run either, both, or neither — `epos_customers` has
  /// carried `points_balance` and `membership_expiry` side by side since long
  /// before there was a card to read them with.
  membership,
}

/// What each prefix means in this venue.
///
/// Held in the back office and synced to every till, because cards are
/// programmed once for the venue and carried around in customers' wallets. Two
/// tills that disagreed about what 9998 means would be two tills where the same
/// card does different things depending on which end of the bar somebody is
/// standing at.
@immutable
class CardSettings {
  const CardSettings({
    this.enabled = true,
    this.clerkPrefix = '9999',
    this.loyaltyPrefix = '9998',
    this.giftPrefix = '9878',
    this.membershipPrefix = '',
    this.numberDigits = 5,
    this.autoEnrol = true,
  });

  /// Whether the till listens to the reader at all.
  final bool enabled;

  /// The venue's live numbers. These defaults are not invented: they are what
  /// this venue programmes its cards with today, copied from the system they
  /// are moving off so that every card already in a wallet keeps working.
  ///
  /// Their old system also had a Dallas Key prefix; they do not use it and
  /// asked for it to be left out, so there is no field for it.
  final String clerkPrefix;
  final String loyaltyPrefix;
  final String giftPrefix;

  /// Empty by default, and that is the honest default rather than a gap.
  ///
  /// The venue's current system has three prefixes and no fourth, so switching
  /// a membership programme on for them would be inventing a scheme they have
  /// not asked for and cannot have cards for. A venue that wants one sets a
  /// prefix, and until then an empty prefix matches nothing — see [classify].
  final String membershipPrefix;

  /// How wide the number after the prefix is when this venue *issues* a card.
  ///
  /// Only used for writing. Reading accepts whatever width is on the card,
  /// because the cards already in circulation were not necessarily made here.
  final int numberDigits;

  /// Whether swiping an unknown loyalty card offers to enrol the person holding
  /// it. The venue's own request, and a switch because a venue that issues
  /// cards only from the back office wants the till to say "not a member"
  /// rather than open a form at the counter.
  final bool autoEnrol;

  /// The prefix for [kind], or empty where the venue does not run it.
  String prefixFor(CardKind kind) => switch (kind) {
    CardKind.clerk => clerkPrefix,
    CardKind.loyalty => loyaltyPrefix,
    CardKind.gift => giftPrefix,
    CardKind.membership => membershipPrefix,
  };

  /// Which programme [number] belongs to, or null for a card from somewhere
  /// else entirely.
  ///
  /// Longest prefix wins, so a venue that has configured 9998 for loyalty and
  /// 99980 for something else gets the more specific answer rather than
  /// whichever was compared first.
  ///
  /// An empty prefix never matches. Without that guard `startsWith('')` would
  /// make every card in the building — hotel keys, other shops' loyalty cards,
  /// bank cards — a member of whichever programme the venue had switched off.
  CardKind? classify(String number) {
    if (number.isEmpty) return null;

    CardKind? best;
    var bestLength = 0;
    for (final kind in CardKind.values) {
      final prefix = prefixFor(kind);
      if (prefix.isEmpty || !number.startsWith(prefix)) continue;
      if (prefix.length > bestLength) {
        best = kind;
        bestLength = prefix.length;
      }
    }
    return best;
  }

  /// The card number for member [number] of [kind] — the string that goes on
  /// the stripe and into the database.
  ///
  /// Prefix included and sentinels excluded, which is the rule everywhere this
  /// number is stored: the sentinels belong to the reader, not to the card, and
  /// the same number has to work on a stripe, in a QR code and on a phone.
  String numberFor(CardKind kind, int number) {
    final prefix = prefixFor(kind);
    final width = numberDigits.clamp(4, 12);
    return '$prefix${number.toString().padLeft(width, '0')}';
  }

  /// What to hand an encoder: the full track, sentinels and all.
  ///
  /// This is the one place they are added back, because this is the one place
  /// the output is a *stripe* rather than a record of a number.
  static String trackFor(String cardNumber) => ';$cardNumber?';

  CardSettings copyWith({
    bool? enabled,
    String? clerkPrefix,
    String? loyaltyPrefix,
    String? giftPrefix,
    String? membershipPrefix,
    int? numberDigits,
    bool? autoEnrol,
  }) => CardSettings(
    enabled: enabled ?? this.enabled,
    clerkPrefix: clerkPrefix ?? this.clerkPrefix,
    loyaltyPrefix: loyaltyPrefix ?? this.loyaltyPrefix,
    giftPrefix: giftPrefix ?? this.giftPrefix,
    membershipPrefix: membershipPrefix ?? this.membershipPrefix,
    numberDigits: numberDigits ?? this.numberDigits,
    autoEnrol: autoEnrol ?? this.autoEnrol,
  );

  Map<String, Object?> toJson() => {
    'enabled': enabled ? 1 : 0,
    'clerk_prefix': clerkPrefix,
    'loyalty_prefix': loyaltyPrefix,
    'gift_prefix': giftPrefix,
    'membership_prefix': membershipPrefix,
    'number_digits': numberDigits,
    'auto_enrol': autoEnrol ? 1 : 0,
  };

  /// Field by field, never throwing.
  ///
  /// A cast would: `raw['number_digits'] as int` on a string from a hand-edited
  /// row takes the whole settings object with it, and a till that fell back to
  /// "no prefixes" would quietly stop recognising every card in the venue.
  static CardSettings fromJson(Object? raw) {
    if (raw is! Map) return const CardSettings();

    String prefix(Object? value, String fallback) {
      if (value == null) return fallback;
      final digits = value.toString().replaceAll(RegExp(r'\D'), '');
      // An explicitly cleared prefix is an answer — "we do not run that
      // programme" — so an empty string is kept rather than replaced with the
      // default. Only an absent field falls back.
      return digits;
    }

    bool flag(Object? value, {required bool fallback}) => switch (value) {
      bool b => b,
      num n => n != 0,
      String s => s == '1' || s.toLowerCase() == 'true',
      _ => fallback,
    };

    return CardSettings(
      enabled: flag(raw['enabled'], fallback: true),
      clerkPrefix: prefix(raw['clerk_prefix'], '9999'),
      loyaltyPrefix: prefix(raw['loyalty_prefix'], '9998'),
      giftPrefix: prefix(raw['gift_prefix'], '9878'),
      membershipPrefix: prefix(raw['membership_prefix'], ''),
      numberDigits: switch (raw['number_digits']) {
        num n => n.toInt().clamp(4, 12),
        String s => (int.tryParse(s) ?? 5).clamp(4, 12),
        _ => 5,
      },
      autoEnrol: flag(raw['auto_enrol'], fallback: true),
    );
  }
}

/// A card that has just been swiped.
@immutable
class SwipedCard {
  const SwipedCard({
    required this.raw,
    required this.number,
    this.via = ReadVia.swipe,
  });

  /// Exactly what the reader typed, sentinels and all. Kept for the diagnostics
  /// screen: when a venue's cards are not being recognised, the first useful
  /// question is what the reader is actually sending, and an application that
  /// only ever shows its own interpretation cannot answer it.
  final String raw;

  /// The digits on the card: prefix and number, nothing else.
  final String number;

  /// Which reader it came from. See [ReadVia].
  final ReadVia via;

  @override
  String toString() => 'SwipedCard($number via ${via.name})';
}

/// What to do with the keystroke just offered to [SwipeBuffer].
enum SwipeVerdict {
  /// Not part of a swipe. Let it through to whatever has focus.
  ignore,

  /// Part of a swipe in progress. Swallow it — see the note at the top of this
  /// file for why that matters.
  consume,

  /// Ends a swipe. Swallow it, and read the card off [SwipeBuffer.card].
  complete,
}

/// How a card reached the till.
///
/// The till does the same thing with all three — the number is the number — but
/// it is worth being able to say which, because when a venue rings up to say
/// "cards have stopped working" the first useful question is whether the
/// stripe, the scanner or the tag reader is the one that has gone quiet.
enum ReadVia {
  /// A magnetic stripe reader, framed by sentinels.
  swipe,

  /// A barcode or QR scanner: a fast burst of characters and a Return. This is
  /// how a wallet pass on a customer's phone is read.
  scan,
}

/// Longest gap between two characters of one swipe.
///
/// A reader types a card in well under a tenth of a second. This is generous by
/// a factor of three, so that a machine busy repainting a sale screen does not
/// break a swipe in half — and still far shorter than any gap between two
/// characters a person types.
const _maxGap = Duration(milliseconds: 300);

/// Longest gap between two characters of a *scan*.
///
/// Far tighter than [_maxGap], and it has to be. Inside a swipe the sentinel has
/// already proved a machine is typing, so the gap rule only has to survive a
/// busy frame. A scan has no sentinel: the speed is the only evidence there is,
/// so the threshold has to sit below anything a person can do and above what
/// every scanner does.
///
/// Readers type at five to twenty milliseconds a character. A fast typist runs
/// at a hundred or so, and somebody drumming digits into a quantity box can beat
/// that in short bursts — which is exactly the case that must not be read as a
/// card. Fifty is comfortably between the two.
const _maxScanGap = Duration(milliseconds: 50);

/// Longest a whole swipe may take, however smooth the keystrokes are.
///
/// The backstop for the case the gap rule cannot catch: somebody typing steadily
/// at three characters a second after a stray `;`. Without it the till could
/// swallow keys indefinitely.
const _maxSwipe = Duration(seconds: 2);

/// Shortest card worth reporting.
///
/// Four digits is already shorter than any prefix this venue uses, so anything
/// below it cannot be one of their cards — and firing on two stray digits would
/// put "unknown card" in front of a clerk who had simply leaned on the keyboard.
const _minDigits = 4;

/// Longest card worth reading. A stripe holds far less than this; a stream this
/// long is a device that is not a card reader.
const _maxDigits = 64;

/// Turning keystrokes into cards.
///
/// A state machine over characters and the times they arrived, deliberately with
/// no Flutter in it: the whole of the interesting behaviour — where a swipe
/// starts, what breaks one, what ends one — is testable without synthesising key
/// events. [SwipeListener] is the thin part that binds it to the keyboard.
class SwipeBuffer {
  final _digits = StringBuffer();
  final _raw = StringBuffer();

  /// The digit that has gone through but might turn out to be the start of a
  /// scan, and when it arrived. See the scanner note in [offer].
  final _run = StringBuffer();
  DateTime? _runAt;

  ReadVia _via = ReadVia.swipe;

  /// Set when a read is abandoned part-way — a letter where a digit should be,
  /// or a stream longer than any card. Nothing is adopted while it is set.
  ///
  /// Without this, the *tail* of a rejected stream is itself a fast run of
  /// digits, so throwing a bad read away would immediately start a new one out
  /// of its own wreckage. It clears on the first real gap, which is a person or
  /// a machine starting again.
  bool _poisoned = false;

  DateTime? _startedAt;
  DateTime? _lastAt;

  /// Set with [SwipeVerdict.complete], and only then.
  SwipedCard? card;

  bool get isReading => _startedAt != null;

  /// Offer one keystroke.
  ///
  /// [character] is the printable character, or null for a key with none.
  /// [isEnter] marks Return or Enter, which some readers send instead of — or
  /// as well as — the end sentinel.
  SwipeVerdict offer(String? character, {required DateTime at, bool isEnter = false}) {
    card = null;

    // A swipe that has stalled is not a swipe. Dropped before this keystroke is
    // considered, so the character that arrives after a long pause is judged on
    // its own merits rather than being glued onto whatever came before it.
    if (_startedAt != null) {
      final since = at.difference(_lastAt ?? _startedAt!);
      final tooSlow = since > (_via == ReadVia.scan ? _maxScanGap : _maxGap);
      if (tooSlow || at.difference(_startedAt!) > _maxSwipe) {
        _reset();
      }
    }

    // A real gap clears a poisoned stream: whatever comes next is somebody, or
    // something, starting again.
    if (_poisoned && _runAt != null && at.difference(_runAt!) > _maxGap) {
      _poisoned = false;
    }

    if (_startedAt == null) {
      // A start sentinel opens a swipe, cleanly and with nothing leaked.
      if (character == ';' || character == '%') {
        _startedAt = at;
        _lastAt = at;
        _via = ReadVia.swipe;
        _raw.write(character);
        _run.clear();
        return SwipeVerdict.consume;
      }

      // A scanner has no sentinels. A barcode or QR reader — and the USB tag
      // readers sold for NFC, which are keyboards too — simply types the payload
      // and presses Return, so there is nothing to open on and the only thing
      // that distinguishes one from a person is the speed.
      //
      // So a run of digits arriving faster than anybody types is treated as a
      // scan from its *second* character. The second, not the first: the gap
      // before the first one is the gap from whatever the clerk was doing a
      // moment ago, which says nothing.
      //
      // WHAT THAT COSTS, SAID PLAINLY
      //
      // One character. If a card is scanned while a dialog with a text field is
      // open, the first digit reaches that field before this can tell a scan
      // from typing. A swipe never does, because the sentinel gives it away
      // immediately. Most scanners can be configured to send a prefix
      // character, and setting that prefix to `;` makes a scan exactly as clean
      // as a swipe — which is worth doing on a counter where the scanner is
      // used mid-sale, and worth nothing on one where it is not.
      if (character != null && _isDigit(character)) {
        final previous = _runAt;
        _runAt = at;
        if (_poisoned) return SwipeVerdict.ignore;

        if (previous != null && at.difference(previous) <= _maxScanGap) {
          // Fast enough to be a machine. Adopt what was collected — including
          // the character that already went through — and carry on.
          _startedAt = previous;
          _lastAt = at;
          _via = ReadVia.scan;
          _raw
            ..clear()
            ..write(_run)
            ..write(character);
          _digits
            ..clear()
            ..write(_run)
            ..write(character);
          _run.clear();
          return SwipeVerdict.consume;
        }

        // The first digit of a possible run. Held so it can be adopted if a
        // second one arrives quickly, and handed straight through meanwhile.
        _run
          ..clear()
          ..write(character);
        return SwipeVerdict.ignore;
      }

      // Anything else ends whatever run was building.
      _run.clear();
      _runAt = null;
      return SwipeVerdict.ignore;
    }

    _lastAt = at;

    // The end sentinel, or a Return from a reader that sends one.
    if (character == '?' || isEnter) {
      if (character != null) _raw.write(character);
      final digits = _digits.toString();
      final raw = _raw.toString();
      final via = _via;
      _reset();

      if (digits.length < _minDigits) return SwipeVerdict.ignore;
      card = SwipedCard(raw: raw, number: digits, via: via);
      return SwipeVerdict.complete;
    }

    if (character == null) {
      // A modifier, an arrow, a function key. Not on a card, and not a reason
      // to throw away a swipe that is halfway through — a reader that sends a
      // shift with its digits is a real thing.
      return SwipeVerdict.consume;
    }

    _raw.write(character);

    // Track structure rather than card data. `=` and `^` separate the number
    // from the expiry and name fields, and **everything after one is service
    // data** — including the digits, which is why this is tested before the
    // digit branch below rather than after it. A bank card's expiry appended to
    // its PAN would be a card number that matches nothing and a member who
    // cannot be found.
    if (character == '=' || character == '^') {
      _separatorSeen = true;
      return SwipeVerdict.consume;
    }
    if (_separatorSeen) {
      // Consumed so it does not land in a text field, and dropped so it does
      // not land in the number.
      return SwipeVerdict.consume;
    }

    if (_isDigit(character)) {
      if (_digits.length >= _maxDigits) {
        _abandon(at);
        return SwipeVerdict.ignore;
      }
      _digits.write(character);
      return SwipeVerdict.consume;
    }

    // Track 1's format code, which sits between the `%` and the number.
    if (character == 'B' || character == 'b') {
      return SwipeVerdict.consume;
    }

    // Something that cannot be on a card in the position it turned up. This was
    // not a swipe: give up, and let the character through so that whoever typed
    // it gets it.
    _abandon(at);
    return SwipeVerdict.ignore;
  }

  /// Throw a part-read away and refuse to start another out of its remains.
  void _abandon(DateTime at) {
    _reset();
    _poisoned = true;
    _runAt = at;
  }

  /// Whether a field separator has gone past. See the note in [offer].
  bool _separatorSeen = false;

  void _reset() {
    _digits.clear();
    _raw.clear();
    _run.clear();
    _runAt = null;
    _poisoned = false;
    _via = ReadVia.swipe;
    _startedAt = null;
    _lastAt = null;
    _separatorSeen = false;
  }

  static bool _isDigit(String character) =>
      character.length == 1 &&
      character.codeUnitAt(0) >= 0x30 &&
      character.codeUnitAt(0) <= 0x39;
}
