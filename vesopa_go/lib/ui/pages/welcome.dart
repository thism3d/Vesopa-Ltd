/// The first screen on a new phone: sign in to a venue that is on Vesopa,
/// register a new one, or try the demo.
library;

import 'package:flutter/foundation.dart' show kDebugMode;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/api.dart';
import '../../data/session.dart';
import '../../data/vesopa_sso.dart';
import '../theme.dart';
import 'sign_in_flow.dart';

class WelcomePage extends ConsumerStatefulWidget {
  const WelcomePage({super.key});
  @override
  ConsumerState<WelcomePage> createState() => _WelcomePageState();
}

class _WelcomePageState extends ConsumerState<WelcomePage> {
  bool _busy = false;
  String? _error;

  Future<void> _signIn() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final sso = await ref.read(apiProvider).signInClient();
      final idToken = await VesopaSso(issuer: sso.issuer, clientId: sso.clientId).authorize();
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
        child: Padding(
          padding: const EdgeInsets.fromLTRB(24, 32, 24, 24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Spacer(),
              const Align(alignment: Alignment.centerLeft, child: TapMark(size: 84)),
              const SizedBox(height: 28),
              Text('Vesopa Go', style: t.displaySmall?.copyWith(fontWeight: FontWeight.w900, letterSpacing: -1)),
              const SizedBox(height: 10),
              Text('Take orders at the table and card payments on this phone. No card machine needed.',
                  style: t.titleMedium?.copyWith(color: t.bodySmall?.color)),
              const Spacer(flex: 2),
              if (_error != null) ...[
                Text(_error!, style: t.bodyMedium?.copyWith(color: Tp.danger)),
                const SizedBox(height: 12),
              ],
              FilledButton.icon(
                onPressed: _busy ? null : _signIn,
                icon: _busy
                    ? const SizedBox.square(dimension: 20, child: CircularProgressIndicator(strokeWidth: 2.5))
                    : const Icon(Icons.login_rounded),
                label: const Text('Continue with Vesopa'),
              ),
              const SizedBox(height: 12),
              OutlinedButton.icon(
                onPressed: _busy ? null : () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const RegisterPage())),
                icon: const Icon(Icons.storefront_rounded),
                label: const Text('Register a new venue'),
              ),
              if (kDebugMode) const SizedBox(height: 4),
              if (kDebugMode) TextButton(
                onPressed: _busy ? null : () => ref.read(tapProvider.notifier).startDemo(),
                child: const Text('Try the demo'),
              ),
            ],
          ),
        ),
      ),
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
