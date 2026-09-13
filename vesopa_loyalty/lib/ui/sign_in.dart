import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/api.dart';
import '../data/session.dart';
import '../data/signin.dart';
import '../platform/passkey.dart';
import '../platform/vesopa_sso.dart';
import 'widgets.dart';

/// Signing in, whichever ways the venue offers.
///
/// ONE WAY LEADS AND THE REST ARE UNDERNEATH. The venue picks which leads; the
/// others are always reachable from a row of plain links. A member who has
/// forgotten they set a password must never be stuck on a password box, and a
/// venue that switched to passwords must not strand the members who have none.
///
/// THE APP NEVER DECIDES WHAT IS ALLOWED. It draws what the server said the
/// venue offers, minus anything this device cannot do, and the server checks
/// again on every route. This page is a convenience, not a gate.
class SignInPage extends ConsumerStatefulWidget {
  const SignInPage({super.key});

  @override
  ConsumerState<SignInPage> createState() => _SignInPageState();
}

/// Where in a method's own little flow we are.
enum _Stage { start, code, name }

class _SignInPageState extends ConsumerState<SignInPage> {
  final _email = TextEditingController();
  final _password = TextEditingController();
  final _phone = TextEditingController();
  final _code = TextEditingController();
  final _name = TextEditingController();

  /// Which way in is on screen. Set from the venue's policy on first build.
  String? _method;
  var _stage = _Stage.start;
  var _busy = false;
  var _showPassword = false;
  String? _error;
  String? _note;

  @override
  void initState() {
    super.initState();
    // Coming back from Continue with Vesopa: the code is in the address.
    WidgetsBinding.instance.addPostFrameCallback((_) => _finishVesopa());
  }

  @override
  void dispose() {
    for (final c in [_email, _password, _phone, _code, _name]) {
      c.dispose();
    }
    super.dispose();
  }

  SignInConfig get _config => ref.read(brandProvider).requireValue.signIn;

