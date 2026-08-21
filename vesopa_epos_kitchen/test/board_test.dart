import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos_kitchen/config/constants.dart';
import 'package:vesopa_epos_kitchen/data/kitchen_api.dart';
import 'package:vesopa_epos_kitchen/data/screen_profile.dart';
import 'package:vesopa_epos_kitchen/data/ticket.dart';
import 'package:vesopa_epos_kitchen/data/ticket_board.dart';

/// The board, against JSON the real server actually sent.
///
/// The fixtures in `test/fixtures/` are not hand-written: they were captured
/// from a running `vesopa_server` talking to a real MySQL, by
/// `vesopa_server/test/capture-fixtures.js` — because the seam most likely to
/// be wrong is the one
/// between the server's JSON and these models, and neither side's own tests
/// cross it. A `TINYINT(1)` arriving as `1` rather than `true`, a `DOUBLE`
/// arriving as `2.5`, a `DATETIME` arriving as a UTC string: all of them are
/// invisible to a test that builds its own input.
void main() {
  late BoardSnapshot board;
  late KitchenProfile profile;

  /// The grill screen: watches kp1 only.
  late ScreenProfile grill;

  /// The pass: watches everything, which is also the single-screen case.
  late ScreenProfile pass;

  // The three tickets the capture planted:
  //
  //   7C41A9  open at both stations, rushed, has a modifier and an order note
  //   B2D3E4  grill done, fryer still going  ← the partly-bumped case
  //   F5A6B7  done everywhere
  Ticket byNo(String ticketNo) =>
      board.tickets.firstWhere((t) => t.ticketNo == ticketNo);

  BoardState state() => BoardState(tickets: board.tickets, online: true);

  setUpAll(() {
    board = BoardSnapshot.fromJson(_fixture('board.json'));
    profile = KitchenProfile.fromJson(_fixture('profile.json'));

    ScreenProfile named(String name) =>
        profile.screens.firstWhere((s) => s.name == name).normalised();

    grill = named('Grill');
    pass = named('Pass');
  });

  group('parsing what the server really sends', () {
    test('a ticket keeps everything the card draws', () {
      final t = byNo('7C41A9');

      expect(t.tableNumber, 4);
      expect(t.roomName, 'Lounge');
      expect(t.staffName, 'sophie');
      expect(t.covers, 2);
      expect(t.note, 'allergy: nuts');
      expect(t.kind, TicketKind.table);
      expect(t.rushed, isTrue);
      expect(t.destination, 'Table #4');
    });

    test('lines keep their order, their modifier and their stations', () {
      final lines = byNo('7C41A9').lines;

      expect(lines.map((l) => l.name), [
        'Crispy Chicken Burger',
        'Kids Breakfast',
        'Chips',
      ]);
      expect(lines[0].note, 'no tomato, no garlic');
      // `null` from the database, not the string "null" — the card decides
      // whether to draw a red line on exactly this.
      expect(lines[1].note, isNull);
      expect(lines[2].stations, {'kp3'});
    });

    test('a fractional quantity survives, and reads as one', () {
      // 2.5 kg of chips is a real thing a scale-priced product produces, and
      // "2.5" must not become "2" or "3".
      final chips = byNo('7C41A9').lines.last;
      expect(chips.quantity, 2.5);
      expect(chips.quantityLabel, '2.5');

      // …while a whole number must not read as "1.0" — a ticket saying
      // `1.0x Chips` looks like a fault.
      expect(byNo('7C41A9').lines.first.quantityLabel, '1');
    });

    test('placedAt is the till\'s time, brought into local time', () {
      final t = byNo('7C41A9');
      expect(t.placedAt.isUtc, isFalse, reason: 'a chef reads a wall clock');
      // The capture planted it 400 seconds before it ran.
      final age = board.serverTime.difference(t.placedAt);
      expect(age.inSeconds, greaterThan(300));
      expect(age.inSeconds, lessThan(600));
    });

    test('a MySQL TINYINT(1) of 1 is read as a switch being on', () {
      // `sound` comes back as the number 1, not `true`. Read naively it would
      // still be truthy in JavaScript and is not in Dart — this is exactly the
      // shape of bug that only shows up against a real database.
      expect(grill.sound, isTrue);
    });

    test('screen thresholds come through, and are clamped sanely', () {
      expect(grill.stations, {'kp1'});
      expect(grill.warn, const Duration(minutes: 5));
      expect(grill.late, const Duration(minutes: 10));
      expect(grill.recallWindow, const Duration(minutes: 45));

      // An unconfigured stations list means every station, which is what a
      // one-screen kitchen wants without ticking six boxes.
      expect(pass.stations, isEmpty);
      expect(pass.columns, 3);
    });

    test('the venue\'s station names win over the slot numbers', () {
      expect(profile.labelFor('kp1'), 'Grill');
      expect(profile.labelFor('kp3'), 'Fryer');
      // Unnamed falls back to the built-in label rather than vanishing.
      expect(profile.labelFor('kp5'), 'KP 5');
    });

    test('the built-in all-stations board is always on offer', () {
      expect(profile.choices.last.isBuiltIn, isTrue);
      expect(profile.choices.last.stations, isEmpty);
    });
  });

  group('what each board sees', () {
    test('the grill draws only its own lines', () {
      final lines = byNo('7C41A9').linesFor(grill.stations);
      expect(lines.map((l) => l.name), [
        'Crispy Chicken Burger',
        'Kids Breakfast',
      ]);
      // The chips went to the fryer and are not the grill's problem.
      expect(lines.any((l) => l.name == 'Chips'), isFalse);
    });

    test('the pass draws the whole order', () {
      expect(byNo('7C41A9').linesFor(pass.stations).length, 3);
    });

    test('rushed sorts ahead of older', () {
      final open = state().open(pass);
      // F5A6B7 is the oldest but is finished; of the two live ones, B2D3E4 is
      // newer than 7C41A9 — which is rushed and must still come first.
      expect(open.first.ticketNo, '7C41A9');
      expect(open.first.rushed, isTrue);
    });

    test('a completed order is off the open board', () {
      expect(
        state().open(pass).map((t) => t.ticketNo),
        isNot(contains('F5A6B7')),
      );
      expect(
        state().completed(pass).map((t) => t.ticketNo),
        contains('F5A6B7'),
      );
    });
  });

  group('a half-bumped order', () {
    // The bug this group exists for: the grill has finished B2D3E4 and the
    // fryer has not. Read as a whole the ticket is neither open nor complete,
    // and the grill's card fell out of *both* tabs — off their screen entirely,
    // un-recallable, while the fryer worked.

    test('the grill sees it as finished', () {
      final t = byNo('B2D3E4');
      expect(t.isOpenFor(grill.stations), isFalse);
      expect(t.completedAtFor(grill.stations), isNotNull);
      expect(
        state().completed(grill).map((t) => t.ticketNo),
        contains('B2D3E4'),
        reason: 'it must be recallable from the screen that finished it',
      );
    });

    test('the pass still sees it as outstanding', () {
      final t = byNo('B2D3E4');
      expect(t.isOpenFor(pass.stations), isTrue);
      expect(t.isComplete, isFalse);
      expect(
        state().open(pass).map((t) => t.ticketNo),
        contains('B2D3E4'),
      );
    });

    test('it reports which station is still working', () {
      final t = byNo('B2D3E4');
      expect(t.isPartlyDone, isTrue);
      expect(t.outstanding, {'kp3'});
      expect(
        t.outstanding.map(profile.labelFor).join(', '),
        'Fryer',
        reason: 'the card says "Still with Fryer", not "Still with kp3"',
      );
    });

    test('who bumped it is recorded', () {
      final kp1 = byNo('B2D3E4').stations.firstWhere((s) => s.station == 'kp1');
      expect(kp1.done, isTrue);
      expect(kp1.doneBy, 'Grill screen');
      expect(kp1.doneAt, isNotNull);
    });

    test('bumping on the grill closes the grill and nothing else', () {
      final t = byNo('7C41A9');
      final bumped = t.bumped(t.stationsFor(grill.stations), by: 'Grill screen');

      expect(bumped.stations.firstWhere((s) => s.station == 'kp1').done, isTrue);
      expect(bumped.stations.firstWhere((s) => s.station == 'kp3').done, isFalse);
      expect(bumped.isOpenFor(grill.stations), isFalse);
      expect(bumped.isOpenFor(pass.stations), isTrue);
    });

    test('a single-screen kitchen\'s tick closes everything', () {
      final t = byNo('7C41A9');
      final bumped = t.bumped(t.stationsFor(pass.stations));
      expect(bumped.isComplete, isTrue);
    });

    test('recall re-opens every station, whoever asked', () {
      final recalled = byNo('B2D3E4').recalled();
      expect(recalled.stations.every((s) => !s.done), isTrue);
      expect(recalled.stations.every((s) => s.doneAt == null), isTrue);
    });
  });

  group('counts', () {
    test('the same dish across two orders is one row', () {
      // Three Crispy Chicken Burgers on B2D3E4 are outstanding for the pass;
      // the one on 7C41A9 carries a modifier and is therefore a different job.
      final rows = state().counts(pass);

      final plain = rows.firstWhere(
        (r) => r.name == 'Crispy Chicken Burger' && r.note == null,
      );
      expect(plain.quantity, 3);

      final modified = rows.firstWhere(
        (r) => r.name == 'Crispy Chicken Burger' && r.note != null,
      );
      expect(modified.note, 'no tomato, no garlic');
      expect(modified.quantity, 1);
    });

    test('most of a thing first', () {
      final rows = state().counts(pass);
      for (var i = 1; i < rows.length; i++) {
        expect(
          rows[i - 1].quantity >= rows[i].quantity,
          isTrue,
          reason: 'a chef reading this is deciding what to batch',
        );
      }
    });

    test('a finished order contributes nothing to prep', () {
      // F5A6B7's soup is cooked and gone.
      expect(
        state().counts(pass).any((r) => r.name == 'Soup'),
        isFalse,
      );
    });

    test('the grill counts only its own stations', () {
      final rows = state().counts(grill);
      expect(rows.any((r) => r.name == 'Chips'), isFalse, reason: 'fryer');
      expect(rows.any((r) => r.name == 'Onion Rings'), isFalse, reason: 'fryer');
      expect(rows.any((r) => r.name == 'Crispy Chicken Burger'), isTrue);
    });
  });

  group('ageing', () {
    test('a ticket crosses amber and then red', () {
      final placed = DateTime.now();
      Duration since(int seconds) => Duration(seconds: seconds);

      expect(TicketAge.of(since(60), grill), TicketAge.fresh);
      expect(TicketAge.of(since(299), grill), TicketAge.fresh);
      expect(TicketAge.of(since(300), grill), TicketAge.warn);
      expect(TicketAge.of(since(599), grill), TicketAge.warn);
      expect(TicketAge.of(since(600), grill), TicketAge.late);
      expect(placed, isNotNull);
    });

    test('a profile whose red arrives before its amber is corrected', () {
      // A bad row must not produce a board that is entirely one colour, which
      // is a board with no information on it.
      const broken = ScreenProfile(
        id: 1,
        name: 'Broken',
        warn: Duration(minutes: 10),
        late: Duration(minutes: 2),
      );
      expect(broken.normalised().late, greaterThan(broken.warn));
    });
  });

  group('the offline cache', () {
    test('a board round-trips through JSON unchanged', () {
      // This is the path a screen takes when it boots with no network: the last
      // board it drew is written to preferences and read back. A field lost
      // here is a card that comes back wrong after a power cut.
      final original = byNo('7C41A9');
      final restored = Ticket.fromJson(
        jsonDecode(jsonEncode(original.toJson())) as Map<String, dynamic>,
      );

      expect(restored.id, original.id);
      expect(restored.ticketNo, original.ticketNo);
      expect(restored.kind, original.kind);
      expect(restored.tableNumber, original.tableNumber);
      expect(restored.roomName, original.roomName);
      expect(restored.staffName, original.staffName);
      expect(restored.covers, original.covers);
      expect(restored.note, original.note);
      expect(restored.rushed, original.rushed);
      expect(
        restored.placedAt.toUtc(),
        original.placedAt.toUtc(),
        reason: 'the elapsed clock depends on this surviving',
      );
      expect(restored.lines.length, original.lines.length);
      expect(restored.lines.first.note, original.lines.first.note);
      expect(restored.lines.last.quantity, 2.5);
      expect(restored.lines.last.stations, {'kp3'});
    });

    test('a half-bumped ticket round-trips with its stamps', () {
      final original = byNo('B2D3E4');
      final restored = Ticket.fromJson(
        jsonDecode(jsonEncode(original.toJson())) as Map<String, dynamic>,
      );

      final kp1 = restored.stations.firstWhere((s) => s.station == 'kp1');
      expect(kp1.done, isTrue);
      expect(kp1.doneBy, 'Grill screen');
      expect(kp1.doneAt, isNotNull);
      expect(restored.isPartlyDone, isTrue);
    });
  });

  group('the clock', () {
    test('ages are measured against the server, not this machine', () {
      // A wall-mounted panel that has been unplugged for a fortnight comes back
      // at some arbitrary time. Without the correction every elapsed figure is
      // wrong in a way that looks authoritative.
      final wrongByAnHour = BoardState(
        tickets: board.tickets,
        clockSkew: const Duration(hours: -1),
      );
      final gap = DateTime.now().difference(wrongByAnHour.now);
      expect(gap.inMinutes, closeTo(60, 1));
    });
  });

  group('defaults', () {
    test('a venue with no screens still gets a working board', () {
      const built = ScreenProfile.allStations;
      expect(built.stations, isEmpty);
      expect(built.watches('kp4'), isTrue);
      expect(built.warn, BoardDefaults.warn);
      expect(built.recallWindow, BoardDefaults.recallWindow);
    });
  });
}

/// Reads a fixture captured from the real server.
Map<String, dynamic> _fixture(String name) {
  final file = File('test/fixtures/$name');
  if (!file.existsSync()) {
    fail(
      'Missing $name. Fixtures are captured from a running server: see '
      'vesopa_server/test/capture-fixtures.js.',
    );
  }
  return jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
}
