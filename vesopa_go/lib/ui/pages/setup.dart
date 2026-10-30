/// Signed in: how this phone is used.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/models.dart';
import '../../data/session.dart';
import '../theme.dart';

class SetupPage extends ConsumerWidget {
  const SetupPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final venue = ref.watch(tapProvider.select((s) => s.venue));
    final t = Theme.of(context).textTheme;
    Widget option(VenueMode mode, IconData icon, String title, String body) => Card(
          child: InkWell(
            borderRadius: BorderRadius.circular(Tp.radius),
            onTap: () => ref.read(tapProvider.notifier).chooseMode(mode),
            child: Padding(
              padding: const EdgeInsets.all(20),
              child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Icon(icon, size: 32, color: context.goLimeInk),
                const SizedBox(width: 16),
                Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(title, style: t.titleLarge),
                  const SizedBox(height: 6),
                  Text(body, style: t.bodyMedium),
                ])),
                const Icon(Icons.chevron_right_rounded),
              ]),
            ),
          ),
        );
    return Scaffold(
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(24),
          children: [
            const SizedBox(height: 24),
            Text('Signed in to', style: t.titleMedium),
            Text(venue?.name ?? 'your venue', style: t.headlineMedium),
            const SizedBox(height: 8),
            Text('This phone counts as one of the venue\'s tills.', style: t.bodyMedium),
            const SizedBox(height: 28),
            option(VenueMode.connected, Icons.hub_rounded, 'With Vesopa EPOS',
                'Beside your tills: the same tables, bills, menu and kitchen screens. A table opened here is on every till.'),
            const SizedBox(height: 14),
            option(VenueMode.standalone, Icons.phone_iphone_rounded, 'On its own',
                'No tills needed: a simple menu or a typed amount, and card payments on the phone. Every sale is in your back office.'),
            const SizedBox(height: 28),
            TextButton(onPressed: () => ref.read(tapProvider.notifier).forgetPhone(), child: const Text('Not this venue? Sign out')),
          ],
        ),
      ),
    );
  }
}
