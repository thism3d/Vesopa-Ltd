/// Taking somebody on, and handing them a card, from the Functions screen.
///
/// WHY THIS IS ON THE TILL AT ALL
///
/// "Ability to add staff members from the function screen. This should ask for
/// their name, role and either pin or to swipe a new staff card. Also the
/// ability for existing staff to assign a new card if their one have broke,
/// lost etc."
///
/// Until now a new starter could not ring anything up until somebody with a
/// back-office login had been found — which in a venue with one manager and no
/// office computer means a Friday evening with an extra pair of hands that
/// cannot be used.
///
/// WHAT IS DELIBERATELY NOT HERE
///
/// Editing, deleting, or changing anybody's PIN. Adding a starter is the
/// counter's problem; the rest is the back office's, and a till that could
/// retire people or read their PINs back is a different security question from
/// the one this answers.
///
/// It is behind manager approval, because it creates somebody who can sell.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/card_repository.dart';
import '../data/local/database.dart';
import '../data/staff_repository.dart';
import '../data/swipe_cards.dart';
import '../data/terminal_identity.dart';
import '../main.dart';
import 'manager_approval.dart';
import 'widgets/pos_message.dart';
import 'widgets/on_screen_keyboard.dart';
import 'widgets/pos_text_field.dart';

/// A screen waiting for the next card, so it can be given to somebody.
///
/// The same shape as [ManagerCardCapture] and for the same reason: a swipe
/// while this is open must not sign the clerk on and throw them off their bill.
/// Two captures cannot be open at once — this one only exists while a modal is
/// on screen — and the manager's takes priority because it is checked first in
/// `handleSwipedCard`.
class StaffCardCapture {
  StaffCardCapture._();

  static Completer<SwipedCard>? _waiting;

  /// True while a staff screen wants the next card.
  static bool get isWaiting => _waiting != null;

  /// Offer a card to whatever is waiting. True when it was taken.
  static bool offer(SwipedCard card) {
    final waiting = _waiting;
    if (waiting == null || waiting.isCompleted) return false;
    _waiting = null;
    waiting.complete(card);
    return true;
  }

  static Future<SwipedCard> _next() {
    _waiting?.complete(SwipedCard(number: '', raw: '', via: ReadVia.swipe));
    final completer = Completer<SwipedCard>();
    _waiting = completer;
    return completer.future;
  }

  static void _stop() => _waiting = null;

  @visibleForTesting
  static Future<SwipedCard> debugWaitForCard() => _next();

  @visibleForTesting
  static void debugStop() => _stop();
}

/// The staff sheet: who is on the list, and the two things a manager needs at
/// the counter.
Future<void> showStaffAdmin(BuildContext context, WidgetRef ref) async {
  // Creating somebody who can sell is a manager's act. The same gate the void
  // and the refund use, answered with a PIN or a card.
  final approval = await askAManagerToApprove(
    context,
    ref,
    title: 'Adding staff needs a manager',
  );
  if (!context.mounted) return;
  if (approval == null) {
    PosMessenger.info(context, 'Nobody was added.');
    return;
  }

  await showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (_) => const _StaffAdminSheet(),
  );
}

class _StaffAdminSheet extends ConsumerStatefulWidget {
  const _StaffAdminSheet();

  @override
  ConsumerState<_StaffAdminSheet> createState() => _StaffAdminSheetState();
}

