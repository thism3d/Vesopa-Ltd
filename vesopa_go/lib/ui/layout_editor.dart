/// Rearranging a programmed screen on the device, for managers (owner,
/// 2026-10-27): the till's screen is Go's to start with, and a manager can
/// move, resize, recolour and remove its keys for this kind of device (iPad
/// or phone) without touching the till's own screen. Saved to the back
/// office (epos_go_layouts), checked there to be a manager's; Back to the
/// till's layout undoes it.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/api.dart';
import '../data/session.dart';
import 'theme.dart';

/// `tablet` or `phone`: which of Go's layouts this device uses.
String formOf(BuildContext context) => MediaQuery.sizeOf(context).shortestSide >= 600 ? 'tablet' : 'phone';

/// [screen] as this kind of device has it: Go's own layout when a manager
/// rearranged it here, else the till's.
TillScreen withGoLayout(TillScreen screen, TapConfig config, String form) {
  final buttons = config.goLayouts[form]?['${screen.id}'];
  if (buttons is! List) return screen;
  return TillScreen(
    id: screen.id,
    name: screen.name,
    surface: screen.surface,
    rows: screen.rows,
    cols: screen.cols,
    topBarId: screen.topBarId,
    bottomBarId: screen.bottomBarId,
    buttons: [for (final b in buttons) ScreenButton.fromJson(Map<String, dynamic>.from(b as Map))],
  );
}

const _swatches = [null, 0xFFA5C715, 0xFF4BA3F5, 0xFFF5B301, 0xFFA435B0, 0xFF3FBBD6, 0xFF2E9E5B, 0xFFF4633A, 0xFFE8412C, 0xFF6B6B6A];

class LayoutEditorPage extends ConsumerStatefulWidget {
  const LayoutEditorPage({super.key, required this.screen, required this.form});
  final TillScreen screen;
  final String form;
  @override
  ConsumerState<LayoutEditorPage> createState() => _LayoutEditorPageState();
}

class _LayoutEditorPageState extends ConsumerState<LayoutEditorPage> {
  late final List<Map<String, dynamic>> _keys = [for (final b in widget.screen.buttons) b.toJson()];
  int? _picked;
  bool _saving = false;

  int get _rows => widget.screen.rows;
  int get _cols => widget.screen.cols;

  bool _fits(Map<String, dynamic> k, {int? row, int? col, int? rowSpan, int? colSpan, int? except}) {
    final r0 = row ?? k['row'] as int, c0 = col ?? k['col'] as int;
    final rs = rowSpan ?? (k['rowSpan'] as int? ?? 1), cs = colSpan ?? (k['colSpan'] as int? ?? 1);
    if (r0 < 0 || c0 < 0 || r0 + rs > _rows || c0 + cs > _cols) return false;
    for (var i = 0; i < _keys.length; i++) {
      if (i == except) continue;
      final o = _keys[i];
      final or = o['row'] as int, oc = o['col'] as int, ors = o['rowSpan'] as int? ?? 1, ocs = o['colSpan'] as int? ?? 1;
      final clash = r0 < or + ors && or < r0 + rs && c0 < oc + ocs && oc < c0 + cs;
      if (clash) return false;
    }
    return true;
  }

  void _tapCell(int r, int c) {
    final i = _keys.indexWhere((k) {
      final kr = k['row'] as int, kc = k['col'] as int;
      return r >= kr && r < kr + (k['rowSpan'] as int? ?? 1) && c >= kc && c < kc + (k['colSpan'] as int? ?? 1);
    });
    if (i >= 0) {
      setState(() => _picked = _picked == i ? null : i);
      return;
    }
    final p = _picked;
    if (p == null) return;
    // An empty cell with a key picked: the key moves there, if it fits.
    if (_fits(_keys[p], row: r, col: c, except: p)) {
      HapticFeedback.selectionClick();
      setState(() => _keys[p] = {..._keys[p], 'row': r, 'col': c});
    } else {
      HapticFeedback.heavyImpact();
    }
  }

  void _span(int dRow, int dCol) {
    final p = _picked;
    if (p == null) return;
    final k = _keys[p];
    final rs = (k['rowSpan'] as int? ?? 1) + dRow, cs = (k['colSpan'] as int? ?? 1) + dCol;
    if (rs < 1 || cs < 1 || !_fits(k, rowSpan: rs, colSpan: cs, except: p)) {
      HapticFeedback.heavyImpact();
      return;
    }
    setState(() => _keys[p] = {...k, 'rowSpan': rs, 'colSpan': cs});
  }

