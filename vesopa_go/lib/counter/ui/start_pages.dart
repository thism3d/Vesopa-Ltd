/// Before selling: the first screen on a new device (Continue with Vesopa,
/// register a venue, or the demo) and the clerk's PIN.
///
/// The sign-in is Go's own (PKCE in the system browser, the device
/// commissioned as a till seat); Lite only brings its own face, and always
/// runs as a counter till on its own -- no tables, no shared bills.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:vesopa_go/data/api.dart';
import 'package:vesopa_go/data/clerk_auth.dart';
import 'package:vesopa_go/data/session.dart';
import 'package:vesopa_go/data/vesopa_sso.dart';
import 'package:vesopa_go/nfc/staff_card.dart';
import 'package:vesopa_go/ui/pages/welcome.dart' show RegisterPage;
import 'package:vesopa_go/ui/theme.dart';

import '../data/lite_demo.dart';
import 'package:vesopa_go/data/demo_venue.dart';
import 'brand.dart';

class LiteWelcomePage extends ConsumerStatefulWidget {
  const LiteWelcomePage({super.key});
  @override
  ConsumerState<LiteWelcomePage> createState() => _LiteWelcomePageState();
}

class _LiteWelcomePageState extends ConsumerState<LiteWelcomePage> {
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
      final session = ref.read(tapProvider.notifier);
      final api = ref.read(apiProvider);
      final answer = await api.commission(idToken, device: session.terminalName, deviceId: session.deviceId);
      final choice = await session.commissioned(answer);
      if (choice != null && mounted) {
        final site = await showDialog<Map<String, dynamic>>(
          context: context,
          builder: (c) => SimpleDialog(title: const Text('Which venue is this device for?'), children: [
            for (final s in choice.sites)
              SimpleDialogOption(onPressed: () => Navigator.pop(c, s), child: Text('${s['name'] ?? s['office_name'] ?? s['id']}')),
          ]),
        );
        if (site == null) return;
        final picked = await api.commissionSite(choice.pickToken, site['id'] as Object, device: session.terminalName, deviceId: session.deviceId);
        await session.commissioned(picked);
      }
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
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 460),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(24, 32, 24, 24),
              child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                const Spacer(),
                const Align(alignment: Alignment.centerLeft, child: GoMark(size: 72)),
                const SizedBox(height: 24),
                const Align(alignment: Alignment.centerLeft, child: GoWordmark(size: 32, mark: false)),
                const SizedBox(height: 10),
                Text('Lightweight on hardware, heavyweight on features. A fast till for bars, pop-ups, '
                    'stalls and beer gardens, on a phone, a tablet or a handheld card terminal.',
                    style: t.titleMedium?.copyWith(color: t.bodySmall?.color)),
                const Spacer(flex: 2),
                if (_error != null) ...[Text(_error!, style: t.bodyMedium?.copyWith(color: Tp.danger)), const SizedBox(height: 12)],
                FilledButton.icon(
                  onPressed: _busy ? null : _signIn,
                  icon: _busy ? const SizedBox.square(dimension: 20, child: CircularProgressIndicator(strokeWidth: 2.5)) : const Icon(Icons.login_rounded),
                  label: const Text('Continue with Vesopa'),
                ),
                const SizedBox(height: 12),
                OutlinedButton.icon(
                  onPressed: _busy ? null : () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const RegisterPage())),
                  icon: const Icon(Icons.storefront_rounded),
                  label: const Text('Register a new venue'),
                ),
                const SizedBox(height: 4),
                TextButton(
                  key: const ValueKey('demo'),
                  onPressed: _busy
                      ? null
                      : () => ref.read(tapProvider.notifier).startDemo(
                            venue: liteDemoVenue,
                            staff: liteDemoClerks,
                            categories: liteDemoCategories,
                            products: liteDemoProducts,
                            tables: demoTables,
                          ),
                  child: const Text('Try the demo'),
                ),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}

/// Nobody signed on: the PIN pad, a staff card, or Face ID / fingerprint.
class LiteLockPage extends ConsumerStatefulWidget {
  const LiteLockPage({super.key});
  @override
  ConsumerState<LiteLockPage> createState() => _LiteLockPageState();
}

class _LiteLockPageState extends ConsumerState<LiteLockPage> {
  final _auth = ClerkAuth();
  String _pin = '';
  String? _error;
  bool _nfc = false;
  bool _bio = false;

