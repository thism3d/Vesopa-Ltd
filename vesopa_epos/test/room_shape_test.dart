/// The shape of a room, from the back office to the till.
///
/// The venue walks the corners of its own room in the designer and the till
/// draws what they walked. Between those two there are three places the shape
/// can quietly be lost, and losing it is silent every time — the plan still
/// renders, as the plain rectangle every room used to be, and nothing anywhere
/// reports a problem.
///
///   * over the wire the outline is JSON *text*, because the back office hands
///     back the database column untouched;
///   * out of this app's own cache it is an already-decoded List;
///   * and a room saved before shapes existed has no outline at all.
///
/// All three have to end up as the same thing, and anything unreadable has to
/// become a rectangle rather than an exception: a till that will not open its
/// floor screen is worse than a till that draws the room as a box.
library;

import 'dart:convert';
import 'dart:ui' show PictureRecorder;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/floor_repository.dart';
import 'package:vesopa_epos/ui/room_walls.dart';

/// An L: along the top, down the right, in to the notch, and back.
const _l = [
  [0, 0],
  [16, 0],
  [16, 5],
  [8, 5],
  [8, 10],
  [0, 10],
];

Map<String, dynamic> _room(Object? outline, {Map<String, dynamic>? extra}) => {
      'id': 2,
      'name': 'Main Floor',
      'tables': const [
        {
          'table_number': 1,
          'pos_x': 1,
          'pos_y': 1,
          'width': 2,
          'height': 2,
          'shape': 'rect',
          'seats': 4,
        },
      ],
      'outline': ?outline,
      ...?extra,
    };

