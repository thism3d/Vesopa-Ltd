/// The controls the settings page is built from.
///
/// Kept apart from the page itself because they are the part with opinions in
/// them — how a folder is chosen, how a volume is set, how two ways of fitting
/// a picture are offered — and the page is then just the order they appear in.
library;

import 'dart:async';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';

import 'theme.dart';

/// Choosing a folder by pointing at it.
///
/// The path is still shown, because somebody setting up two screens needs to
/// see which is which. It is not typed. Asking a manager to type
/// `D:\Vesopa\Adverts` means the one they type is the one with the typo in it,
/// and the failure that produces — a screen quietly showing nothing — is the
/// hardest kind to work back from.
class FolderField extends StatelessWidget {
  const FolderField({
    super.key,
    required this.label,
    required this.path,
    required this.onPicked,
    required this.onCleared,
    this.note,
  });

  final String label;
  final String path;
  final ValueChanged<String> onPicked;
  final VoidCallback onCleared;
  final String? note;

  Future<void> _choose() async {
    // Opens on the folder already chosen, so changing one of two screens is a
    // click rather than a walk back down the tree.
    final trimmed = path.trim();
    final chosen = await getDirectoryPath(
      initialDirectory: trimmed.isEmpty ? null : trimmed,
      confirmButtonText: 'Use this folder',
    );
    if (chosen != null) onPicked(chosen);
  }

  @override
  Widget build(BuildContext context) {
    final chosen = path.trim().isNotEmpty;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          label,
          style: const TextStyle(
            color: Brand.ink,
            fontSize: 14,
            fontWeight: FontWeight.w600,
          ),
        ),
        const SizedBox(height: 8),
        Row(
          children: [
            Expanded(
              child: Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 12,
                ),
                decoration: BoxDecoration(
                  color: Brand.panel,
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: Brand.line),
                ),
                child: Row(
                  children: [
                    Icon(
                      chosen ? Icons.folder : Icons.folder_off_outlined,
                      size: 18,
                      color: chosen ? Brand.lime : Brand.inkSoft,
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        chosen ? path.trim() : 'No folder chosen',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontFamily: chosen ? 'Consolas' : null,
                          fontSize: 13,
                          color: chosen ? Brand.ink : Brand.inkSoft,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(width: 8),
            FilledButton.icon(
              onPressed: () => unawaited(_choose()),
              icon: const Icon(Icons.folder_open, size: 18),
              label: const Text('Choose'),
            ),
            if (chosen) ...[
              const SizedBox(width: 4),
              IconButton(
                tooltip: 'Clear',
                onPressed: onCleared,
                icon: const Icon(Icons.close, size: 18, color: Brand.inkSoft),
              ),
            ],
          ],
        ),
        if (note != null) ...[
          const SizedBox(height: 8),
          Text(
            note!,
            style: const TextStyle(color: Brand.inkSoft, fontSize: 12.5),
          ),
        ],
      ],
    );
  }
}

/// A speaker that opens a slider, and puts it away again once it has been set.
///
/// Modelled on the control everybody already has in their pocket: the icon says
/// the state at a glance, and the slider is only on screen while it is being
/// used. A slider sitting permanently on the page invites somebody to nudge the
/// volume of a screen in a quiet room on their way past.
class VolumeControl extends StatefulWidget {
  const VolumeControl({
    super.key,
    required this.volume,
    required this.onChanged,
  });

  final int volume;
  final ValueChanged<int> onChanged;

  @override
  State<VolumeControl> createState() => _VolumeControlState();
}

class _VolumeControlState extends State<VolumeControl> {
  bool _open = false;
  Timer? _close;

  /// Held open while it is being dragged, then wound down. Without the delay
  /// the slider would vanish under the finger still setting it.
  void _keepOpen() {
    _close?.cancel();
    _close = Timer(const Duration(milliseconds: 1600), () {
      if (mounted) setState(() => _open = false);
    });
  }

  @override
  void dispose() {
    _close?.cancel();
    super.dispose();
  }

