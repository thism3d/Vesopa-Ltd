import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/session_controller.dart';
import '../data/vesopa_sso.dart';
import '../main.dart';
import 'theme.dart';
import 'widgets/vesopa_mark.dart';

/// Commissioning the terminal. Shown once, on first run, and again after a
/// verified sign-out.
///
/// Signing in tells the till which venue it belongs to, so the catalogue,
/// deals and floor plan it pulls are that venue's — the office is no longer
/// baked into the build.
class SignInPage extends ConsumerStatefulWidget {
  const SignInPage({super.key});

  @override
  ConsumerState<SignInPage> createState() => _SignInPageState();
}

class _SignInPageState extends ConsumerState<SignInPage> {
  final _email = TextEditingController();
  final _password = TextEditingController();
  bool _busy = false;
  String? _error;

  /// Whether the back office will accept a Vesopa account.
  ///
  /// Read from [vesopaOptionProvider] in `build`, so a test can override it and
  /// draw either shape of this page. Null while the question is in flight, so
  /// the button does not flash into view and back out again on a slow line.
  VesopaOption? get _vesopa => ref.watch(vesopaOptionProvider).value;

  /// The address the browser was sent to, shown after it opens.
  ///
  /// A till is often a kiosked Windows machine with no browser to hand the
  /// address to, and a clerk who can READ it can finish the sign-in on their
  /// phone. Without this the terminal simply appears to hang.
  Uri? _opened;

  /// Whether the back office says Vesopa is the only way to commission a till.
  ///
  /// False while the question is still in flight, so the page does not flash
  /// the password fields away on a slow line — it starts as the venue had it
  /// and settles once the answer lands.
  bool get _vesopaOnly => (_vesopa?.enabled ?? false) && (_vesopa?.only ?? false);

