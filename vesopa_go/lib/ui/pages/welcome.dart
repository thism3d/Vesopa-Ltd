/// The first screen on a new phone: sign in to a venue that is on Vesopa,
/// register a new one, or try the demo.
library;

import 'package:flutter/foundation.dart' show kDebugMode;
import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../config/constants.dart';
import '../../data/api.dart';
import '../../data/recent_venues.dart';
import '../../data/session.dart';
import '../../data/vesopa_sso.dart';
import '../theme.dart';
import 'sign_in_flow.dart';
import 'welcome_slides.dart';

class WelcomePage extends ConsumerStatefulWidget {
  const WelcomePage({super.key});
  @override
  ConsumerState<WelcomePage> createState() => _WelcomePageState();
}

class _WelcomePageState extends ConsumerState<WelcomePage> {
  bool _busy = false;
  String? _error;

  List<RecentVenue> _recent = const [];

  @override
  void initState() {
    super.initState();
    RecentVenues.load().then((v) {
      if (mounted) setState(() => _recent = v);
    });
    // From More's "Switch venue or account": straight to Vesopa's picker.
    if (RecentVenues.switchOnOpen) {
      RecentVenues.switchOnOpen = false;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _signIn(selectAccount: true);
      });
    }
  }

  Future<void> _signIn({bool selectAccount = false}) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final sso = await ref.read(apiProvider).signInClient();
      final idToken = await VesopaSso(issuer: sso.issuer, clientId: sso.clientId).authorize(selectAccount: selectAccount);
      if (!mounted) return;
      await commissionDevice(context, ref, idToken);
    } on SsoFailed catch (e) {
      setState(() => _error = e.message);
    } on TapApiError catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Scaffold(
      body: SafeArea(
        child: LayoutBuilder(builder: (context, box) {
          // Phones and iPads alike: one centred column, the tour sized to the
          // screen so nothing scrolls on a small phone held upright.
          final slides = (box.maxHeight * 0.42).clamp(220.0, 380.0);
          return SingleChildScrollView(
            child: ConstrainedBox(
              constraints: BoxConstraints(minHeight: box.maxHeight),
              child: Center(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 520),
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(24, 20, 24, 20),
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        _Entrance(delay: 0, child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                          const TapMark(size: 40),
                          const SizedBox(width: 12),
                          Text('Vesopa Go', style: t.headlineMedium?.copyWith(fontWeight: FontWeight.w900, letterSpacing: -0.8)),
                        ])),
                        const SizedBox(height: 8),
                        _Entrance(
                          delay: 80,
                          child: Text('The till in your pocket', textAlign: TextAlign.center,
                              style: t.titleMedium?.copyWith(color: t.bodySmall?.color)),
                        ),
                        const SizedBox(height: 12),
                        _Entrance(delay: 160, child: WelcomeSlides(height: slides)),
                        const SizedBox(height: 20),
                        if (_error != null) ...[
                          Text(_error!, textAlign: TextAlign.center, style: t.bodyMedium?.copyWith(color: Tp.danger)),
                          const SizedBox(height: 12),
                        ],
                        _Entrance(
                          delay: 240,
                          child: Pressable(
                            child: FilledButton.icon(
                              onPressed: _busy ? null : () => _signIn(selectAccount: _recent.isNotEmpty),
                              icon: _busy
                                  ? const SizedBox.square(dimension: 20, child: CircularProgressIndicator(strokeWidth: 2.5))
                                  : const Icon(Icons.login_rounded),
                              label: const Text('Continue with Vesopa'),
                            ),
                          ),
                        ),
                        const SizedBox(height: 12),
                        _Entrance(
                          delay: 300,
                          child: Pressable(
                            child: OutlinedButton.icon(
                              onPressed: _busy ? null : () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const RegisterPage())),
                              icon: const Icon(Icons.storefront_rounded),
                              label: const Text('Register a new venue'),
                            ),
                          ),
                        ),
                        if (_recent.isNotEmpty) ...[
                          const SizedBox(height: 22),
                          Text('Signed in here before', textAlign: TextAlign.center, style: t.labelLarge?.copyWith(color: t.bodySmall?.color)),
                          const SizedBox(height: 8),
                          Wrap(alignment: WrapAlignment.center, spacing: 8, runSpacing: 8, children: [
                            for (final v in _recent)
                              Pressable(
                                child: ActionChip(
                                  avatar: _RecentMark(url: v.markUrl),
                                  label: Text(v.name),
                                  onPressed: _busy ? null : () => _signIn(selectAccount: true),
                                ),
                              ),
                          ]),
                        ],
                        if (kDebugMode) const SizedBox(height: 4),
                        if (kDebugMode) TextButton(
                          onPressed: _busy ? null : () => ref.read(tapProvider.notifier).startDemo(),
                          child: const Text('Try the demo'),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          );
        }),
      ),
    );
  }
}

