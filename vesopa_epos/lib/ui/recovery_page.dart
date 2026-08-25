import 'package:flutter/material.dart';

import '../data/startup_repair.dart';
import 'theme.dart';

/// Shown when the till cannot get itself started.
///
/// It exists because of what used to be here instead: a spinner, on black, in a
/// window the till deliberately will not let anybody close. A terminal whose
/// preferences file had been truncated by a power cut showed that for ever, and
/// the only cure was somebody who knew to delete a folder in AppData. An
/// operator cannot be asked to work that out with a queue at the counter.
///
/// The till repairs the common case by itself on the way up — see
/// [repairStorageIfNeeded] — so most terminals never see this. This is the
/// backstop for when the automatic repair did not take, and for a start-up that
/// hangs for a reason nobody has met yet.
///
/// Two actions, and the difference between them is the whole point:
///
///   * **Repair** clears the cached settings and sign-in. It costs a sign-in
///     and nothing else, because everything it removes can be sent again by the
///     back office.
///   * **Reset everything** also removes the sales database, and that database
///     holds sales rung up but not yet pushed — for those it is the only copy
///     of the money. So it is never automatic, it is behind a confirmation that
///     says so in those words, and it is the operator's decision.
class RecoveryPage extends StatefulWidget {
  const RecoveryPage({
    super.key,
    required this.onRetry,
    this.failure,
    this.stuck = false,
  });

  /// Re-run whatever was stuck. The caller invalidates the providers.
  final Future<void> Function() onRetry;

  /// What went wrong, when anything said so.
  final Object? failure;

  /// True when nothing threw and the till simply never finished starting.
  final bool stuck;

  @override
  State<RecoveryPage> createState() => _RecoveryPageState();
}

class _RecoveryPageState extends State<RecoveryPage> {
  bool _busy = false;
  String? _note;

  Future<void> _run(Future<void> Function() work, String done) async {
    setState(() {
      _busy = true;
      _note = null;
    });
    try {
      await work();
      await widget.onRetry();
      if (mounted) setState(() => _note = done);
    } catch (e) {
      if (mounted) setState(() => _note = 'That did not work: $e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _confirmFullReset() async {
    final agreed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Reset everything on this terminal?'),
        content: const Text(
          'This removes the sales database as well as the settings.\n\n'
          'Any sale rung up on this till that has not yet reached the back '
          'office will be lost, and there is no other copy of it. Only do this '
          'if the till still will not start after a repair.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: Pos.red),
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Reset everything'),
          ),
        ],
      ),
    );
    if (agreed != true) return;
    await _run(resetEverything, 'Reset. The till will ask to be signed in.');
  }

  @override
  Widget build(BuildContext context) {
    final pal = PayPalette.of(context);

    return Scaffold(
      backgroundColor: pal.canvas,
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(32),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 560),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'This till could not finish starting',
                  style: TextStyle(
                    color: pal.ink,
                    fontSize: 26,
                    fontWeight: FontWeight.w700,
                    letterSpacing: -0.3,
                  ),
                ),
                const SizedBox(height: 12),
                Text(
                  widget.stuck
                      ? 'It has been waiting on its own stored settings for longer than it '
                            'ever should. Repairing clears them and starts again.'
                      : 'Its stored settings could not be read. Repairing clears them and '
                            'starts again.',
                  style: TextStyle(color: pal.inkMuted, fontSize: 15, height: 1.45),
                ),
                const SizedBox(height: 20),

                // The reassurance that decides whether somebody dares press the
                // button. Said before the button, not after it.
                Container(
                  padding: const EdgeInsets.all(14),
                  decoration: BoxDecoration(
                    color: pal.panel,
                    borderRadius: BorderRadius.circular(10),
                    border: Border.all(color: pal.panelLine),
                  ),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Icon(Icons.shield_outlined, color: Pos.brand, size: 20),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Text(
                          'Repairing keeps every sale on this till. It clears the sign-in '
                          'and the settings the back office sends, so you will be asked to '
                          'sign in again — nothing else is removed.',
                          style: TextStyle(
                            color: pal.ink,
                            fontSize: 13.5,
                            height: 1.45,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 22),

                Row(
                  children: [
                    FilledButton(
                      onPressed: _busy
                          ? null
                          : () => _run(
                              () async {
                                await repairStorageIfNeeded();
                              },
                              'Repaired. Signing in will finish setting the till up.',
                            ),
                      child: Padding(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 10,
                          vertical: 6,
                        ),
                        child: Text(_busy ? 'Working…' : 'Repair and continue'),
                      ),
                    ),
                    const SizedBox(width: 12),
                    TextButton(
                      onPressed: _busy ? null : () => _run(() async {}, 'Trying again…'),
                      child: const Text('Try again'),
                    ),
                  ],
                ),

                if (_note != null) ...[
                  const SizedBox(height: 14),
                  Text(
                    _note!,
                    style: TextStyle(color: Pos.brand, fontSize: 13.5),
                  ),
                ],

                const SizedBox(height: 28),
                Divider(color: pal.panelLine),
                const SizedBox(height: 12),

                Text(
                  'Still not starting?',
                  style: TextStyle(
                    color: pal.ink,
                    fontSize: 15,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 6),
                Text(
                  'A full reset also removes the sales database. Any sale not yet sent to '
                  'the back office would be lost with it, so try a repair first.',
                  style: TextStyle(color: pal.inkMuted, fontSize: 13, height: 1.45),
                ),
                const SizedBox(height: 10),
                TextButton(
                  onPressed: _busy ? null : _confirmFullReset,
                  style: TextButton.styleFrom(foregroundColor: Pos.red),
                  child: const Text('Reset everything on this terminal'),
                ),

                // For whoever picks up the phone about it. Small, last, and
                // never the first thing an operator reads.
                if (widget.failure != null) ...[
                  const SizedBox(height: 18),
                  SelectableText(
                    '${widget.failure}',
                    style: TextStyle(
                      color: pal.inkMuted,
                      fontSize: 11.5,
                      fontFamily: 'monospace',
                    ),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}