  Future<void> _vesopaSignIn() async {
    final option = _vesopa;
    if (option == null || !option.enabled) return;

    setState(() {
      _busy = true;
      _error = null;
      _opened = null;
    });

    try {
      await ref.read(sessionControllerProvider.notifier).signInWithVesopa(
            apiBase: ref.read(apiBaseProvider),
            via: option,
            onUrl: (url) {
              if (mounted) setState(() => _opened = url);
            },
          );
    } on SignInFailed catch (e) {
      if (mounted) {
        setState(() {
          _error = e.message;
          _busy = false;
          _opened = null;
        });
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

  Future<void> _submit() async {
    if (_email.text.trim().isEmpty || _password.text.isEmpty) {
      setState(() => _error = 'Enter your email and password.');
      return;
    }

    setState(() {
      _busy = true;
      _error = null;
    });

    try {
      await ref.read(sessionControllerProvider.notifier).signIn(
            apiBase: ref.read(apiBaseProvider),
            email: _email.text.trim(),
            password: _password.text,
          );
      // The shell rebuilds on the session; nothing more to do here.
    } on SignInFailed catch (e) {
      if (mounted) {
        setState(() {
          _error = e.message;
          _busy = false;
        });
      }
    }
  }

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;

    return Scaffold(
      backgroundColor: dark ? const Color(0xFF0E0C12) : const Color(0xFFF5F4F7),
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 400),
            child: Card(
              elevation: dark ? 0 : 2,
              child: Padding(
                padding: const EdgeInsets.all(32),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Image.asset(
                      dark
                          ? 'assets/brand/vesopa_logo_on_dark.png'
                          : 'assets/brand/vesopa_logo.png',
                      height: 40,
                      errorBuilder: (_, _, _) => const SizedBox.shrink(),
                    ),
                    const SizedBox(height: 28),
                    Text(
                      'Sign in to this terminal',
                      textAlign: TextAlign.center,
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    const SizedBox(height: 6),
                    Text(
                      _vesopaOnly
                          ? 'Sign in with your Vesopa account. The till will '
                                'load your venue\'s products, deals and floor '
                                'plan.\n\nStaff are added by your manager in '
                                'the back office — this is not the same as '
                                'signing on to sell.'
                          : 'Use your back office account. The till will load '
                                'your venue\'s products, deals and floor plan.',
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        fontSize: 12.5,
                        height: 1.4,
                        color: Theme.of(context).hintColor,
                      ),
                    ),
                    const SizedBox(height: 26),

                    // Email and password, for a venue that has not moved over
                    // yet. Hidden — not deleted — once the back office says
                    // Vesopa is the only way in, so rolling back is a flag and
                    // a restart rather than a Store release. See
                    // VesopaOption.only.
                    if (!_vesopaOnly) ...[
                    TextField(
                      controller: _email,
                      enabled: !_busy,
                      autofocus: true,
                      keyboardType: TextInputType.emailAddress,
                      autofillHints: const [AutofillHints.username],
                      decoration: const InputDecoration(
                        labelText: 'Email',
                        prefixIcon: Icon(Icons.alternate_email),
                        border: OutlineInputBorder(),
                      ),
                    ),
                    const SizedBox(height: 14),
                    TextField(
                      controller: _password,
                      enabled: !_busy,
                      obscureText: true,
                      autofillHints: const [AutofillHints.password],
                      onSubmitted: (_) => _busy ? null : _submit(),
                      decoration: const InputDecoration(
                        labelText: 'Password',
                        prefixIcon: Icon(Icons.lock_outline),
                        border: OutlineInputBorder(),
                      ),
                    ),
                    ],

                    if (_error != null) ...[
                      const SizedBox(height: 16),
                      Container(
                        padding: const EdgeInsets.all(12),
                        decoration: BoxDecoration(
                          color: Pos.red.withValues(alpha: 0.10),
                          borderRadius: BorderRadius.circular(8),
                        ),
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const Icon(Icons.error_outline,
                                size: 18, color: Pos.red),
                            const SizedBox(width: 10),
                            Expanded(
                              child: Text(
                                _error!,
                                style: const TextStyle(
                                  color: Pos.red,
                                  fontSize: 12.5,
                                  height: 1.35,
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],

                    if (!_vesopaOnly) ...[
                      const SizedBox(height: 22),
                      FilledButton(
                        style: FilledButton.styleFrom(
                          backgroundColor: Pos.brand,
                          foregroundColor: Pos.onBrand,
                          padding: const EdgeInsets.symmetric(vertical: 15),
                        ),
                        onPressed: _busy ? null : _submit,
                        child: _busy
                            ? const SizedBox(
                                width: 20,
                                height: 20,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                  color: Pos.onBrand,
                                ),
                              )
                            : const Text(
                                'Sign in',
                                style: TextStyle(
                                  fontSize: 15,
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                      ),
                    ],

                    if (_vesopa?.enabled ?? false) ...[
                      // The rule between the two ways in, drawn only while
                      // there ARE two. With Vesopa on its own there is nothing
                      // to separate.
                      if (!_vesopaOnly) ...[
                        const SizedBox(height: 18),
                        Row(
                          children: [
                            const Expanded(child: Divider()),
                            Padding(
                              padding:
                                  const EdgeInsets.symmetric(horizontal: 12),
                              child: Text(
                                'or',
                                style: TextStyle(
                                  fontSize: 11.5,
                                  color: Theme.of(context).hintColor,
                                ),
                              ),
                            ),
                            const Expanded(child: Divider()),
                          ],
                        ),
                      ],
                      const SizedBox(height: 18),
                      // "(Vesopa icon) Login with Vesopa" — the brand's own
                      // mark rather than the open-in-new arrow it wore before,
                      // and a filled button rather than an outlined one when
                      // it is the only way in. A venue should not have to work
                      // out which of two buttons is the real one.
                      _vesopaOnly
                          ? FilledButton.icon(
                              style: FilledButton.styleFrom(
                                backgroundColor: Pos.brand,
                                foregroundColor: Pos.onBrand,
                                padding:
                                    const EdgeInsets.symmetric(vertical: 15),
                              ),
                              onPressed: _busy ? null : _vesopaSignIn,
                              icon: _busy
                                  ? const SizedBox(
                                      width: 20,
                                      height: 20,
                                      child: CircularProgressIndicator(
                                        strokeWidth: 2,
                                        color: Pos.onBrand,
                                      ),
                                    )
                                  : const VesopaMark(size: 20),
                              label: const Text(
                                'Login with Vesopa',
                                style: TextStyle(
                                  fontSize: 15,
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                            )
                          : OutlinedButton.icon(
                              style: OutlinedButton.styleFrom(
                                padding:
                                    const EdgeInsets.symmetric(vertical: 15),
                              ),
                              onPressed: _busy ? null : _vesopaSignIn,
                              icon: const VesopaMark(size: 18),
                              label: const Text(
                                'Login with Vesopa',
                                style: TextStyle(
                                  fontSize: 15,
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                            ),
                      // The address, once the browser has been sent to it. A
                      // kiosked till may have no browser at all; this is what
                      // lets the sign-in be finished on a phone instead.
                      if (_opened != null) ...[
                        const SizedBox(height: 12),
                        SelectableText(
                          'Finish in the browser, or open:\n${_opened!.origin}',
                          textAlign: TextAlign.center,
                          style: TextStyle(
                            fontSize: 11.5,
                            height: 1.4,
                            color: Theme.of(context).hintColor,
                          ),
                        ),
                      ],
                    ],

                    const SizedBox(height: 16),
                    Text(
                      ref.watch(apiBaseProvider),
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        fontSize: 11,
                        color: Theme.of(context).hintColor,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
