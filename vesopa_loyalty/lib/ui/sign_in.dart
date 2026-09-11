import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/api.dart';
import '../data/session.dart';
import 'widgets.dart';

/// Signing in, and joining: an email, a six-digit code from it, and -- for an
/// address the venue has never seen -- a name. No passwords to forget.
class SignInPage extends ConsumerStatefulWidget {
  const SignInPage({super.key});

  @override
  ConsumerState<SignInPage> createState() => _SignInPageState();
}

enum _Step { email, code, name }

class _SignInPageState extends ConsumerState<SignInPage> {
  final _email = TextEditingController();
  final _code = TextEditingController();
  final _name = TextEditingController();
  var _step = _Step.email;
  var _busy = false;
  String? _error;
  String? _note;

  @override
  void dispose() {
    _email.dispose();
    _code.dispose();
    _name.dispose();
    super.dispose();
  }

  Future<void> _run(Future<void> Function() job) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await job();
    } on ApiError catch (e) {
      if (e.needsName) {
        setState(() {
          _step = _Step.name;
          _note = 'Welcome! You are new here, so tell us your name to join.';
        });
      } else {
        setState(() => _error = e.message);
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _sendCode() => _run(() async {
    final email = _email.text.trim();
    if (!RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$').hasMatch(email)) {
      throw ApiError('Please enter your email address.');
    }
    await ref.read(apiProvider).requestCode(email);
    setState(() {
      _step = _Step.code;
      _note = 'We have emailed a six-digit code to $email.';
    });
  });

  Future<void> _verify() => _run(() async {
    final code = _code.text.trim();
    if (!RegExp(r'^\d{6}$').hasMatch(code)) throw ApiError('Enter the six-digit code from the email.');
    final name = _step == _Step.name ? _name.text.trim() : null;
    if (_step == _Step.name && (name == null || name.isEmpty)) throw ApiError('Please tell us your name.');
    final token = await ref.read(apiProvider).verify(
      email: _email.text.trim(),
      code: code,
      name: name,
      platform: ref.read(configProvider).platform,
    );
    await ref.read(sessionProvider.notifier).signedIn(token);
  });

  @override
  Widget build(BuildContext context) {
    final brand = ref.watch(brandProvider).requireValue;
    final theme = Theme.of(context);
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: AutofillGroup(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    VenueLogo(brand: brand, size: 96),
                    const SizedBox(height: 20),
                    Text(brand.name, textAlign: TextAlign.center, style: theme.textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
                    const SizedBox(height: 8),
                    Text(brand.welcome, textAlign: TextAlign.center, style: theme.textTheme.bodyLarge),
                    const SizedBox(height: 28),
                    if (_note != null) ...[
                      Text(_note!, textAlign: TextAlign.center, style: theme.textTheme.bodyMedium),
                      const SizedBox(height: 14),
                    ],
                    TextField(
                      controller: _email,
                      enabled: _step == _Step.email && !_busy,
                      keyboardType: TextInputType.emailAddress,
                      autofillHints: const [AutofillHints.email],
                      textInputAction: TextInputAction.go,
                      decoration: const InputDecoration(labelText: 'Email address'),
                      onSubmitted: (_) => _sendCode(),
                    ),
                    if (_step != _Step.email) ...[
                      const SizedBox(height: 12),
                      TextField(
                        controller: _code,
                        enabled: !_busy,
                        autofocus: true,
                        keyboardType: TextInputType.number,
                        autofillHints: const [AutofillHints.oneTimeCode],
                        inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(6)],
                        style: theme.textTheme.titleLarge?.copyWith(letterSpacing: 8),
                        textAlign: TextAlign.center,
                        decoration: const InputDecoration(labelText: 'Six-digit code'),
                        onSubmitted: (_) => _verify(),
                      ),
                    ],
                    if (_step == _Step.name) ...[
                      const SizedBox(height: 12),
                      TextField(
                        controller: _name,
                        enabled: !_busy,
                        autofocus: true,
                        textCapitalization: TextCapitalization.words,
                        autofillHints: const [AutofillHints.name],
                        decoration: const InputDecoration(labelText: 'Your name'),
                        onSubmitted: (_) => _verify(),
                      ),
                    ],
                    if (_error != null) ...[
                      const SizedBox(height: 12),
                      Text(_error!, textAlign: TextAlign.center, style: TextStyle(color: theme.colorScheme.error, fontWeight: FontWeight.w600)),
                    ],
                    const SizedBox(height: 18),
                    FilledButton(
                      onPressed: _busy ? null : (_step == _Step.email ? _sendCode : _verify),
                      child: _busy
                          ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.5))
                          : Text(switch (_step) {
                              _Step.email => 'Send me a code',
                              _Step.code => 'Sign in',
                              _Step.name => 'Join',
                            }),
                    ),
                    if (_step != _Step.email)
                      TextButton(
                        onPressed: _busy
                            ? null
                            : () => setState(() {
                                _step = _Step.email;
                                _code.clear();
                                _name.clear();
                                _note = null;
                                _error = null;
                              }),
                        child: const Text('Use a different email'),
                      ),
                    const SizedBox(height: 24),
                    const PoweredBy(),
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
