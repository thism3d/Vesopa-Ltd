import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config/constants.dart';
import '../data/providers.dart';
import 'theme.dart';
import 'widgets/brand_mark.dart';
import 'widgets/vesopa_mark.dart';
import 'widgets/on_screen_keyboard.dart';

/// Signing a kitchen screen in.
///
/// Three fields, and the on-screen keyboard the brief asks for. The venue is
/// its contact email, which is the tenancy key everything else in this platform
/// is scoped by; the username and password are created by the back office under
/// **Kitchen screens**, and are not a member of staff's — they belong to the
/// wall.
///
/// Done once. The token lasts ninety days, so the realistic frequency of this
/// screen being seen is "when a machine is replaced".
class SignInPage extends ConsumerStatefulWidget {
  const SignInPage({super.key});

  @override
  ConsumerState<SignInPage> createState() => _SignInPageState();
}

enum _Field { office, username, password }

class _SignInPageState extends ConsumerState<SignInPage> {
  final _office = TextEditingController();
  final _username = TextEditingController();
  final _password = TextEditingController();

  /// Which field the keyboard is typing into.
  ///
  /// One keyboard for three fields, rather than one that follows focus, because
  /// a keyboard that moves as focus moves also moves when it does not — and on
  /// a touch screen the difference between "I tapped the field" and "I tapped
  /// past the field" is a few pixels.
  _Field _active = _Field.office;

  bool _busy = false;
  bool _revealed = false;
  String? _error;

  /// Whether the back office offers a Vesopa account, and whether it is meant
  /// to be the only way in. Null while the question is in flight, so the page
  /// does not flash one shape and settle into the other on a slow line.
  ({bool enabled, bool only, String issuer, String clientId})? _vesopa;

  /// Set when somebody chooses the screen login instead.
  ///
  /// A way through rather than a way round: a venue mid-migration, a screen
  /// being set up before anybody has a Vesopa account, and the morning the
  /// identity provider is the thing that is down. Hidden behind a press, so
  /// the page still has one obvious answer on it.
  bool _typedInstead = false;

  /// The address the browser was sent to, once it has been opened.
  ///
  /// A kitchen screen is a wall-mounted machine that may have no browser to
  /// hand it to, and somebody who can READ the address can finish on a phone.
  /// Without this the screen simply appears to hang.
  Uri? _opened;

  bool get _vesopaOnly =>
      (_vesopa?.enabled ?? false) && (_vesopa?.only ?? false) && !_typedInstead;

  bool get _showsTyped => !(_vesopa?.enabled ?? false) || !_vesopaOnly;

  @override
  void initState() {
    super.initState();
    unawaited(_askAboutVesopa());
  }

  Future<void> _askAboutVesopa() async {
    final option = await ref.read(kitchenApiProvider).vesopaOption();
    if (mounted) setState(() => _vesopa = option);
  }