  Future<void> _run(Future<void> Function() job) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await job();
    } on PasskeyCancelled {
      // Somebody changed their mind. Not an error, and nothing to say.
    } on ApiError catch (e) {
      if (e.needsName) {
        setState(() {
          _stage = _Stage.name;
          _note = 'Welcome! You are new here, so tell us your name to join.';
        });
      } else {
        setState(() => _error = e.message);
      }
    } catch (_) {
      setState(() => _error = 'That did not work. Please try again.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _choose(String method) => setState(() {
    _method = method;
    _stage = _Stage.start;
    _error = null;
    _note = null;
    _code.clear();
    _password.clear();
  });

  bool _emailLooksRight(String v) => RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$').hasMatch(v);

  // ---- The five ways in ------------------------------------------------------

  Future<void> _sendEmailCode() => _run(() async {
    final email = _email.text.trim();
    if (!_emailLooksRight(email)) throw ApiError('Please enter your email address.');
    await ref.read(apiProvider).requestCode(email);
    setState(() {
      _stage = _Stage.code;
      _note = 'We have emailed a six-digit code to $email.';
    });
  });

  Future<void> _verifyEmailCode() => _run(() async {
    final code = _code.text.trim();
    if (!RegExp(r'^\d{6}$').hasMatch(code)) throw ApiError('Enter the six-digit code from the email.');
    final name = _stage == _Stage.name ? _name.text.trim() : null;
    if (_stage == _Stage.name && (name == null || name.isEmpty)) throw ApiError('Please tell us your name.');
    final token = await ref.read(apiProvider).verify(
      email: _email.text.trim(),
      code: code,
      name: name,
      platform: ref.read(configProvider).platform,
    );
    await ref.read(sessionProvider.notifier).signedIn(token);
  });

  Future<void> _signInWithPassword() => _run(() async {
    final email = _email.text.trim();
    if (!_emailLooksRight(email)) throw ApiError('Please enter your email address.');
    if (_password.text.isEmpty) throw ApiError('Please enter your password.');
    final token = await ref.read(apiProvider).signInWithPassword(
      email: email,
      password: _password.text,
      platform: ref.read(configProvider).platform,
    );
    await ref.read(sessionProvider.notifier).signedIn(token);
  });

  Future<void> _sendTextCode() => _run(() async {
    final phone = _phone.text.trim();
    if (phone.length < 7) throw ApiError('Please enter your mobile number.');
    await ref.read(apiProvider).requestSmsCode(phone);
    setState(() {
      _stage = _Stage.code;
      // Deliberately not "we texted you": the server only texts a number it
      // already holds for a member, and saying it did would tell a stranger
      // whether a number is on the venue's books.
      _note = 'If that number is on your membership, a code is on its way.';
    });
  });

  Future<void> _verifyTextCode() => _run(() async {
    final token = await ref.read(apiProvider).signInWithSms(
      phone: _phone.text.trim(),
      code: _code.text.trim(),
      platform: ref.read(configProvider).platform,
    );
    await ref.read(sessionProvider.notifier).signedIn(token);
  });

  Future<void> _signInWithPasskey() => _run(() async {
    final api = ref.read(apiProvider);
    final email = _email.text.trim();
    final options = await api.passkeyOptions(email: _emailLooksRight(email) ? email : null);
    final result = await passkeyGet(options);
    final token = await api.signInWithPasskey(
      challenge: result.challenge,
      credential: result.credential,
      platform: ref.read(configProvider).platform,
    );
    await ref.read(sessionProvider.notifier).signedIn(token);
  });

  Future<void> _startVesopa() => _run(() async {
    final brand = ref.read(brandProvider).requireValue;
    final answer = await startVesopaSignIn(
      slug: ref.read(configProvider).slug,
      venue: brand.name,
    );
    // Null on the web: the page has left for auth.vesopa.com and the answer
    // arrives in the address when it comes back.
    if (answer != null) await _completeVesopa(answer);
  });

  /// Back from Vesopa with a code in the address. Runs once, on first build.
  Future<void> _finishVesopa() async {
    final pending = takeVesopaAnswer();
    if (pending == null) return;
    await _run(() => _completeVesopa(pending));
  }

  Future<void> _completeVesopa(VesopaAnswer answer) async {
    if (answer.error != null) {
      setState(() {
        _method = 'vesopa';
        _error = answer.error;
      });
      return;
    }
    if (answer.isEmpty) return;
    final token = await ref.read(apiProvider).signInWithVesopa(
      code: answer.code,
      verifier: answer.code == null ? null : answer.verifier,
      redirectUri: answer.code == null ? null : answer.redirectUri,
      idToken: answer.idToken,
      platform: ref.read(configProvider).platform,
    );
    await ref.read(sessionProvider.notifier).signedIn(token);
  }
  // ---- What the primary button does right now --------------------------------

  ({String label, VoidCallback action})? get _primary {
    final method = _method ?? _config.leads;
    if (_stage == _Stage.name) return (label: 'Join', action: _verifyEmailCode);
    if (_stage == _Stage.code) {
      return method == 'code_sms'
          ? (label: 'Sign in', action: _verifyTextCode)
          : (label: 'Sign in', action: _verifyEmailCode);
    }
    return switch (method) {
      'password' => (label: 'Sign in', action: _signInWithPassword),
      'code_sms' => (label: 'Text me a code', action: _sendTextCode),
      'passkey' => (label: 'Use a passkey', action: _signInWithPasskey),
      'vesopa' => (label: 'Continue with Vesopa', action: _startVesopa),
      _ => (label: 'Email me a code', action: _sendEmailCode),
    };
  }

  @override
  Widget build(BuildContext context) {
    final brand = ref.watch(brandProvider).requireValue;
    final theme = Theme.of(context);
    final config = brand.signIn;
    final method = _method ?? config.leads;
    final primary = _primary!;

    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              // A little wider than before: the password row and the "or" list
              // want the room, and on a laptop a 420px column looked like a
              // phone screenshot dropped into the middle of a page.
              constraints: const BoxConstraints(maxWidth: 460),
              child: AutofillGroup(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    VenueLogo(brand: brand, size: 96),
                    const SizedBox(height: 20),
                    Text(
                      brand.name,
                      textAlign: TextAlign.center,
                      style: theme.textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800),
                    ),
                    const SizedBox(height: 8),
                    Text(brand.welcome, textAlign: TextAlign.center, style: theme.textTheme.bodyLarge),
                    const SizedBox(height: 28),
                    if (_note != null) ...[
                      Text(_note!, textAlign: TextAlign.center, style: theme.textTheme.bodyMedium),
                      const SizedBox(height: 14),
                    ],
                    ..._fields(method, theme),
                    if (_error != null) ...[
                      const SizedBox(height: 12),
                      Text(
                        _error!,
                        textAlign: TextAlign.center,
                        style: TextStyle(color: theme.colorScheme.error, fontWeight: FontWeight.w600),
                      ),
                    ],
                    const SizedBox(height: 18),
                    FilledButton(
                      onPressed: _busy ? null : primary.action,
                      child: _busy
                          ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.5))
                          : Text(primary.label),
                    ),
                    if (_stage != _Stage.start)
                      TextButton(
                        onPressed: _busy ? null : () => _choose(method),
                        child: const Text('Start again'),
                      ),
                    ..._otherWays(config, method, theme),
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

  /// The boxes this way in needs, at this point in it.
  List<Widget> _fields(String method, ThemeData theme) {
    if (_stage == _Stage.code || _stage == _Stage.name) {
      return [
        if (_stage == _Stage.code)
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
            onSubmitted: (_) => _primary!.action(),
          ),
        if (_stage == _Stage.name) ...[
          TextField(
            controller: _code,
            enabled: !_busy,
            keyboardType: TextInputType.number,
            inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(6)],
            style: theme.textTheme.titleLarge?.copyWith(letterSpacing: 8),
            textAlign: TextAlign.center,
            decoration: const InputDecoration(labelText: 'Six-digit code'),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _name,
            enabled: !_busy,
            autofocus: true,
            textCapitalization: TextCapitalization.words,
            autofillHints: const [AutofillHints.name],
            decoration: const InputDecoration(labelText: 'Your name'),
            onSubmitted: (_) => _primary!.action(),
          ),
        ],
      ];
    }

    if (method == 'code_sms') {
      return [
        TextField(
          controller: _phone,
          enabled: !_busy,
          keyboardType: TextInputType.phone,
          autofillHints: const [AutofillHints.telephoneNumber],
          decoration: const InputDecoration(labelText: 'Mobile number', hintText: '07…'),
          onSubmitted: (_) => _primary!.action(),
        ),
      ];
    }

    if (method == 'vesopa') {
      return [
        Text(
          'Sign in with the Vesopa account this venue gave you.',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodyMedium,
        ),
      ];
    }

    return [
      TextField(
        controller: _email,
        enabled: !_busy,
        keyboardType: TextInputType.emailAddress,
        autofillHints: const [AutofillHints.email],
        textInputAction: method == 'password' ? TextInputAction.next : TextInputAction.go,
        decoration: InputDecoration(
          labelText: 'Email address',
          // With a passkey the address is a hint, not a requirement: a
          // discoverable passkey signs somebody in without one.
          helperText: method == 'passkey' ? 'Optional — your device may already know you.' : null,
        ),
        onSubmitted: (_) => method == 'password' ? null : _primary!.action(),
      ),
      if (method == 'password') ...[
        const SizedBox(height: 12),
        TextField(
          controller: _password,
          enabled: !_busy,
          obscureText: !_showPassword,
          autofillHints: const [AutofillHints.password],
          decoration: InputDecoration(
            labelText: 'Password',
            suffixIcon: IconButton(
              onPressed: () => setState(() => _showPassword = !_showPassword),
              icon: Icon(_showPassword ? Icons.visibility_off : Icons.visibility),
              tooltip: _showPassword ? 'Hide password' : 'Show password',
            ),
          ),
          onSubmitted: (_) => _primary!.action(),
        ),
      ],
    ];
  }

  /// The ways in that are not on screen, as plain links.
  ///
  /// Always all of them, never a "more" menu. There are at most four, and a
  /// member who cannot find the one they use is a member who gives up.
  List<Widget> _otherWays(SignInConfig config, String method, ThemeData theme) {
    final others = config.usable.where((m) => m != method).toList()
      ..sort((a, b) => config.alternatives.indexOf(a).compareTo(config.alternatives.indexOf(b)));
    if (others.isEmpty || _stage != _Stage.start) return const [];
    return [
      const SizedBox(height: 6),
      Row(
        children: [
          const Expanded(child: Divider()),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 10),
            child: Text('or', style: theme.textTheme.bodySmall),
          ),
          const Expanded(child: Divider()),
        ],
      ),
      Wrap(
        alignment: WrapAlignment.center,
        children: [
          for (final m in others)
            TextButton(
              onPressed: _busy ? null : () => _choose(m),
              child: Text(signInLabel(m)),
            ),
        ],
      ),
    ];
  }
}