  @override
  void initState() {
    super.initState();
    StaffCardReader.available().then((v) => mounted ? setState(() => _nfc = v) : null);
    _auth.biometricsAvailable().then((v) => mounted ? setState(() => _bio = v) : null);
  }

  void _digit(String d) {
    if (_pin.length >= 6) return;
    HapticFeedback.selectionClick();
    setState(() {
      _pin += d;
      _error = null;
    });
    final clerk = ClerkAuth.byPin(ref.read(tapProvider).staff, _pin);
    if (clerk != null) {
      ref.read(tapProvider.notifier).signOn(clerk);
    } else if (_pin.length == 6) {
      HapticFeedback.heavyImpact();
      setState(() {
        _pin = '';
        _error = 'That PIN is not on this venue\'s staff list';
      });
    }
  }

  Future<void> _card() async {
    final id = await StaffCardReader.readOnce();
    if (id == null) return;
    final clerk = ClerkAuth.byCard(ref.read(tapProvider).staff, id);
    if (clerk != null) {
      ref.read(tapProvider.notifier).signOn(clerk);
    } else {
      setState(() => _error = 'That card is not anyone\'s staff card. Set it in the back office under Staff.');
    }
  }

  Future<void> _face() async {
    final last = ref.read(tapProvider).lastClerk;
    if (last != null && await _auth.unlockWithBiometrics(last)) ref.read(tapProvider.notifier).signOn(last);
  }

  @override
  Widget build(BuildContext context) {
    final s = ref.watch(tapProvider);
    final t = Theme.of(context).textTheme;
    final dim = t.bodySmall?.color ?? Colors.grey;
    final bio = _bio && s.lastClerk != null;
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 420),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 16),
              child: Column(children: [
                Row(children: [
                  const GoMark(size: 32),
                  const SizedBox(width: 12),
                  Expanded(child: Text(s.venue?.name ?? '', style: t.titleMedium, overflow: TextOverflow.ellipsis)),
                  if (s.demo) const Chip(label: Text('Demo')),
                  if (!s.online) const Icon(Icons.cloud_off_rounded, color: Tp.amber),
                ]),
                const Spacer(),
                Text('Enter your PIN', style: t.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
                const SizedBox(height: 18),
                Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                  for (var i = 0; i < 4; i++)
                    AnimatedContainer(
                      duration: const Duration(milliseconds: 120),
                      margin: const EdgeInsets.all(8),
                      width: 16,
                      height: 16,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: i < _pin.length ? Tp.lime : Colors.transparent,
                        border: Border.all(color: i < _pin.length ? Tp.lime : dim, width: 2),
                      ),
                    ),
                ]),
                SizedBox(height: 28, child: _error == null ? null : Text(_error!, textAlign: TextAlign.center, style: t.bodySmall?.copyWith(color: Tp.danger))),
                const Spacer(),
                for (final row in const [['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9']])
                  Row(children: [for (final d in row) _Key(label: d, onTap: () => _digit(d))]),
                Row(children: [
                  _Key(icon: bio ? Icons.face_rounded : (_nfc ? Icons.nfc_rounded : null), onTap: bio ? _face : (_nfc ? _card : null)),
                  _Key(label: '0', onTap: () => _digit('0')),
                  _Key(icon: Icons.backspace_outlined, onTap: _pin.isEmpty ? null : () => setState(() => _pin = _pin.substring(0, _pin.length - 1))),
                ]),
                const SizedBox(height: 8),
                if (s.demo) Text('Demo PINs: 1111 Sam (manager) · 2222 Alex · 3333 Priya', style: t.bodySmall),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}

class _Key extends StatelessWidget {
  const _Key({this.label, this.icon, this.onTap});
  final String? label;
  final IconData? icon;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) => Expanded(
        child: Padding(
          padding: const EdgeInsets.all(6),
          child: SizedBox(
            height: 64,
            child: label == null && icon == null
                ? null
                : Material(
                    color: Theme.of(context).colorScheme.surfaceContainer,
                    borderRadius: BorderRadius.circular(18),
                    child: InkWell(
                      key: label == null ? null : ValueKey('pin-$label'),
                      borderRadius: BorderRadius.circular(18),
                      onTap: onTap,
                      child: Center(
                        child: label != null
                            ? Text(label!, style: const TextStyle(fontSize: 26, fontWeight: FontWeight.w700, fontFeatures: Tp.tabular))
                            : Icon(icon, size: 26),
                      ),
                    ),
                  ),
          ),
        ),
      );
}
