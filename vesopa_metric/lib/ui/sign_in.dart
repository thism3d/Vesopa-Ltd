import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../brand.dart';
import '../data/session.dart';
import 'widgets.dart';

/// The front door. One way in: Continue with Vesopa, which also makes a
/// Vesopa account for somebody who has none (an emailed code, no password).
class SignInPage extends ConsumerStatefulWidget {
  const SignInPage({super.key});

  @override
  ConsumerState<SignInPage> createState() => _SignInPageState();
}

class _SignInPageState extends ConsumerState<SignInPage> {
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _error = ref.read(sessionProvider.notifier).lastSignInError;
    ref.read(sessionProvider.notifier).lastSignInError = null;
  }

  Future<void> _go() async {
    ref.read(activityLogProvider).tap('continue_with_vesopa');
    setState(() {
      _busy = true;
      _error = null;
    });
    final error = await ref.read(sessionProvider.notifier).continueWithVesopa();
    if (!mounted) return;
    setState(() {
      _busy = false;
      _error = error;
    });
  }

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Scaffold(
      backgroundColor: Colors.white,
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(28),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Center(child: MetricLogo(height: 56)),
                  const SizedBox(height: 36),
                  Text('Membership', style: text.headlineMedium?.copyWith(color: MetricBrand.navy, fontWeight: FontWeight.w700)),
                  const SizedBox(height: 8),
                  Text(
                    'Register your car and the barrier opens for you, on the way in and on the way out. No tickets, no cards.',
                    style: text.bodyLarge?.copyWith(color: const Color(0xFF5D6679)),
                  ),
                  const SizedBox(height: 28),
                  const _Step(n: 1, text: 'Sign in with your Vesopa account, or make one in a minute.'),
                  const _Step(n: 2, text: 'Add your car registrations.'),
                  const _Step(n: 3, text: 'Drive up. The camera reads your plate and the barrier lifts.'),
                  const SizedBox(height: 28),
                  if (_error != null) ...[
                    Container(
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(color: const Color(0xFFFDE7E6), borderRadius: BorderRadius.circular(12)),
                      child: Text(_error!, style: const TextStyle(color: Color(0xFFB3261E))),
                    ),
                    const SizedBox(height: 16),
                  ],
                  FilledButton(
                    key: const Key('continue-with-vesopa'),
                    onPressed: _busy ? null : _go,
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        if (_busy)
                          const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                        else
                          ClipRRect(
                            borderRadius: BorderRadius.circular(4),
                            child: Image.asset('assets/vesopa-mark.png', width: 22, height: 22),
                          ),
                        const SizedBox(width: 12),
                        Text(_busy ? 'Waiting for Vesopa…' : 'Continue with Vesopa'),
                      ],
                    ),
                  ),
                  const SizedBox(height: 12),
                  Text(
                    'New here? Continue with Vesopa makes your account. Metric approves new memberships before the barriers open.',
                    textAlign: TextAlign.center,
                    style: text.bodySmall?.copyWith(color: const Color(0xFF5D6679)),
                  ),
                  const SizedBox(height: 36),
                  Wrap(
                    alignment: WrapAlignment.center,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    spacing: 4,
                    children: [
                      Text('${MetricBrand.company} · ', style: text.bodySmall),
                      InkWell(
                        onTap: () => launchUrl(Uri.parse('tel:${MetricBrand.phone.replaceAll(' ', '')}')),
                        child: Text(MetricBrand.phone, style: text.bodySmall?.copyWith(color: MetricBrand.navy)),
                      ),
                    ],
                  ),
                  const SizedBox(height: 4),
                  Text('Powered by Vesopa', textAlign: TextAlign.center, style: text.bodySmall?.copyWith(color: const Color(0xFF8A93A6))),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _Step extends StatelessWidget {
  const _Step({required this.n, required this.text});

  final int n;
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        CircleAvatar(
          radius: 14,
          backgroundColor: MetricBrand.green,
          child: Text('$n', style: const TextStyle(color: MetricBrand.navy, fontWeight: FontWeight.w700)),
        ),
        const SizedBox(width: 12),
        Expanded(child: Padding(padding: const EdgeInsets.only(top: 4), child: Text(text))),
      ],
    ),
  );
}
