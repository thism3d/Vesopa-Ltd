import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../data/vesopa_setup.dart';
import 'display_page.dart';
import 'licence_panel.dart';
import 'dart:async';
import '../data/app_update.dart';

/// Where this display's back office is.
///
/// The display has never had one: it reads a basket a till writes and pairs over
/// the local network, and that is still how it shows a sale. It needs an address
/// only to sign in and claim a licence, which is why this is a constant with a
/// build-time override rather than something a venue is asked for.
const displayApiBase = String.fromEnvironment(
  'DISPLAY_API',
  defaultValue: 'https://backoffice.vesopaepos.com',
);

/// The first screen: connect this display to Vesopa, then carry on as before.
///
/// WHY THIS COMES FIRST
///
/// A display was paired by a till and had no credential of its own, so it could
/// not be counted — a venue paying for one could run six, and the display
/// subscription was the one product whose screens worked perfectly while it sat
/// expired.
///
/// WHAT IT DOES NOT DO
///
/// It does not replace pairing. Signing in claims the venue's display licence;
/// pairing with a till is unchanged and happens next, exactly as it always has.
///
/// SIGNING IN IS NOT OPTIONAL, AND IS ONLY ASKED ONCE
///
/// There is no way past this screen without connecting. A display that could
/// be skipped past is a display that never gets counted, which is the whole
/// reason the subscription for them sat expired while the screens worked.
///
/// It is asked ONCE. A screen that has connected before never sees this page
/// again -- its commissioning is kept, and it works offline for ever after.
/// So a broadband failure can never take a venue's customer screens down; only
/// a brand-new screen is held, and a brand-new screen is never mid-service.
///
/// A back office too old to offer sign-in at all still goes straight through.
/// That is not a loophole: there is nothing there to sign in to.
class ConnectPage extends ConsumerStatefulWidget {
  const ConnectPage({super.key});

  @override
  ConsumerState<ConnectPage> createState() => _ConnectPageState();
}

class _ConnectPageState extends ConsumerState<ConnectPage> {
  VesopaOption? _option;
  bool _looked = false;
  bool _busy = false;
  String? _error;

  final _email = TextEditingController();
  final _password = TextEditingController();
  bool _reveal = false;

  /// Every licence in use, which "Try again" cannot fix: somebody has to free
  /// one first.
  bool _full = false;

  /// The back office could not be reached at all, as opposed to refusing us.
  /// Worth separating: one is a network somebody can go and look at, the other
  /// is an answer. Telling a venue "check the network" when Vesopa said no is
  /// how an evening gets wasted on the wrong thing.
  bool _unreachable = false;

  @override
  void initState() {
    super.initState();
    _look();
  }

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _look() async {
    final option = await fetchOption(displayApiBase);
    if (!mounted) return;
    setState(() {
      _option = option;
      _looked = true;
    });
  }

  void _onward() {
    if (!mounted) return;
    // The token is read by the link to a till on another computer, so the
    // provider is told it has changed.
    ref.invalidate(commissionProvider);
    Navigator.of(context).pushReplacement(
      MaterialPageRoute<void>(builder: (_) => const DisplayPage()),
    );
  }

  void _failed(Object e) {
    if (!mounted) return;
    final message = e is DisplayLicenceFull
        ? e.message
        : e is DisplaySetupFailed
            ? e.message
            : 'That did not work. Please try again.';
    setState(() {
      _error = message;
      _full = e is DisplayLicenceFull;
      _unreachable = message.contains('Could not reach');
      _busy = false;
    });
  }

  /// Email and password, like the till (2026-10-17).
  Future<void> _signIn() async {
    if (_busy) return;
    if (_email.text.trim().isEmpty || _password.text.isEmpty) {
      setState(() => _error = 'Enter the email and password you sign in to the till with.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
      _full = false;
      _unreachable = false;
    });
    try {
      await signInWithPassword(
        apiBase: displayApiBase,
        email: _email.text,
        password: _password.text,
      );
      _onward();
    } catch (e) {
      _failed(e);
    }
  }

