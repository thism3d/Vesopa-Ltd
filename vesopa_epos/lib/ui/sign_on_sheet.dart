/// Handing the till to somebody else, in one press.
///
/// The till has always had Sign Off, which locks the screen and puts the idle
/// picture up for the next person to type their PIN into. That is right at the
/// end of a shift and wrong in the middle of service: the common case is a
/// colleague stepping in for one sale while the first clerk is still standing
/// there, and making them lock the till, wait for the screensaver and then type
/// into it is three steps for something that should be one.
///
/// So: a Sign On key. It names who is on now, lists everybody who could take
/// over, and asks the new person for their PIN. The bill on screen is left
/// exactly as it is — a handover is a change of who is responsible, not a
/// change of what the customer has ordered.
///
/// Where the venue runs more than one till, this is also where a clerk's items
/// catch up with them: see [signOnHere], which moves their session off whatever
/// terminal they were on and offers to bring the bill they left there.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/local/database.dart';
import '../data/staff_session.dart';
import '../main.dart';
import 'pin_dialog.dart';
import 'staff_handover.dart';
import 'widgets/pos_message.dart';

/// Offer the till to somebody else.
///
/// Returns the id of a bill the caller should switch to — the one the new clerk
/// brought with them from another terminal — or null to leave the screen as it
/// is, which is the ordinary answer.
Future<String?> showSignOnSheet(BuildContext context, WidgetRef ref) async {
  // A terminal that cannot check a PIN has nothing to offer here. Said plainly
  // rather than opening a sheet whose every row refuses.
  if (!ref.read(canSignOnProvider)) {
    PosMessenger.info(
      context,
      'Nobody is set up to sign on at this venue yet, or this terminal has not '
      'downloaded the staff list. Settings › Staff.',
    );
    return null;
  }

  return showModalBottomSheet<String>(
    context: context,
    isScrollControlled: true,
    builder: (_) => const _SignOnSheet(),
  );
}

class _SignOnSheet extends ConsumerStatefulWidget {
  const _SignOnSheet();

  @override
  ConsumerState<_SignOnSheet> createState() => _SignOnSheetState();
}

class _SignOnSheetState extends ConsumerState<_SignOnSheet> {
  bool _busy = false;

  @override
  Widget build(BuildContext context) {
    final staff = ref.watch(staffListProvider).value ?? const <StaffData>[];
    final now = ref.watch(staffSessionProvider).staff;

    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxHeight: MediaQuery.of(context).size.height * 0.85,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 18, 20, 4),
              child: Row(
                children: [
                  const Icon(Icons.login),
                  const SizedBox(width: 10),
                  const Expanded(
                    child: Text(
                      'Sign on',
                      style: TextStyle(
                        fontSize: 20,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
                  IconButton(
                    icon: const Icon(Icons.close),
                    onPressed: () => Navigator.of(context).pop(),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 12),
              child: Text(
                now == null
                    ? 'Nobody is signed on. Pick your name and type your PIN.'
                    : '${now.name} is on the till. Picking another name hands '
                          'it over — the bill on screen is left exactly as it is.',
                style: TextStyle(
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
              ),
            ),
            Flexible(
              child: ListView.separated(
                shrinkWrap: true,
                itemCount: staff.length,
                separatorBuilder: (_, _) => const Divider(height: 1),
                itemBuilder: (_, i) {
                  final who = staff[i];
                  final isOn = now != null && now.id == who.id;
                  return ListTile(
                    leading: CircleAvatar(
                      backgroundColor: isOn
                          ? Theme.of(context).colorScheme.primary
                          : Theme.of(
                              context,
                            ).colorScheme.surfaceContainerHighest,
                      child: Icon(
                        isOn ? Icons.check : Icons.person_outline,
                        color: isOn
                            ? Theme.of(context).colorScheme.onPrimary
                            : Theme.of(context).colorScheme.onSurfaceVariant,
                      ),
                    ),
                    title: Text(who.name),
                    subtitle: isOn ? const Text('Signed on here') : null,
                    enabled: !_busy && !isOn,
                    onTap: () => _take(who),
                  );
                },
              ),
            ),
            if (now != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 12, 20, 8),
                child: OutlinedButton.icon(
                  icon: const Icon(Icons.logout),
                  label: const Text('Sign off and lock the till'),
                  onPressed: _busy
                      ? null
                      : () {
                          ref.read(staffSessionProvider.notifier).signOff();
                          Navigator.of(context).pop();
                        },
                ),
              ),
            const SizedBox(height: 12),
          ],
        ),
      ),
    );
  }

  Future<void> _take(StaffData who) async {
    final pin = await askForPin(context, 'Your PIN, ${who.name}');
    if (pin == null || !mounted) return;

    setState(() => _busy = true);
    try {
      final matched = await ref.read(staffRepositoryProvider).byPin(pin);
      if (!mounted) return;
      if (matched == null || matched.id != who.id) {
        setState(() => _busy = false);
        PosMessenger.error(context, 'That PIN does not match ${who.name}.');
        return;
      }

      // Signs them on locally, moves their session off any other terminal, and
      // offers to bring the bill they had there. Returns the bill to switch to,
      // or null.
      final bring = await signOnHere(context, ref, matched);
      if (!mounted) return;
      Navigator.of(context).pop(bring);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }
}