void main() {
  group('the shape as it arrives', () {
    test('reads the JSON text the back office sends', () {
      // The column is TEXT and the route hands it straight back, so this is
      // what a real response looks like.
      final room = FloorRoom.fromJson(_room(jsonEncode(_l)));
      expect(room.outline, _l);
    });

    test('reads the list its own cache gives back', () {
      final room = FloorRoom.fromJson(_room(_l));
      expect(room.outline, _l);
    });

    test('a room saved before shapes existed is a rectangle', () {
      expect(FloorRoom.fromJson(_room(null)).outline, isNull);
    });

    test('an outline stored as null is a rectangle', () {
      expect(FloorRoom.fromJson(_room(null, extra: {'outline': null})).outline,
          isNull);
    });

    test('two corners is a line, not a room', () {
      // Refused rather than drawn: a two-point polygon paints a hairline across
      // the floor and reads as a fault in the screen.
      expect(FloorRoom.fromJson(_room(jsonEncode([[0, 0], [4, 4]]))).outline,
          isNull);
    });

    test('a shape that will not parse does not stop the floor screen', () {
      // Truncated text, a point that is not a pair, a point that is not a
      // number. Every one of these is a rectangle and none of them throws.
      for (final bad in <Object>[
        '[[0,0],[4,0],',
        jsonEncode([[0, 0], [4, 0], [4]]),
        jsonEncode([[0, 0], [4, 0], ['x', 'y']]),
        jsonEncode({'not': 'a list'}),
        42,
      ]) {
        expect(
          () => FloorRoom.fromJson(_room(bad)),
          returnsNormally,
          reason: 'threw on $bad',
        );
        expect(FloorRoom.fromJson(_room(bad)).outline, isNull,
            reason: 'accepted $bad');
      }
    });

    test('a shape survives being cached and read back', () {
      // The plan is written to local storage on every successful fetch so the
      // till still shows the right room when the wifi drops. A shape that does
      // not survive that round trip is a shape that vanishes exactly when it
      // is most needed.
      final sent = FloorRoom.fromJson(_room(jsonEncode(_l), extra: {
        'floor_colour': '#F4F5F1',
        'wall_colour': '#8A8F98',
      }));
      final cached = FloorRoom.fromJson(
        jsonDecode(jsonEncode(sent.toJson())) as Map<String, dynamic>,
      );
      expect(cached.outline, _l);
      expect(cached.floorColour, '#F4F5F1');
      expect(cached.wallColour, '#8A8F98');
      expect(cached.tables.single.number, 1);
    });
  });

  group('the colours', () {
    test('a colour the picker wrote is read', () {
      expect(colourOf('#A5C715'), const Color(0xFFA5C715));
      expect(colourOf('#000000'), const Color(0xFF000000));
    });

    test('anything that is not one is the theme\'s own', () {
      // Null rather than a guess. These are validated on the way into the
      // database, so a value that does not look like a colour came from
      // somewhere else — and a colour nobody chose is worse than the default.
      for (final bad in <String?>[
        null,
        '',
        'red',
        'A5C715',
        '#A5C71',
        '#A5C7155',
        '#GGGGGG',
        'rgb(1,2,3)',
      ]) {
        expect(colourOf(bad), isNull, reason: 'accepted $bad');
      }
    });

    test('a table carries its own colour, and keeps it through the cache', () {
      final table = FloorTable.fromJson(const {
        'table_number': 7,
        'pos_x': 0,
        'pos_y': 0,
        'width': 2,
        'height': 2,
        'shape': 'circle',
        'seats': 2,
        'colour': '#123ABC',
      });
      expect(table.colour, '#123ABC');
      expect(FloorTable.fromJson(table.toJson()).colour, '#123ABC');
    });

    test('a table with no colour of its own says so', () {
      final table = FloorTable.fromJson(const {
        'table_number': 7,
        'pos_x': 0,
        'pos_y': 0,
        'width': 2,
        'height': 2,
        'shape': 'rect',
        'seats': 2,
      });
      expect(table.colour, isNull);
      // And does not invent one on the way into the cache, which would make
      // "no colour" impossible to store.
      expect(table.toJson().containsKey('colour'), isFalse);
    });
  });

  group('drawing the walls', () {
    test('repaints when the room changes shape', () {
      const a = WallsPainter(
        outline: _l,
        unit: 40,
        floor: Color(0xFFEEEEEE),
        wall: Color(0xFF888888),
      );
      const same = WallsPainter(
        outline: _l,
        unit: 40,
        floor: Color(0xFFEEEEEE),
        wall: Color(0xFF888888),
      );
      const moved = WallsPainter(
        outline: [
          [0, 0],
          [16, 0],
          [16, 6],
          [8, 6],
          [8, 10],
          [0, 10],
        ],
        unit: 40,
        floor: Color(0xFFEEEEEE),
        wall: Color(0xFF888888),
      );

      // The plan is rebuilt from JSON on every poll, so the lists are always
      // different objects and almost always the same shape. Comparing by
      // identity would repaint the floor several times a minute for nothing;
      // not comparing the points at all would miss a wall being moved.
      expect(a.shouldRepaint(same), isFalse);
      expect(a.shouldRepaint(moved), isTrue);
    });

    test('repaints when the plan is rescaled or recoloured', () {
      const a = WallsPainter(
        outline: _l,
        unit: 40,
        floor: Color(0xFFEEEEEE),
        wall: Color(0xFF888888),
      );
      expect(
        a.shouldRepaint(const WallsPainter(
          outline: _l,
          unit: 26,
          floor: Color(0xFFEEEEEE),
          wall: Color(0xFF888888),
        )),
        isTrue,
        reason: 'a rescaled plan must be redrawn at the new size',
      );
      expect(
        a.shouldRepaint(const WallsPainter(
          outline: _l,
          unit: 40,
          floor: Color(0xFF102030),
          wall: Color(0xFF888888),
        )),
        isTrue,
      );
    });

    test('an L is painted as an L, with the notch left empty', () async {
      // The strongest thing that can be asserted about a painter without a
      // golden file, and the thing that actually matters: the floor is drawn
      // where the room is and nowhere else. A polygon that filled its own
      // bounding box would pass every other test in this file and would draw
      // the notch of an L as part of the room — which on a till is a member of
      // staff being sent to a table that is on the other side of a wall.
      const unit = 4.0;   // 16x10 grid squares into a 64x40 image
      final recorder = PictureRecorder();
      const WallsPainter(
        outline: _l,
        unit: unit,
        floor: Color(0xFFFFFFFF),
        wall: Color(0xFFFFFFFF),
      ).paint(Canvas(recorder), const Size(64, 40));
      final image = await recorder.endRecording().toImage(64, 40);
      final data = (await image.toByteData())!.buffer.asUint8List();

      int alphaAt(int x, int y) => data[(y * 64 + x) * 4 + 3];

      // Well inside the top limb, and well inside the left limb.
      expect(alphaAt(20, 8), greaterThan(200), reason: 'the top of the L is empty');
      expect(alphaAt(12, 32), greaterThan(200), reason: 'the left of the L is empty');

      // The notch — bottom right, past the step at (8,5) — is outside the room.
      expect(alphaAt(52, 34), lessThan(40), reason: 'the notch was filled in');

      // And so is the world beyond the far corner.
      expect(alphaAt(63, 39), lessThan(40), reason: 'paint escaped the room');
    });

    test('a shape too small to be a room paints nothing at all', () async {
      // Rather than a hairline across the floor, which reads as a fault in the
      // screen rather than as a room nobody finished drawing.
      final recorder = PictureRecorder();
      const WallsPainter(
        outline: [
          [0, 0],
          [4, 4],
        ],
        unit: 40,
        floor: Color(0xFFEEEEEE),
        wall: Color(0xFF888888),
      ).paint(Canvas(recorder), const Size(400, 400));
      final picture = recorder.endRecording();
      final image = await picture.toImage(40, 40);
      final data = await image.toByteData();
      expect(
        data!.buffer.asUint8List().every((byte) => byte == 0),
        isTrue,
        reason: 'something was drawn for a two-point outline',
      );
    });
  });
}