class _StaffAdminSheetState extends ConsumerState<_StaffAdminSheet> {
  List<StaffData> _staff = const [];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    final rows = await ref.read(staffRepositoryProvider).all();
    if (!mounted) return;
    setState(() {
      _staff = rows;
      _loading = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;

    return SizedBox(
      height: MediaQuery.of(context).size.height * 0.8,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 4, 12, 8),
            child: Row(
              children: [
                const Expanded(
                  child: Text(
                    'Staff',
                    style: TextStyle(fontSize: 19, fontWeight: FontWeight.w700),
                  ),
                ),
                FilledButton.icon(
                  onPressed: _addSomebody,
                  icon: const Icon(Icons.person_add),
                  label: const Text('Add someone'),
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 10),
            child: Text(
              'Everybody who can sign on at this venue. A card that has been '
              'lost or has stopped working can be replaced here; names, PINs '
              'and roles are changed in the back office.',
              style: TextStyle(color: scheme.onSurfaceVariant, fontSize: 13),
            ),
          ),
          const Divider(height: 1),
          Expanded(
            child: _loading
                ? const Center(child: CircularProgressIndicator())
                : _staff.isEmpty
                ? Center(
                    child: Padding(
                      padding: const EdgeInsets.all(28),
                      child: Text(
                        'Nobody on the list yet. Add someone so they can sign '
                        'on.',
                        textAlign: TextAlign.center,
                        style: TextStyle(color: scheme.onSurfaceVariant),
                      ),
                    ),
                  )
                : ListView.separated(
                    itemCount: _staff.length,
                    separatorBuilder: (_, _) => const Divider(height: 1),
                    itemBuilder: (context, i) {
                      final person = _staff[i];
                      final hasCard = person.swipeCard.isNotEmpty;
                      return ListTile(
                        leading: CircleAvatar(
                          child: Text(
                            person.name.isEmpty
                                ? '?'
                                : person.name[0].toUpperCase(),
                          ),
                        ),
                        title: Text(person.name),
                        subtitle: Text(
                          hasCard
                              ? 'Card ${person.swipeCard}'
                              : 'No card — signs on with a PIN',
                        ),
                        trailing: OutlinedButton.icon(
                          onPressed: () => _giveCard(person),
                          icon: const Icon(Icons.credit_card, size: 18),
                          label: Text(hasCard ? 'New card' : 'Give a card'),
                        ),
                      );
                    },
                  ),
          ),
        ],
      ),
    );
  }

  // ---------------------------------------------------------------------
  // Adding somebody
  // ---------------------------------------------------------------------

  Future<void> _addSomebody() async {
    final roles = await ref.read(staffRepositoryProvider).permissionGroups();
    if (!mounted) return;

    final made = await showDialog<_NewStaff>(
      context: context,
      builder: (_) => _AddStaffDialog(roles: roles),
    );
    if (made == null || !mounted) return;

    final int id;
    try {
      id = await ref
          .read(staffRepositoryProvider)
          .create(
            name: made.name,
            permissionGroupId: made.roleId,
            pin: made.pin,
          );
    } on StaffSyncFailed catch (e) {
      if (mounted) PosMessenger.error(context, e.message);
      return;
    }

    if (!mounted) return;
    await _load();
    if (!mounted) return;

    if (made.wantsCard) {
      // The other half of "either pin or to swipe a new staff card". The person
      // exists now; the card is written onto them exactly as it would be for
      // somebody who had lost one.
      await _assignTo(id: id, name: made.name);
    } else {
      PosMessenger.success(
        context,
        '${made.name} can sign on with their PIN now.',
      );
    }
  }

  // ---------------------------------------------------------------------
  // Handing over a card
  // ---------------------------------------------------------------------

  Future<void> _giveCard(StaffData person) =>
      _assignTo(id: person.id, name: person.name);

  Future<void> _assignTo({required int id, required String name}) async {
    final card = await showDialog<SwipedCard>(
      context: context,
      barrierDismissible: false,
      builder: (_) => _SwipeForCard(name: name),
    );
    if (card == null || card.number.isEmpty || !mounted) return;

    try {
      await ref
          .read(cardRepositoryProvider)
          .assign(
            cardNumber: card.number,
            subjectId: '$id',
            subjectName: name,
            issuedBy: ref.read(servedByProvider),
            terminal: ref.read(terminalNameProvider),
          );
    } on CardException catch (e) {
      // Includes the useful refusal: the server names whoever already holds
      // this card rather than silently moving it off them.
      if (mounted) PosMessenger.error(context, e.message);
      return;
    }

    // The staff list is what the till checks a swipe against, so it has to
    // catch up before the new card will sign anybody on.
    try {
      await ref.read(staffRepositoryProvider).sync();
    } on StaffSyncFailed {
      // The card is attached in the back office; the next sync brings it down.
    }
    if (!mounted) return;
    await _load();
    if (!mounted) return;
    PosMessenger.success(context, 'Card ${card.number} is now $name’s.');
  }
}

/// What the add form came back with.
class _NewStaff {
  const _NewStaff({
    required this.name,
    required this.roleId,
    required this.pin,
    required this.wantsCard,
  });

  final String name;
  final int? roleId;

  /// Null when the manager chose to hand them a card instead.
  final String? pin;
  final bool wantsCard;
}

class _AddStaffDialog extends StatefulWidget {
  const _AddStaffDialog({required this.roles});

  final List<({int id, String name})> roles;

  @override
  State<_AddStaffDialog> createState() => _AddStaffDialogState();
}

