/// Moving tables on the device, for managers, as the till's floor editor
/// (floor_editor_page.dart): drag a table to its place on the grid, make it
/// round or square, bigger or smaller, more seats or fewer, then Save. It is
/// the venue's one floor plan: the tills and the back office see it too.
library;

import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/api.dart';
import '../../data/models.dart';
import '../../data/session.dart';
import '../theme.dart';

class FloorEditorPage extends ConsumerStatefulWidget {
  const FloorEditorPage({super.key, required this.area});
  final String area;
  @override
  ConsumerState<FloorEditorPage> createState() => _FloorEditorPageState();
}

class _FloorEditorPageState extends ConsumerState<FloorEditorPage> {
  late final List<TableInfo> _tables = [for (final t in ref.read(tapProvider).tables) if (t.area == widget.area) t];
  String? _picked;
  bool _saving = false;
  Offset _drag = Offset.zero;

  void _change(TableInfo Function(TableInfo) f) {
    final i = _tables.indexWhere((t) => t.id == _picked);
    if (i < 0) return;
    HapticFeedback.selectionClick();
    setState(() => _tables[i] = f(_tables[i]));
  }

  Future<void> _save() async {
    setState(() => _saving = true);
    final messenger = ScaffoldMessenger.of(context);
    try {
      if (!ref.read(tapProvider).demo) {
        await ref.read(apiProvider).saveFloor(_tables);
        await ref.read(tapProvider.notifier).refresh();
      }
      if (mounted) Navigator.pop(context);
      messenger.showSnackBar(SnackBar(content: Text('${widget.area} saved: the tills have it too')));
    } on TapApiError catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(e.message)));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final picked = _tables.where((t) => t.id == _picked).firstOrNull;
    // The room as squares: wide enough for every table, and some room to move.
    final cols = math.max(24, _tables.fold<int>(0, (m, t) => math.max(m, t.x + t.width + 2)));
    final rows = math.max(16, _tables.fold<int>(0, (m, t) => math.max(m, t.y + t.height + 2)));
    return Scaffold(
      appBar: AppBar(
        title: Text('Arrange ${widget.area}'),
        actions: [FilledButton(onPressed: _saving ? null : _save, child: const Text('Save')), const SizedBox(width: 12)],
      ),
      body: Column(children: [
        const Padding(
          padding: EdgeInsets.fromLTRB(16, 8, 16, 0),
          child: Text('Drag a table to move it. Tap one to change its shape, size and seats.'),
        ),
        Expanded(
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: LayoutBuilder(builder: (context, box) {
              final cell = math.min(box.maxWidth / cols, box.maxHeight / rows);
              return Center(
                child: Container(
                  width: cell * cols,
                  height: cell * rows,
                  decoration: BoxDecoration(color: Tp.inkCard, borderRadius: BorderRadius.circular(12), border: Border.all(color: Tp.inkLine)),
                  child: Stack(children: [
                    for (final t in _tables)
                      AnimatedPositioned(
                        duration: _picked == t.id && _drag != Offset.zero ? Duration.zero : const Duration(milliseconds: 160),
                        left: t.x * cell + (_picked == t.id ? _drag.dx : 0),
                        top: t.y * cell + (_picked == t.id ? _drag.dy : 0),
                        width: t.width * cell,
                        height: t.height * cell,
                        child: GestureDetector(
                          onTap: () => setState(() => _picked = _picked == t.id ? null : t.id),
                          onPanStart: (_) => setState(() {
                            _picked = t.id;
                            _drag = Offset.zero;
                          }),
                          onPanUpdate: (d) => setState(() => _drag += d.delta),
                          onPanEnd: (_) {
                            final dx = (_drag.dx / cell).round(), dy = (_drag.dy / cell).round();
                            setState(() => _drag = Offset.zero);
                            _change((x) => x.moved(x: (x.x + dx).clamp(0, 200), y: (x.y + dy).clamp(0, 200)));
                          },
                          child: Container(
                            alignment: Alignment.center,
                            decoration: ShapeDecoration(
                              color: _picked == t.id ? Tp.lime.withValues(alpha: 0.25) : Tp.inkRaised,
                              shape: t.round
                                  ? CircleBorder(side: BorderSide(color: _picked == t.id ? Tp.lime : Tp.inkLine, width: 2))
                                  : RoundedRectangleBorder(borderRadius: BorderRadius.circular(10), side: BorderSide(color: _picked == t.id ? Tp.lime : Tp.inkLine, width: 2)),
                            ),
                            child: FittedBox(
                              fit: BoxFit.scaleDown,
                              child: Padding(
                                padding: const EdgeInsets.all(4),
                                child: Column(mainAxisSize: MainAxisSize.min, children: [
                                  Text(t.name, style: const TextStyle(fontWeight: FontWeight.w800)),
                                  Text('${t.seats} seats', style: const TextStyle(fontSize: 11, color: Tp.muted)),
                                ]),
                              ),
                            ),
                          ),
                        ),
                      ),
                  ]),
                ),
              );
            }),
          ),
        ),
        AnimatedSwitcher(
          duration: const Duration(milliseconds: 200),
          child: picked == null
              ? const SizedBox(height: 12)
              : SafeArea(
                  top: false,
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
                    child: Wrap(spacing: 8, runSpacing: 8, crossAxisAlignment: WrapCrossAlignment.center, children: [
                      Text(picked.name, style: Theme.of(context).textTheme.titleMedium),
                      SegmentedButton<bool>(
                        showSelectedIcon: false,
                        segments: const [ButtonSegment(value: false, label: Text('Square')), ButtonSegment(value: true, label: Text('Round'))],
                        selected: {picked.round},
                        onSelectionChanged: (v) => _change((x) => x.moved(round: v.first)),
                      ),
                      IconButton.filledTonal(tooltip: 'Wider', onPressed: () => _change((x) => x.moved(width: (x.width + 1).clamp(1, 20))), icon: const Icon(Icons.keyboard_double_arrow_right_rounded)),
                      IconButton.filledTonal(tooltip: 'Narrower', onPressed: () => _change((x) => x.moved(width: (x.width - 1).clamp(1, 20))), icon: const Icon(Icons.keyboard_double_arrow_left_rounded)),
                      IconButton.filledTonal(tooltip: 'Taller', onPressed: () => _change((x) => x.moved(height: (x.height + 1).clamp(1, 20))), icon: const Icon(Icons.keyboard_double_arrow_down_rounded)),
                      IconButton.filledTonal(tooltip: 'Shorter', onPressed: () => _change((x) => x.moved(height: (x.height - 1).clamp(1, 20))), icon: const Icon(Icons.keyboard_double_arrow_up_rounded)),
                      IconButton.filledTonal(tooltip: 'Fewer seats', onPressed: () => _change((x) => x.moved(seats: (x.seats - 1).clamp(0, 99))), icon: const Icon(Icons.remove_rounded)),
                      Text('${picked.seats} seats'),
                      IconButton.filledTonal(tooltip: 'More seats', onPressed: () => _change((x) => x.moved(seats: (x.seats + 1).clamp(0, 99))), icon: const Icon(Icons.add_rounded)),
                    ]),
                  ),
                ),
        ),
      ]),
    );
  }
}
