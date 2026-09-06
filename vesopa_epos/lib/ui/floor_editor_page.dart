// Laying out the room, on the floor, standing in it.
//
// WHY THIS IS ON THE TILL AND NOT ONLY IN THE BACK OFFICE
//
// Arranging a dining room in a browser means doing it on a laptop in an office,
// from memory, about a room you are not in. Everybody who has done it has then
// walked out to the floor and found the plan wrong — the two-top by the window
// is on the wrong side, the booth is a table further along. The till is already
// standing in the room, so this is the same three edits the back office makes,
// made where the answer is visible.
//
// WHY IT IS A SEPARATE SCREEN
//
// The Tables page is a service screen. A clerk crossing it at eight on a Friday
// is parking bills and recalling them, and a plan that could be rearranged by a
// stray finger is a plan that will be. Editing is a mode you enter deliberately,
// behind a manager key, and leave again.
//
// WHAT IS SAVED WHEN
//
// Adding a table saves at once, because the code printed on the card that sits
// on it is minted by the server and there is nothing sensible to hold locally.
// Moving and resizing are held until Save, because a manager rearranging a room
// touches a dozen tables and a write per drag would be a dozen writes and a
// dozen chances for half of them to land.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/floor_repository.dart';
import '../data/till_permissions.dart';
import '../main.dart';
import 'theme.dart';
import 'permission_gate.dart';
import 'widgets/pos_message.dart';
import 'room_walls.dart';

/// The furniture a room is actually made of.
///
/// Not "a table": a room is two-tops along the window, four-tops in the middle,
/// a long six for the party, a couple of stools at the bar. The sizes are the
/// proportions of the real thing, so a six reads as long and a round four reads
/// as round before the label under it is read at all.
class TablePreset {
  const TablePreset(this.label, this.seats, this.w, this.h, this.shape);

  final String label;
  final int seats;
  final int w;
  final int h;
  final String shape;

  bool get isCircle => shape == 'circle';

  static const all = <TablePreset>[
    TablePreset('Two', 2, 2, 2, 'rect'),
    TablePreset('Round 2', 2, 2, 2, 'circle'),
    TablePreset('Four', 4, 3, 2, 'rect'),
    TablePreset('Round 4', 4, 3, 3, 'circle'),
    TablePreset('Six', 6, 4, 2, 'rect'),
    TablePreset('Round 6', 6, 4, 4, 'circle'),
    TablePreset('Eight', 8, 5, 3, 'rect'),
    TablePreset('Booth', 4, 4, 3, 'rect'),
    TablePreset('Stool', 1, 1, 1, 'circle'),
  ];
}

/// Open the editor, if this member of staff is allowed to and this till can.
Future<void> openFloorEditor(BuildContext context, WidgetRef ref) async {
  final repo = ref.read(floorRepositoryProvider).value;
  if (repo == null || !repo.canEdit) {
    PosMessenger.error(
      context,
      'This till has not been commissioned, so it cannot change the floor plan. '
      'Sign the terminal in, or lay the room out in the back office.',
    );
    return;
  }

  // Rearranging the room is a manager's job, and the venue was explicit that it
  // did not want a screen full of extra switches — so this rides on the manager
  // key that already exists rather than adding a twelfth.
  if (!await allowed(context, ref, TillPermission.isManager)) return;
  if (!context.mounted) return;

  await Navigator.of(context).push(
    MaterialPageRoute<void>(builder: (_) => const FloorEditorPage()),
  );
  // Whatever was saved came back through floor.updated, but a plan that was
  // opened and left alone should still be current when the service screen
  // reappears.
  ref.invalidate(floorPlanProvider);
}

class FloorEditorPage extends ConsumerStatefulWidget {
  const FloorEditorPage({super.key});

  /// The same grid unit the designer and the service plan use, so a table drawn
  /// at (5,3) is at (5,3) everywhere.
  static const grid = 40.0;

