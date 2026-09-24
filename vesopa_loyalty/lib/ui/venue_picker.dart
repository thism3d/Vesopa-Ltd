import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/api.dart';
import '../data/session.dart';
import '../platform/vesopa_sso.dart';
import 'widgets.dart';

/// The first screen on Windows, Android and an iPhone: Continue with Vesopa.
///
/// A browser never sees this: the app is served at `loyalty.vesopa.com/<slug>/` and the venue
/// is in the address.
///
/// NO VENUE CODE. A venue gives somebody access in its back office -- it
/// invites their email address, or links their Vesopa account -- and that is
/// the only way onto a venue's scheme from this app. So the app asks for the
/// Vesopa account and the server says where it may go: one venue and the member
/// is straight in, several and they choose, none and they are told to ask
/// their venue. Nothing here makes a membership.
class VenuePickerPage extends ConsumerStatefulWidget {
  const VenuePickerPage({super.key});

  @override
  ConsumerState<VenuePickerPage> createState() => _VenuePickerPageState();
}

class _VenuePickerPageState extends ConsumerState<VenuePickerPage> {
  var _busy = false;
  String? _error;

  /// Held between the two calls when the account has several venues.
  String? _idToken;
  List<VesopaVenue> _choices = const [];

  static const _config = AppConfig(base: AppConfig.apiBase, slug: '');
  LoyaltyApi get _api => LoyaltyApi(base: AppConfig.apiBase, slug: '');

  Future<void> _run(Future<void> Function() body) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await body();
    } on ApiError catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (_) {
      if (mounted) setState(() => _error = 'That sign-in could not be completed. Please try again.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _continue() => _run(() async {
    setState(() => _choices = const []);
    final answer = await startVesopaSignIn(slug: '', venue: 'Vesopa Loyalty');
    if (answer == null || answer.isEmpty) return;
    if (answer.error != null || answer.idToken == null) {
      setState(() => _error = answer.error ?? 'That sign-in could not be completed.');
      return;
    }
    _idToken = answer.idToken;
    await _arrive(await _api.continueWithVesopa(idToken: _idToken!, platform: _config.platform));
  });

  Future<void> _choose(VesopaVenue venue) => _run(() async {
    final token = _idToken;
    if (token == null) return;
    await _arrive(await _api.continueWithVesopa(
      idToken: token,
      slug: venue.slug,
      platform: _config.platform,
    ));
  });

  Future<void> _arrive(VesopaWayIn way) async {
    if (way.token != null && way.venue != null) {
      _idToken = null;
      await rememberToken(way.venue!.slug, way.token!);
      await ref.read(venueProvider.notifier).choose(way.venue!.slug);
      return;
    }
    setState(() => _choices = way.venues);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 460),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Image.asset(
                    'assets/vesopa-mark.png',
                    width: 84,
                    height: 84,
                    errorBuilder: (_, _, _) => const SizedBox(height: 84),
                  ),
                  const SizedBox(height: 22),
                  Text(
                    _choices.isEmpty ? 'Vesopa Loyalty' : 'Which card?',
                    textAlign: TextAlign.center,
                    style: theme.textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800),
                  ),
                  const SizedBox(height: 10),
                  Text(
                    _choices.isEmpty
                        ? 'Your loyalty card for the venues you visit. Sign in with the '
                            'Vesopa account your venue gave access to.'
                        : 'Your Vesopa account has a card at more than one venue.',
                    textAlign: TextAlign.center,
                    style: theme.textTheme.bodyLarge,
                  ),
                  const SizedBox(height: 26),
                  if (_choices.isNotEmpty)
                    for (final v in _choices)
                      Card(
                        child: ListTile(
                          leading: const Icon(Icons.storefront_outlined),
                          title: Text(v.name),
                          trailing: const Icon(Icons.chevron_right),
                          enabled: !_busy,
                          onTap: () => _choose(v),
                        ),
                      )
                  else
                    FilledButton.icon(
                      onPressed: _busy ? null : _continue,
                      icon: _busy
                          ? const SizedBox(
                              width: 20,
                              height: 20,
                              child: CircularProgressIndicator(strokeWidth: 2.5),
                            )
                          : const Icon(Icons.login),
                      label: const Text('Continue with Vesopa'),
                    ),
                  if (_error != null) ...[
                    const SizedBox(height: 14),
                    Text(
                      _error!,
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        color: theme.colorScheme.error,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ],
                  if (_choices.isNotEmpty) ...[
                    const SizedBox(height: 12),
                    TextButton(
                      onPressed: _busy ? null : _continue,
                      child: const Text('Use a different Vesopa account'),
                    ),
                  ],
                  const SizedBox(height: 28),
                  Text(
                    'Vesopa Loyalty works with venues that use Vesopa. Your venue '
                    'invites your email address; there is nothing to join here.',
                    textAlign: TextAlign.center,
                    style: theme.textTheme.bodySmall,
                  ),
                  const SizedBox(height: 20),
                  const PoweredBy(),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