class _AddStaffDialogState extends State<_AddStaffDialog> {
  final _name = TextEditingController();
  final _pin = TextEditingController();
  int? _roleId;
  bool _byCard = false;
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    _pin.dispose();
    super.dispose();
  }

  void _submit() {
    final name = _name.text.trim();
    if (name.isEmpty) {
      setState(() => _error = 'Give them a name.');
      return;
    }
    final pin = _pin.text.trim();
    if (!_byCard && !RegExp(r'^[0-9]{4}$').hasMatch(pin)) {
      // The same rule the back office enforces, and the reason for it: the pad
      // submits on the fourth key, so anything longer creates somebody who can
      // never sign on.
      setState(() => _error = 'A PIN is exactly four digits.');
      return;
    }
    Navigator.of(context).pop(
      _NewStaff(
        name: name,
        roleId: _roleId,
        pin: _byCard ? null : pin,
        wantsCard: _byCard,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Add someone to the staff list'),
      content: SizedBox(
        width: 420,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            PosTextField(
              controller: _name,
              autofocus: false,
              decoration: const InputDecoration(
                labelText: 'Name',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 14),
            if (widget.roles.isEmpty)
              const Text(
                'This venue has no roles set up, so they will be able to use '
                'every key. Roles are created in the back office under Staff '
                'Permissions.',
                style: TextStyle(fontSize: 12.5),
              )
            else
              DropdownButtonFormField<int?>(
                initialValue: _roleId,
                decoration: const InputDecoration(
                  labelText: 'Role',
                  border: OutlineInputBorder(),
                ),
                items: [
                  const DropdownMenuItem(
                    value: null,
                    child: Text('Every key (no role)'),
                  ),
                  for (final role in widget.roles)
                    DropdownMenuItem(value: role.id, child: Text(role.name)),
                ],
                onChanged: (v) => setState(() => _roleId = v),
              ),
            const SizedBox(height: 16),
            SegmentedButton<bool>(
              segments: const [
                ButtonSegment(
                  value: false,
                  icon: Icon(Icons.dialpad),
                  label: Text('PIN'),
                ),
                ButtonSegment(
                  value: true,
                  icon: Icon(Icons.credit_card),
                  label: Text('Card'),
                ),
              ],
              selected: {_byCard},
              onSelectionChanged: (s) => setState(() {
                _byCard = s.first;
                _error = null;
              }),
            ),
            const SizedBox(height: 12),
            if (_byCard)
              const Text(
                'They will be added, and then you will be asked to swipe the '
                'card that is going to be theirs.',
                style: TextStyle(fontSize: 12.5),
              )
            else
              PosTextField(
                controller: _pin,
                // The number pad, not the full board: four digits is the
                // whole answer and a QWERTY layout over the counter for it is
                // four taps of somebody else's time.
                mode: PosKeyboardMode.number,
                inputFormatters: [
                  FilteringTextInputFormatter.digitsOnly,
                  LengthLimitingTextInputFormatter(4),
                ],
                decoration: const InputDecoration(
                  labelText: 'PIN — four digits',
                  border: OutlineInputBorder(),
                ),
              ),
            if (_error != null) ...[
              const SizedBox(height: 10),
              Text(
                _error!,
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
            ],
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(onPressed: _submit, child: const Text('Add')),
      ],
    );
  }
}

/// Wait for a card, so it can be given to somebody.
class _SwipeForCard extends StatefulWidget {
  const _SwipeForCard({required this.name});

  final String name;

  @override
  State<_SwipeForCard> createState() => _SwipeForCardState();
}

class _SwipeForCardState extends State<_SwipeForCard> {
  @override
  void initState() {
    super.initState();
    unawaited(_wait());
  }

  Future<void> _wait() async {
    final card = await StaffCardCapture._next();
    if (mounted) Navigator.of(context).pop(card);
  }

  @override
  void dispose() {
    // Stop intercepting the moment the prompt goes, or the next ordinary swipe
    // on the sale screen would be swallowed by a dialog nobody can see.
    StaffCardCapture._stop();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: Text('Swipe ${widget.name}’s new card'),
    content: const Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(Icons.credit_card, size: 52),
        SizedBox(height: 14),
        Text(
          'Swipe the card now. Whoever held it before will keep theirs — the '
          'back office refuses a card that already belongs to somebody else, '
          'and says whose it is.',
          textAlign: TextAlign.center,
        ),
      ],
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.of(context).pop(),
        child: const Text('Cancel'),
      ),
    ],
  );
}