  Future<void> _save({bool reset = false}) async {
    final s = ref.read(tapProvider);
    final clerk = s.clerk;
    if (clerk == null) return;
    setState(() => _saving = true);
    final messenger = ScaffoldMessenger.of(context);
    try {
      if (!s.demo) {
        await ref.read(apiProvider).saveLayout(widget.form, widget.screen.id, reset ? null : _keys, clerkId: clerk.id, pin: clerk.pin);
        await ref.read(tapProvider.notifier).refresh();
      }
      if (mounted) Navigator.pop(context);
      messenger.showSnackBar(SnackBar(content: Text(reset ? 'Back to the till\'s layout' : 'Layout saved for ${widget.form == 'tablet' ? 'iPads and tablets' : 'phones'}')));
    } on TapApiError catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(e.message)));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final p = _picked;
    return Scaffold(
      appBar: AppBar(
        title: Text('Arrange ${widget.screen.name}'),
        actions: [
          TextButton(onPressed: _saving ? null : () => _save(reset: true), child: const Text('Back to the till\'s')),
          const SizedBox(width: 8),
          FilledButton(onPressed: _saving ? null : _save, child: const Text('Save')),
          const SizedBox(width: 12),
        ],
      ),
      body: Column(children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
          child: Text(p == null ? 'Tap a key to pick it, then tap an empty space to move it there.' : 'Picked: ${_keys[p]['label'] ?? _keys[p]['kind']}. Tap an empty space to move it, or change it below.', style: t.bodyMedium),
        ),
        Expanded(
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: LayoutBuilder(builder: (context, box) {
              const gap = 8.0;
              final w = (box.maxWidth - gap * (_cols - 1)) / _cols;
              final h = (box.maxHeight - gap * (_rows - 1)) / _rows;
              return Stack(children: [
                for (var r = 0; r < _rows; r++)
                  for (var c = 0; c < _cols; c++)
                    Positioned(
                      left: c * (w + gap),
                      top: r * (h + gap),
                      width: w,
                      height: h,
                      child: GestureDetector(
                        onTap: () => _tapCell(r, c),
                        child: DecoratedBox(decoration: BoxDecoration(borderRadius: BorderRadius.circular(10), border: Border.all(color: Tp.inkLine))),
                      ),
                    ),
                for (var i = 0; i < _keys.length; i++)
                  AnimatedPositioned(
                    duration: const Duration(milliseconds: 180),
                    left: (_keys[i]['col'] as int) * (w + gap),
                    top: (_keys[i]['row'] as int) * (h + gap),
                    width: w * (_keys[i]['colSpan'] as int? ?? 1) + gap * ((_keys[i]['colSpan'] as int? ?? 1) - 1),
                    height: h * (_keys[i]['rowSpan'] as int? ?? 1) + gap * ((_keys[i]['rowSpan'] as int? ?? 1) - 1),
                    child: GestureDetector(
                      onTap: () => _tapCell(_keys[i]['row'] as int, _keys[i]['col'] as int),
                      child: AnimatedContainer(
                        duration: const Duration(milliseconds: 150),
                        padding: const EdgeInsets.all(8),
                        decoration: BoxDecoration(
                          color: _colourOf(_keys[i]['fill']) ?? Tp.inkCard,
                          borderRadius: BorderRadius.circular(10),
                          border: Border.all(color: i == p ? Tp.lime : Tp.inkLine, width: i == p ? 3 : 1),
                        ),
                        child: Text('${_keys[i]['label'] ?? _keys[i]['kind']}', maxLines: 3, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w700)),
                      ),
                    ),
                  ),
              ]);
            }),
          ),
        ),
        AnimatedSwitcher(
          duration: const Duration(milliseconds: 200),
          child: p == null
              ? const SizedBox(height: 12)
              : SafeArea(
                  top: false,
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
                    child: Wrap(spacing: 8, runSpacing: 8, crossAxisAlignment: WrapCrossAlignment.center, children: [
                      IconButton.filledTonal(tooltip: 'Wider', onPressed: () => _span(0, 1), icon: const Icon(Icons.keyboard_double_arrow_right_rounded)),
                      IconButton.filledTonal(tooltip: 'Narrower', onPressed: () => _span(0, -1), icon: const Icon(Icons.keyboard_double_arrow_left_rounded)),
                      IconButton.filledTonal(tooltip: 'Taller', onPressed: () => _span(1, 0), icon: const Icon(Icons.keyboard_double_arrow_down_rounded)),
                      IconButton.filledTonal(tooltip: 'Shorter', onPressed: () => _span(-1, 0), icon: const Icon(Icons.keyboard_double_arrow_up_rounded)),
                      for (final c in _swatches)
                        InkWell(
                          onTap: () => setState(() => _keys[p] = {..._keys[p], 'fill': c == null ? null : '#${(c & 0xFFFFFF).toRadixString(16).padLeft(6, '0')}'}),
                          child: Container(
                            width: 32,
                            height: 32,
                            decoration: BoxDecoration(color: c == null ? Tp.inkCard : Color(c), shape: BoxShape.circle, border: Border.all(color: Tp.inkLine)),
                            child: c == null ? const Icon(Icons.format_color_reset_rounded, size: 16) : null,
                          ),
                        ),
                      TextButton.icon(
                        onPressed: () => setState(() {
                          _keys.removeAt(p);
                          _picked = null;
                        }),
                        icon: const Icon(Icons.delete_outline_rounded, color: Tp.danger),
                        label: const Text('Remove', style: TextStyle(color: Tp.danger)),
                      ),
                    ]),
                  ),
                ),
        ),
      ]),
    );
  }

  Color? _colourOf(Object? hex) {
    final h = '${hex ?? ''}'.replaceAll('#', '');
    final v = int.tryParse(h, radix: 16);
    return h.length == 6 && v != null ? Color(0xFF000000 | v) : null;
  }
}