  @override
  ConsumerState<FloorEditorPage> createState() => _FloorEditorPageState();
}

class _FloorEditorPageState extends ConsumerState<FloorEditorPage> {
  /// The plan being worked on. A copy, so leaving without saving leaves the
  /// real one alone.
  List<_EditableRoom> _rooms = const [];
  int _roomIndex = 0;
  bool _loaded = false;
  bool _dirty = false;
  bool _saving = false;

  /// Corners, while the room is being drawn. Null the rest of the time.
  List<List<int>>? _drawing;

  _EditableRoom? get _room =>
      _rooms.isEmpty ? null : _rooms[_roomIndex.clamp(0, _rooms.length - 1)];

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final rooms = await ref.read(floorPlanProvider.future);
    if (!mounted) return;
    setState(() {
      _rooms = [for (final r in rooms) _EditableRoom.from(r)];
      _loaded = true;
    });
  }

  /// The lowest number this venue is not already using.
  int get _nextNumber {
    final used = <int>{
      for (final r in _rooms)
        for (final t in r.tables) t.number,
    };
    var n = 1;
    while (used.contains(n)) {
      n++;
    }
    return n;
  }

  // -------------------------------------------------------------------------
  // Saving
  // -------------------------------------------------------------------------

  Future<void> _save() async {
    final room = _room;
    if (room == null || _saving) return;
    setState(() => _saving = true);
    try {
      final repo = await ref.read(floorRepositoryProvider.future);
      await repo.saveTables([for (final t in room.tables) t.toFloorTable()]);
      if (!mounted) return;
      setState(() {
        _dirty = false;
        _saving = false;
      });
      PosMessenger.success(context, 'Layout saved to every till.');
    } on FloorSaveFailed catch (e) {
      if (!mounted) return;
      setState(() => _saving = false);
      PosMessenger.error(context, e.message);
    } catch (e) {
      if (!mounted) return;
      setState(() => _saving = false);
      PosMessenger.error(context, 'Could not reach the back office.\n$e');
    }
  }

  Future<void> _add(TablePreset preset) async {
    final room = _room;
    if (room == null || room.id == null) return;

    // Dropped in the middle of what is on screen, which is where somebody
    // looking at the plan expects it, and then dragged where it belongs.
    final number = _nextNumber;
    try {
      final repo = await ref.read(floorRepositoryProvider.future);
      final id = await repo.addTable(
        roomId: room.id!,
        tableNumber: number,
        x: (room.extentX / 2 - preset.w / 2).round().clamp(0, 200),
        y: (room.extentY / 2 - preset.h / 2).round().clamp(0, 200),
        width: preset.w,
        height: preset.h,
        shape: preset.shape,
        seats: preset.seats,
      );
      if (!mounted) return;
      setState(() {
        room.tables.add(_EditableTable(
          id: id,
          number: number,
          x: (room.extentX / 2 - preset.w / 2).round().clamp(0, 200),
          y: (room.extentY / 2 - preset.h / 2).round().clamp(0, 200),
          width: preset.w,
          height: preset.h,
          shape: preset.shape,
          seats: preset.seats,
        ));
      });
      PosMessenger.success(context, 'Table $number added. Drag it into place.');
    } on FloorSaveFailed catch (e) {
      if (!mounted) return;
      PosMessenger.error(context, e.message);
    }
  }

  Future<void> _saveShape(List<List<int>>? outline) async {
    final room = _room;
    if (room == null || room.id == null) return;
    try {
      final repo = await ref.read(floorRepositoryProvider.future);
      await repo.saveRoomShape(room.id!, outline);
      if (!mounted) return;
      setState(() {
        room.outline = outline;
        _drawing = null;
      });
      PosMessenger.success(
        context,
        outline == null ? 'Back to a plain rectangle.' : 'Room shape saved.',
      );
    } on FloorSaveFailed catch (e) {
      if (!mounted) return;
      setState(() => _drawing = null);
      PosMessenger.error(context, e.message);
    }
  }

  // -------------------------------------------------------------------------
  // Drawing the room
  // -------------------------------------------------------------------------

  void _startDrawing() {
    // Opens on whatever shape the room already has, so adjusting an L is moving
    // six corners rather than drawing it again from nothing.
    setState(() => _drawing = [
          for (final p in _room?.outline ?? const <List<int>>[]) [p[0], p[1]],
        ]);
  }

  /// A tap on the plan while drawing: another corner, or the one that closes it.
  void _corner(int x, int y) {
    final points = _drawing;
    if (points == null) return;

    // Back on the first corner closes the shape. Two squares of slack, not
    // none: the target is a small dot and a fingertip is nearer forty pixels,
    // so demanding the exact square is a shape that cannot be closed by the
    // person who drew it.
    if (points.length >= 3 &&
        (points.first[0] - x).abs() <= 2 &&
        (points.first[1] - y).abs() <= 2) {
      _saveShape(List<List<int>>.from(points));
      return;
    }

    // The same square twice is a double tap, not two corners in one place —
    // and a repeated point is a polygon the server refuses.
    if (points.isNotEmpty &&
        points.last[0] == x &&
        points.last[1] == y) {
      return;
    }

    setState(() => points.add([x, y]));
  }

  @override
  Widget build(BuildContext context) {
    final room = _room;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Lay out the room'),
        actions: [
          if (_dirty && _drawing == null)
            Padding(
              padding: const EdgeInsets.only(right: 8),
              child: FilledButton.icon(
                onPressed: _saving ? null : _save,
                icon: _saving
                    ? const SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.check),
                label: const Text('Save layout'),
              ),
            ),
        ],
      ),
      body: !_loaded
          ? const Center(child: CircularProgressIndicator())
          : room == null
              ? const Center(
                  child: Padding(
                    padding: EdgeInsets.all(32),
                    child: Text(
                      'No rooms yet. Create one in the back office and it will '
                      'appear here to lay out.',
                      textAlign: TextAlign.center,
                    ),
                  ),
                )
              : Column(
                  children: [
                    if (_rooms.length > 1) _roomTabs(),
                    if (_drawing != null) _drawBar() else _palette(),
                    Expanded(child: _plan(room)),
                  ],
                ),
    );
  }

  Widget _roomTabs() => SizedBox(
        height: 52,
        child: ListView.separated(
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          itemCount: _rooms.length,
          separatorBuilder: (_, _) => const SizedBox(width: 8),
          itemBuilder: (context, i) => ChoiceChip(
            label: Text(_rooms[i].name),
            selected: i == _roomIndex,
            // Switching rooms mid-drawing would leave corners belonging to a
            // room nobody is looking at.
            onSelected: _drawing != null
                ? null
                : (_) => setState(() => _roomIndex = i),
          ),
        ),
      );

  Widget _palette() => SizedBox(
        height: 92,
        child: ListView.separated(
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          itemCount: TablePreset.all.length + 1,
          separatorBuilder: (_, _) => const SizedBox(width: 8),
          itemBuilder: (context, i) {
            if (i == TablePreset.all.length) {
              return OutlinedButton.icon(
                onPressed: _startDrawing,
                icon: const Icon(Icons.crop_free),
                label: const Text('Draw the room'),
              );
            }
            final preset = TablePreset.all[i];
            return _PresetButton(preset: preset, onTap: () => _add(preset));
          },
        ),
      );

  Widget _drawBar() {
    final points = _drawing ?? const <List<int>>[];
    final message = points.isEmpty
        ? 'Tap the first corner of the room.'
        : points.length < 3
            ? 'Corner ${points.length} down. Keep tapping round the walls.'
            : '${points.length} corners. Tap the first one again to close it.';

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      color: Pos.brand.withValues(alpha: .14),
      child: Row(
        children: [
          Expanded(
            child: Text(
              message,
              style: const TextStyle(fontWeight: FontWeight.w600),
            ),
          ),
          TextButton(
            onPressed: points.isEmpty
                ? null
                : () => setState(() => points.removeLast()),
            child: const Text('Undo corner'),
          ),
          TextButton(
            onPressed: () => setState(() => _drawing = null),
            child: const Text('Cancel'),
          ),
          FilledButton(
            // Fewer than three corners is not a room. Saved as null rather than
            // refused: somebody who drew two points and pressed Done meant
            // "no custom shape", and that is a rectangle.
            onPressed: () =>
                _saveShape(points.length >= 3 ? List<List<int>>.from(points) : null),
            child: const Text('Done'),
          ),
        ],
      ),
    );
  }

  Widget _plan(_EditableRoom room) {
    const grid = FloorEditorPage.grid;
    final drawing = _drawing;
    final extentX = room.extentX;
    final extentY = room.extentY;

    return LayoutBuilder(
      builder: (context, constraints) {
        // Fit on both axes so a wide or a deep room never runs off the edge and
        // hides the tables at the far end.
        final scale = ((constraints.maxWidth / (extentX * grid))
                .clamp(0.25, 1.4))
            .toDouble();
        final unit = grid * scale;

        return SingleChildScrollView(
          child: SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: SizedBox(
              width: (extentX * unit).clamp(constraints.maxWidth, double.infinity),
              height: extentY * unit + 24,
              child: GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTapUp: drawing == null
                    ? null
                    : (details) => _corner(
                          (details.localPosition.dx / unit)
                              .round()
                              .clamp(0, 200),
                          (details.localPosition.dy / unit)
                              .round()
                              .clamp(0, 200),
                        ),
                child: Stack(
                  children: [
                    // The room, under everything and taking no taps.
                    if (room.outline != null && drawing == null)
                      Positioned.fill(
                        child: IgnorePointer(
                          child: CustomPaint(
                            painter: WallsPainter(
                              outline: room.outline!,
                              unit: unit,
                              floor: Theme.of(context)
                                  .colorScheme
                                  .surfaceContainerHighest,
                              wall:
                                  Theme.of(context).colorScheme.outlineVariant,
                            ),
                          ),
                        ),
                      ),
                    if (drawing != null)
                      Positioned.fill(
                        child: IgnorePointer(
                          child: CustomPaint(
                            painter: _DrawingPainter(
                              points: drawing,
                              unit: unit,
                              colour: Pos.brand,
                            ),
                          ),
                        ),
                      ),
                    for (final table in room.tables)
                      Positioned(
                        left: table.x * unit,
                        top: table.y * unit,
                        width: table.width * unit - 4,
                        height: table.height * unit - 4,
                        child: _DraggableTable(
                          table: table,
                          unit: unit,
                          // Not while the room is being drawn: a drag would
                          // start instead of a corner being dropped, and the
                          // corner somebody is aiming at is usually one a table
                          // is sitting on.
                          frozen: drawing != null,
                          onMoved: (dx, dy) => setState(() {
                            table.x = (table.x + dx)
                                .clamp(0, 200 - table.width);
                            table.y = (table.y + dy)
                                .clamp(0, 200 - table.height);
                            _dirty = true;
                          }),
                        ),
                      ),
                  ],
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}

// ---------------------------------------------------------------------------
// The plan being edited
// ---------------------------------------------------------------------------

/// A room, in a form that can be changed.
///
/// FloorRoom is immutable and is what the service screens read; this is the
/// working copy the editor drags about, so abandoning an edit is simply not
/// saving it.
class _EditableRoom {
  _EditableRoom({
    required this.id,
    required this.name,
    required this.tables,
    this.outline,
  });

  factory _EditableRoom.from(FloorRoom room) => _EditableRoom(
        id: room.id,
        name: room.name,
        outline: room.outline == null
            ? null
            : [for (final p in room.outline!) [p[0], p[1]]],
        tables: [
          for (final t in room.tables)
            _EditableTable(
              id: t.id,
              number: t.number,
              label: t.label,
              x: t.x,
              y: t.y,
              width: t.width,
              height: t.height,
              shape: t.shape,
              seats: t.seats,
              colour: t.colour,
            ),
        ],
      );

  final int? id;
  final String name;
  final List<_EditableTable> tables;
  List<List<int>>? outline;

  /// How far the room reaches, walls included.
  ///
  /// A minimum of twelve by eight so an empty room is a floor somebody can drop
  /// a table onto, rather than a single square in the corner.
  int get extentX {
    var max = 12;
    for (final t in tables) {
      if (t.x + t.width > max) max = t.x + t.width;
    }
    for (final p in outline ?? const <List<int>>[]) {
      if (p[0] > max) max = p[0];
    }
    return max + 1;
  }

  int get extentY {
    var max = 8;
    for (final t in tables) {
      if (t.y + t.height > max) max = t.y + t.height;
    }
    for (final p in outline ?? const <List<int>>[]) {
      if (p[1] > max) max = p[1];
    }
    return max + 1;
  }
}

class _EditableTable {
  _EditableTable({
    required this.id,
    required this.number,
    required this.x,
    required this.y,
    required this.width,
    required this.height,
    required this.shape,
    required this.seats,
    this.label,
    this.colour,
  });

  final int? id;
  final int number;
  final String? label;
  int x;
  int y;
  int width;
  int height;
  String shape;
  int seats;
  String? colour;

  bool get isCircle => shape == 'circle';

  FloorTable toFloorTable() => FloorTable(
        id: id,
        number: number,
        label: label,
        x: x,
        y: y,
        width: width,
        height: height,
        shape: shape,
        seats: seats,
        colour: colour,
      );
}

// ---------------------------------------------------------------------------
// The pieces
// ---------------------------------------------------------------------------

class _PresetButton extends StatelessWidget {
  const _PresetButton({required this.preset, required this.onTap});

  final TablePreset preset;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(10),
      child: Container(
        width: 74,
        padding: const EdgeInsets.all(6),
        decoration: BoxDecoration(
          border: Border.all(color: Theme.of(context).colorScheme.outlineVariant),
          borderRadius: BorderRadius.circular(10),
        ),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.end,
          children: [
            // Drawn in its own proportions, so a six reads as long and a round
            // four reads as round before the word is read at all.
            Container(
              width: preset.w * 9.0,
              height: preset.h * 9.0,
              decoration: BoxDecoration(
                border: Border.all(color: Pos.brand, width: 2),
                borderRadius: preset.isCircle
                    ? BorderRadius.circular(400)
                    : BorderRadius.circular(3),
                color: Pos.brand.withValues(alpha: .16),
              ),
            ),
            const SizedBox(height: 6),
            Text(
              preset.label,
              style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600),
              overflow: TextOverflow.ellipsis,
            ),
          ],
        ),
      ),
    );
  }
}

/// One table, draggable by the grid square.
class _DraggableTable extends StatefulWidget {
  const _DraggableTable({
    required this.table,
    required this.unit,
    required this.frozen,
    required this.onMoved,
  });

  final _EditableTable table;
  final double unit;
  final bool frozen;

  /// How many grid squares it moved, once the finger lifts.
  final void Function(int dx, int dy) onMoved;

  @override
  State<_DraggableTable> createState() => _DraggableTableState();
}

class _DraggableTableState extends State<_DraggableTable> {
  /// Where the finger is, relative to where the drag started, in pixels.
  Offset _drag = Offset.zero;

  @override
  Widget build(BuildContext context) {
    final t = widget.table;
    final radius = t.isCircle
        ? BorderRadius.circular(400)
        : BorderRadius.circular(8);
    final surface = colourOf(t.colour) ?? Theme.of(context).posIdle;

    return Transform.translate(
      offset: _drag,
      child: GestureDetector(
        onPanStart: widget.frozen ? null : (_) => setState(() {}),
        onPanUpdate: widget.frozen
            ? null
            : (d) => setState(() => _drag += d.delta),
        onPanEnd: widget.frozen
            ? null
            : (_) {
                // Snapped on release rather than on every frame: snapping as
                // the finger moves makes the table jump ahead of it, which
                // reads as the drag fighting back.
                final dx = (_drag.dx / widget.unit).round();
                final dy = (_drag.dy / widget.unit).round();
                setState(() => _drag = Offset.zero);
                if (dx != 0 || dy != 0) widget.onMoved(dx, dy);
              },
        child: Material(
          color: surface,
          borderRadius: radius,
          elevation: _drag == Offset.zero ? 0 : 6,
          child: Container(
            decoration: BoxDecoration(
              borderRadius: radius,
              border: Border.all(color: Pos.brand, width: 2),
            ),
            child: Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    t.label?.isNotEmpty == true ? t.label! : '${t.number}',
                    style: TextStyle(
                      fontWeight: FontWeight.bold,
                      color: Pos.inkOn(surface),
                    ),
                  ),
                  Text(
                    '${t.seats}',
                    style: TextStyle(
                      fontSize: 11,
                      color: Pos.mutedInkOn(surface),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// The room as it is being walked out: the wall so far, and every corner.
class _DrawingPainter extends CustomPainter {
  const _DrawingPainter({
    required this.points,
    required this.unit,
    required this.colour,
  });

  final List<List<int>> points;
  final double unit;
  final Color colour;

  @override
  void paint(Canvas canvas, Size size) {
    if (points.isEmpty) return;

    final wall = Paint()
      ..color = colour
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2.5
      ..strokeJoin = StrokeJoin.round;

    final path = Path()..moveTo(points.first[0] * unit, points.first[1] * unit);
    for (final p in points.skip(1)) {
      path.lineTo(p[0] * unit, p[1] * unit);
    }

    if (points.length >= 3) {
      final filled = Path.from(path)..close();
      canvas.drawPath(filled, Paint()..color = colour.withValues(alpha: .16));
      // The wall back to the start, dashed, so a shape three corners in already
      // reads as the room it is about to become.
      _dashed(
        canvas,
        Offset(points.last[0] * unit, points.last[1] * unit),
        Offset(points.first[0] * unit, points.first[1] * unit),
        wall,
      );
    }
    canvas.drawPath(path, wall);

    for (var i = 0; i < points.length; i++) {
      final at = Offset(points[i][0] * unit, points[i][1] * unit);
      // The first corner grows into a target once closing is possible, because
      // "tap the first corner again" is only an instruction if it can be found.
      final closes = i == 0 && points.length >= 3;
      canvas.drawCircle(
        at,
        closes ? 15 : 9,
        Paint()..color = closes ? colour : Colors.white,
      );
      canvas.drawCircle(
        at,
        closes ? 15 : 9,
        Paint()
          ..color = closes ? Colors.white : colour
          ..style = PaintingStyle.stroke
          ..strokeWidth = 3,
      );
    }
  }

  void _dashed(Canvas canvas, Offset from, Offset to, Paint paint) {
    const dash = 7.0;
    const gap = 5.0;
    final total = (to - from).distance;
    if (total == 0) return;
    final step = (to - from) / total;
    var walked = 0.0;
    while (walked < total) {
      final end = (walked + dash).clamp(0.0, total);
      canvas.drawLine(from + step * walked, from + step * end, paint);
      walked = end + gap;
    }
  }

  @override
  bool shouldRepaint(_DrawingPainter old) =>
      old.unit != unit ||
      old.colour != colour ||
      old.points.length != points.length ||
      !_same(old.points, points);

  static bool _same(List<List<int>> a, List<List<int>> b) {
    for (var i = 0; i < a.length; i++) {
      if (a[i][0] != b[i][0] || a[i][1] != b[i][1]) return false;
    }
    return true;
  }
}
