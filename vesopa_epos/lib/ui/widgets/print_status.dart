import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/kitchen_printing.dart';
import '../../main.dart';
import '../printers_page.dart' show printerSettingsProvider;
import '../theme.dart';

/// What the till is doing about paper, right now.
///
/// Deliberately not a dialog and not a blocking wait. A kitchen ticket goes out
/// *after* the order is saved or the money is taken, so by the time anything
/// can go wrong the sale is already done — and the clerk's next customer is
/// already at the counter. Interrupting them to say "KP 2 is unplugged" costs
/// the venue more than the ticket is worth.
///
/// So the state lives here, the top bar renders it, and nothing about it stops
/// anyone from carrying on. A failure stays visible until it is dealt with; a
/// success clears itself after a few seconds.
enum PrintPhase { idle, printing, printed, failed }

class PrintStatus {
  const PrintStatus({
    this.phase = PrintPhase.idle,
    this.message = '',
    this.result,
    this.retrying = false,
  });

  final PrintPhase phase;
  final String message;

  /// The run this status describes, kept so a retry knows which stations
  /// failed and which lines they were carrying.
  final KitchenFireResult? result;

  final bool retrying;

  bool get isVisible => phase != PrintPhase.idle;

  /// Whether there is something to send again.
  bool get canRetry =>
      phase == PrintPhase.failed && (result?.hasFailures ?? false);
}

final printStatusProvider =
    NotifierProvider<PrintStatusController, PrintStatus>(
      PrintStatusController.new,
    );

class PrintStatusController extends Notifier<PrintStatus> {
  Timer? _clear;

  @override
  PrintStatus build() {
    ref.onDispose(() => _clear?.cancel());
    return const PrintStatus();
  }

  void printing(String what) {
    _clear?.cancel();
    state = PrintStatus(phase: PrintPhase.printing, message: what);
  }

  /// Report a finished run.
  ///
  /// A clean run fades out on its own — the clerk does not need to dismiss
  /// something that went right. A failed one stays: it is the only record that
  /// food did not reach a station, and it has to survive until somebody has
  /// either retried it or carried the order through by hand.
  void finished(KitchenFireResult result) {
    _clear?.cancel();
    if (result.isSilent) {
      state = const PrintStatus();
      return;
    }
    if (result.hasFailures) {
      state = PrintStatus(
        phase: PrintPhase.failed,
        message: result.summary,
        result: result,
      );
      return;
    }
    state = PrintStatus(
      phase: PrintPhase.printed,
      message: result.summary,
      result: result,
    );
    _clear = Timer(const Duration(seconds: 4), dismiss);
  }

  void retrying() {
    _clear?.cancel();
    state = PrintStatus(
      phase: PrintPhase.printing,
      message: 'Sending to the kitchen again…',
      result: state.result,
      retrying: true,
    );
  }

  /// A one-off failure that never got as far as a per-station run.
  void failed(String message) {
    _clear?.cancel();
    state = PrintStatus(phase: PrintPhase.failed, message: message);
  }

  void dismiss() {
    _clear?.cancel();
    state = const PrintStatus();
  }
}

/// The top-bar chip. Nothing when there is nothing to say.
///
/// Sits beside the sync badge because they answer the same kind of question —
/// "did the thing I just did actually land?" — and a clerk who has learned to
/// glance at one corner of the screen should not have to learn a second.
class PrintStatusBadge extends ConsumerWidget {
  const PrintStatusBadge({super.key, this.compact = false});

  /// Icon only, for a tablet's app bar where there is no room for words.
  final bool compact;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final status = ref.watch(printStatusProvider);
    if (!status.isVisible) return const SizedBox.shrink();

