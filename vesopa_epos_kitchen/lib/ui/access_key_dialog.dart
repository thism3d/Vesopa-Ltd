import 'package:flutter/material.dart';

/// What somebody typed to license this device.
class AccessKeyAnswer {
  const AccessKeyAnswer(this.venueCode, this.terminalNumber, this.accessKey);
  final String venueCode;
  final String terminalNumber;
  final String accessKey;
}

/// Venue code, terminal number and access key, from Terminals in the back
/// office. Null when cancelled. Licensing it is the caller's: this only asks.
Future<AccessKeyAnswer?> askForAccessKey(BuildContext context) {
  return showDialog<AccessKeyAnswer>(
    context: context,
    builder: (_) => const _AccessKeyDialog(),
  );
}

class _AccessKeyDialog extends StatefulWidget {
  const _AccessKeyDialog();

  @override
  State<_AccessKeyDialog> createState() => _AccessKeyDialogState();
}

class _AccessKeyDialogState extends State<_AccessKeyDialog> {
  final _venue = TextEditingController();
  final _number = TextEditingController();
  final _key = TextEditingController();

  @override
  void dispose() {
    _venue.dispose();
    _number.dispose();
    _key.dispose();
    super.dispose();
  }

  bool get _ready =>
      _venue.text.trim().isNotEmpty &&
      _number.text.trim().isNotEmpty &&
      _key.text.trim().isNotEmpty;

  void _done() {
    if (!_ready) return;
    Navigator.of(context).pop(AccessKeyAnswer(_venue.text.trim(), _number.text.trim(), _key.text.trim()));
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Use an access key'),
      content: SizedBox(
        width: 380,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
              controller: _venue,
              autofocus: true,
              keyboardType: TextInputType.number,
              onChanged: (_) => setState(() {}),
              decoration: const InputDecoration(labelText: 'Venue code'),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _number,
              keyboardType: TextInputType.number,
              onChanged: (_) => setState(() {}),
              decoration: const InputDecoration(labelText: 'Terminal number'),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _key,
              textCapitalization: TextCapitalization.characters,
              onChanged: (_) => setState(() {}),
              onSubmitted: (_) => _done(),
              decoration: const InputDecoration(
                labelText: 'Access key',
                helperText: 'From Terminals in the back office.',
              ),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancel')),
        FilledButton(onPressed: _ready ? _done : null, child: const Text('License')),
      ],
    );
  }
}
