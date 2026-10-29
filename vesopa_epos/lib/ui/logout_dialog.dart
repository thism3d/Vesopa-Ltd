import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/auth_service.dart';
import '../main.dart';
import '../data/session_controller.dart' show VesopaOption, vesopaOptionProvider;
import '../data/vesopa_sso.dart' show VesopaSsoFailed;
import 'theme.dart';

/// Confirms who is signing out, and refuses to do it while this terminal still
/// holds sales the server has never seen.
class LogoutDialog extends ConsumerStatefulWidget {
  const LogoutDialog({super.key});

  @override
  ConsumerState<LogoutDialog> createState() => _LogoutDialogState();
}

class _LogoutDialogState extends ConsumerState<LogoutDialog> {
  final _password = TextEditingController();
  bool _busy = false;

  /// The eye beside the password: shown in plain text while pressed on.
  bool _reveal = false;

  /// The Vesopa sign-in page, once it has been opened in the browser.
  Uri? _opened;

  /// Confirm with the person's Vesopa account (2026-10-27): the way to sign
  /// out of a till whose venue signs in with Vesopa only, where the account
  /// has no password here to type.
  Future<void> _confirmWithVesopa(VesopaOption option) async {
    setState(() {
      _busy = true;
      _error = null;
      _opened = null;
    });
    try {
      await ref.read(authServiceProvider).logoutWithVesopa(
            issuer: option.issuer,
            clientId: option.clientId,
            terminalToken: ref.read(sessionProvider).terminalToken,
            onUrl: (url) {
              if (mounted) setState(() => _opened = url);
            },
          );
      if (mounted) Navigator.of(context).pop(true);
    } on LogoutBlocked catch (e) {
      if (mounted) {
        setState(() {
          _error = e.message;
          _busy = false;
          _opened = null;
        });
        await _counts();
      }
    } on VesopaSsoFailed catch (e) {
      if (mounted) {
        setState(() {
          _error = e.message;
          _busy = false;
          _opened = null;
        });
      }
    }
  }
  String? _error;
  int _pending = 0;
  int _parked = 0;

  /// Who is signed in. Known already — the clerk should not have to retype the
  /// address they signed in with.
  String get _email => ref.read(sessionProvider).email ?? '';

  @override
  void initState() {
    super.initState();
    _counts();
  }

  Future<void> _counts() async {
    final auth = ref.read(authServiceProvider);
    final pending = await auth.pendingCount();
    final parked = await auth.parkedCount();
    if (mounted) {
      setState(() {
        _pending = pending;
        _parked = parked;
      });
    }
  }

  Future<void> _submit() async {
    setState(() {
      _busy = true;
      _error = null;
    });

    try {
      await ref.read(authServiceProvider).logout(
            email: _email,
            password: _password.text,
          );
      if (mounted) Navigator.of(context).pop(true);
    } on LogoutBlocked catch (e) {
      if (mounted) {
        setState(() {
          _error = e.message;
          _busy = false;
        });
        // Numbers may have moved: a flush might have cleared some of them.
        await _counts();
      }
    }
  }

  @override
  void dispose() {
    _password.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final unsafe = _pending > 0 || _parked > 0;
    final vesopa = ref.watch(vesopaOptionProvider).value;
    final withVesopa = vesopa != null && vesopa.enabled;
    // Vesopa is the only way into this venue: no password to type.
    final vesopaOnly = withVesopa && vesopa.only;

    return AlertDialog(
      title: const Row(
        children: [
          Icon(Icons.logout, color: Pos.brandDeep),
          SizedBox(width: 12),
          Text('Sign out'),
        ],
      ),
      content: SizedBox(
        width: 380,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              vesopaOnly
                  ? 'Confirm it is you with your Vesopa account. Everything taken '
                      'on this terminal is sent to the server before you are signed out.'
                  : 'Confirm your password. Everything taken on this terminal is '
                      'sent to the server before you are signed out.',
              style: theme.textTheme.bodyMedium,
            ),
            const SizedBox(height: 16),

            if (unsafe)
              Container(
                padding: const EdgeInsets.all(12),
                margin: const EdgeInsets.only(bottom: 16),
                decoration: BoxDecoration(
                  color: Pos.amber.withValues(alpha: 0.14),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Icon(Icons.warning_amber, size: 18, color: Pos.amber),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        [
                          if (_pending > 0)
                            '$_pending sale(s) not yet sent to the server',
                          if (_parked > 0) '$_parked bill(s) open on tables',
                        ].join('\n'),
                        style: theme.textTheme.bodySmall,
                      ),
                    ),
                  ],
                ),
              ),

            // Who is signing out. Shown, not asked for — they signed in with
            // this address and should not have to retype it.
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
              decoration: BoxDecoration(
                color: theme.colorScheme.surfaceContainerHighest,
                borderRadius: BorderRadius.circular(8),
              ),
              child: Row(
                children: [
                  Icon(Icons.person, size: 18, color: theme.hintColor),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      _email,
                      style: const TextStyle(fontSize: 13.5),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 12),
            if (withVesopa) ...[
              SizedBox(
                width: double.infinity,
                child: FilledButton.tonalIcon(
                  icon: const Icon(Icons.verified_user_outlined),
                  label: Text(_busy && _opened != null ? 'Waiting for Vesopa…' : 'Confirm with Vesopa'),
                  onPressed: _busy ? null : () => _confirmWithVesopa(vesopa),
                ),
              ),
              if (_opened != null) ...[
                const SizedBox(height: 8),
                Text(
                  'Sign in on the Vesopa page that has opened in the browser, then come back here.',
                  style: theme.textTheme.bodySmall,
                ),
              ],
              if (!vesopaOnly) ...[
                const SizedBox(height: 12),
                Text('Or type the password', style: theme.textTheme.bodySmall),
                const SizedBox(height: 8),
              ],
            ],
            if (!vesopaOnly) TextField(
              controller: _password,
              enabled: !_busy,
              obscureText: !_reveal,
              autofocus: true,
              onSubmitted: (_) => _busy ? null : _submit(),
              decoration: InputDecoration(
                labelText: 'Password',
                border: const OutlineInputBorder(),
                suffixIcon: IconButton(
                  tooltip: _reveal ? 'Hide password' : 'Show password',
                  icon: Icon(_reveal ? Icons.visibility_off_outlined : Icons.visibility_outlined),
                  onPressed: () => setState(() => _reveal = !_reveal),
                ),
              ),
            ),

            if (_error != null) ...[
              const SizedBox(height: 14),
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: Pos.red.withValues(alpha: 0.10),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Text(
                  _error!,
                  style: TextStyle(color: Pos.red, fontSize: 13),
                ),
              ),
            ],
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: _busy ? null : () => Navigator.of(context).pop(false),
          child: const Text('Cancel'),
        ),
        if (!vesopaOnly)
          FilledButton(
            onPressed: _busy ? null : _submit,
            child: _busy
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Text('Sign out'),
          ),
      ],
    );
  }
}
