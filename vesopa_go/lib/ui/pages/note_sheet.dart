/// A note for the kitchen: the venue's quick notes (back office, Vesopa Go
/// options) as chips, and free text, which the keyboard's microphone can
/// dictate. Answers the note, or null when cancelled.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/session.dart';

Future<String?> askNote(BuildContext context, WidgetRef ref, {required String title, String initial = ''}) {
  final chips = ref.read(tapProvider).config.go.noteChips;
  return showModalBottomSheet<String>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (c) => _NoteSheet(title: title, initial: initial, chips: chips),
  );
}

class _NoteSheet extends StatefulWidget {
  const _NoteSheet({required this.title, required this.initial, required this.chips});
  final String title;
  final String initial;
  final List<String> chips;
  @override
  State<_NoteSheet> createState() => _NoteSheetState();
}

class _NoteSheetState extends State<_NoteSheet> {
  late final _text = TextEditingController(text: widget.initial);

  List<String> get _parts => _text.text.split(',').map((s) => s.trim()).where((s) => s.isNotEmpty).toList();

  void _toggle(String chip) {
    final parts = _parts;
    parts.contains(chip) ? parts.remove(chip) : parts.add(chip);
    setState(() => _text.text = parts.join(', '));
  }

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final parts = _parts;
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.fromLTRB(20, 0, 20, 20 + MediaQuery.viewInsetsOf(context).bottom),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('Note for ${widget.title}', style: t.titleLarge),
          const SizedBox(height: 12),
          Wrap(spacing: 8, runSpacing: 8, children: [
            for (final c in widget.chips) FilterChip(label: Text(c), selected: parts.contains(c), onSelected: (_) => _toggle(c)),
          ]),
          const SizedBox(height: 12),
          TextField(
            controller: _text,
            autofocus: widget.chips.isEmpty,
            textCapitalization: TextCapitalization.sentences,
            maxLength: 200,
            onChanged: (_) => setState(() {}),
            decoration: const InputDecoration(labelText: 'Instructions', helperText: 'Type, or use the microphone on the keyboard'),
          ),
          const SizedBox(height: 8),
          Row(children: [
            if (widget.initial.isNotEmpty)
              TextButton(onPressed: () => Navigator.pop(context, ''), child: const Text('Remove the note')),
            const Spacer(),
            FilledButton(
              style: FilledButton.styleFrom(minimumSize: const Size(140, 52)),
              onPressed: () => Navigator.pop(context, _text.text.trim()),
              child: const Text('Done'),
            ),
          ]),
        ]),
      ),
    );
  }
}
