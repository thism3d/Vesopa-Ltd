import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/control.dart' show supportedTiles;
import '../data/settings.dart';
import 'board_scale.dart';
import 'theme.dart';

/// What each tile is called on a settings page.
const tileNames = <String, String>{
  'clock': 'Clock',
  'date': 'Date',
  'welcome': 'Welcome message',
  'special': "Today's special",
  'qr': 'QR code',
  'cards': 'Cards we accept',
  'total': 'Running total',
};

/// The big-screen settings on this display (2026-10-17): screen size, zoom,
/// touch, and the tiles. The till has the same controls, and both work (the
/// owner, 2026-10-17: "in touch enabled everything can be controlled by the
/// apps itself"); whichever changes something last wins.
class BigScreenSettings extends ConsumerStatefulWidget {
  const BigScreenSettings({super.key, required this.tillToo});

  /// A till is setting this screen up as well: say so.
  final bool tillToo;

  @override
  ConsumerState<BigScreenSettings> createState() => _BigScreenSettingsState();
}

class _BigScreenSettingsState extends ConsumerState<BigScreenSettings> {
  final _welcome = TextEditingController();
  final _specialTitle = TextEditingController();
  final _specialText = TextEditingController();
  bool _filled = false;

  @override
  void dispose() {
    _welcome.dispose();
    _specialTitle.dispose();
    _specialText.dispose();
    super.dispose();
  }

  void _save(DisplaySettings next) =>
      unawaited(ref.read(displaySettingsProvider.notifier).save(next));

  @override
  Widget build(BuildContext context) {
    final s = ref.watch(displaySettingsProvider).value;
    if (s == null) return const SizedBox.shrink();
    if (!_filled) {
      _welcome.text = s.welcomeText;
      _specialTitle.text = s.specialTitle;
      _specialText.text = s.specialText;
      _filled = true;
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (widget.tillToo)
          const Padding(
            padding: EdgeInsets.only(bottom: 12),
            child: Text(
              'The till can change these too (Customer display); the last change wins.',
              style: TextStyle(color: Brand.inkSoft, fontSize: 13),
            ),
          ),
        const Text(
          'Screen size',
          style: TextStyle(fontWeight: FontWeight.w700, color: Brand.ink),
        ),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final e in BoardScale.presets.entries)
              ChoiceChip(
                label: Text(e.value),
                selected: s.screenSize == e.key,
                onSelected: (_) => _save(s.copyWith(screenSize: e.key)),
              ),
          ],
        ),
        const SizedBox(height: 14),
        Row(
          children: [
            const Text(
              'Zoom',
              style: TextStyle(fontWeight: FontWeight.w700, color: Brand.ink),
            ),
            const SizedBox(width: 12),
            IconButton.filledTonal(
              icon: const Icon(Icons.remove),
              onPressed: s.zoom <= 50
                  ? null
                  : () => _save(s.copyWith(zoom: (s.zoom - 10).clamp(50, 300))),
            ),
            SizedBox(
              width: 64,
              child: Text(
                '${s.zoom}%',
                textAlign: TextAlign.center,
                style: const TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w800,
                  color: Brand.ink,
                ),
              ),
            ),
            IconButton.filledTonal(
              icon: const Icon(Icons.add),
              onPressed: s.zoom >= 300
                  ? null
                  : () => _save(s.copyWith(zoom: (s.zoom + 10).clamp(50, 300))),
            ),
          ],
        ),
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          title: const Text('Touch screen', style: TextStyle(color: Brand.ink)),
          subtitle: const Text(
            'Off for a screen nobody should touch: fingers do nothing, a mouse and keyboard still work, and the till runs it.',
            style: TextStyle(color: Brand.inkSoft),
          ),
          value: s.touch,
          onChanged: (on) => _save(s.copyWith(touch: on)),
        ),
        const SizedBox(height: 8),
        const Text(
          'Tiles',
          style: TextStyle(fontWeight: FontWeight.w700, color: Brand.ink),
        ),
        const SizedBox(height: 4),
        const Text(
          'Extra panels for a big screen. All off unless you turn them on.',
          style: TextStyle(color: Brand.inkSoft, fontSize: 13),
        ),
        for (final id in supportedTiles)
          CheckboxListTile(
            contentPadding: EdgeInsets.zero,
            dense: true,
            title: Text(
              tileNames[id] ?? id,
              style: const TextStyle(color: Brand.ink),
            ),
            value: s.tiles.contains(id),
            onChanged: (on) {
              final next = [
                for (final t in supportedTiles)
                  if (t == id ? on == true : s.tiles.contains(t)) t,
              ];
              _save(s.copyWith(tiles: next));
            },
          ),
        Row(
          children: [
            const Text('Tiles go', style: TextStyle(color: Brand.ink)),
            const SizedBox(width: 12),
            ChoiceChip(
              label: const Text('Along the bottom'),
              selected: s.tilePlace != 'side',
              onSelected: (_) => _save(s.copyWith(tilePlace: 'bottom')),
            ),
            const SizedBox(width: 8),
            ChoiceChip(
              label: const Text('Down the side'),
              selected: s.tilePlace == 'side',
              onSelected: (_) => _save(s.copyWith(tilePlace: 'side')),
            ),
          ],
        ),
        const SizedBox(height: 12),
        TextField(
          controller: _welcome,
          decoration: const InputDecoration(
            labelText: 'Welcome message',
            hintText: 'Welcome to the club',
          ),
          onChanged: (v) => _save(s.copyWith(welcomeText: v)),
        ),
        const SizedBox(height: 10),
        TextField(
          controller: _specialTitle,
          decoration: const InputDecoration(
            labelText: "Today's special: heading",
            hintText: 'Sunday roast',
          ),
          onChanged: (v) => _save(s.copyWith(specialTitle: v)),
        ),
        const SizedBox(height: 10),
        TextField(
          controller: _specialText,
          maxLines: 2,
          decoration: const InputDecoration(
            labelText: "Today's special: details",
            hintText: 'Beef or chicken, £14.95',
          ),
          onChanged: (v) => _save(s.copyWith(specialText: v)),
        ),
      ],
    );
  }
}