/// Rises and fades in once, [delay] ms after the screen opens.
class _Entrance extends StatelessWidget {
  const _Entrance({required this.delay, required this.child});
  final int delay;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    if (MediaQuery.of(context).disableAnimations) return child;
    return TweenAnimationBuilder<double>(
      tween: Tween(begin: 0, end: 1),
      duration: Duration(milliseconds: 520 + delay),
      curve: Interval(delay / (520 + delay), 1, curve: const Cubic(0.2, 0, 0, 1)),
      builder: (_, v, c) => Opacity(opacity: v, child: Transform.translate(offset: Offset(0, (1 - v) * 18), child: c)),
      child: child,
    );
  }
}

/// A venue's logo on its "Signed in here before" chip, or Go's mark.
class _RecentMark extends StatelessWidget {
  const _RecentMark({this.url});
  final String? url;

  @override
  Widget build(BuildContext context) {
    final u = url;
    if (u == null) return const TapMark(size: 22);
    return CachedNetworkImage(
      imageUrl: u.startsWith('http') ? u : '$apiBase${u.startsWith('/') ? '' : '/'}$u',
      width: 22,
      height: 22,
      fit: BoxFit.contain,
      errorWidget: (_, _, _) => const TapMark(size: 22),
    );
  }
}

/// A venue new to Vesopa, starting on Vesopa Go alone. The person makes
/// (or uses) a Vesopa account, and the venue is created on the back office
/// with this phone as its first terminal: everything it sells is in the back
/// office from the first sale.
class RegisterPage extends ConsumerStatefulWidget {
  const RegisterPage({super.key});
  @override
  ConsumerState<RegisterPage> createState() => _RegisterPageState();
}

class _RegisterPageState extends ConsumerState<RegisterPage> {
  final _form = GlobalKey<FormState>();
  final _name = TextEditingController();
  final _postcode = TextEditingController();
  String _type = 'Pub or bar';
  bool _busy = false;
  String? _error;

  static const _types = ['Pub or bar', 'Restaurant', 'Café', 'Club', 'Market stall or pop-up', 'Events'];

  Future<void> _go() async {
    if (!_form.currentState!.validate()) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final sso = await ref.read(apiProvider).signInClient();
      final idToken = await VesopaSso(issuer: sso.issuer, clientId: sso.clientId).authorize(signUp: true);
      final session = ref.read(tapProvider.notifier);
      final answer = await ref.read(apiProvider).registerVenue(
            idToken: idToken,
            venueName: _name.text.trim(),
            businessType: _type,
            postcode: _postcode.text.trim().toUpperCase(),
            device: session.terminalName,
            deviceId: session.deviceId,
          );
      await ref.read(tapProvider.notifier).commissioned(answer);
      if (mounted) Navigator.of(context).pop();
    } on SsoFailed catch (e) {
      setState(() => _error = e.message);
    } on TapApiError catch (e) {
      setState(() => _error = e.status == 404
          ? 'Registering from the app is coming soon. For now, sign up at vesopa.com and then Continue with Vesopa.'
          : e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(title: const Text('Register a venue')),
      body: Form(
        key: _form,
        child: ListView(
          padding: const EdgeInsets.all(24),
          children: [
            Text('Start taking payments today. Your sales, staff and menu live in the Vesopa back office, '
                'and you can add Vesopa EPOS tills whenever you like.', style: t.bodyLarge),
            const SizedBox(height: 24),
            TextFormField(
              controller: _name,
              textCapitalization: TextCapitalization.words,
              decoration: const InputDecoration(labelText: 'Venue name'),
              validator: (v) => (v ?? '').trim().length < 2 ? 'Give the venue a name' : null,
            ),
            const SizedBox(height: 14),
            DropdownButtonFormField<String>(
              initialValue: _type,
              decoration: const InputDecoration(labelText: 'Type of business'),
              items: [for (final t in _types) DropdownMenuItem(value: t, child: Text(t))],
              onChanged: (v) => setState(() => _type = v ?? _type),
            ),
            const SizedBox(height: 14),
            TextFormField(
              controller: _postcode,
              textCapitalization: TextCapitalization.characters,
              decoration: const InputDecoration(labelText: 'Postcode'),
              validator: (v) => RegExp(r'^[A-Za-z]{1,2}\d[A-Za-z\d]?\s*\d[A-Za-z]{2}$').hasMatch((v ?? '').trim())
                  ? null
                  : 'A UK postcode, like SA8 4EG',
            ),
            const SizedBox(height: 24),
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Row(children: [
                  Icon(Icons.credit_card_rounded, color: context.goLimeInk),
                  const SizedBox(width: 12),
                  Expanded(child: Text('Card payments go through your own Dojo account. You connect it in the back office '
                      'after registering; until then the app runs in test mode.', style: t.bodyMedium)),
                ]),
              ),
            ),
            const SizedBox(height: 24),
            if (_error != null) ...[Text(_error!, style: t.bodyMedium?.copyWith(color: Tp.danger)), const SizedBox(height: 12)],
            FilledButton(onPressed: _busy ? null : _go, child: Text(_busy ? 'Setting up…' : 'Create my Vesopa account')),
          ],
        ),
      ),
    );
  }
}
