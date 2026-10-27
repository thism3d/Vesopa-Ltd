/// Nobody is signed on: PIN, staff card or Face ID. Straight onto the pad,
/// as the till's Sign On key does -- the PIN already says who you are.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/clerk_auth.dart';
import '../../data/session.dart';
import '../../nfc/staff_card.dart';
import '../theme.dart';

class ClerkLockPage extends ConsumerStatefulWidget {
  const ClerkLockPage({super.key});
  @override
  ConsumerState<ClerkLockPage> createState() => _ClerkLockPageState();
}

class _ClerkLockPageState extends ConsumerState<ClerkLockPage> {
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
    if (last == null) return;
    if (await _auth.unlockWithBiometrics(last)) ref.read(tapProvider.notifier).signOn(last);
  }

  @override
  Widget build(BuildContext context) {
    final s = ref.watch(tapProvider);
    final t = Theme.of(context).textTheme;
    final dim = t.bodySmall?.color;
    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 16),
          child: Column(children: [
            Row(children: [
              const TapMark(size: 36),
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
                    border: Border.all(color: i < _pin.length ? Tp.lime : (dim ?? Colors.grey), width: 2),
                  ),
                ),
            ]),
            SizedBox(height: 28, child: _error == null ? null : Text(_error!, textAlign: TextAlign.center, style: t.bodySmall?.copyWith(color: Tp.danger))),
            const Spacer(),
            for (final row in const [['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9']])
              Row(children: [for (final d in row) _Key(label: d, onTap: () => _digit(d))]),
            Row(children: [
              _Key(
                icon: _bio && s.lastClerk != null ? Icons.face_rounded : (_nfc ? Icons.nfc_rounded : null),
                onTap: _bio && s.lastClerk != null ? _face : (_nfc ? _card : null),
              ),
              _Key(label: '0', onTap: () => _digit('0')),
              _Key(icon: Icons.backspace_outlined, onTap: _pin.isEmpty ? null : () => setState(() => _pin = _pin.substring(0, _pin.length - 1))),
            ]),
            const SizedBox(height: 8),
            if (_nfc)
              TextButton.icon(onPressed: _card, icon: const Icon(Icons.badge_rounded), label: const Text('Tap your staff card')),
            if (s.demo) Text('Demo PINs: 1111 Sam · 2222 Alex · 3333 Priya', style: t.bodySmall),
          ]),
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
            height: 68,
            child: label == null && icon == null
                ? null
                : Material(
                    color: Theme.of(context).colorScheme.surfaceContainer,
                    borderRadius: BorderRadius.circular(18),
                    child: InkWell(
                      borderRadius: BorderRadius.circular(18),
                      onTap: onTap,
                      child: Center(
                        child: label != null
                            ? Text(label!, style: const TextStyle(fontSize: 28, fontWeight: FontWeight.w700, fontFeatures: Tp.tabular))
                            : Icon(icon, size: 28),
                      ),
                    ),
                  ),
          ),
        ),
      );
}
