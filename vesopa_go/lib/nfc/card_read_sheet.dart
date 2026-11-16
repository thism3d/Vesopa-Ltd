/// The reading screen: one sheet for every card Go reads by NFC.
///
/// An iPhone draws its own "Ready to scan" sheet. An Android phone draws
/// nothing at all: the clerk pressed "Read a staff card" and the screen sat
/// there, with no sign that the phone was listening or where to hold the card
/// (the owner, 2026-11-16). This is that sign, on both, and it is also where
/// the other two ways in live: the camera, for a card that carries a QR or a
/// barcode, and typing the number.
library;

import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../ui/pages/scan_sheet.dart';
import '../ui/theme.dart';
import 'staff_card.dart';

const _useCamera = '\u0000camera';

/// Reads one card. Answers with its id (NFC), its code (camera) or what was
/// typed; null when the clerk closed the sheet.
///
/// [camera] offers the camera as well, for cards printed with a code.
/// [typing] offers a box for the number on the card.
Future<String?> readCard(
  BuildContext context, {
  required String title,
  String hint = 'Hold the card flat against the back of the phone',
  bool camera = true,
  bool typing = false,
  String cameraHint = 'Point the camera at the code on the card',
}) async {
  final answer = await showModalBottomSheet<String>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (_) => _CardReadSheet(title: title, hint: hint, camera: camera, typing: typing),
  );
  if (answer != _useCamera) return answer;
  if (!context.mounted) return null;
  return scanCode(context, title: title, hint: cameraHint);
}

class _CardReadSheet extends StatefulWidget {
  const _CardReadSheet({required this.title, required this.hint, required this.camera, required this.typing});
  final String title;
  final String hint;
  final bool camera;
  final bool typing;

  @override
  State<_CardReadSheet> createState() => _CardReadSheetState();
}

enum _Reading { starting, listening, read, off }

class _CardReadSheetState extends State<_CardReadSheet> with SingleTickerProviderStateMixin {
  late final _pulse = AnimationController(vsync: this, duration: const Duration(milliseconds: 1800));
  final _typed = TextEditingController();
  var _state = _Reading.starting;
  bool _closed = false;

  @override
  void initState() {
    super.initState();
    unawaited(_listen());
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (ambientMotion(context) && !_pulse.isAnimating) _pulse.repeat();
  }

  Future<void> _listen() async {
    if (!await StaffCardReader.available()) {
      if (mounted) setState(() => _state = _Reading.off);
      return;
    }
    if (!mounted) return;
    setState(() => _state = _Reading.listening);
    // Long enough to find the card in a pocket; the sheet's own close stops it.
    final id = await StaffCardReader.readOnce(timeout: const Duration(minutes: 2));
    if (!mounted || _closed) return;
    if (id == null) {
      // An iPhone's own sheet was cancelled, or the wait ran out. The sheet
      // stays, so the camera and the number box are still there to use.
      setState(() => _state = _Reading.off);
      return;
    }
    setState(() => _state = _Reading.read);
    unawaited(HapticFeedback.mediumImpact());
    await Future<void>.delayed(const Duration(milliseconds: 450));
    if (mounted && !_closed) _finish(id);
  }

  void _finish(String? value) {
    if (_closed) return;
    _closed = true;
    Navigator.pop(context, value);
  }

  @override
  void dispose() {
    _closed = true;
    unawaited(StaffCardReader.cancel());
    _pulse.dispose();
    _typed.dispose();
    super.dispose();
  }

  String get _status => switch (_state) {
        _Reading.starting => 'Getting ready',
        _Reading.listening => 'Ready to read',
        _Reading.read => 'Card read',
        _Reading.off => Platform.isIOS ? 'Not reading' : 'NFC is off or not on this phone',
      };

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final listening = _state == _Reading.listening;
    final read = _state == _Reading.read;
    final accent = read ? Tp.green : (listening ? context.goLimeInk : context.goMuted);
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.fromLTRB(20, 0, 20, 20 + MediaQuery.viewInsetsOf(context).bottom),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text(widget.title, style: t.titleLarge, textAlign: TextAlign.center),
          const SizedBox(height: 18),
          Semantics(
            liveRegion: true,
            label: _status,
            child: SizedBox(
              height: 168,
              child: AnimatedBuilder(
                animation: _pulse,
                builder: (_, _) => CustomPaint(
                  painter: _RingsPainter(progress: listening ? _pulse.value : 0, colour: accent, still: !listening),
                  child: Center(
                    child: AnimatedSwitcher(
                      duration: const Duration(milliseconds: 200),
                      child: Icon(
                        read ? Icons.check_circle_rounded : Icons.contactless_rounded,
                        key: ValueKey(read),
                        size: 64,
                        color: accent,
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
          const SizedBox(height: 10),
          Text(_status, style: t.titleMedium?.copyWith(color: accent, fontWeight: FontWeight.w700), textAlign: TextAlign.center),
          const SizedBox(height: 4),
          Text(
            _state == _Reading.off
                ? (widget.camera ? 'Use the camera or type the number instead.' : 'Turn NFC on in the phone\'s settings, then try again.')
                : widget.hint,
            style: t.bodyMedium?.copyWith(color: context.goMuted),
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 18),
          if (_state == _Reading.off)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: FilledButton.icon(
                onPressed: () {
                  setState(() => _state = _Reading.starting);
                  unawaited(_listen());
                },
                icon: const Icon(Icons.refresh_rounded),
                label: const Text('Try again'),
              ),
            ),
          if (widget.camera)
            OutlinedButton.icon(
              onPressed: () => _finish(_useCamera),
              icon: const Icon(Icons.qr_code_scanner_rounded),
              label: const Text('Scan the code with the camera'),
            ),
          if (widget.typing) ...[
            const SizedBox(height: 10),
            TextField(
              controller: _typed,
              textInputAction: TextInputAction.done,
              onSubmitted: (v) => v.trim().isEmpty ? null : _finish(v.trim()),
              decoration: InputDecoration(
                labelText: 'Or type the number',
                suffixIcon: IconButton(
                  tooltip: 'Use this number',
                  icon: const Icon(Icons.arrow_forward_rounded),
                  onPressed: () => _typed.text.trim().isEmpty ? null : _finish(_typed.text.trim()),
                ),
              ),
            ),
          ],
          const SizedBox(height: 4),
          TextButton(onPressed: () => _finish(null), child: const Text('Cancel')),
        ]),
      ),
    );
  }
}

/// Three rings leaving the mark, the way every contactless reader draws
/// "I am listening". Still, and fainter, when it is not.
class _RingsPainter extends CustomPainter {
  _RingsPainter({required this.progress, required this.colour, required this.still});
  final double progress;
  final Color colour;
  final bool still;

  @override
  void paint(Canvas canvas, Size size) {
    final centre = size.center(Offset.zero);
    final reach = size.shortestSide / 2;
    for (var i = 0; i < 3; i++) {
      final at = still ? (i + 1) / 3 : (progress + i / 3) % 1.0;
      final paint = Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2.5
        ..color = colour.withValues(alpha: still ? 0.16 : (1 - at) * 0.55);
      canvas.drawCircle(centre, 40 + (reach - 40) * at, paint);
    }
  }

  @override
  bool shouldRepaint(_RingsPainter old) => old.progress != progress || old.colour != colour || old.still != still;
}
