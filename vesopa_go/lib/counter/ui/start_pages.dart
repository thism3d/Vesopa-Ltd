/// Before selling: the first screen on a new device (Continue with Vesopa,
/// register a venue, or the demo) and the clerk's PIN.
///
/// The sign-in is Go's own (PKCE in the system browser, the device
/// commissioned as a till seat); Lite only brings its own face, and always
/// runs as a counter till on its own -- no tables, no shared bills.
library;

import 'dart:math' as math;

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/foundation.dart' show kDebugMode;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:vesopa_go/config/constants.dart' show apiBase;
import 'package:vesopa_go/data/api.dart';
import 'package:vesopa_go/data/models.dart';
import 'package:vesopa_go/data/clerk_auth.dart';
import 'package:vesopa_go/data/session.dart';
import 'package:vesopa_go/data/vesopa_sso.dart';
import 'package:vesopa_go/nfc/staff_card.dart';
import 'package:vesopa_go/ui/go_frame.dart' show IdleScreen, VenueMark;
import 'package:vesopa_go/ui/pages/sign_in_flow.dart';
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
                // The demo is gone from the store builds (owner, 2026-10-28):
                // reviewers sign in to The Vesopa Kitchen. It stays in a
                // developer build, where the tests drive it, and in the web
                // showroom (GO_DEMO_ONLY).
                if (kDebugMode) const SizedBox(height: 4),
                if (kDebugMode) TextButton(
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

/// Nobody signed on: the venue's wallpaper behind the staff and the PIN pad,
/// as the till's sign-in. Each way in is the venue's to switch off (back
/// office, Vesopa Go options > Signing in): the PIN, the staff tiles, a staff
/// card, Face ID / fingerprint; signing in can clock the member of staff in.
class LiteLockPage extends ConsumerStatefulWidget {
  const LiteLockPage({super.key});
  @override
  ConsumerState<LiteLockPage> createState() => _LiteLockPageState();
}

class _LiteLockPageState extends ConsumerState<LiteLockPage> with SingleTickerProviderStateMixin {
  final _auth = ClerkAuth();
  String _pin = '';
  String? _error;
  bool _nfc = false;
  bool _bio = false;
  Clerk? _picked;
  bool _idle = false;
  late final _shake = AnimationController(vsync: this, duration: const Duration(milliseconds: 420));

  @override
  void initState() {
    super.initState();
    StaffCardReader.available().then((v) => mounted ? setState(() => _nfc = v) : null);
    _auth.biometricsAvailable().then((v) => mounted ? setState(() => _bio = v) : null);
  }

  @override
  void dispose() {
    _shake.dispose();
    super.dispose();
  }

  Future<void> _signOn(Clerk clerk) async {
    final s = ref.read(tapProvider);
    ref.read(tapProvider.notifier).signOn(clerk);
    if (s.config.go.loginClockIn && !s.demo) {
      // Clocked in on the first sign-in of the shift; already in stays in.
      ref.read(apiProvider).clockIn(clerk.id).catchError((Object _) => false);
    }
  }

  void _wrong(String why) {
    // Felt as well as seen, and the pad starts again at the first digit.
    HapticFeedback.heavyImpact();
    HapticFeedback.vibrate();
    _shake.forward(from: 0);
    setState(() {
      _pin = '';
      _error = why;
    });
  }

  void _digit(String d) {
    if (_pin.length >= 6) return;
    HapticFeedback.selectionClick();
    setState(() {
      _pin += d;
      _error = null;
    });
    final picked = _picked;
    final staff = picked == null ? ref.read(tapProvider).staff : [picked];
    final clerk = ClerkAuth.byPin(staff, _pin);
    if (clerk != null) {
      _signOn(clerk);
    } else if (_pin.length >= _pinLength(staff)) {
      // Wrong as soon as it is as long as the venue's PINs (4 digits at most
      // venues), not after six (owner, 2026-10-31).
      _wrong(picked == null ? 'That PIN is not on this venue\'s staff list' : 'That is not ${picked.name}\'s PIN');
    }
  }

  /// The longest PIN on the staff list: a PIN that long and matching nobody
  /// is wrong. 4 when nobody has one.
  static int _pinLength(List<Clerk> staff) {
    var n = 0;
    for (final c in staff) {
      if (c.pin.length > n) n = c.pin.length;
    }
    return n == 0 ? 4 : n.clamp(4, 6);
  }

  /// Cancel: what was typed goes, and the idle screen comes back when the
  /// venue has one (owner, 2026-10-31).
  void _cancel() {
    setState(() {
      _pin = '';
      _error = null;
      _picked = null;
      _idle = ref.read(tapProvider).config.go.idleEnabled;
    });
  }

  Future<void> _card() async {
    final id = await StaffCardReader.readOnce();
    if (id == null) return;
    final clerk = ClerkAuth.byCard(ref.read(tapProvider).staff, id);
    if (clerk != null) {
      _signOn(clerk);
    } else {
      _wrong('That card is not anyone\'s staff card. Set it in the back office under Staff.');
    }
  }

  Future<void> _face() async {
    final last = ref.read(tapProvider).lastClerk;
    if (last != null && await _auth.unlockWithBiometrics(last)) _signOn(last);
  }

  @override
  Widget build(BuildContext context) {
    final s = ref.watch(tapProvider);
    final go = s.config.go;
    final t = Theme.of(context).textTheme;
    final dim = t.bodySmall?.color ?? Colors.grey;
    final bio = go.loginBiometrics && _bio && s.lastClerk != null;
    final nfc = go.loginNfc && _nfc;
    final url = s.config.idleImageUrl;
    final wallpaper = url == null ? null : (url.startsWith('http') ? url : '$apiBase${url.startsWith('/') ? '' : '/'}$url');
    final picked = _picked;

    final pad = ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 400),
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        AnimatedSwitcher(
          duration: const Duration(milliseconds: 200),
          child: Text(
            picked == null ? (go.loginPin ? 'Enter your PIN' : 'Tap your staff card') : 'Hello ${picked.name.split(' ').first}',
            key: ValueKey(picked?.id),
            style: t.headlineSmall?.copyWith(fontWeight: FontWeight.w800, color: Colors.white),
          ),
        ),
        const SizedBox(height: 18),
        if (go.loginPin) ...[
          AnimatedBuilder(
            animation: _shake,
            builder: (_, child) => Transform.translate(offset: Offset(12 * math.sin(_shake.value * math.pi * 6) * (1 - _shake.value), 0), child: child),
            child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
              for (var i = 0; i < _pinLength(picked == null ? s.staff : [picked]); i++)
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
          ),
          SizedBox(height: 28, child: _error == null ? null : Text(_error!, textAlign: TextAlign.center, style: t.bodySmall?.copyWith(color: Tp.danger))),
          for (final row in const [['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9']])
            Row(children: [for (final d in row) _Key(label: d, onTap: () => _digit(d))]),
          Row(children: [
            _Key(icon: bio ? Icons.face_rounded : (nfc ? Icons.nfc_rounded : null), onTap: bio ? _face : (nfc ? _card : null)),
            _Key(label: '0', onTap: () => _digit('0')),
            _Key(icon: Icons.backspace_outlined, onTap: _pin.isEmpty ? null : () => setState(() => _pin = _pin.substring(0, _pin.length - 1))),
          ]),
        ] else ...[
          SizedBox(height: 28, child: _error == null ? null : Text(_error!, textAlign: TextAlign.center, style: t.bodySmall?.copyWith(color: Tp.danger))),
          if (nfc) FilledButton.icon(onPressed: _card, icon: const Icon(Icons.nfc_rounded), label: const Text('Read my staff card')),
          if (bio) Padding(padding: const EdgeInsets.only(top: 10), child: OutlinedButton.icon(onPressed: _face, icon: const Icon(Icons.face_rounded), label: const Text('Face ID'))),
        ],
        const SizedBox(height: 8),
        TextButton(
          onPressed: _cancel,
          style: TextButton.styleFrom(foregroundColor: Colors.white, minimumSize: const Size(160, 48), textStyle: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
          child: const Text('Cancel'),
        ),
        if (s.demo) Text('Demo PINs: 1111 Sam (manager) · 2222 Alex · 3333 Priya', style: t.bodySmall),
      ]),
    );

    if (_idle) return IdleScreen(onWake: () => setState(() => _idle = false));
    return Scaffold(
      backgroundColor: context.goDeep,
      body: Stack(fit: StackFit.expand, children: [
        if (wallpaper != null) CachedNetworkImage(imageUrl: wallpaper, fit: BoxFit.cover, errorWidget: (_, _, _) => const SizedBox.shrink()),
        const ColoredBox(color: Color(0xB3000000)),
        SafeArea(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 16),
            child: Column(children: [
              Row(children: [
                // The venue's own logo, as on the idle screen.
                const VenueMark(height: 36),
                const SizedBox(width: 12),
                Expanded(child: Text(s.venue?.name ?? '', style: t.titleMedium?.copyWith(color: Colors.white), overflow: TextOverflow.ellipsis)),
                if (s.demo) const Chip(label: Text('Demo')),
                if (!s.online) const Icon(Icons.cloud_off_rounded, color: Tp.amber),
                if (!s.demo) const _SyncMark(),
              ]),
              Expanded(
                child: Center(child: SingleChildScrollView(child: pad)),
              ),
            ]),
          ),
        ),
      ]),
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

/// The venue's menu, staff and settings: turning while they are being
/// fetched, a tick once they are in. A tap fetches them again (owner,
/// 2026-10-31: "a sync icon here if new stuff is added").
class _SyncMark extends ConsumerWidget {
  const _SyncMark();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.read(tapProvider.notifier);
    return ValueListenableBuilder<bool>(
      valueListenable: session.syncing,
      builder: (context, busy, _) => IconButton(
        tooltip: busy ? 'Fetching the menu and staff' : 'Menu and staff are up to date. Tap to fetch again.',
        onPressed: busy ? null : session.refresh,
        icon: busy
            ? const SizedBox.square(dimension: 22, child: CircularProgressIndicator(strokeWidth: 2.4, color: Colors.white))
            : const Icon(Icons.cloud_done_rounded, color: Colors.white),
      ),
    );
  }
}