  /// Set this screen up with a Vesopa account.
  Future<void> _vesopaSignIn() async {
    final option = _vesopa;
    if (option == null || !option.enabled) return;

    setState(() {
      _busy = true;
      _error = null;
      _opened = null;
    });

    try {
      await ref.read(kitchenSessionProvider.notifier).signInWithVesopa(
            issuer: option.issuer,
            clientId: option.clientId,
            onUrl: (url) {
              if (mounted) setState(() => _opened = url);
            },
          );
      // Nothing to do on success: the app watches the session and swaps this
      // page for the board.
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = '$e';
          _busy = false;
          _opened = null;
        });
      }
    }
  }

  @override
  void dispose() {
    _office.dispose();
    _username.dispose();
    _password.dispose();
    super.dispose();
  }

  TextEditingController get _controller => switch (_active) {
    _Field.office => _office,
    _Field.username => _username,
    _Field.password => _password,
  };

  Future<void> _submit() async {
    // Move to the next empty field rather than failing. Somebody who has filled
    // in the venue and pressed the green key means "next", not "sign in", and
    // answering with a validation error would be pedantry.
    if (_office.text.trim().isEmpty) {
      setState(() => _active = _Field.office);
      return;
    }
    if (_username.text.trim().isEmpty) {
      setState(() => _active = _Field.username);
      return;
    }
    if (_password.text.isEmpty) {
      setState(() => _active = _Field.password);
      return;
    }

    setState(() {
      _busy = true;
      _error = null;
    });

    try {
      await ref
          .read(kitchenSessionProvider.notifier)
          .signIn(
            office: _office.text,
            username: _username.text,
            password: _password.text,
          );
      // Nothing to do on success: the app watches the session and swaps this
      // page for the board.
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final skin = Kds.of(context);
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 820),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  // The product's own mark rather than the company wordmark.
                  // This is the first thing a chef sees on a new machine, and
                  // it is the same tile they will be tapping on the taskbar
                  // from then on.
                  const BrandMark(size: 64),
                  const SizedBox(height: 12),
                  Text(
                    VesopaBrand.appName,
                    style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  SizedBox(height: 4),
                  Text(
                    _vesopaOnly
                        ? 'Sign this screen in with your Vesopa account. The '
                              'screen keeps its own login from then on — '
                              'nobody stays signed in as you.'
                        : 'Sign this screen in with the kitchen login created '
                              'in the back office, under Kitchen screens.',
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                      color: skin.inkMuted,
                    ),
                  ),
                  const SizedBox(height: 22),

                  // Outside the typed block, because a Vesopa sign-in can fail
                  // too and its message has to be readable on a page with no
                  // fields on it.
                  if (_error != null) ...[
                    const SizedBox(height: 14),
                    Container(
                      width: double.infinity,
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        color: Kds.late.withValues(alpha: 0.10),
                        borderRadius: BorderRadius.circular(10),
                      ),
                      child: Text(
                        _error!,
                        style: const TextStyle(color: Kds.late),
                      ),
                    ),
                  ],

                  // "(Vesopa icon) Continue with Vesopa", first on the page
                  // and, where the venue has moved over, the only thing on it.
                  //
                  // THE COLOURS ARE SET HERE RATHER THAN LEFT TO THE THEME, and
                  // so are the words. The owner's report was that this button
                  // "not maintained the branding like Vesopa Backoffice" — and
                  // it did not: the back office draws lime-on-black and says
                  // "Continue with Vesopa", while this took whatever the
                  // kitchen's own ColorScheme made of a FilledButton and said
                  // "Login with". One button, three products, three
                  // appearances. Somebody who has seen it once should recognise
                  // it anywhere, which is the entire value of a sign-in button
                  // being branded at all.
                  if (_vesopa?.enabled ?? false) ...[
                    SizedBox(
                      width: double.infinity,
                      child: FilledButton.icon(
                        style: FilledButton.styleFrom(
                          backgroundColor: Kds.brand,
                          foregroundColor: Colors.black,
                        ),
                        onPressed: _busy ? null : _vesopaSignIn,
                        icon: _busy
                            ? const SizedBox(
                                width: 22,
                                height: 22,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2.4,
                                  color: Colors.black,
                                ),
                              )
                            : const VesopaMark(size: 22),
                        label: const Text('Continue with Vesopa'),
                      ),
                    ),
                    if (_opened != null) ...[
                      const SizedBox(height: 10),
                      SelectableText(
                        'Finish in the browser, or open:\n${_opened!.origin}',
                        textAlign: TextAlign.center,
                        style: Theme.of(context).textTheme.bodySmall?.copyWith(
                          color: skin.inkMuted,
                        ),
                      ),
                    ],
                    // The way through for a venue mid-migration, and for the
                    // morning auth.vesopa.com is the thing that is down. A
                    // press rather than a second button, so the page still has
                    // one obvious answer on it.
                    if (_vesopaOnly) ...[
                      const SizedBox(height: 12),
                      TextButton(
                        onPressed: _busy
                            ? null
                            : () => setState(() => _typedInstead = true),
                        child: const Text('Use a screen login instead'),
                      ),
                    ],
                    if (_showsTyped) const SizedBox(height: 22),
                  ],

                  // The screen login: three fields, the on-screen keyboard
                  // and its own button. Hidden as one block rather than field
                  // by field, so a field added here later is covered by the
                  // same rule instead of quietly reappearing on a page that is
                  // supposed to have one way in.
                  if (_showsTyped) ...[
                  _FieldBox(
                    label: 'Venue',
                    hint: 'The office email your tills use',
                    controller: _office,
                    active: _active == _Field.office,
                    onTap: () => setState(() => _active = _Field.office),
                  ),
                  const SizedBox(height: 10),
                  _FieldBox(
                    label: 'Kitchen login',
                    hint: 'e.g. grill',
                    controller: _username,
                    active: _active == _Field.username,
                    onTap: () => setState(() => _active = _Field.username),
                  ),
                  const SizedBox(height: 10),
                  _FieldBox(
                    label: 'Password',
                    controller: _password,
                    active: _active == _Field.password,
                    obscure: !_revealed,
                    onTap: () => setState(() => _active = _Field.password),
                    trailing: IconButton(
                      icon: Icon(
                        _revealed
                            ? Icons.visibility_off_outlined
                            : Icons.visibility_outlined,
                      ),
                      // A shared password typed on a keyboard drawn on glass,
                      // by somebody who cannot feel the keys, in a room where
                      // everybody already knows it. Being able to see what was
                      // typed is worth more here than hiding it is.
                      tooltip: _revealed ? 'Hide' : 'Show',
                      onPressed: () => setState(() => _revealed = !_revealed),
                    ),
                  ),

                  const SizedBox(height: 16),
                  SizedBox(
                    width: double.infinity,
                    child: FilledButton(
                      onPressed: _busy ? null : _submit,
                      child: _busy
                          ? const SizedBox(
                              width: 22,
                              height: 22,
                              child: CircularProgressIndicator(
                                strokeWidth: 2.4,
                                color: Colors.white,
                              ),
                            )
                          : const Text('Sign in'),
                    ),
                  ),

                  const SizedBox(height: 18),
                  OnScreenKeyboard(
                    controller: _controller,
                    onSubmit: _busy ? null : _submit,
                    submitLabel: _active == _Field.password
                        ? 'Sign in'
                        : 'Next',
                  ),
                  ],

                  SizedBox(height: 14),
                  Text(
                    Api.isLive
                        ? 'Connecting to ${Uri.parse(Api.resolvedBase).host}'
                        : '${Api.environmentName} · ${Api.resolvedBase}',
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: skin.inkMuted,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _FieldBox extends StatelessWidget {
  const _FieldBox({
    required this.label,
    required this.controller,
    required this.active,
    required this.onTap,
    this.hint,
    this.obscure = false,
    this.trailing,
  });

  final String label;
  final String? hint;
  final TextEditingController controller;
  final bool active;
  final VoidCallback onTap;
  final bool obscure;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final skin = Kds.of(context);
    return GestureDetector(
      onTap: onTap,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 120),
        padding: EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(
          color: skin.card,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(
            color: active ? Kds.selected : const Color(0x22000000),
            width: active ? 2 : 1,
          ),
        ),
        child: Row(
          children: [
            SizedBox(
              width: 130,
              child: Text(
                label,
                style: TextStyle(
                  color: skin.inkMuted,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
            Expanded(
              child: TextField(
                controller: controller,
                obscureText: obscure,
                // The on-screen keyboard is the input method here. A hardware
                // keyboard still works — a machine on a bench during setup has
                // one — but the field must never summon the operating system's
                // touch keyboard on top of ours.
                keyboardType: TextInputType.none,
                style: const TextStyle(fontSize: 19),
                decoration: InputDecoration(
                  border: InputBorder.none,
                  isDense: true,
                  hintText: hint,
                  hintStyle: const TextStyle(color: Color(0xFF9AA1AC)),
                ),
                onTap: onTap,
              ),
            ),
            ?trailing,
          ],
        ),
      ),
    );
  }
}