  Future<void> _connect() async {
    final option = _option;
    if (option == null || !option.enabled || _busy) return;
    setState(() {
      _busy = true;
      _error = null;
      _full = false;
      _unreachable = false;
    });
    try {
      await commission(
        apiBase: displayApiBase,
        option: option,
        // The browser opens on this machine. A customer display is a Windows PC
        // with a keyboard somewhere near it during setup, and this is the same
        // door the till and the kiosk use.
        onUrl: (url) => launchUrl(url, mode: LaunchMode.externalApplication),
      );
      _onward();
    } catch (e) {
      _failed(e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    // Still asking the server. Deliberately bare: this is on screen for well
    // under a second on a working network.
    if (!_looked) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    final vesopa = _option?.enabled ?? false;

    return Scaffold(
      body: Center(
        child: SingleChildScrollView(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 520),
            child: Padding(
              padding: const EdgeInsets.all(32),
              child: AutofillGroup(
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text('Connect this display', style: theme.textTheme.headlineMedium),
                    const SizedBox(height: 12),
                    Text(
                      'Sign in with the email and password you use on the till. '
                      'The display then connects to a till, on this computer or another one.',
                      style: theme.textTheme.bodyLarge,
                    ),
                    const SizedBox(height: 24),
                    TextField(
                      controller: _email,
                      enabled: !_busy,
                      keyboardType: TextInputType.emailAddress,
                      autofillHints: const [AutofillHints.email],
                      textInputAction: TextInputAction.next,
                      decoration: const InputDecoration(
                        labelText: 'Email',
                        border: OutlineInputBorder(),
                      ),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: _password,
                      enabled: !_busy,
                      obscureText: !_reveal,
                      autofillHints: const [AutofillHints.password],
                      onSubmitted: (_) => _signIn(),
                      decoration: InputDecoration(
                        labelText: 'Password',
                        border: const OutlineInputBorder(),
                        suffixIcon: IconButton(
                          tooltip: _reveal ? 'Hide' : 'Show',
                          icon: Icon(_reveal ? Icons.visibility_off : Icons.visibility),
                          onPressed: () => setState(() => _reveal = !_reveal),
                        ),
                      ),
                    ),
                    if (_error != null) ...[
                      const SizedBox(height: 16),
                      Container(
                        padding: const EdgeInsets.all(14),
                        decoration: BoxDecoration(
                          color: theme.colorScheme.errorContainer,
                          borderRadius: BorderRadius.circular(10),
                        ),
                        child: Text(
                          _error!,
                          style: TextStyle(color: theme.colorScheme.onErrorContainer),
                        ),
                      ),
                      if (_full) ...[
                        const SizedBox(height: 8),
                        Text(
                          'Ask a manager to sign another display out in the back office, '
                          'under Devices, then try again.',
                          style: theme.textTheme.bodySmall,
                        ),
                      ] else if (_unreachable) ...[
                        const SizedBox(height: 8),
                        Text(
                          'The back office cannot be reached. Check this machine is on '
                          'the network, then try again.',
                          style: theme.textTheme.bodySmall,
                        ),
                      ],
                    ],
                    const SizedBox(height: 20),
                    FilledButton(
                      onPressed: _busy ? null : _signIn,
                      style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(52)),
                      child: Text(_busy ? 'Signing in…' : 'Sign in'),
                    ),
                    if (vesopa) ...[
                      const SizedBox(height: 10),
                      OutlinedButton(
                        onPressed: _busy ? null : _connect,
                        style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(48)),
                        child: const Text('Continue with Vesopa instead'),
                      ),
                    ] else ...[
                      // A back office that does not ask displays to sign in
                      // (no Vesopa sign-in switched on) let them straight
                      // through before; that stays possible here.
                      const SizedBox(height: 10),
                      TextButton(
                        onPressed: _busy ? null : _onward,
                        child: const Text('Not now: use this display on this computer only'),
                      ),
                    ],
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

/// Which screen this display starts on.
///
/// Commissioned already, or a back office that does not offer sign-in: the
/// display, exactly as before. Otherwise the connect screen, once.
class DisplayEntry extends ConsumerWidget {
  const DisplayEntry({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final commissioned = ref.watch(commissionProvider);
    return commissioned.when(
      // Anything unknown resolves towards showing the display. A screen that
      // failed to read its own settings must still show a customer their bill.
      loading: () => const Scaffold(body: Center(child: CircularProgressIndicator())),
      error: (_, _) => const DisplayPage(),
      data: (value) => value == null ? const ConnectPage() : const _LicensedDisplay(),
    );
  }
}

/// The display, unless its licence has lapsed past its grace.
///
/// `.value` is null while it loads and when the server could not be asked, and
/// both carry on into the display. Locking has to be something we were TOLD,
/// never assumed from silence: a customer screen that went blank because a
/// licence lookup timed out would be a worse fault than an uncounted display.
class _LicensedDisplay extends ConsumerWidget {
  const _LicensedDisplay();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final licence = ref.watch(displayLicenceProvider).value;
    // The version this display's venue is set to on admin.vesopa.com
    // (Versions). Customers face this screen, so nobody is asked: it is
    // fetched quietly and taken the next time the display starts.
    ref.listen(displayLicenceProvider, (_, next) {
      unawaited(stageUpdate(next.value?.update, builtVersion: displayAppVersion));
    });
    if (licence != null && licence.locked) {
      return LicenceLockedPage(
        state: licence,
        onRetry: () => ref.invalidate(displayLicenceProvider),
      );
    }
    return const DisplayPage();
  }
}
