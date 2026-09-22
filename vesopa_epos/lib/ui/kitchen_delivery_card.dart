import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/till_settings.dart';
import '../main.dart'
    show
        apiBaseProvider,
        kitchenScreenSenderProvider,
        sessionProvider,
        tillSettingsProvider;
import '../printing/print_targets.dart';
import 'widgets/pos_message.dart';

/// Where each kitchen station's tickets come out: paper, a screen, or both.
///
/// Lives on the printers screen because that is where somebody goes when they
/// are thinking about the kitchen, and because the two settings are read
/// together — "KP 3 has no printer on this till" means something very different
/// once KP 3 is on a screen.
///
/// Unlike everything else on that screen, this is **venue-wide**. Setting it
/// here changes it for every till in the building, which is stated on the card
/// rather than left to be discovered: a manager who thinks they are configuring
/// one counter and has in fact reconfigured four is a support call.
class KitchenDeliveryCard extends ConsumerStatefulWidget {
  const KitchenDeliveryCard({super.key});

  @override
  ConsumerState<KitchenDeliveryCard> createState() =>
      _KitchenDeliveryCardState();
}

class _KitchenDeliveryCardState extends ConsumerState<KitchenDeliveryCard> {
  /// The station currently being saved, so its row can show a spinner and the
  /// rest of the card stays usable.
  String? _saving;

  /// How many tickets are waiting to reach the screens.
  ///
  /// Shown because it is the one thing about this feature that can be wrong in
  /// a way nobody would otherwise see: the till reports a successful sale, the
  /// kitchen gets nothing, and the only evidence is a number on a settings
  /// screen. Better to put the number where somebody will find it.
  int _queued = 0;

  @override
  void initState() {
    super.initState();
    _readQueue();
  }

  Future<void> _readQueue() async {
    try {
      final pending = await ref.read(kitchenScreenSenderProvider).pending();
      if (mounted) setState(() => _queued = pending);
    } catch (_) {
      // A settings screen that cannot count the queue should still show the
      // settings.
    }
  }

  Future<void> _set(String station, KitchenDelivery mode) async {
    final session = ref.read(sessionProvider);
    final client = KitchenDeliveryClient(
      apiBase: ref.read(apiBaseProvider),
      terminalToken: session.terminalToken,
    );

    setState(() => _saving = station);
    try {
      await client.setMode(station, mode);
      // Re-read rather than patch the local copy: the server is the venue's
      // record of this, and showing what it stored is what keeps four tills
      // agreeing about where the fryer's food goes.
      ref.invalidate(tillSettingsProvider);
      if (mounted) {
        PosMessenger.success(context, 'Saved for every till in this venue.');
      }
    } catch (e) {
      if (mounted) PosMessenger.error(context, '$e');
    } finally {
      if (mounted) setState(() => _saving = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final settings = ref.watch(tillSettingsProvider);
    final commissioned = ref.watch(sessionProvider).commissioned;
    final theme = Theme.of(context);

    return Card(
      margin: EdgeInsets.zero,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 4),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    const Icon(Icons.tv_outlined, size: 20),
                    const SizedBox(width: 8),
                    Text(
                      'Kitchen screens',
                      style: theme.textTheme.titleMedium,
                    ),
                  ],
                ),
                const SizedBox(height: 6),
                Text(
                  'Vesopa Kitchen shows a station its orders on a screen '
                  'instead of printing them. Products are still routed to KP 1 '
                  'to KP 6 in the back office exactly as they are now — this '
                  'only decides where each station\'s ticket comes out.',
                  style: theme.textTheme.bodySmall,
                ),
                const SizedBox(height: 6),
                Text(
                  'This applies to every till in the venue, not just this one.',
                  style: theme.textTheme.bodySmall?.copyWith(
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ),
          ),

          if (!commissioned)
            const Padding(
              padding: EdgeInsets.fromLTRB(16, 10, 16, 12),
              child: Text(
                'Sign this till in again to change these — it was set up '
                'before terminals carried their own credential, so the back '
                'office cannot tell that the change came from this venue.',
                style: TextStyle(fontSize: 12.5),
              ),
            ),

          const Divider(height: 20),

          for (final target in PrintTarget.kitchenStations) ...[
            if (target != PrintTarget.kitchenStations.first)
              const Divider(height: 1),
            _StationRow(
              label: settings.labelFor(target),
              station: target.station!,
              mode: settings.deliveryFor(target.station!),
              busy: _saving == target.station,
              enabled: commissioned && _saving == null,
              onChanged: (mode) => _set(target.station!, mode),
            ),
          ],

          if (_queued > 0)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 14),
              child: Row(
                children: [
                  const Icon(Icons.cloud_off_outlined, size: 18),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      _queued == 1
                          ? '1 ticket is waiting to reach the kitchen screens. '
                                'It is sent automatically when the link comes '
                                'back, and dropped if it gets more than ten '
                                'minutes old.'
                          : '$_queued tickets are waiting to reach the kitchen '
                                'screens. They are sent automatically when the '
                                'link comes back, and dropped once they are '
                                'more than ten minutes old.',
                      style: theme.textTheme.bodySmall,
                    ),
                  ),
                  TextButton(
                    onPressed: () async {
                      await ref.read(kitchenScreenSenderProvider).flush();
                      await _readQueue();
                    },
                    child: const Text('Try now'),
                  ),
                ],
              ),
            )
          else
            const SizedBox(height: 6),
        ],
      ),
    );
  }
}

class _StationRow extends StatelessWidget {
  const _StationRow({
    required this.label,
    required this.station,
    required this.mode,
    required this.busy,
    required this.enabled,
    required this.onChanged,
  });

  final String label;
  final String station;
  final KitchenDelivery mode;
  final bool busy;
  final bool enabled;
  final ValueChanged<KitchenDelivery> onChanged;

  @override
  Widget build(BuildContext context) {
    return ListTile(
      title: Text(label),
      // The slot number as well as the venue's name for it, because the product
      // editor in the back office lists both and a manager cross-referencing
      // the two screens needs the key that appears on each.
      subtitle: Text(
        station.toUpperCase().replaceFirst('KP', 'KP '),
        style: const TextStyle(fontSize: 12),
      ),
      trailing: busy
          ? const SizedBox(
              width: 20,
              height: 20,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          : SegmentedButton<KitchenDelivery>(
              segments: const [
                ButtonSegment(
                  value: KitchenDelivery.printer,
                  icon: Icon(Icons.print_outlined),
                  tooltip: 'Print a ticket at this station',
                ),
                ButtonSegment(
                  value: KitchenDelivery.screen,
                  icon: Icon(Icons.tv_outlined),
                  tooltip: 'Show it on the kitchen screen instead',
                ),
                ButtonSegment(
                  value: KitchenDelivery.both,
                  icon: Icon(Icons.done_all),
                  tooltip: 'Both — paper and screen',
                ),
              ],
              selected: {mode},
              showSelectedIcon: false,
              onSelectionChanged: enabled
                  ? (next) => onChanged(next.first)
                  : null,
            ),
    );
  }
}
