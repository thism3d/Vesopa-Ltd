/// After sign-in, on a device the back office leaves to choose: EPOS, Vesopa
/// Kitchen or Customer display (owner, 2026-11-03).
///
/// Laid out the way Apple's setup screens are: a large title that says what
/// is being decided, one sentence under it, and the choices as big, plainly
/// labelled cards (three across where there is room, a list on a phone),
/// each a single tap with a light haptic. Nothing is hidden behind a menu,
/// and the words say it can be changed later, so the choice is not a worry.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/session.dart';
import '../ui/pages/setup.dart' show AnimatedModeChooser;
import 'device_mode.dart';

class ModeChooserPage extends ConsumerWidget {
  const ModeChooserPage({super.key});

  // Drawn as the setup page is (ui/pages/setup.dart): each mode's motion
  // picture, drifting glows, the cards rising in turn (owner, 2026-11-17).
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final venue = ref.watch(tapProvider.select((s) => s.venue?.name)) ?? 'your venue';
    return AnimatedModeChooser(
      venue: venue,
      onChoose: (m) => ref.read(deviceModeProvider.notifier).choose(m),
    );
  }
}
