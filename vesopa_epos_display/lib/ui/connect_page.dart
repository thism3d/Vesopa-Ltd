import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../data/vesopa_setup.dart';
import 'display_page.dart';

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
/// IT NEVER TRAPS A SCREEN
///
/// A back office too old to offer this, no network, a venue with no licences
/// set: every one of them walks straight through to the display. A customer
/// screen stuck on a sign-in page is a screen somebody unplugs, and then a
/// counter with nothing facing the customer at all.
class ConnectPage extends ConsumerStatefulWidget {
  const ConnectPage({super.key});

  @override
  ConsumerState<ConnectPage> createState() => _ConnectPageState();
}

class _ConnectPageState extends ConsumerState<ConnectPage> {
  VesopaOption? _option;
  bool _busy = false;
  String? _error;
  bool _full = false;

  @override
  void initState() {
    super.initState();
    _look();
  }

  Future<void> _look() async {
    final option = await fetchOption(displayApiBase);
    if (!mounted) return;
    // Nothing to sign in to. Straight on, as this screen behaved before there
    // was a sign-in at all.
    if (!option.enabled) {
      _onward();
      return;
    }
    setState(() => _option = option);
  }

  void _onward() {
    if (!mounted) return;
    Navigator.of(context).pushReplacement(
      MaterialPageRoute<void>(builder: (_) => const DisplayPage()),
    );
  }

  Future<void> _connect() async {
    final option = _option;
    if (option == null || _busy) return;
    setState(() {
      _busy = true;
      _error = null;
      _full = false;
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
    } on DisplayLicenceFull catch (e) {
      if (mounted) {
        setState(() {
          _error = e.message;
          _full = true;
          _busy = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = e is DisplaySetupFailed ? e.message : 'That did not work. Please try again.';
          _busy = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final option = _option;
    final theme = Theme.of(context);

    // Still asking the server. Deliberately bare: this is on screen for well
    // under a second on a working network, and a spinner with a heading would
    // flash a sentence nobody can read.
    if (option == null) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }

    return Scaffold(
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 520),
          child: Padding(
            padding: const EdgeInsets.all(32),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Connect this display', style: theme.textTheme.headlineMedium),
                const SizedBox(height: 12),
                Text(
                  'Sign in with the Vesopa account for this venue. '
                  'The display then pairs with a till as usual.',
                  style: theme.textTheme.bodyLarge,
                ),
                if (_error != null) ...[
                  const SizedBox(height: 20),
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
                ],
                const SizedBox(height: 28),
                Row(
                  children: [
                    FilledButton(
                      onPressed: _busy ? null : _connect,
                      child: Text(_busy ? 'Waiting for the browser…' : 'Continue with Vesopa'),
                    ),
                    const SizedBox(width: 12),
                    /*
                     * THE WAY PAST, and it is always here.
                     *
                     * Every display licence in use, no network, a venue midway
                     * through sorting its subscription out — none of those is a
                     * reason for a customer to stare at a sign-in page across a
                     * counter. The screen goes on working and the back office
                     * shows it as unlicensed, which is a conversation to have
                     * with a manager rather than with a queue.
                     */
                    TextButton(
                      onPressed: _busy ? null : _onward,
                      child: Text(_full ? 'Carry on without a licence' : 'Set up later'),
                    ),
                  ],
                ),
              ],
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
      data: (value) => value == null ? const ConnectPage() : const DisplayPage(),
    );
  }
}
