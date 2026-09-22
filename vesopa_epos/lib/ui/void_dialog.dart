import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;

import '../main.dart';
import 'theme.dart';
import 'widgets/on_screen_keyboard.dart';

/// The void reasons offered on the till. Defined in the back office; cached in
/// prefs is overkill for a short list, so this just fetches with a sensible
/// fallback for when the network is down.
final voidReasonsProvider = FutureProvider<List<String>>((ref) async {
  const fallback = [
    'Customer changed mind',
    'Wrong item rung up',
    'Duplicate order',
    'Kitchen error',
    'Other',
  ];
  try {
    final res = await http
        .get(Uri.parse('${ref.watch(apiBaseProvider)}/till/void-reasons'))
        .timeout(const Duration(seconds: 5));
    if (res.statusCode != 200) return fallback;
    final reasons = (jsonDecode(res.body) as List<dynamic>).cast<String>();
    return reasons.isEmpty ? fallback : reasons;
  } catch (_) {
    return fallback;
  }
});

/// Confirms a void and captures why. Returns the chosen reason, or null if
/// cancelled. A void with no reason is not allowed — that is the whole point of
/// the audit trail.
///
/// Two shapes, because they are very different acts: [wholeCheck] cancels the
/// entire sale, while the default removes the picked lines. The dialog says
/// which, and names the items, so a clerk cannot clear a table's whole bill
/// while believing they are dropping one coffee.
Future<String?> showVoidDialog(
  BuildContext context,
  WidgetRef ref, {
  bool wholeCheck = false,
  int itemCount = 0,
  String itemSummary = '',
}) {
  return showDialog<String>(
    context: context,
    builder: (_) => _VoidDialog(
      wholeCheck: wholeCheck,
      itemCount: itemCount,
      itemSummary: itemSummary,
    ),
  );
}

class _VoidDialog extends ConsumerStatefulWidget {
  const _VoidDialog({
    required this.wholeCheck,
    required this.itemCount,
    required this.itemSummary,
  });

  final bool wholeCheck;
  final int itemCount;
  final String itemSummary;

  @override
  ConsumerState<_VoidDialog> createState() => _VoidDialogState();
}

class _VoidDialogState extends ConsumerState<_VoidDialog> {
  String? _selected;
  final _custom = TextEditingController();

  @override
  void initState() {
    super.initState();
    // Follow the field itself, not just the keystrokes Flutter reports.
    //
    // This is the whole of "typing a reason still won't let me press Void".
    // The button is gated on [_canConfirm], which reads this controller, and
    // the on-screen keyboard below types by *writing to the controller* —
    // `controller.value = ...`. A programmatic write like that does not go
    // through the input connection, so `TextField.onChanged` never fires for
    // it. On a till, which is a touch screen with no keyboard behind it, that
    // is every character a clerk types: the reason appeared in the box and the
    // only button that would accept it stayed grey.
    //
    // A listener on the controller sees both paths — the on-screen keyboard
    // and a hardware one — which is why the fix belongs here rather than on
    // another `onChanged`. The same omission was found and fixed in the sale
    // page's field dialog; this dialog is the one it was named after and the
    // one that never got it.
    _custom.addListener(_onCustomChanged);
  }

  @override
  void dispose() {
    _custom.removeListener(_onCustomChanged);
    _custom.dispose();
    super.dispose();
  }

