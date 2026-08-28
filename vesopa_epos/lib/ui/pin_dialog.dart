/// A PIN pad, asked for as a question rather than as a lock screen.
///
/// The idle screen has a pad of its own and keeps it: that one is the lock on
/// the till and owns the whole display. This is the small version — "who is
/// this?" asked in the middle of something else — and it exists because two
/// features now need it and neither of them is signing on.
///
/// A time clock anybody can punch on a colleague's behalf proves nothing, and a
/// Sign On key that hands the till to whoever presses it is not a handover, it
/// is an unlocked till. Both are answered by asking for four digits.
///
/// Deliberately its own pad rather than the platform keyboard: a counter
/// terminal has no keyboard, and the one it can raise covers the dialog.
library;

import 'package:flutter/material.dart';

/// Ask for a PIN. Resolves to the digits typed, or null if it was dismissed.
Future<String?> askForPin(BuildContext context, String title) =>
    showDialog<String>(
      context: context,
      builder: (_) => _PinDialog(title: title),
    );

/// Every PIN the back office issues is four digits, and the pad submits on the
/// fourth. Nobody reaches for Enter on a four-digit PIN.
const _pinLength = 4;

class _PinDialog extends StatefulWidget {
  const _PinDialog({required this.title});

  final String title;

  @override
  State<_PinDialog> createState() => _PinDialogState();
}

class _PinDialogState extends State<_PinDialog> {
  String _pin = '';

  void _key(String key) {
    setState(() {
      if (key == '<') {
        if (_pin.isNotEmpty) _pin = _pin.substring(0, _pin.length - 1);
      } else if (_pin.length < _pinLength) {
        _pin += key;
      }
    });
    if (_pin.length == _pinLength) Navigator.of(context).pop(_pin);
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;

    return AlertDialog(
      title: Text(widget.title),
      content: SizedBox(
        width: 260,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            // Dots, not the digits. Somebody types this at a counter with a
            // queue behind them.
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                for (var i = 0; i < _pinLength; i++)
                  Container(
                    width: 14,
                    height: 14,
                    margin: const EdgeInsets.symmetric(horizontal: 7),
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: i < _pin.length
                          ? scheme.primary
                          : scheme.surfaceContainerHighest,
                    ),
                  ),
              ],
            ),
            const SizedBox(height: 18),
            for (final row in const [
              ['1', '2', '3'],
              ['4', '5', '6'],
              ['7', '8', '9'],
              ['', '0', '<'],
            ])
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    for (final key in row)
                      SizedBox(
                        width: 72,
                        height: 52,
                        child: key.isEmpty
                            ? const SizedBox.shrink()
                            : Padding(
                                padding:
                                    const EdgeInsets.symmetric(horizontal: 4),
                                child: OutlinedButton(
                                  onPressed: () => _key(key),
                                  child: key == '<'
                                      ? const Icon(Icons.backspace_outlined,
                                          size: 18)
                                      : Text(
                                          key,
                                          style: const TextStyle(fontSize: 20),
                                        ),
                                ),
                              ),
                      ),
                  ],
                ),
              ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
      ],
    );
  }
}
