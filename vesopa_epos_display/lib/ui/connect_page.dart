import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../data/vesopa_setup.dart';
import 'display_page.dart';
import 'licence_panel.dart';

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
  bool _busy = false;
  String? _error;
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
        final message =
            e is DisplaySetupFailed ? e.message : 'That did not work. Please try again.';
        setState(() {
          _error = message;
          _unreachable = message.contains('Could not reach');
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
                      child: Text(
                        _busy
                            ? 'Waiting for the browser…'
                            : (_error == null ? 'Continue with Vesopa' : 'Try again'),
                      ),
                    ),
                    const SizedBox(width: 12),
                    /*
                     * THERE IS NO WAY PAST THIS, deliberately, and the note is
                     * here because the button that used to be was removed on
                     * purpose rather than lost.
                     *
                     * A display that could be skipped past never gets counted,
                     * and that is exactly how a venue ran customer screens for
                     * months against a subscription that had expired.
                     *
                     * What stops this trapping a venue is that it is asked ONCE:
                     * a screen that has connected before never reaches this page
                     * again and works with the broadband down for ever after.
                     * See DisplayEntry at the foot of this file.
                     */
                    /*
                     * Two failures, two different next actions, and pressing
                     * "Try again" only helps with one of them. A network that
                     * is down is worth retrying; every licence being taken is
                     * not -- somebody has to go and free one first.
                     */
                    if (_full)
                      Flexible(
                        child: Text(
                          'Ask a manager to sign another display out in the back office, '
                          'under Devices, then try again.',
                          style: theme.textTheme.bodySmall,
                        ),
                      )
                    else if (_unreachable)
                      Flexible(
                        child: Text(
                          'The back office cannot be reached. Check this machine is on '
                          'the network, then try again.',
                          style: theme.textTheme.bodySmall,
                        ),
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
    if (licence != null && licence.locked) {
      return LicenceLockedPage(
        state: licence,
        onRetry: () => ref.invalidate(displayLicenceProvider),
      );
    }
    return const DisplayPage();
  }
}