  void _onCustomChanged() {
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final reasons = ref.watch(voidReasonsProvider).value ?? const [];
    final isCustom = _selected == '__custom__';

    final whole = widget.wholeCheck;

    return AlertDialog(
      title: Row(
        children: [
          Icon(whole ? Icons.block : Icons.backspace_outlined, color: Pos.red),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              whole
                  ? 'Cancel the whole check?'
                  : widget.itemCount == 1
                      ? 'Void this item?'
                      : 'Void ${widget.itemCount} items?',
            ),
          ),
        ],
      ),
      // Scrollable so that when "Other reason…" pulls up the on-screen
      // keyboard, the shrunken content area scrolls instead of overflowing.
      content: SizedBox(
        // Widened once the keyboard is showing. The keyboard divides its keys
        // out of whatever width it is given and will not overflow a narrow one
        // — it just makes the keys too small to hit, which on a list of
        // reasons somebody is typing under pressure is the same as broken.
        width: isCustom ? 660 : 380,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                whole
                    ? 'This clears every item on the bill. Choose a reason — it '
                        'is recorded against the terminal.'
                    : 'The rest of the bill stays as it is. Choose a reason — '
                        'it is recorded against the terminal.',
                style: Theme.of(context).textTheme.bodyMedium,
              ),
              // Name what is going. "Void 3 items" with no list is how the
              // wrong three get voided.
              if (!whole && widget.itemSummary.isNotEmpty) ...[
                const SizedBox(height: 10),
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.symmetric(
                    horizontal: 10,
                    vertical: 8,
                  ),
                  decoration: BoxDecoration(
                    color: Theme.of(context).colorScheme.surfaceContainerHighest,
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Text(
                    widget.itemSummary,
                    style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                          fontWeight: FontWeight.w600,
                        ),
                  ),
                ),
              ],
              const SizedBox(height: 16),
              for (final reason in reasons)
                RadioListTile<String>(
                  dense: true,
                  contentPadding: EdgeInsets.zero,
                  value: reason,
                  // ignore: deprecated_member_use
                  groupValue: _selected,
                  // ignore: deprecated_member_use
                  onChanged: (v) => setState(() => _selected = v),
                  title: Text(reason),
                ),
              RadioListTile<String>(
                dense: true,
                contentPadding: EdgeInsets.zero,
                value: '__custom__',
                // ignore: deprecated_member_use
                groupValue: _selected,
                // ignore: deprecated_member_use
                onChanged: (v) => setState(() => _selected = v),
                title: const Text('Other reason…'),
              ),
              if (isCustom)
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: TextField(
                    controller: _custom,
                    autofocus: true,
                    // No `onChanged` here on purpose: the controller listener
                    // set up in initState covers this field and the on-screen
                    // keyboard both, and `onChanged` covers only one of them.
                    // The green key on the on-screen keyboard, and Enter on a
                    // hardware one, mean "that is my reason" — not "insert a
                    // newline into a single-line field".
                    textInputAction: TextInputAction.done,
                    onSubmitted: (_) {
                      if (_canConfirm) _confirm();
                    },
                    // Ours is the input method — see the keyboard below. A
                    // hardware keyboard still types into this; this only stops
                    // Windows sliding its own touch keyboard over the top.
                    keyboardType: TextInputType.none,
                    decoration: const InputDecoration(
                      hintText: 'Type the reason',
                      border: OutlineInputBorder(),
                    ),
                  ),
                ),
              // The keyboard this dialog's scroll view was already built to
              // accommodate. A void reason is free text on a machine that
              // usually has no keyboard behind it, so without one the "Other"
              // option was an option a clerk could choose and then not answer.
              if (isCustom)
                Padding(
                  padding: const EdgeInsets.only(top: 10),
                  child: OnScreenKeyboard(
                    controller: _custom,
                    submitLabel: whole ? 'Cancel check' : 'Void',
                    onSubmit: _canConfirm ? _confirm : null,
                  ),
                ),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        FilledButton(
          style: FilledButton.styleFrom(
            backgroundColor: Pos.red,
            foregroundColor: Colors.white,
          ),
          onPressed: _canConfirm ? _confirm : null,
          child: Text(whole ? 'Cancel check' : 'Void'),
        ),
      ],
    );
  }

  bool get _canConfirm {
    if (_selected == null) return false;
    if (_selected == '__custom__') return _custom.text.trim().isNotEmpty;
    return true;
  }

  void _confirm() {
    final reason = _selected == '__custom__' ? _custom.text.trim() : _selected!;
    Navigator.pop(context, reason);
  }
}
