import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/kitchen_api.dart';
import '../../data/providers.dart';
import '../theme.dart';
import 'on_screen_keyboard.dart';

/// Ask for the password of the login this screen is signed in as.
///
/// Two callers, one question. Signing out asks because the button sits on a
/// header a chef leans against, and the cost of a mis-tap is a board that stops
/// showing orders until somebody who knows the venue's credentials walks in —
/// which, at half past seven on a Saturday, is nobody. Saving branding asks
/// because that is a venue-wide change being made from a shared panel on a
/// wall.
///
/// Returns the password on success, and null if it was cancelled. The password
/// itself comes back rather than a bare `true` because the caller needs it
/// again: the branding write re-checks it server-side in the same request, so
/// there is no window between "verified" and "saved" for a screen to be walked
/// away from.
Future<String?> askForKitchenPassword(
  BuildContext context,
  WidgetRef ref, {
  required String title,
  required String explanation,
  required String confirmLabel,
  IconData icon = Icons.lock_outline,
  Color? tone,
}) {
  return showDialog<String>(
    context: context,
    // A wall screen with a modal half-dismissed by a sleeve is worse than one
    // that insists on an answer, and both answers here are one tap away.
    barrierDismissible: false,
    builder: (dialogContext) => _PasswordPrompt(
      title: title,
      explanation: explanation,
      confirmLabel: confirmLabel,
      icon: icon,
      tone: tone,
    ),
  );
}

class _PasswordPrompt extends ConsumerStatefulWidget {
  const _PasswordPrompt({
    required this.title,
    required this.explanation,
    required this.confirmLabel,
    required this.icon,
    this.tone,
  });

  final String title;
  final String explanation;
  final String confirmLabel;
  final IconData icon;
  final Color? tone;

  @override
  ConsumerState<_PasswordPrompt> createState() => _PasswordPromptState();
}

class _PasswordPromptState extends ConsumerState<_PasswordPrompt> {
  final _password = TextEditingController();

  bool _busy = false;
  bool _revealed = false;
  String? _error;

  @override
  void dispose() {
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_password.text.isEmpty || _busy) return;

    setState(() {
      _busy = true;
      _error = null;
    });

    try {
      final ok = await ref
          .read(kitchenSessionProvider.notifier)
          .verifyPassword(_password.text);

      if (!mounted) return;
      if (ok) {
        Navigator.of(context).pop(_password.text);
        return;
      }
      setState(() {
        _error = 'That is not the password for this screen.';
        _busy = false;
      });
      _password.clear();
    } on KitchenApiError catch (e) {
      // Told apart on purpose. "Wrong password" sends somebody looking for a
      // credential; "cannot reach the back office" sends them to look at the
      // network, and the check has established nothing about the password.
      if (!mounted) return;
      setState(() {
        _error = e.signedOut
            ? 'This screen needs to be signed in again — ask the office.'
            : 'The back office cannot be reached, so the password could not '
                  'be checked. Try again in a moment.';
        _busy = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _error = 'The password could not be checked right now.';
        _busy = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final skin = Kds.of(context);
    final tone = widget.tone ?? Kds.selected;

    return AlertDialog(
      icon: Icon(widget.icon, size: 30, color: tone),
      title: Text(widget.title),
      // Scrollable, because the keyboard is tall and this dialog has to survive
      // a 1024x768 panel — the smallest thing a venue has ever hung one of
      // these on.
      content: SizedBox(
        width: 640,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                widget.explanation,
                style: TextStyle(color: skin.inkMuted, height: 1.35),
              ),
              const SizedBox(height: 16),
              TextField(
                controller: _password,
                obscureText: !_revealed,
                autofocus: true,
                enabled: !_busy,
                onSubmitted: (_) => _submit(),
                decoration: InputDecoration(
                  labelText: 'Kitchen password',
                  errorText: _error,
                  // Two or three people share this login and it is typed one
                  // character at a time on glass. Being able to see it is the
                  // difference between a second attempt and giving up.
                  suffixIcon: IconButton(
                    icon: Icon(
                      _revealed ? Icons.visibility_off : Icons.visibility,
                    ),
                    tooltip: _revealed ? 'Hide' : 'Show',
                    onPressed: () => setState(() => _revealed = !_revealed),
                  ),
                ),
              ),
              const SizedBox(height: 12),
              OnScreenKeyboard(
                controller: _password,
                onSubmit: _busy ? null : _submit,
                submitLabel: widget.confirmLabel,
              ),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: _busy ? null : () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: _busy ? null : _submit,
          style: FilledButton.styleFrom(backgroundColor: tone),
          child: _busy
              ? const SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    color: Colors.white,
                  ),
                )
              : Text(widget.confirmLabel),
        ),
      ],
    );
  }
}
