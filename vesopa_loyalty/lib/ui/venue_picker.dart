import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/api.dart';
import '../data/session.dart';
import 'widgets.dart';

/// "Which venue?" — the first screen on Windows, Android and an iPhone.
///
/// A browser never sees this: the app is served at `/app/<slug>/` and the venue
/// is in the address. Everything else has no address, so somebody has to say,
/// once.
///
/// IT ACCEPTS THE WHOLE LINK, not just the code. Whoever is typing this has a
/// table card, a receipt or a text message in front of them, and what is
/// printed on it is the address — demanding they pick the last word out of it
/// is how a first run gets abandoned.
///
/// AND IT CHECKS BEFORE IT ACCEPTS. A venue code that does not exist is told so
/// here, where there is a box to correct, rather than being saved and turned
/// into a sign-in page that fails for reasons nobody can see.
class VenuePickerPage extends ConsumerStatefulWidget {
  const VenuePickerPage({super.key});

  @override
  ConsumerState<VenuePickerPage> createState() => _VenuePickerPageState();
}

class _VenuePickerPageState extends ConsumerState<VenuePickerPage> {
  final _input = TextEditingController();
  var _busy = false;
  String? _error;

  @override
  void dispose() {
    _input.dispose();
    super.dispose();
  }

  Future<void> _go() async {
    final slug = AppConfig.cleanSlug(_input.text);
    if (slug == null) {
      setState(() => _error = 'That does not look like a venue code or link.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      // Ask the server whether this venue exists and has its app switched on,
      // using a throwaway client: the real one is built from the venue, and
      // there is no venue yet.
      final api = LoyaltyApi(base: AppConfig.apiBase, slug: slug);
      final venue = await api.app();
      final name = (venue['name'] as String?) ?? 'that venue';
      await ref.read(venueProvider.notifier).choose(slug);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Opening $name.'), behavior: SnackBarBehavior.floating),
        );
      }
    } on ApiError catch (e) {
      setState(() => _error = e.status == 404
          ? 'There is no app at that code. Check it with the venue.'
          : e.message);
    } catch (_) {
      setState(() => _error = 'Could not check that code. Are you online?');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
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
                    'Which venue?',
                    textAlign: TextAlign.center,
                    style: theme.textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800),
                  ),
                  const SizedBox(height: 10),
                  Text(
                    'Enter the code your venue gave you, or paste the link to its app. '
                    'You only have to do this once.',
                    textAlign: TextAlign.center,
                    style: theme.textTheme.bodyLarge,
                  ),
                  const SizedBox(height: 26),
                  TextField(
                    controller: _input,
                    enabled: !_busy,
                    autofocus: true,
                    autocorrect: false,
                    textInputAction: TextInputAction.go,
                    decoration: const InputDecoration(
                      labelText: 'Venue code or link',
                      hintText: 'the-crown  —  or  menu.vesopaepos.com/app/the-crown/',
                    ),
                    onSubmitted: (_) => _go(),
                  ),
                  if (_error != null) ...[
                    const SizedBox(height: 12),
                    Text(
                      _error!,
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        color: theme.colorScheme.error,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ],
                  const SizedBox(height: 18),
                  FilledButton(
                    onPressed: _busy ? null : _go,
                    child: _busy
                        ? const SizedBox(
                            width: 22,
                            height: 22,
                            child: CircularProgressIndicator(strokeWidth: 2.5),
                          )
                        : const Text('Continue'),
                  ),
                  const SizedBox(height: 28),
                  Text(
                    "Vesopa Loyalty works with venues that use the Vesopa till system. "
                    "If you do not have a code, ask at the venue.",
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
