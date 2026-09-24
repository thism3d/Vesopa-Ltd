// The shape of a room, drawn under its tables.
//
// WHY THE TILL CARES WHAT SHAPE THE ROOM IS
//
// Real rooms are not boxes. An L wrapping a corner is the commonest floor in
// the trade, and a bar cutting across the front is the second. A member of
// staff crossing a room with two plates is navigating by its shape — the bay
// window, the corner past the bar — and not by a grid of numbered squares. A
// plan that draws every venue as the same rectangle makes them read the
// numbers instead, which is slower and is done while carrying something hot.
//
// The back office lets a venue walk the corners of its own room. This is the
// till drawing what they walked, from the same rows, so the plan on the screen
// and the floor underfoot are recognisably the same place.
//
// Shared by the floor screen and the table picker because they draw the same
// room and must not drift apart: two copies of this is how one of them ends up
// showing last month's shape.

import 'package:flutter/material.dart';

/// A colour the back office wrote, as "#RRGGBB", or null.
///
/// Null for anything that is not exactly that, rather than a guess. These
/// strings come from a colour picker and are validated on the way into the
/// database, so a value that does not look like one came from somewhere else,
/// and the right answer is the theme's own colour rather than a colour nobody
/// chose.
Color? colourOf(String? hex) {
  if (hex == null) return null;
  final text = hex.trim();
  if (text.length != 7 || !text.startsWith('#')) return null;
  final value = int.tryParse(text.substring(1), radix: 16);
  return value == null ? null : Color(0xFF000000 | value);
}

/// The walls, as the venue drew them.
///
/// A polygon of grid points scaled by the same unit the tables use, so the
/// corner table is in the corner of the actual corner. Filled as well as
/// outlined: the fill is what makes an L read as a room at a glance rather than
/// as a line drawing of one.
class WallsPainter extends CustomPainter {
  const WallsPainter({
    required this.outline,
    required this.unit,
    required this.floor,
    required this.wall,
  });

  /// Corners in grid squares, walked round the room.
  final List<List<int>> outline;

  /// Pixels per grid square, after the plan has been scaled to fit.
  final double unit;

  final Color floor;
  final Color wall;

  @override
  void paint(Canvas canvas, Size size) {
    // Two corners is a line, not a room. Nothing is drawn rather than something
    // wrong being drawn.
    if (outline.length < 3) return;

    final path = Path()
      ..moveTo(outline.first[0] * unit, outline.first[1] * unit);
    for (final point in outline.skip(1)) {
      path.lineTo(point[0] * unit, point[1] * unit);
    }
    path.close();

    canvas.drawPath(path, Paint()..color = floor);
    canvas.drawPath(
      path,
      Paint()
        ..color = wall
        ..style = PaintingStyle.stroke
        // Scaled with the plan, and clamped at both ends: unscaled, the walls
        // of a room shrunk to fit a phone become a thick band around a tiny
        // floor, and the walls of a room on a big screen become a hairline.
        ..strokeWidth = (unit * 0.06).clamp(1.5, 4.0)
        ..strokeJoin = StrokeJoin.round,
    );
  }

  @override
  bool shouldRepaint(WallsPainter old) =>
      old.unit != unit ||
      old.floor != floor ||
      old.wall != wall ||
      !_sameOutline(old.outline, outline);

  /// Compared point by point rather than by identity: the plan is rebuilt from
  /// JSON on every poll, so the lists are always different objects and always
  /// usually the same shape.
  static bool _sameOutline(List<List<int>> a, List<List<int>> b) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i][0] != b[i][0] || a[i][1] != b[i][1]) return false;
    }
    return true;
  }
}
