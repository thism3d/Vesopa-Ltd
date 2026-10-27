/// One camera sheet for everything Go scans: a table's QR, a product barcode
/// or PLU, a gift card or a member's card. It answers with the code; the
/// caller decides what the code means.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../theme.dart';

Future<String?> scanCode(BuildContext context, {required String title, String hint = ''}) =>
    showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (c) => _ScanSheet(title: title, hint: hint),
    );

class _ScanSheet extends StatefulWidget {
  const _ScanSheet({required this.title, required this.hint});
  final String title;
  final String hint;
  @override
  State<_ScanSheet> createState() => _ScanSheetState();
}

class _ScanSheetState extends State<_ScanSheet> {
  final _typed = TextEditingController();
  bool _done = false;

  void _finish(String code) {
    if (_done || code.trim().isEmpty) return;
    _done = true;
    HapticFeedback.mediumImpact();
    Navigator.pop(context, code.trim());
  }

  @override
  void dispose() {
    _typed.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.fromLTRB(20, 0, 20, 20 + MediaQuery.viewInsetsOf(context).bottom),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text(widget.title, style: t.titleLarge),
          if (widget.hint.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 4), child: Text(widget.hint, style: t.bodyMedium)),
          const SizedBox(height: 14),
          ClipRRect(
            borderRadius: BorderRadius.circular(Tp.radius),
            child: SizedBox(
              height: 300,
              child: Stack(fit: StackFit.expand, children: [
                MobileScanner(onDetect: (capture) {
                  final raw = capture.barcodes.map((b) => b.rawValue).whereType<String>().firstOrNull;
                  if (raw != null) _finish(raw);
                }),
                // The frame to aim at, pulsing so it reads as live.
                const Center(child: _Reticle()),
              ]),
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _typed,
            textInputAction: TextInputAction.done,
            onSubmitted: _finish,
            decoration: InputDecoration(
              labelText: 'Or type the number',
              suffixIcon: IconButton(icon: const Icon(Icons.arrow_forward_rounded), onPressed: () => _finish(_typed.text)),
            ),
          ),
        ]),
      ),
    );
  }
}

class _Reticle extends StatefulWidget {
  const _Reticle();
  @override
  State<_Reticle> createState() => _ReticleState();
}

class _ReticleState extends State<_Reticle> with SingleTickerProviderStateMixin {
  late final _pulse = AnimationController(vsync: this, duration: const Duration(milliseconds: 1100));

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (ambientMotion(context) && !_pulse.isAnimating) _pulse.repeat(reverse: true);
  }

  @override
  void dispose() {
    _pulse.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
        animation: _pulse,
        builder: (_, _) => Container(
          width: 200 + 12 * _pulse.value,
          height: 200 + 12 * _pulse.value,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(18),
            border: Border.all(color: Tp.lime.withValues(alpha: 0.55 + 0.45 * _pulse.value), width: 3),
          ),
        ),
      );
}