    final (colour, icon, label) = switch (status.phase) {
      PrintPhase.printing => (Pos.blue, Icons.print_outlined, 'Printing…'),
      PrintPhase.printed => (Pos.green, Icons.check_circle_outline, 'Sent'),
      PrintPhase.failed => (Pos.red, Icons.print_disabled_outlined, 'Not sent'),
      PrintPhase.idle => (Pos.graphite, Icons.print_outlined, ''),
    };

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 6),
      child: Tooltip(
        message: status.message,
        child: Material(
          color: Colors.transparent,
          child: InkWell(
            borderRadius: BorderRadius.circular(20),
            onTap: () => _open(context, ref),
            child: Container(
              padding: EdgeInsets.symmetric(
                horizontal: compact ? 8 : 11,
                vertical: 6,
              ),
              decoration: BoxDecoration(
                color: colour.withValues(alpha: 0.14),
                borderRadius: BorderRadius.circular(20),
                border: Border.all(color: colour.withValues(alpha: 0.5)),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (status.phase == PrintPhase.printing)
                    SizedBox(
                      width: 14,
                      height: 14,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        valueColor: AlwaysStoppedAnimation(colour),
                      ),
                    )
                  else
                    Icon(icon, size: 16, color: colour),
                  if (!compact) ...[
                    const SizedBox(width: 7),
                    Text(
                      label,
                      style: TextStyle(
                        color: colour,
                        fontSize: 12.5,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  /// The detail, and the way out of it.
  void _open(BuildContext context, WidgetRef ref) {
    final status = ref.read(printStatusProvider);
    if (status.phase == PrintPhase.printing) return;

    showDialog<void>(
      context: context,
      builder: (context) => Consumer(
        builder: (context, ref, _) {
          final live = ref.watch(printStatusProvider);
          final result = live.result;

          return AlertDialog(
            icon: Icon(
              live.phase == PrintPhase.failed
                  ? Icons.print_disabled_outlined
                  : Icons.check_circle_outline,
              size: 30,
              color: live.phase == PrintPhase.failed ? Pos.red : Pos.green,
            ),
            title: Text(
              live.phase == PrintPhase.failed
                  ? 'The kitchen did not get everything'
                  : 'Sent to the kitchen',
            ),
            content: SizedBox(
              width: 420,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (result == null)
                    Text(live.message)
                  else ...[
                    for (final station in result.stations)
                      ListTile(
                        contentPadding: EdgeInsets.zero,
                        dense: true,
                        leading: Icon(
                          station.printed
                              ? Icons.check_circle
                              : Icons.error_outline,
                          color: station.printed ? Pos.green : Pos.red,
                        ),
                        title: Text(station.label),
                        subtitle: Text(
                          station.printed
                              ? 'Ticket printed'
                              : station.error ?? 'Did not print',
                          style: const TextStyle(fontSize: 12),
                        ),
                      ),
                    if (live.phase == PrintPhase.failed) ...[
                      const SizedBox(height: 10),
                      Text(
                        'Retrying sends the same ticket again, only to the '
                        'stations that failed. Nothing else on the bill is '
                        'reprinted.',
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                    ],
                  ],
                ],
              ),
            ),
            actions: [
              TextButton(
                onPressed: () {
                  ref.read(printStatusProvider.notifier).dismiss();
                  Navigator.pop(context);
                },
                child: const Text('Dismiss'),
              ),
              if (live.canRetry)
                FilledButton.icon(
                  onPressed: live.retrying
                      ? null
                      : () {
                          Navigator.pop(context);
                          unawaited(_retry(context, ref, live));
                        },
                  icon: const Icon(Icons.refresh, size: 18),
                  label: const Text('Print again'),
                ),
            ],
          );
        },
      ),
    );
  }

  Future<void> _retry(
    BuildContext context,
    WidgetRef ref,
    PrintStatus status,
  ) async {
    final previous = status.result;
    if (previous == null) return;

    final controller = ref.read(printStatusProvider.notifier);
    controller.retrying();
    try {
      final printers = await ref.read(printerSettingsProvider.future);
      final result = await ref
          .read(kitchenPrintingProvider)
          .retry(
            previous: previous,
            printers: printers,
            stationNames: ref.read(tillSettingsProvider).printerNames,
            staffName: ref.read(servedByProvider),
          );
      controller.finished(result);
    } catch (e) {
      controller.failed('Could not print again: $e');
    }
  }
}
