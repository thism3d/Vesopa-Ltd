import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/display_link.dart';
import '../../data/till_permissions.dart';
import '../../main.dart' show displayPairingProvider;
import '../customer_display_page.dart';
import '../permission_gate.dart';

/// The customer display, one press from the top bar (2026-10-17).
///
/// The owner: "a quick access button to add to the topbar or bottom bar and
/// then get all the settings, screens and everything of the connected
/// display". Drawn only on a till that has a customer display (paired on this
/// PC, live over the link, or on another computer), so a till without one has
/// nothing extra on its bar. Lit when a display is connected right now.
///
/// Opens the Customer display page: what the screen is doing, which monitor,
/// its size, touch, tiles and everything else. A manager's job, so a clerk
/// without the manager key is asked for one first.
class CustomerDisplayButton extends ConsumerStatefulWidget {
  const CustomerDisplayButton({super.key});

  @override
  ConsumerState<CustomerDisplayButton> createState() => _CustomerDisplayButtonState();
}

class _CustomerDisplayButtonState extends ConsumerState<CustomerDisplayButton> {
  StreamSubscription<void>? _changes;
  Timer? _check;
  bool _paired = false;

  DisplayLinkHub get _hub => DisplayLinkHub.instance;

  @override
  void initState() {
    super.initState();
    _changes = _hub.changes.listen((_) {
      if (mounted) setState(() {});
    });
    unawaited(_readPaired());
    // Pairings change at human speed; a slow look is plenty.
    _check = Timer.periodic(const Duration(seconds: 20), (_) => unawaited(_readPaired()));
  }

  @override
  void dispose() {
    unawaited(_changes?.cancel());
    _check?.cancel();
    super.dispose();
  }

  Future<void> _readPaired() async {
    try {
      final paired = await ref.read(displayPairingProvider).paired();
      if (mounted && paired.isNotEmpty != _paired) setState(() => _paired = paired.isNotEmpty);
    } catch (_) {
      // A till that cannot read its pairings simply shows no button.
    }
  }

  Future<void> _open() async {
    if (!await allowed(context, ref, TillPermission.isManager)) return;
    if (!mounted) return;
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => Scaffold(
          appBar: AppBar(title: const Text('Customer display')),
          body: const CustomerDisplayPage(),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final live = _hub.localConnected || _hub.remotes.any((r) => r.online);
    final has = _paired || live || _hub.remotes.isNotEmpty || _hub.requests.isNotEmpty;
    if (!has) return const SizedBox.shrink();
    final waiting = _hub.requests.isNotEmpty;
    return Tooltip(
      message: waiting
          ? 'A customer display is waiting to connect'
          : live
              ? 'Customer display: connected'
              : 'Customer display',
      child: InkWell(
        onTap: _open,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 10),
          child: Center(
            child: Badge(
              isLabelVisible: waiting,
              smallSize: 9,
              child: Icon(
                live ? Icons.tv : Icons.tv_off_outlined,
                size: 24,
                color: live ? const Color(0xFF6E8A0E) : Theme.of(context).disabledColor,
              ),
            ),
          ),
        ),
      ),
    );
  }
}