  IconData get _icon {
    if (widget.volume == 0) return Icons.volume_off_rounded;
    if (widget.volume < 34) return Icons.volume_mute_rounded;
    if (widget.volume < 67) return Icons.volume_down_rounded;
    return Icons.volume_up_rounded;
  }

  @override
  Widget build(BuildContext context) => Row(
    children: [
      IconButton(
        tooltip: widget.volume == 0 ? 'Silent' : '${widget.volume}%',
        icon: Icon(
          _icon,
          color: widget.volume == 0 ? Brand.inkSoft : Brand.lime,
        ),
        onPressed: () {
          setState(() => _open = !_open);
          if (_open) _keepOpen();
        },
      ),
      const SizedBox(width: 4),
      Expanded(
        child: AnimatedSwitcher(
          duration: const Duration(milliseconds: 180),
          child: _open
              ? Row(
                  key: const ValueKey('open'),
                  children: [
                    Expanded(
                      child: Slider(
                        value: widget.volume.toDouble(),
                        max: 100,
                        divisions: 20,
                        label: '${widget.volume}%',
                        onChanged: (v) {
                          widget.onChanged(v.round());
                          _keepOpen();
                        },
                      ),
                    ),
                    SizedBox(
                      width: 46,
                      child: Text(
                        '${widget.volume}%',
                        textAlign: TextAlign.right,
                        style: const TextStyle(
                          color: Brand.lime,
                          fontSize: 13,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                  ],
                )
              : Align(
                  key: const ValueKey('shut'),
                  alignment: Alignment.centerLeft,
                  child: Text(
                    widget.volume == 0
                        ? 'Clips play silently'
                        : 'Clips play at ${widget.volume}%',
                    style: const TextStyle(
                      color: Brand.inkSoft,
                      fontSize: 12.5,
                    ),
                  ),
                ),
        ),
      ),
    ],
  );
}

/// The two ways to fit a picture, offered as what they do rather than named.
class FitChoice extends StatelessWidget {
  const FitChoice({
    super.key,
    required this.label,
    required this.fill,
    required this.onChanged,
  });

  final String label;
  final bool fill;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) => Row(
    children: [
      Expanded(
        child: Text(
          label,
          style: const TextStyle(color: Brand.ink, fontSize: 14),
        ),
      ),
      SegmentedButton<bool>(
        segments: const [
          ButtonSegment(
            value: true,
            icon: Icon(Icons.crop_free, size: 16),
            label: Text('Fill'),
          ),
          ButtonSegment(
            value: false,
            icon: Icon(Icons.fit_screen_outlined, size: 16),
            label: Text('Fit'),
          ),
        ],
        selected: {fill},
        showSelectedIcon: false,
        onSelectionChanged: (v) => onChanged(v.first),
      ),
    ],
  );
}

/// How long the status panel stays up, offered as the handful of answers a
/// venue actually gives rather than as a slider over every number.
class HideAfterChoice extends StatelessWidget {
  const HideAfterChoice({
    super.key,
    required this.seconds,
    required this.onChanged,
  });

  final int seconds;
  final ValueChanged<int> onChanged;

  static const _options = <int, String>{
    5: '5s',
    10: '10s',
    15: '15s',
    60: '1 min',
    120: '2 min',
    300: '5 min',
    0: 'Never',
  };

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      const Text(
        'Hide it again after',
        style: TextStyle(
          color: Brand.ink,
          fontSize: 14,
          fontWeight: FontWeight.w600,
        ),
      ),
      const SizedBox(height: 10),
      Wrap(
        spacing: 8,
        runSpacing: 8,
        children: [
          for (final entry in _options.entries)
            ChoiceChip(
              label: Text(entry.value),
              selected: seconds == entry.key,
              onSelected: (_) => onChanged(entry.key),
            ),
        ],
      ),
      const SizedBox(height: 8),
      Text(
        seconds == 0
            ? 'It stays until somebody closes it — right while a screen is '
                  'being set up, and wrong once customers can see it.'
            : 'A tap anywhere on the screen brings it back.',
        style: const TextStyle(color: Brand.inkSoft, fontSize: 12.5),
      ),
    ],
  );
}
